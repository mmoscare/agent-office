#!/usr/bin/env node
// Installs the Mac launcher: the Mac's version of personal/windows/Install-Launcher.ps1.
//
//   node personal/mac/install-launcher.mjs [--office <dir>] [--port <n>] [--branch <name>] [--apps <dir>]
//
// Writes three things, and changes nothing else on the Mac:
//   - ~/Library/Application Support/Agent Office/settings.json: this checkout, the office folder
//     (default ~/Documents/Development/Personal-Portfolio), the port (4600) and the branch (personal);
//   - "Agent Office.command" next to it, the server window Terminal runs (launcher.mjs);
//   - ~/Applications/Agent Office.app, for the Dock, Launchpad and Spotlight, with the Windows
//     launcher's icon. It opens the office in Chrome when it's running and starts it otherwise.
// Run it again after moving the checkout, or to change the office folder or port. The launcher's
// own code stays in this checkout, so an office update brings it along without a reinstall.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORT_DIR } from './launcher.mjs';

export const BUNDLE_ID = 'local.agent-office.launcher';
const here = path.dirname(fileURLToPath(import.meta.url));

/** A word for a shell script, whatever is in it. */
export function sh(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** node as found on PATH (Homebrew's /opt/homebrew/bin/node survives `brew upgrade`), else this one. */
export function nodePath(env = process.env) {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    const file = dir && path.join(dir, 'node');
    if (file && existsSync(file)) return file;
  }
  return process.execPath;
}

export function infoPlist() {
  const keys = {
    CFBundleName: 'Agent Office',
    CFBundleDisplayName: 'Agent Office',
    CFBundleIdentifier: BUNDLE_ID,
    CFBundleExecutable: 'Agent Office',
    CFBundleIconFile: 'AppIcon',
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: '1.0',
    CFBundleVersion: '1',
    LSMinimumSystemVersion: '11.0',
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${Object.entries(keys).map(([k, v]) => `  <key>${k}</key><string>${xml(v)}</string>`).join('\n')}
</dict>
</plist>
`;
}

/** What the app runs when it's opened: Chrome when the office is up or starting, else its window. */
export function appScript({ supportDir, port }) {
  return `#!/bin/bash
# Agent Office.app, made by personal/mac/install-launcher.mjs. Opens the office in Chrome when it's
# running (or a launcher is starting it), and otherwise starts it in a Terminal window. A saved pid
# counts only while it runs launcher.mjs: the kernel gives a dead launcher's pid out again.
SUPPORT=${sh(supportDir)}
URL=${sh(`http://localhost:${port}`)}
running() {
  curl -fsS -m 1 ${sh(`http://127.0.0.1:${port}/api/health`)} 2>/dev/null | grep -Eq '"ok" *: *true' && return 0
  pid=$(cat "$SUPPORT/launcher.pid" 2>/dev/null) && [ -n "$pid" ] && ps -p "$pid" -o command= 2>/dev/null | grep -Eq '(^|[ /])launcher\\.mjs( |$)'
}
if running; then
  open -a 'Google Chrome' "$URL" 2>/dev/null || open "$URL"
else
  open -a Terminal "$SUPPORT/Agent Office.command"
fi
`;
}

/** The server window: Terminal runs it in a login shell, so the office and its workers get your PATH. */
export function commandScript({ codeDir, node }) {
  return `#!/bin/zsh
# Agent Office's server window (personal/mac/launcher.mjs), made by install-launcher.mjs.
# Close this window or press Ctrl+C to stop the office.
cd ${sh(codeDir)} || exit 1
NODE="$(command -v node)"
[ -n "$NODE" ] || NODE=${sh(node)}
exec "$NODE" personal/mac/launcher.mjs
`;
}

/** AppIcon.icns from the Windows launcher's 256px picture, with macOS's own sips and iconutil. */
function makeIcon(png, icns) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-office-icon-'));
  try {
    const set = path.join(tmp, 'AppIcon.iconset');
    mkdirSync(set);
    for (const [name, size] of [['16x16', 16], ['16x16@2x', 32], ['32x32', 32], ['32x32@2x', 64], ['128x128', 128], ['128x128@2x', 256], ['256x256', 256]]) {
      execFileSync('sips', ['-z', String(size), String(size), png, '--out', path.join(set, `icon_${name}.png`)], { stdio: 'ignore' });
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', icns], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function install({
  codeDir = path.resolve(here, '..', '..'),
  officeDir = path.join(os.homedir(), 'Documents', 'Development', 'Personal-Portfolio'),
  port = 4600, branch = 'personal',
  appsDir = path.join(os.homedir(), 'Applications'),
  supportDir = SUPPORT_DIR,
  node = nodePath(),
  icon = process.platform === 'darwin',
} = {}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('--port needs a number from 1 to 65535');
  officeDir = path.resolve(officeDir);
  if (!existsSync(officeDir)) throw new Error(`The office folder ${officeDir} doesn't exist yet. Import the building first, or pass --office <folder>.`);
  const app = path.join(appsDir, 'Agent Office.app');
  const plist = path.join(app, 'Contents', 'Info.plist');
  // Only ever replaces an Agent Office.app this installer made.
  if (existsSync(app) && !(existsSync(plist) && readFileSync(plist, 'utf8').includes(`<string>${BUNDLE_ID}</string>`))) {
    throw new Error(`${app} is there already and isn't this launcher. Move it aside, or pass --apps <folder>.`);
  }

  mkdirSync(supportDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(supportDir, 'settings.json'), JSON.stringify({ codeDir, officeDir, port, branch }, null, 2) + '\n');
  const command = path.join(supportDir, 'Agent Office.command');
  writeFileSync(command, commandScript({ codeDir, node }));
  chmodSync(command, 0o755);

  mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(plist, infoPlist());
  const exe = path.join(app, 'Contents', 'MacOS', 'Agent Office');
  writeFileSync(exe, appScript({ supportDir, port }));
  chmodSync(exe, 0o755);
  const iconMade = icon && makeIcon(path.join(codeDir, 'personal', 'windows', 'Agent Office.png'), path.join(app, 'Contents', 'Resources', 'AppIcon.icns'));
  return { app, command, settings: path.join(supportDir, 'settings.json'), icon: !!iconMade };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--office') opts.officeDir = value();
    else if (a === '--port') opts.port = Number(value());
    else if (a === '--branch') opts.branch = value();
    else if (a === '--apps') opts.appsDir = path.resolve(value());
    else throw new Error(`unknown option ${a}\nusage: node personal/mac/install-launcher.mjs [--office <dir>] [--port <n>] [--branch <name>] [--apps <dir>]`);
  }
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'darwin') console.log('(Not a Mac: the app is written, but it only runs on macOS.)');
  const done = install(parseArgs(argv));
  console.log(`Installed ${done.app}${done.icon ? '' : ' (without its icon)'}`);
  console.log(`Settings: ${done.settings}`);
  console.log('Open it from Launchpad or Spotlight ("Agent Office"). To keep it in the Dock, drag it there from the Finder window that just opened.');
  if (process.platform === 'darwin') {
    try { execFileSync('touch', [done.app]); execFileSync('open', ['-R', done.app], { stdio: 'ignore' }); } catch { /* the Finder window is a courtesy */ }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exit(main()); } catch (err) { console.error(`install-launcher: ${err.message}`); process.exit(1); }
}
