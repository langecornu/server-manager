'use strict';

/* ───────────────────────── Small helpers ───────────────────────── */

const $ = (id) => document.getElementById(id);

// Builds DOM nodes without innerHTML, so text coming from other apps is never parsed as markup.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'icon') el.innerHTML = ICONS[v];
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const svg = (body) => `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  grid: svg('<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>'),
  refresh: svg('<path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 14.3 4.3l1.7-1.8"/><path d="M20 20v-4.5h-4.5"/>'),
  arrow: svg('<path d="M7 17 17 7"/><path d="M9 7h8v8"/>'),
  pencil: svg('<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/>'),
  close: svg('<path d="m6 6 12 12M18 6 6 18"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3.9a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.5 2.5a7.6 7.6 0 0 0-2.6 1.5l-2.3-.9-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-.9a7.6 7.6 0 0 0 2.6 1.5l.5 2.5h4l.5-2.5a7.6 7.6 0 0 0 2.6-1.5l2.3.9 2-3.4z"/>'),
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  eyeOff: svg('<path d="M4 4l16 16"/><path d="M9.5 5.9A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.7M6.3 7.6A16 16 0 0 0 2.5 12S6 18.5 12 18.5c1.5 0 2.8-.4 4-1"/><path d="M9.9 9.9a2.8 2.8 0 0 0 4 4"/>'),
  plug: svg('<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0V8z"/><path d="M12 17v4"/>'),
};

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return 'less than a minute';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const hours = Math.floor(m / 60);
  if (hours < 24) return `${hours}h ${m % 60}m`;
  const d = Math.floor(hours / 24);
  return `${d}d ${hours % 24}h`;
}

function initials(name) {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

const hue = (id) => [...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);

const KIND = { web: 'Web app', api: 'API', tcp: 'Service' };

/* ───────────────────────── State ───────────────────────── */

let scope = 'node';
try {
  if (localStorage.getItem('scope') === 'all') scope = 'all';
} catch {}
let data = null;
let signature = '';
let query = '';
let showHidden = false;

let checkedAt = 0;

async function load(force, fresh) {
  try {
    const params = new URLSearchParams();
    if (scope === 'all') params.set('all', '1');
    if (fresh) params.set('fresh', '1');
    const res = await fetch(`/api/apps?${params}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
    checkedAt = Date.now();
    const next = JSON.stringify([data.apps, data.stopped, scope]);
    if (force || next !== signature) {
      signature = next;
      render();
    }
    setStatus();
  } catch {
    const status = $('status');
    status.className = 'pill bad';
    status.lastElementChild.textContent = 'Server Manager is not responding';
  }
}

function setStatus() {
  const n = data.apps.length;
  const status = $('status');
  status.className = n ? 'pill live' : 'pill';
  status.firstElementChild.className = n ? '' : 'dot';
  status.lastElementChild.textContent = `${n} running`;
  status.title = `Last checked at ${new Date(checkedAt).toLocaleTimeString()}. Checks by itself every few seconds.`;
  const self = data.self;
  $('eyebrow').textContent = `${self.name} · port ${self.port} · ${self.lan ? 'open to the local network' : 'this computer only'} · ${self.https ? 'HTTPS' : 'HTTP'}`;
}

/* ───────────────────────── Rendering ───────────────────────── */

function matches(app) {
  if (!query) return true;
  const hay = [app.name, app.description, app.rootLabel, ...app.ports.flatMap((p) => [String(p.port), p.command, p.title])].join(' ').toLowerCase();
  return query.split(/\s+/).every((word) => hay.includes(word));
}

// When this page is opened from another device, "localhost" would mean that device, so links use the
// name this computer was reached by. Apps that only listen locally can't be opened from there at all.
const REMOTE = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

function hrefFor(p) {
  if (!REMOTE) return p.url;
  if (p.local) return null;
  const u = new URL(p.url);
  if (u.hostname === 'localhost') u.hostname = location.hostname;
  return u.href.replace(/\/$/, '');
}

