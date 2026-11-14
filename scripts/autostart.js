'use strict';

// Starts Server Manager automatically when you log in to this Mac (a launchd "LaunchAgent").
//   node scripts/autostart.js install   start at login, and start it right now
//   node scripts/autostart.js remove    stop it and no longer start at login
//   node scripts/autostart.js status    say whether it is installed and running

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LABEL = 'local.server-manager';
const ROOT = path.join(__dirname, '..');
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(ROOT, 'data', 'server.log');
const DOMAIN = `gui/${process.getuid()}`;

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function launchctl(args, quiet) {
  try {
    return execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (!quiet) throw new Error(String(e.stderr || e.message).trim());
    return '';
  }
}

function install() {
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(path.join(ROOT, 'server.js'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`);
  launchctl(['bootout', `${DOMAIN}/${LABEL}`], true);
  launchctl(['bootstrap', DOMAIN, PLIST]);
  console.log(`Server Manager now starts at login and is starting now.\n  Agent: ${PLIST}\n  Log:   ${LOG}`);
}

function remove() {
  launchctl(['bootout', `${DOMAIN}/${LABEL}`], true);
  fs.rmSync(PLIST, { force: true });
  console.log('Server Manager is stopped and no longer starts at login.');
}

function status() {
  const out = launchctl(['print', `${DOMAIN}/${LABEL}`], true);
  if (!out) return console.log(fs.existsSync(PLIST) ? 'Installed, but not loaded.' : 'Not installed.');
  const state = (out.match(/^\s*state = (.+)$/m) || [])[1] || 'unknown';
  const pid = (out.match(/^\s*pid = (\d+)$/m) || [])[1];
  console.log(`Installed. State: ${state}${pid ? `, process ${pid}` : ''}.`);
}

const action = { install, remove, status }[process.argv[2]];
if (!action) {
  console.log('Usage: node scripts/autostart.js install | remove | status');
  process.exit(1);
}
try {
  action();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
