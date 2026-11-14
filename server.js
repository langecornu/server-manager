'use strict';

// Server Manager: an inventory of the local apps listening on this computer.
// No dependencies; run with `node server.js` and open http://localhost:1111.

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const net = require('node:net');
const { execFileSync } = require('node:child_process');

const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'apps.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const TLS_DIR = path.join(DATA_DIR, 'tls');
const ICON_DIR = path.join(DATA_DIR, 'icons');

/* ───────────────────────── Settings (changed from the Settings dialog) ───────────────────────── */
// port: where Server Manager listens. lan: also reachable from the local network. https: serve over TLS.

const DEFAULT_PORT = Number(process.env.PORT) || 1111;

function normalizeSettings(s) {
  const port = Number(s && s.port);
  return {
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT,
    lan: Boolean(s && s.lan),
    https: Boolean(s && s.https),
  };
}

let settings = normalizeSettings(null);
try {
  settings = normalizeSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
} catch {}

function saveSettings() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}
const HOME = os.homedir();

const SCAN_TTL = 2000;
const PROBE_TTL = 30000;
const ICON_TTL = 5 * 60000;
const ICON_MISS_TTL = 60000;

/* ───────────────────────── Saved state ───────────────────────── */
// apps[id] = { key, root, runtime, name, description, lastPorts, lastSeen, override }

let store = { apps: {} };
try {
  store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!store.apps) store.apps = {};
} catch {}

// Throwaway copies (temp folders, hidden tool folders such as .claude/worktrees) are shown while they run
// but never remembered afterwards.
const TEMP_ROOTS = ['/private/tmp/', '/tmp/', '/private/var/', '/var/folders/'];
const isThrowaway = (root) => TEMP_ROOTS.some((t) => root.startsWith(t)) || root.split(path.sep).some((part) => part.startsWith('.') && part.length > 1);

for (const [id, entry] of Object.entries(store.apps)) {
  if (entry.root && isThrowaway(entry.root)) delete store.apps[id];
}

function saveStore() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('Could not save', DATA_FILE, e.message);
  }
}

/* ───────────────────────── Process discovery ───────────────────────── */

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: 8000, env: { ...process.env, LC_ALL: 'C' } }, (_err, stdout) => resolve(stdout || ''));
  });
}

async function listListeners() {
  const out = await run('/usr/sbin/lsof', ['-nP', '+c', '0', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']);
  const map = new Map();
  let pid = 0;
  let cmd = '';
  for (const line of out.split('\n')) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') pid = Number(val);
    else if (tag === 'c') cmd = val;
    else if (tag === 'n') {
      const i = val.lastIndexOf(':');
      const port = Number(val.slice(i + 1));
      if (!port) continue;
      const address = val.slice(0, i).replace(/^\[|\]$/g, '');
      const key = `${pid}:${port}`;
      const cur = map.get(key);
      if (cur) cur.addresses.add(address);
      else map.set(key, { pid, cmd, port, addresses: new Set([address]) });
    }
  }
  return [...map.values()];
}

async function processInfo(pids) {
  const info = new Map();
  if (!pids.length) return info;
  const out = await run('/bin/ps', ['-ww', '-o', 'pid=,lstart=,command=', '-p', pids.join(',')]);
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
    if (!m) continue;
    const started = Date.parse(m[2]);
    info.set(Number(m[1]), { started: Number.isNaN(started) ? null : started, command: m[3].trim() });
  }
  return info;
}

async function workingDirs(pids) {
  const dirs = new Map();
  if (!pids.length) return dirs;
  const out = await run('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]);
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n') dirs.set(pid, line.slice(1));
  }
  return dirs;
}

const JS_RUNTIME = /^(node|nodejs|bun|deno|tsx|ts-node|next-server|nuxt|vite|npm|pnpm|yarn)\b/i;

function isNode(cmd, command) {
  const first = path.basename((command || '').split(' ')[0] || '');
  return JS_RUNTIME.test(cmd) || JS_RUNTIME.test(first);
}

/* ───────────────────────── Project metadata ───────────────────────── */