function art(app) {
  if (app.customIcon) {
    return h('div', { class: 'art has-img has-custom', 'aria-hidden': 'true' }, h('img', { src: `/api/icon/${app.id}?v=${app.customIcon}`, alt: '' }));
  }
  if (app.emoji) return h('div', { class: 'art has-emoji', 'aria-hidden': 'true' }, app.emoji);
  const box = h('div', { class: 'art', style: `--hue:${hue(app.id)}`, 'aria-hidden': 'true' });
  if (!app.icon) {
    box.textContent = initials(app.name);
    return box;
  }
  box.classList.add('has-img');
  box.append(h('img', {
    src: `/api/icon/${app.id}`,
    alt: '',
    onerror: () => {
      box.classList.remove('has-img');
      box.textContent = initials(app.name);
    },
  }));
  return box;
}

function portRow(p, app) {
  const meta = h('span', { class: 'port-meta' },
    h('strong', {}, KIND[p.kind] || 'Service',
      app.running && (p.local
        ? h('span', { class: 'tag', title: 'Only reachable from this computer' }, 'Local only')
        : h('span', { class: 'tag net', title: 'Reachable from other devices on your local network' }, 'Local network')),
      app.running && p.kind !== 'tcp' && (p.scheme === 'https'
        ? h('span', { class: 'tag secure', title: 'Encrypted connection' }, 'HTTPS')
        : h('span', { class: 'tag', title: 'Not encrypted' }, 'HTTP')),
    ),
    p.command && h('small', { title: p.command }, p.command),
  );
  const num = h('span', { class: 'port-num' }, h('small', {}, ':'), String(p.port));
  if (!app.running) {
    const label = p.kind === 'expected' ? 'Usual port' : 'Last port';
    const source = p.kind === 'expected' ? `from ${p.source}` : `${(KIND[p.kind] || 'service').toLowerCase()}, last time it ran`;
    return h('div', { class: 'port plain' }, num, h('span', { class: 'port-meta' },
      h('strong', {}, label, p.usedBy && h('span', { class: 'tag warn', title: `Port ${p.port} is currently used by ${p.usedBy}` }, `in use by ${p.usedBy}`)),
      h('small', {}, source),
    ));
  }
  if (p.kind === 'tcp') return h('div', { class: 'port plain', title: 'Not a web page, nothing to open in a browser' }, num, meta);
  const href = hrefFor(p);
  if (!href) return h('div', { class: 'port plain', title: 'This app only listens on the computer itself, so it cannot be opened from this device' }, num, meta);
  return h('a', { class: `port${p.primary ? ' primary' : ''}`, href, target: '_blank', rel: 'noopener', title: `Open ${href}` },
    num, meta, h('span', { class: 'go' }, 'Open', h('span', { icon: 'arrow' })));
}

function card(app) {
  const oldest = Math.min(...app.ports.map((p) => p.started || Infinity));
  const foot = h('div', { class: 'app-foot' });
  if (app.running && Number.isFinite(oldest)) foot.append(h('span', { class: 'chip up', 'data-started': oldest }, h('i'), h('span', {}, `Up ${ago(Date.now() - oldest)}`)));
  if (!app.running && app.lastSeen) foot.append(h('span', { class: 'chip', 'data-seen': app.lastSeen }, h('span', {}, `Last seen ${ago(Date.now() - app.lastSeen)} ago`)));
  if (!app.running && !app.lastSeen) foot.append(h('span', { class: 'chip' }, 'Not seen running yet'));
  if (!app.running && app.startCommand) foot.append(h('span', { class: 'chip path', title: 'Run this in the project folder to start it' }, h('bdi', {}, app.startCommand)));
  if (app.rootLabel) foot.append(h('span', { class: 'chip path', title: app.root }, h('bdi', {}, app.rootLabel)));
  foot.append(h('span', { class: 'spacer' }));
  if (app.running) {
    const primary = app.ports[0];
    const link = primary.kind !== 'tcp' && hrefFor(primary);
    if (link) foot.append(h('button', { type: 'button', class: 'link-btn', onclick: (e) => copy(e.currentTarget, link) }, 'Copy link'));
  } else if (app.hidden) {
    foot.prepend(h('span', { class: 'chip hid' }, 'Hidden'));
    foot.append(h('button', { type: 'button', class: 'link-btn', title: 'Put it back in the list for good', onclick: () => setHidden(app, false) }, 'Unhide'));
  } else {
    foot.append(h('button', { type: 'button', class: 'link-btn danger', title: 'Hide from this list. It comes back the next time it runs, or use Show hidden at the top.', onclick: () => setHidden(app, true) }, 'Hide'));
  }

  return h('article', { class: `card app${app.running ? '' : ' stopped'}${app.hidden ? ' is-hidden' : ''}` },
    h('div', { class: 'app-top' },
      art(app),
      h('div', { class: 'app-title' },
        h('h2', { title: app.name }, app.name),
        app.description ? h('p', {}, app.description) : h('p', { class: 'none' }, 'No description yet'),
      ),
      h('button', { type: 'button', class: 'icon-btn small edit', icon: 'pencil', 'aria-label': `Edit ${app.name}`, title: 'Edit name, description and icon', onclick: () => openEdit(app) }),
    ),
    h('div', { class: 'ports' }, app.ports.map((p) => portRow(p, app))),
    foot,
  );
}

