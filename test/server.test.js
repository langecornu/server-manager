'use strict';

// Starts a real copy of the server with its own temporary data folder and talks to it over HTTP.
// Run with `npm test`. Needs `openssl` for the HTTPS part, which every Mac and most Linux systems have.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function request(scheme, port, method, url, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const mod = scheme === 'https' ? https : http;
    const req = mod.request(
      { host: '127.0.0.1', port, path: url, method, rejectUnauthorized: false, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw last;
}

test('server', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-manager-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), SCAN_DIRS: dataDir },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await waitFor(() => request('http', port, 'GET', '/'));

  await t.test('serves the page and the inventory', async () => {
    const page = await request('http', port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.text, /Server Manager/);

    const inv = await request('http', port, 'GET', '/api/apps');
    assert.equal(inv.status, 200);
    assert.ok(Array.isArray(inv.json.apps));
    assert.ok(Array.isArray(inv.json.stopped));
    assert.equal(inv.json.self.port, port);
    assert.equal(inv.json.self.lan, false);
    assert.equal(inv.json.self.https, false);
  });

  await t.test('refuses requests that name another host (DNS rebinding)', async () => {
    const res = await request('http', port, 'GET', '/api/apps', { headers: { host: 'evil.example' } });
    assert.equal(res.status, 403);
  });

  await t.test('refuses changes that come from another website', async () => {
    const res = await request('http', port, 'PUT', '/api/settings', {
      body: { port, lan: true, https: false },
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
  });

  await t.test('does not serve files outside the public folder', async () => {
    const res = await request('http', port, 'GET', '/..%2fserver.js');
    assert.notEqual(res.status, 200);
  });

  await t.test('rejects a port that is out of range', async () => {
    const res = await request('http', port, 'PUT', '/api/settings', { body: { port: 80, lan: false, https: false } });
    assert.equal(res.status, 400);
  });

  await t.test('switches to HTTPS with a certificate, and redirects plain HTTP', async () => {
    const res = await request('http', port, 'PUT', '/api/settings', { body: { port, lan: false, https: true } });
    assert.equal(res.status, 200);

    const inv = await waitFor(async () => {
      const r = await request('https', port, 'GET', '/api/apps');
      assert.equal(r.status, 200);
      return r;
    });
    assert.equal(inv.json.self.https, true);
    assert.ok(inv.json.self.certExpires > Date.now() + 60 * 24 * 3600 * 1000, 'certificate lasts well over a month');

    const plain = await request('http', port, 'GET', '/');
    assert.equal(plain.status, 308);
    assert.match(plain.headers.location, /^https:\/\//);

    const ca = await request('https', port, 'GET', '/ca.crt');
    assert.equal(ca.status, 200);
    assert.match(ca.text, /BEGIN CERTIFICATE/);
  });
});