function findRoot(cwd) {
  let dir = cwd;
  while (dir && dir !== '/' && dir !== HOME) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function prettify(name) {
  return String(name || '')
    .replace(/^@[^/]+\//, '')
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function clip(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

function readmeSummary(root) {
  let dir = root;
  for (let depth = 0; depth < 4 && dir && dir !== '/' && dir !== HOME; depth++) {
    for (const file of ['README.md', 'readme.md', 'README']) {
      let text;
      try {
        text = fs.readFileSync(path.join(dir, file), 'utf8');
      } catch {
        continue;
      }
      const para = [];
      let fenced = false;
      for (const raw of text.split('\n').slice(0, 120)) {
        const line = raw.trim();
        if (line.startsWith('```')) { fenced = !fenced; continue; }
        if (fenced) continue;
        if (!line) { if (para.length) break; continue; }
        if (!para.length && /^([#!<|>\-*=[]|\d+\.)/.test(line)) continue;
        para.push(line);
      }
      const summary = para.join(' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/[*_`]/g, '');
      if (summary.trim()) return clip(summary, 200);
    }
    if (fs.existsSync(path.join(dir, '.git'))) break;
    dir = path.dirname(dir);
  }
  return '';
}

function readProject(root) {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {}
  const description = typeof pkg.description === 'string' && pkg.description.trim() ? clip(pkg.description, 200) : readmeSummary(root);
  return { pkgName: pkg.productName || pkg.displayName || pkg.name || '', description };
}

const GENERIC_PACKAGE = /^(web|client|server|app|api|frontend|backend|ui|site|www)$/i;

// "web" or "server" says nothing on its own, so borrow the parent folder: "Sem Meter Web".
function projectName(root, pkgName) {
  const folder = path.basename(root);
  const squash = (s) => String(s || '').replace(/^@[^/]+\//, '').replace(/[-_. ]/g, '').toLowerCase();
  // package.json names are lowercase; when the folder is the same word with real capitals ("BPMachina"), keep those.
  if (/[A-Z]/.test(folder) && squash(folder) === squash(pkgName)) return folder.replace(/[-_]+/g, ' ');
  const name = prettify(pkgName) || prettify(folder);
  return GENERIC_PACKAGE.test(name) ? `${prettify(path.basename(path.dirname(root)))} ${name}` : name;
}

/* ───────────────────────── Projects on disk (running or not) ───────────────────────── */

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'tmp', 'Library']);
const DEFAULT_SCAN_DIRS = ['Repo', 'Repos', 'Sites', 'Projects', 'Developer', 'Code', 'dev', 'src', 'work', 'git'];
const CATALOG_TTL = 30000;

function scanDirs() {
  const configured = process.env.SCAN_DIRS
    ? process.env.SCAN_DIRS.split(':')
    : Array.isArray(store.scanDirs) && store.scanDirs.length
      ? store.scanDirs
      : DEFAULT_SCAN_DIRS.map((d) => path.join(HOME, d));
  const dirs = new Set();
  for (const raw of configured) {
    const dir = raw.startsWith('~') ? path.join(HOME, raw.slice(1)) : raw;
    try {
      if (fs.statSync(dir).isDirectory()) dirs.add(fs.realpathSync(dir));
    } catch {}
  }
  return [...dirs];
}

function readSmall(file) {
  try {
    if (fs.statSync(file).size > 200 * 1024) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const SERVER_FILES = [
  'server.js', 'index.js', 'app.js', 'main.js', 'config.js',
  'server/index.js', 'server/index.ts', 'server/config.js', 'server/config.ts', 'server/server.js', 'server/app.js', 'server/env.js',
  'src/index.js', 'src/index.ts', 'src/server.js', 'src/server.ts', 'src/config.js', 'src/config.ts', 'src/app.js',
];

// Best guess at the port an app uses, read from its config rather than from a running process.
function detectPorts(root, pkg) {
  const found = new Map();
  const add = (port, source) => {
    const n = Number(port);
    if (n >= 1024 && n < 65536 && !found.has(n)) found.set(n, source);
  };

  let viteConfig = false;
  for (const dir of ['', 'client', 'web', 'frontend']) {
    for (const ext of ['js', 'ts', 'mjs', 'mts']) {
      const rel = path.join(dir, `vite.config.${ext}`);
      const text = readSmall(path.join(root, rel));
      if (!text) continue;
      viteConfig = true;
      const m = text.match(/\bport:\s*(\d{2,5})/);
      add(m ? m[1] : 5173, m ? rel : 'Vite default');
    }
  }

  for (const [name, script] of Object.entries(pkg.scripts || {})) {
    if (!/^(dev|start|serve|preview)(:|$)/.test(name)) continue;
    for (const m of String(script).matchAll(/(?:--port[= ]|\s-p\s+|\bPORT=)(\d{2,5})/g)) add(m[1], `"${name}" script`);
  }

  for (const env of ['.env', '.env.local', '.env.development', '.env.example']) {
    for (const m of readSmall(path.join(root, env)).matchAll(/^\s*(?:export\s+)?(?:(?:VITE|API|SERVER|APP|WEB|HTTP|HTTPS|DEV|CLIENT|BACKEND|FRONTEND)_)?PORT\s*=\s*["']?(\d{2,5})\b/gm)) add(m[1], env);
  }

  const files = [...new Set([typeof pkg.main === 'string' ? pkg.main : '', ...SERVER_FILES].filter(Boolean))];
  for (const rel of files) {
    const text = readSmall(path.join(root, rel));
    if (!text) continue;
    for (const m of text.matchAll(/process\.env\.\w*PORT\w*\s*(?:\|\||\?\?)\s*['"]?(\d{2,5})/g)) add(m[1], rel);
    for (const m of text.matchAll(/\.listen\(\s*(\d{2,5})\b/g)) add(m[1], rel);
    for (const m of text.matchAll(/\bport\w*\s*[:=]\s*(?:Number\(|parseInt\()?\s*(?:process\.env\.\w+\s*(?:\|\||\?\?|,)\s*)?['"]?(\d{4,5})\b/gi)) add(m[1], rel);
  }

  if (!found.size) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.vite && !viteConfig) add(5173, 'Vite default');
    else if (deps.next || deps['react-scripts'] || deps.nuxt) add(3000, 'framework default');
    else if (deps.astro) add(4321, 'Astro default');
  }
  return [...found].slice(0, 4).map(([port, source]) => ({ port, source }));
}

function findProjects(dir, depth, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.name === 'package.json' && e.isFile())) {
    if (dir === __dirname) return;
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      return;
    }
    const scripts = pkg.scripts || {};
    const script = ['dev', 'start', 'serve'].find((s) => scripts[s]);
    if (!script) return; // a library or a one-off script, not an app you start
    const project = readProject(dir);
    out.push({
      id: idOf(dir),
      root: dir,
      name: projectName(dir, project.pkgName),
      description: project.description,
      startCommand: script === 'start' ? 'npm start' : `npm run ${script}`,
      ports: detectPorts(dir, pkg),
    });
    return;
  }
  if (depth >= 4) return;
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) findProjects(path.join(dir, e.name), depth + 1, out);
  }
}

let catalogCache = null;

function catalog() {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL) return catalogCache;
  const dirs = scanDirs();
  const projects = [];
  for (const dir of dirs) findProjects(dir, 0, projects);
  catalogCache = { at: Date.now(), dirs, projects };
  return catalogCache;
}

function shortCommand(command, root) {
  let c = command || '';
  if (root) c = c.split(root + '/').join('');
  c = c.split(HOME).join('~');
  c = c.replace(/^\S*\/(node|bun|deno)(?=\s|$)/, '$1');
  c = c.replace(/^node (\S*node_modules\/\.bin\/)(\S+)/, '$2');
  return clip(c, 90);
}

const tilde = (p) => (p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);

/* ───────────────────────── HTTP probing ───────────────────────── */

function fetchOnce(scheme, host, port, pathName, limit = 256 * 1024, timeout = 1500) {
  return new Promise((resolve) => {
    const mod = scheme === 'https' ? https : http;
    const req = mod.request(
      {
        host,
        port,
        path: pathName,
        method: 'GET',
        timeout,
        rejectUnauthorized: false,
        headers: { host: `localhost:${port}`, accept: 'text/html,image/*,*/*;q=0.8', 'user-agent': 'ServerManager' },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        const done = () => resolve({ ok: true, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        res.on('data', (c) => {
          size += c.length;
          if (size <= limit) chunks.push(c);
          else req.destroy();
        });
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false }));
    req.end();
  });
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : '';
}

function analyze(res, scheme, host) {
  const type = String(res.headers['content-type'] || '');
  const head = res.body.toString('utf8', 0, Math.min(res.body.length, 256 * 1024));
  const html = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(head);
  const out = { scheme, host, kind: html ? 'web' : 'api', title: '', description: '', iconHref: '' };
  if (!html) return out;
  const title = head.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (title) out.title = clip(decodeEntities(title[1]), 80);
  for (const tag of head.match(/<(meta|link)\b[^>]*>/gi) || []) {
    if (/^<meta/i.test(tag)) {
      if (!out.description && /^description$/i.test(attr(tag, 'name'))) out.description = clip(attr(tag, 'content'), 200);
    } else if (!out.iconHref && /(^|\s)(shortcut\s+)?icon(\s|$)|apple-touch-icon/i.test(attr(tag, 'rel'))) {
      out.iconHref = attr(tag, 'href');
    }
  }
  return out;
}

function probeHosts(addresses) {
  const hosts = [];
  for (const a of addresses) {
    if (a === '*') hosts.push('127.0.0.1', '::1');
    else hosts.push(a);
  }
  return [...new Set(hosts)];
}

const httpsPorts = new Set(); // remembered so a refresh doesn't wait on a plain-HTTP attempt first

async function probe(listener) {
  for (const scheme of httpsPorts.has(listener.port) ? ['https', 'http'] : ['http', 'https']) {
    for (const host of probeHosts(listener.addresses)) {
      let res = await fetchOnce(scheme, host, listener.port, '/');
      if (!res.ok) continue;
      if (scheme === 'https') httpsPorts.add(listener.port);
      else httpsPorts.delete(listener.port);
      for (let hop = 0; hop < 3 && res.status >= 300 && res.status < 400 && res.headers.location; hop++) {
        let next;
        try {
          next = new URL(res.headers.location, `${scheme}://localhost:${listener.port}/`);
        } catch {
          break;
        }
        // Only follow redirects that stay on this same server.
        if (next.protocol !== scheme + ':' || Number(next.port || (scheme === 'https' ? 443 : 80)) !== listener.port) {
          return { scheme, host, kind: 'web', title: '', description: '', iconHref: '' };
        }
        const followed = await fetchOnce(scheme, host, listener.port, next.pathname + next.search);
        if (!followed.ok) break;
        res = followed;
      }
      return analyze(res, scheme, host);
    }
  }
  return { scheme: 'http', host: '', kind: 'tcp', title: '', description: '', iconHref: '' };
}

const probeCache = new Map();

async function probeCached(listener) {
  const key = `${listener.pid}:${listener.port}`;
  const hit = probeCache.get(key);
  // Ports that don't speak HTTP are slow to probe (they time out), so ask them far less often.
  if (hit && Date.now() - hit.at < (hit.value.kind === 'tcp' ? PROBE_TTL * 10 : PROBE_TTL)) return hit.value;
  const value = await probe(listener);
  probeCache.set(key, { at: Date.now(), value });
  return value;
}

/* ───────────────────────── Icons ───────────────────────── */

const ICON_FILES = [
  'public/favicon.svg', 'public/favicon.png', 'public/favicon.ico', 'public/icon.svg', 'public/icon.png',
  'public/logo.svg', 'public/logo.png', 'favicon.svg', 'favicon.png', 'favicon.ico',
  'static/favicon.svg', 'static/favicon.png', 'static/favicon.ico', 'src/favicon.ico',
  'app/favicon.ico', 'app/icon.svg', 'app/icon.png', 'src/app/favicon.ico', 'src/app/icon.png',
  'client/public/favicon.svg', 'client/public/favicon.ico', 'web/public/favicon.svg', 'web/public/favicon.ico',
  'assets/icon.png', 'build/icon.png',
];

function sniffImage(buf) {
  if (!buf || buf.length < 8) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (/<svg[\s>]/i.test(buf.toString('utf8', 0, Math.min(buf.length, 1024)))) return 'image/svg+xml';
  return '';
}

async function findIcon(info) {
  const p = info.primary;
  if (p && p.kind === 'web') {
    const candidates = [];
    if (p.iconHref.startsWith('data:')) {
      const m = p.iconHref.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
      if (m) {
        const body = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
        const type = sniffImage(body);
        if (type) return { type, body };
      }
    } else if (p.iconHref) {
      try {
        const u = new URL(p.iconHref, `${p.scheme}://localhost:${p.port}/`);
        if (u.hostname === 'localhost' && Number(u.port) === p.port) candidates.push(u.pathname + u.search);
      } catch {}
    }
    candidates.push('/favicon.ico');
    for (const c of candidates) {
      const res = await fetchOnce(p.scheme, p.host, p.port, c, 1024 * 1024);
      if (!res.ok || res.status !== 200) continue;
      const type = sniffImage(res.body);
      if (type) return { type, body: res.body };
    }
  }
  if (info.root) {
    for (const file of ICON_FILES) {
      try {
        const body = fs.readFileSync(path.join(info.root, file));
        const type = sniffImage(body);
        if (type && body.length < 1024 * 1024) return { type, body };
      } catch {}
    }
  }
  return null;
}

const iconCache = new Map();
const iconSources = new Map(); // id -> { root, primary }

const customIconFile = (id) => path.join(ICON_DIR, `${id}.png`);

async function getIcon(id) {
  // An image uploaded from the edit dialog wins over anything detected.
  if (store.apps[id] && store.apps[id].override && store.apps[id].override.iconAt) {
    try {
      return { type: 'image/png', body: fs.readFileSync(customIconFile(id)) };
    } catch {}
  }
  const hit = iconCache.get(id);
  if (hit && Date.now() - hit.at < (hit.value ? ICON_TTL : ICON_MISS_TTL)) return hit.value;
  const info = iconSources.get(id);
  const value = info ? await findIcon(info) : null;
  iconCache.set(id, { at: Date.now(), value });
  return value;
}

/* ───────────────────────── Building the inventory ───────────────────────── */

const GENERIC_TITLE = /^(vite(\s*\+\s*\w+)*(\s+app)?|react app|document|untitled|index|home|localhost.*|error.*|.*not found.*|cannot get.*)$/i;
const DEV_SERVER = /\b(vite|next|nuxt|webpack|astro|remix|parcel|react-scripts|svelte-kit|ng serve|storybook)\b/i;

const idOf = (key) => crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);

function publicHost(addresses) {
  if (addresses.has('*') || addresses.has('127.0.0.1') || addresses.has('::1')) return 'localhost';
  const a = [...addresses][0];
  return a.includes(':') ? `[${a}]` : a;
}

function applyOverride(app, entry) {
  const o = (entry && entry.override) || {};
  app.auto = { name: app.name, description: app.description };
  app.custom = Boolean(o.name || o.description || o.emoji || o.iconAt);
  app.customIcon = o.iconAt || 0;
  if (o.name) app.name = o.name;
  if (o.description) app.description = o.description;
  app.emoji = o.emoji || '';
  return app;
}

async function buildInventory(includeAll) {
  const listeners = (await listListeners()).filter((l) => l.pid !== process.pid);
  const pids = [...new Set(listeners.map((l) => l.pid))];
  const [procs, dirs] = await Promise.all([processInfo(pids), workingDirs(pids)]);

  const wanted = [];
  for (const l of listeners) {
    const proc = procs.get(l.pid);
    l.command = proc ? proc.command : l.cmd;
    l.started = proc ? proc.started : null;
    l.cwd = dirs.get(l.pid) || '';
    l.node = isNode(l.cmd, l.command);
    if (includeAll || l.node) wanted.push(l);
  }
  await Promise.all(wanted.map(async (l) => { l.probe = await probeCached(l); }));

  const groups = new Map();
  for (const l of wanted) {
    const root = l.cwd ? findRoot(l.cwd) : null;
    const dir = root || (l.cwd && l.cwd !== '/' && l.cwd !== HOME ? l.cwd : null);
    // Other programs that merely run from a project folder stay separate from the Node app that lives there.
    const key = l.node ? dir || `proc:${l.cmd}` : `${dir || 'proc'}#${l.cmd}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, root: dir, hasPackage: Boolean(root) && l.node, node: l.node, cmd: l.cmd, listeners: [] }));
    g.listeners.push(l);
  }

  const running = [];
  let dirty = false;
  for (const g of groups.values()) {
    const id = idOf(g.key);
    const score = (l) => (l.probe.kind === 'web' ? 10 : l.probe.kind === 'api' ? 2 : 0) + (DEV_SERVER.test(l.command) ? 5 : 0);
    g.listeners.sort((a, b) => score(b) - score(a) || a.port - b.port);
    const primary = g.listeners[0];
    const project = g.hasPackage ? readProject(g.root) : { pkgName: '', description: g.root && g.node ? readmeSummary(g.root) : '' };

    const title = primary.probe.kind === 'web' ? primary.probe.title : '';
    const name =
      (title && title.length <= 40 && !GENERIC_TITLE.test(title) && title) ||
      (g.root && g.node ? projectName(g.root, project.pkgName) : g.cmd);
    const description = project.description || primary.probe.description || '';

    const ports = g.listeners.map((l, i) => ({
      port: l.port,
      url: `${l.probe.scheme}://${publicHost(l.addresses)}:${l.port}`,
      scheme: l.probe.scheme,
      kind: l.probe.kind,
      title: l.probe.title,
      command: shortCommand(l.command, g.root),
      pid: l.pid,
      started: l.started,
      local: [...l.addresses].every((a) => a === '::1' || a.startsWith('127.')),
      primary: i === 0,
    }));

    iconSources.set(id, { root: g.root, primary: { ...primary.probe, port: primary.port } });
    const runtime = g.listeners.some((l) => l.node) ? 'node' : 'other';
    const app = { id, running: true, runtime, name, description, root: g.root, rootLabel: g.root ? tilde(g.root) : '', ports };

    let entry = store.apps[id];
    if (runtime === 'node' && g.root && !isThrowaway(g.root)) {
      const lastPorts = ports.map((p) => ({ port: p.port, url: p.url, kind: p.kind }));
      const stale = !entry || !entry.lastSeen || Date.now() - entry.lastSeen > 10 * 60000;
      if (stale || entry.hidden || entry.name !== name || entry.description !== description || JSON.stringify(entry.lastPorts) !== JSON.stringify(lastPorts)) {
        entry = store.apps[id] = { ...entry, hidden: false, key: g.key, root: g.root, runtime, name, description, lastPorts, lastSeen: Date.now() };
        dirty = true;
      }
    }
    running.push(applyOverride(app, entry));
  }

  const runningIds = new Set(running.map((a) => a.id));
  const usedBy = new Map();
  for (const a of running) for (const p of a.ports) usedBy.set(p.port, a.name);
  const found = catalog();
  const onDisk = new Map(found.projects.map((p) => [p.id, p]));
  const stopped = [];

  // Apps seen running before: show the ports they really used last time.
  for (const [id, entry] of Object.entries(store.apps)) {
    if (runningIds.has(id) || !entry.lastSeen || !entry.root || entry.runtime !== 'node') continue;
    if (!fs.existsSync(entry.root)) continue;
    iconSources.set(id, { root: entry.root, primary: null });
    stopped.push(applyOverride({
      id,
      running: false,
      runtime: 'node',
      name: entry.name,
      description: entry.description,
      root: entry.root,
      rootLabel: tilde(entry.root),
      ports: (entry.lastPorts || []).map((p) => ({ ...p, source: 'last used' })),
      lastSeen: entry.lastSeen,
      startCommand: onDisk.get(id) ? onDisk.get(id).startCommand : '',
    }, entry));
  }

  // Projects found on disk that have never been seen running: show the port from their config.
  const listed = new Set(stopped.map((a) => a.id));
  for (const p of found.projects) {
    const entry = store.apps[p.id];
    if (runningIds.has(p.id) || listed.has(p.id)) continue;
    iconSources.set(p.id, { root: p.root, primary: null });
    stopped.push(applyOverride({
      id: p.id,
      running: false,
      runtime: 'node',
      name: p.name,
      description: p.description,
      root: p.root,
      rootLabel: tilde(p.root),
      ports: p.ports.map((x) => ({ port: x.port, url: `http://localhost:${x.port}`, kind: 'expected', source: x.source })),
      lastSeen: null,
      startCommand: p.startCommand,
    }, entry));
  }
  for (const a of stopped) {
    a.hidden = Boolean(store.apps[a.id] && store.apps[a.id].hidden);
    for (const p of a.ports) if (usedBy.has(p.port)) p.usedBy = usedBy.get(p.port);
  }
  if (dirty) saveStore();

  await Promise.all([...running, ...stopped].map(async (a) => { a.icon = Boolean(await getIcon(a.id)); }));

  const byName = (a, b) => a.name.localeCompare(b.name);
  const hasWeb = (a) => (a.ports.some((p) => p.kind === 'web') ? 0 : 1);
  running.sort((a, b) => hasWeb(a) - hasWeb(b) || byName(a, b));
  stopped.sort(byName);
  return { scannedAt: Date.now(), scanDirs: found.dirs.map(tilde), apps: running, stopped };
}

const scans = new Map(); // mode -> { at, promise }

function inventory(includeAll) {
  const mode = includeAll ? 'all' : 'node';
  const hit = scans.get(mode);
  if (hit && Date.now() - hit.at < SCAN_TTL) return hit.promise;
  const promise = buildInventory(includeAll);
  scans.set(mode, { at: Date.now(), promise });
  promise.catch(() => scans.delete(mode));
  return promise;
}

/* ───────────────────────── HTTP server ───────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 700 * 1024) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/* ───────────────────────── This computer on the network ───────────────────────── */

let cachedLocalName = '';
function localName() {
  if (!cachedLocalName) {
    try {
      cachedLocalName = execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim();
    } catch {}
    if (!/^[A-Za-z0-9-]+$/.test(cachedLocalName)) cachedLocalName = os.hostname().split('.')[0].replace(/[^A-Za-z0-9-]/g, '') || 'this-mac';
  }
  return cachedLocalName;
}

function lanIPs() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

// True when the browser asking is on this computer (settings can only be changed from here).
function isThisComputer(req) {
  const a = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || lanIPs().includes(a);
}

function selfInfo(req) {
  const scheme = settings.https ? 'https' : 'http';
  const urls = [`${scheme}://localhost:${settings.port}`];
  if (settings.lan) {
    urls.push(`${scheme}://${localName().toLowerCase()}.local:${settings.port}`);
    for (const ip of lanIPs()) urls.push(`${scheme}://${ip}:${settings.port}`);
  }
  const cert = settings.https ? readCert() : null;
  return {
    name: localName(),
    port: settings.port,
    lan: settings.lan,
    https: settings.https,
    urls,
    networkHosts: [`${localName().toLowerCase()}.local`, ...lanIPs()],
    certExpires: cert ? Date.parse(cert.validTo) : null,
    canConfigure: isThisComputer(req),
  };
}

/* ───────────────────────── HTTPS certificate (self-signed, renews itself) ───────────────────────── */
// A small private certificate authority is created once (10 years). It signs a 90-day certificate for this
// computer's names and addresses, replaced automatically 30 days before it expires or when the address changes.
// Trusting ca.crt on a device removes the browser warning for good, renewals included.

const RENEW_BEFORE = 30 * 24 * 3600 * 1000;
const tlsFile = (name) => path.join(TLS_DIR, name);

function readCert() {
  try {
    return new crypto.X509Certificate(fs.readFileSync(tlsFile('server.crt')));
  } catch {
    return null;
  }
}

function tlsNames() {
  const names = new Set(['localhost', `${localName().toLowerCase()}.local`]);
  const host = os.hostname().toLowerCase();
  if (/^[a-z0-9.-]+$/.test(host)) names.add(host);
  return { names: [...names], ips: ['127.0.0.1', ...lanIPs()] };
}

function certificateStale() {
  const cert = readCert();
  if (!cert || !fs.existsSync(tlsFile('server.key')) || !fs.existsSync(tlsFile('ca.crt'))) return true;
  if (Date.parse(cert.validTo) - Date.now() < RENEW_BEFORE) return true;
  const san = `${cert.subjectAltName || ''},`;
  const { names, ips } = tlsNames();
  return names.some((n) => !san.includes(`DNS:${n},`)) || ips.some((ip) => !san.includes(`IP Address:${ip},`));
}

function openssl(args) {
  execFileSync('/usr/bin/openssl', args, { cwd: TLS_DIR, stdio: ['ignore', 'ignore', 'pipe'] });
}

// Returns true when a new certificate was issued.
function ensureCertificate() {
  if (!certificateStale()) return false;
  fs.mkdirSync(TLS_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(tlsFile('ca.key')) || !fs.existsSync(tlsFile('ca.crt'))) {
    fs.writeFileSync(tlsFile('ca.cnf'), [
      '[req]', 'distinguished_name = dn', 'prompt = no', 'x509_extensions = v3_ca',
      '[dn]', `CN = Server Manager Local CA (${localName()})`,
      '[v3_ca]', 'basicConstraints = critical,CA:TRUE', 'keyUsage = critical,keyCertSign,cRLSign', 'subjectKeyIdentifier = hash', '',
    ].join('\n'));
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650', '-keyout', 'ca.key', '-out', 'ca.crt', '-config', 'ca.cnf']);
  }
  const { names, ips } = tlsNames();
  fs.writeFileSync(tlsFile('leaf.cnf'), [
    '[req]', 'distinguished_name = dn', 'prompt = no',
    '[dn]', `CN = ${localName()}.local`,
    '[v3_leaf]', 'basicConstraints = CA:FALSE', 'keyUsage = critical,digitalSignature,keyEncipherment', 'extendedKeyUsage = serverAuth', 'subjectAltName = @alt',
    '[alt]', ...names.map((n, i) => `DNS.${i + 1} = ${n}`), ...ips.map((ip, i) => `IP.${i + 1} = ${ip}`), '',
  ].join('\n'));
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key.new', '-out', 'server.csr', '-config', 'leaf.cnf']);
  openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt.new', '-days', '90', '-sha256', '-extfile', 'leaf.cnf', '-extensions', 'v3_leaf']);
  fs.renameSync(tlsFile('server.key.new'), tlsFile('server.key'));
  fs.renameSync(tlsFile('server.crt.new'), tlsFile('server.crt'));
  for (const f of ['ca.key', 'server.key']) fs.chmodSync(tlsFile(f), 0o600);
  console.log(`Issued a new HTTPS certificate, valid until ${readCert().validTo}`);
  return true;
}

function tlsOptions() {
  return { key: fs.readFileSync(tlsFile('server.key')), cert: Buffer.concat([fs.readFileSync(tlsFile('server.crt')), fs.readFileSync(tlsFile('ca.crt'))]) };
}

// Keeps other websites from reading or changing the inventory (DNS rebinding, cross-site requests).
function trusted(req) {
  const allowed = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (settings.lan) {
    allowed.add(os.hostname().toLowerCase());
    allowed.add(`${localName().toLowerCase()}.local`);
    for (const ip of lanIPs()) allowed.add(ip);
  }
  const hostname = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!allowed.has(hostname) && !hostname.endsWith('.localhost')) return false;
  if (req.method !== 'GET' && req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  if (!trusted(req)) return sendJson(res, 403, { error: 'Forbidden' });

  if (url.pathname === '/api/apps' && req.method === 'GET') {
    // The Refresh button: skip every cache and look again from scratch.
    if (url.searchParams.get('fresh') === '1') {
      scans.clear();
      catalogCache = null;
      for (const [key, hit] of probeCache) if (hit.value.kind !== 'tcp') probeCache.delete(key);
    }
    const found = await inventory(url.searchParams.get('all') === '1');
    return sendJson(res, 200, { ...found, self: selfInfo(req) });
  }

  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    if (!isThisComputer(req)) return sendJson(res, 403, { error: 'Settings can only be changed on the computer Server Manager runs on.' });
    const body = await readBody(req);
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return sendJson(res, 400, { error: 'Choose a port between 1024 and 65535.' });
    const next = { port, lan: Boolean(body.lan), https: Boolean(body.https) };
    if (port !== settings.port) {
      const taken = (await listListeners()).find((l) => l.port === port && l.pid !== process.pid);
      if (taken) return sendJson(res, 409, { error: `Port ${port} is already used by another program (${taken.cmd}).` });
    }
    if (next.https) {
      try {
        ensureCertificate();
      } catch (e) {
        return sendJson(res, 500, { error: `Could not create the HTTPS certificate: ${String(e.stderr || e.message).trim().split('\n').pop()}` });
      }
    }
    sendJson(res, 200, { ok: true, ...next });
    // Answer first, then move to the new address.
    setTimeout(() => applySettings(next).catch((e) => console.error('Could not apply settings:', e.message)), 250);
    return;
  }

  if (url.pathname === '/ca.crt' && req.method === 'GET') {
    try {
      const body = fs.readFileSync(tlsFile('ca.crt'));
      res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="server-manager-ca.crt"' });
      return res.end(body);
    } catch {
      res.writeHead(404);
      return res.end();
    }
  }

  if (parts[0] === 'api' && parts[1] === 'icon' && parts[2] && req.method === 'GET') {
    const icon = await getIcon(parts[2]);
    if (!icon) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {
      'content-type': icon.type,
      'cache-control': 'max-age=300',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    return res.end(icon.body);
  }

  if (parts[0] === 'api' && parts[1] === 'apps' && parts[2] && req.method === 'PUT') {
    const id = parts[2];
    const body = await readBody(req);
    const source = iconSources.get(id);
    if (!/^[0-9a-f]{12}$/.test(id) || (!store.apps[id] && !source)) return sendJson(res, 404, { error: 'Unknown app' });
    const previous = (store.apps[id] && store.apps[id].override) || {};
    const override = {
      name: clip(body.name, 60),
      description: clip(body.description, 300),
      emoji: String(body.emoji || '').trim().slice(0, 8),
      iconAt: previous.iconAt || 0,
    };
    // icon: a PNG data URL sets a custom image, an empty string removes it, absent leaves it alone.
    if (typeof body.icon === 'string') {
      if (!body.icon) {
        override.iconAt = 0;
        try {
          fs.unlinkSync(customIconFile(id));
        } catch {}
      } else {
        const m = body.icon.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
        const image = m ? Buffer.from(m[1], 'base64') : null;
        if (!image || sniffImage(image) !== 'image/png' || image.length > 400 * 1024) return sendJson(res, 400, { error: 'That image could not be used.' });
        fs.mkdirSync(ICON_DIR, { recursive: true });
        fs.writeFileSync(customIconFile(id), image);
        override.iconAt = Date.now();
      }
      iconCache.delete(id);
    }
    store.apps[id] = { ...store.apps[id], override };
    saveStore();
    scans.clear();
    return sendJson(res, 200, { ok: true });
  }

  if (parts[0] === 'api' && parts[1] === 'apps' && parts[2] && req.method === 'DELETE') {
    // Kept as "hidden" rather than deleted, so the folder scan doesn't bring it straight back.
    store.apps[parts[2]] = { ...store.apps[parts[2]], hidden: true };
    saveStore();
    scans.clear();
    return sendJson(res, 200, { ok: true });
  }

  if (parts[0] === 'api' && parts[1] === 'apps' && parts[2] && parts[3] === 'unhide' && req.method === 'POST') {
    if (store.apps[parts[2]]) store.apps[parts[2]].hidden = false;
    saveStore();
    scans.clear();
    return sendJson(res, 200, { ok: true });
  }

  if (parts[0] === 'api') return sendJson(res, 404, { error: 'Not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function onRequest(req, res) {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message || 'Server error' });
    else res.end();
  });
}

// One port serves everything. With HTTPS on, the first byte of each connection tells a TLS handshake from
// plain HTTP, so an old http:// bookmark is redirected to https:// instead of failing.
const plainServer = http.createServer(onRequest);
const redirectServer = http.createServer((req, res) => {
  res.writeHead(308, { location: `https://${req.headers.host || `localhost:${settings.port}`}${req.url}` });
  res.end();
});
let secureServer = null;
let listener = null;
const sockets = new Set();

function startListener() {
  return new Promise((resolve, reject) => {
    if (settings.https) {
      ensureCertificate();
      secureServer = https.createServer(tlsOptions(), onRequest);
    } else {
      secureServer = null;
    }
    const tcp = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      if (!secureServer) return plainServer.emit('connection', socket);
      socket.once('data', (first) => {
        socket.pause();
        socket.unshift(first);
        (first[0] === 22 ? secureServer : redirectServer).emit('connection', socket);
        process.nextTick(() => socket.resume());
      });
    });
    tcp.once('error', reject);
    tcp.listen(settings.port, settings.lan ? '0.0.0.0' : '127.0.0.1', () => {
      tcp.off('error', reject);
      listener = tcp;
      console.log(`Server Manager is running at ${settings.https ? 'https' : 'http'}://localhost:${settings.port}${settings.lan ? ' and is open to the local network' : ' (this computer only)'}`);
      resolve();
    });
  });
}

function stopListener() {
  return new Promise((resolve) => {
    if (!listener) return resolve();
    listener.close(() => resolve());
    listener = null;
    for (const socket of sockets) socket.destroy();
  });
}

async function applySettings(next) {
  const previous = settings;
  await stopListener();
  settings = next;
  try {
    await startListener();
    saveSettings();
  } catch (e) {
    settings = previous;
    await startListener();
    throw e;
  }
}

// Renewal: checked hourly, so an expiring certificate or a new network address is picked up without a restart.
setInterval(() => {
  if (!settings.https) return;
  try {
    if (ensureCertificate() && secureServer) secureServer.setSecureContext(tlsOptions());
  } catch (e) {
    console.error('Certificate renewal failed:', String(e.stderr || e.message).trim());
  }
}, 3600 * 1000).unref();

startListener().catch((e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${settings.port} is already in use. Is Server Manager already running? To use another port: PORT=1112 node server.js`);
  else console.error(e);
  process.exit(1);
});