function emptyState() {
  const filtered = Boolean(query) && data.apps.length > 0;
  return h('div', { class: 'empty-state' },
    h('span', { class: 'empty-ico', icon: filtered ? 'search' : 'plug' }),
    h('div', {},
      h('h3', {}, filtered ? 'No app matches that search' : scope === 'all' ? 'Nothing is listening on a port' : 'No Node apps are running'),
      h('p', {}, filtered ? (data.stopped.some(matches) ? 'Nothing running matches, but see Not running below.' : 'Try a name, a folder or a port number.') : 'Start one of your projects and it shows up here within a few seconds, with its port and a link to open it.'),
    ),
  );
}

function render() {
  const running = data.apps.filter(matches);
  $('apps').replaceChildren(...(running.length ? running.map(card) : [emptyState()]));
  const hiddenCount = data.stopped.filter((a) => a.hidden).length;
  if (!hiddenCount) showHidden = false;
  const toggle = $('hidden-toggle');
  toggle.disabled = hiddenCount === 0;
  toggle.classList.toggle('on', showHidden);
  toggle.setAttribute('aria-pressed', String(showHidden));
  toggle.title = hiddenCount ? (showHidden ? 'Put the hidden apps out of sight again' : 'Show the apps you have hidden') : 'No app is hidden';
  $('hidden-icon').innerHTML = showHidden ? ICONS.eyeOff : ICONS.eye;
  $('hidden-label').textContent = showHidden ? 'Hide again' : hiddenCount ? `Show hidden (${hiddenCount})` : 'Show hidden';
  const stopped = data.stopped.filter((a) => (showHidden || !a.hidden) && matches(a));
  $('stopped-section').hidden = stopped.length === 0;
  $('stopped-count').textContent = String(stopped.length);
  $('stopped-note').textContent = data.scanDirs.length ? `Node apps found in ${data.scanDirs.join(', ')}` : 'Apps seen running before';
  $('stopped').replaceChildren(...stopped.map(card));
  for (const b of document.querySelectorAll('.seg button')) b.classList.toggle('on', b.dataset.scope === scope);
}

function tickClocks() {
  for (const el of document.querySelectorAll('[data-started]')) el.lastElementChild.textContent = `Up ${ago(Date.now() - Number(el.dataset.started))}`;
  for (const el of document.querySelectorAll('[data-seen]')) el.lastElementChild.textContent = `Last seen ${ago(Date.now() - Number(el.dataset.seen))} ago`;
}

/* ───────────────────────── Actions ───────────────────────── */

async function copy(button, text) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = text;
  }
  setTimeout(() => { button.textContent = 'Copy link'; }, 1600);
}

async function setHidden(app, hidden) {
  await fetch(hidden ? `/api/apps/${app.id}` : `/api/apps/${app.id}/unhide`, { method: hidden ? 'DELETE' : 'POST' });
  load(true);
}

let editing = null;

function openEdit(app) {
  editing = app;
  const custom = (value, auto) => (app.custom && value !== auto ? value : '');
  $('edit-path').textContent = app.rootLabel || app.ports.map((p) => `port ${p.port}`).join(', ');
  $('edit-name').value = custom(app.name, app.auto.name);
  $('edit-name').placeholder = app.auto.name;
  $('edit-description').value = custom(app.description, app.auto.description);
  $('edit-description').placeholder = app.auto.description || 'What is this app for?';
  $('edit-emoji').value = app.customIcon ? '' : app.emoji;
  pendingIcon = undefined;
  $('edit-error').hidden = true;
  previewIcon();
  $('edit').showModal();
  $('edit-name').focus();
}

