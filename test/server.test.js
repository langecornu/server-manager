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

  // Two small projects the server will find, one that starts and one that fails straight away.
  const projects = path.join(dataDir, 'projects');
  const appPort = await freePort();
  const project = (name, scripts) => {
    fs.mkdirSync(path.join(projects, name), { recursive: true });
    fs.writeFileSync(path.join(projects, name, 'package.json'), JSON.stringify({ name, description: `${name} for the tests`, scripts }));
  };
  project('works-app', { dev: `node -e "require('http').createServer((q,r)=>r.end('ok')).listen(${appPort})"` });
  project('fails-app', { start: `node -e "console.error('boom: missing config');process.exit(3)"` });
  project('library', { build: 'echo not an app' });

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), SCAN_DIRS: projects },
    stdio: 'ignore',
  });
  t.after(async () => {
    // The app started by the test runs on its own, so it has to be stopped too, while the server can still name it.
    try {
      // By now the server may have switched to HTTPS, which answers plain HTTP with a redirect.
      const inv = (await request('https', port, 'GET', '/api/apps').catch(() => null)) || (await request('http', port, 'GET', '/api/apps').catch(() => null));
      const listening = inv && inv.json && inv.json.apps.flatMap((a) => a.ports).find((p) => p.port === appPort);
      if (listening) process.kill(listening.pid);
    } catch {}
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

  await t.test('lists projects that are not running, with the command that starts them', async () => {
    const inv = await request('http', port, 'GET', '/api/apps');
    const names = inv.json.stopped.map((a) => a.name);
    assert.ok(names.includes('Works App'));
    assert.ok(names.includes('Fails App'));
    assert.ok(!names.includes('Library'), 'a project without dev, start or serve is not an app');
    assert.equal(inv.json.stopped.find((a) => a.name === 'Works App').startCommand, 'npm run dev');
    assert.equal(inv.json.stopped.find((a) => a.name === 'Fails App').startCommand, 'npm start');
  });

  await t.test('shows why an app failed to start', async () => {
    const id = (await request('http', port, 'GET', '/api/apps')).json.stopped.find((a) => a.name === 'Fails App').id;
    const res = await request('http', port, 'POST', `/api/apps/${id}/start`);
    assert.equal(res.status, 202);
    const failed = await waitFor(async () => {
      const app = (await request('http', port, 'GET', '/api/apps')).json.stopped.find((a) => a.id === id);
      assert.ok(app.failed, 'still starting');
      return app.failed;
    });
    assert.equal(failed.code, 3);
    assert.ok(failed.tail.some((line) => line.includes('boom: missing config')));
  });

  await t.test('refuses to start something it does not know, or from another website', async () => {
    assert.equal((await request('http', port, 'POST', '/api/apps/000000000000/start')).status, 404);
    assert.equal((await request('http', port, 'POST', '/api/apps/not-an-id/start')).status, 404);
    const id = (await request('http', port, 'GET', '/api/apps')).json.stopped[0].id;
    const cross = await request('http', port, 'POST', `/api/apps/${id}/start`, { headers: { origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);
  });

  const hasLsof = ['/usr/sbin/lsof', '/usr/bin/lsof'].some((f) => fs.existsSync(f));
  await t.test('starts an app and then shows it running', { skip: !hasLsof && 'lsof is not installed' }, async () => {
    const id = (await request('http', port, 'GET', '/api/apps')).json.stopped.find((a) => a.name === 'Works App').id;
    const res = await request('http', port, 'POST', `/api/apps/${id}/start`);
    assert.equal(res.status, 202);
    assert.equal(res.json.command, 'npm run dev');
    const app = await waitFor(async () => {
      const found = (await request('http', port, 'GET', '/api/apps')).json.apps.find((a) => a.id === id);
      assert.ok(found, 'not listening yet');
      return found;
    }, 20000);
    assert.equal(app.ports[0].port, appPort);
    assert.equal((await request('http', port, 'POST', `/api/apps/${id}/start`)).status, 409, 'cannot be started twice');
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