// undefined: leave the image as it is. '': remove it. Otherwise a PNG data URL to save.
let pendingIcon;

function previewIcon() {
  const box = $('edit-preview');
  const emoji = $('edit-emoji').value.trim();
  const image = pendingIcon || (pendingIcon === undefined && editing.customIcon ? `/api/icon/${editing.id}?v=${editing.customIcon}` : '');
  box.className = 'art';
  box.style.setProperty('--hue', hue(editing.id));
  if (image) {
    box.classList.add('has-img', 'has-custom');
    box.replaceChildren(h('img', { src: image, alt: '' }));
  } else if (emoji) {
    box.classList.add('has-emoji');
    box.textContent = emoji;
  } else if (editing.icon && !editing.customIcon) {
    box.classList.add('has-img');
    box.replaceChildren(h('img', { src: `/api/icon/${editing.id}`, alt: '' }));
  } else {
    box.textContent = initials($('edit-name').value || editing.auto.name);
  }
}

// Shrinks any picture to a 128px square PNG in the browser, so only a small, safe image is stored.
function toIcon(file) {
  return new Promise((resolve, reject) => {
    const src = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const size = 128;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const scale = Math.max(size / (img.naturalWidth || size), size / (img.naturalHeight || size));
      const w = (img.naturalWidth || size) * scale;
      const hgt = (img.naturalHeight || size) * scale;
      canvas.getContext('2d').drawImage(img, (size - w) / 2, (size - hgt) / 2, w, hgt);
      URL.revokeObjectURL(src);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(src);
      reject(new Error('That file is not an image this browser can read.'));
    };
    img.src = src;
  });
}

async function saveEdit(values) {
  if (!editing) return;
  const res = await fetch(`/api/apps/${editing.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    $('edit-error').textContent = body.error || 'Could not save.';
    $('edit-error').hidden = false;
    return;
  }
  $('edit').close();
  load(true);
}

/* ───────────────────────── Settings ───────────────────────── */

let draftLan = false;

function fillSettings() {
  const self = data.self;
  const https = $('set-https').checked;
  const port = Number($('set-port').value) || self.port;
  for (const b of document.querySelectorAll('#set-lan button')) b.classList.toggle('on', (b.dataset.lan === '1') === draftLan);
  $('set-lan-note').textContent = draftLan
    ? 'Anyone on your network can open this page, with no login. Apps marked "Local only" still cannot be opened from other devices.'
    : 'Only browsers on this computer can open this page.';
  const scheme = https ? 'https' : 'http';
  const hosts = draftLan ? ['localhost', ...self.networkHosts] : ['localhost'];
  $('set-urls').replaceChildren(...hosts.map((hst) => h('li', {}, h('span', {}, `${scheme}://${hst}:${port}`))));
  const cert = $('set-cert');
  cert.hidden = !https;
  if (https) {
    cert.replaceChildren(
      self.https && self.certExpires
        ? `Certificate valid until ${new Date(self.certExpires).toLocaleDateString()}, replaced automatically a month before. `
        : 'A certificate is created when you save. ',
      ...(self.https ? ['To remove the browser warning for good, ', h('a', { href: '/ca.crt' }, 'download the certificate authority'), ' and trust it on each device.'] : []),
    );
  }
}

function openSettings() {
  if (!data) return;
  const self = data.self;
  draftLan = self.lan;
  $('set-port').value = self.port;
  $('set-https').checked = self.https;
  $('set-error').hidden = true;
  $('set-locked').hidden = self.canConfigure;
  for (const el of [$('set-port'), $('set-https'), $('settings-save'), ...document.querySelectorAll('#set-lan button')]) el.disabled = !self.canConfigure;
  $('settings-save').textContent = 'Save and restart';
  fillSettings();
  $('settings').showModal();
}

async function saveSettings() {
  const next = { port: Number($('set-port').value), lan: draftLan, https: $('set-https').checked };
  const error = $('set-error');
  error.hidden = true;
  const self = data.self;
  if (next.port === self.port && next.lan === self.lan && next.https === self.https) return $('settings').close();
  $('settings-save').disabled = true;
  $('settings-save').textContent = 'Restarting…';
  try {
    const res = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Could not save the settings.');
    // If network access was just turned off, only "localhost" still works.
    const host = next.lan ? location.hostname : 'localhost';
    setTimeout(() => { location.href = `${next.https ? 'https' : 'http'}://${host}:${next.port}/`; }, 1500);
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
    $('settings-save').disabled = false;
    $('settings-save').textContent = 'Save and restart';
  }
}

/* ───────────────────────── Wiring ───────────────────────── */

$('logo').innerHTML = ICONS.grid;
$('refresh-icon').innerHTML = ICONS.refresh;
$('search-icon').innerHTML = ICONS.search;
$('edit-close').innerHTML = ICONS.close;
$('apps').replaceChildren(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));

for (const b of document.querySelectorAll('.seg button')) {
  b.classList.toggle('on', b.dataset.scope === scope);
  b.addEventListener('click', () => {
    scope = b.dataset.scope;
    try {
      localStorage.setItem('scope', scope);
    } catch {}
    for (const other of document.querySelectorAll('.seg button')) other.classList.toggle('on', other === b);
    load(true);
  });
}

$('hidden-toggle').addEventListener('click', () => {
  showHidden = !showHidden;
  if (data) render();
  if (showHidden) $('stopped-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('refresh').addEventListener('click', async () => {
  const btn = $('refresh');
  const before = data ? data.apps.length : null;
  btn.disabled = true;
  btn.classList.add('spin');
  $('refresh-label').textContent = 'Checking…';
  await load(true, true);
  btn.classList.remove('spin');
  btn.disabled = false;
  const diff = before === null || !data ? 0 : data.apps.length - before;
  $('refresh-label').textContent = diff > 0 ? `${diff} new` : diff < 0 ? `${-diff} stopped` : 'Up to date';
  setTimeout(() => { $('refresh-label').textContent = 'Refresh'; }, 2000);
});

$('search').addEventListener('input', (e) => {
  query = e.target.value.trim().toLowerCase();
  if (data) render();
});

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (e.key === '/' && !typing && !$('edit').open && !$('settings').open) {
    e.preventDefault();
    $('search').focus();
  } else if (e.key === 'Escape' && document.activeElement === $('search')) {
    $('search').value = '';
    query = '';
    $('search').blur();
    if (data) render();
  }
});

$('edit-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const values = { name: $('edit-name').value, description: $('edit-description').value, emoji: $('edit-emoji').value };
  if (pendingIcon !== undefined) values.icon = pendingIcon;
  saveEdit(values);
});
$('edit-reset').addEventListener('click', () => saveEdit({ name: '', description: '', emoji: '', icon: '' }));
$('edit-upload').addEventListener('click', () => $('edit-file').click());
$('edit-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    pendingIcon = await toIcon(file);
    $('edit-emoji').value = '';
    $('edit-error').hidden = true;
  } catch (err) {
    $('edit-error').textContent = err.message;
    $('edit-error').hidden = false;
  }
  previewIcon();
});
$('edit-emoji').addEventListener('input', () => {
  if ($('edit-emoji').value.trim()) pendingIcon = '';
  previewIcon();
});
$('edit-icon-clear').addEventListener('click', () => {
  pendingIcon = '';
  $('edit-emoji').value = '';
  previewIcon();
});

$('settings-btn').innerHTML = ICONS.gear;
$('settings-close').innerHTML = ICONS.close;
$('settings-btn').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', () => $('settings').close());
$('settings-cancel').addEventListener('click', () => $('settings').close());
$('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  saveSettings();
});
$('set-https').addEventListener('change', fillSettings);
$('set-port').addEventListener('input', fillSettings);
for (const b of document.querySelectorAll('#set-lan button')) {
  b.addEventListener('click', () => {
    draftLan = b.dataset.lan === '1';
    fillSettings();
  });
}
$('edit-cancel').addEventListener('click', () => $('edit').close());
$('edit-close').addEventListener('click', () => $('edit').close());

load(true);
setInterval(() => { if (!document.hidden) load(false); }, 4000);
setInterval(tickClocks, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(false); });
