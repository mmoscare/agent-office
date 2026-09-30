import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson, stagePaths, type Applied } from '../src/server/app-swap.js';

// The Windows launcher's side of the guided update (personal/windows): host.mjs switches a staged
// build in before the office loads, exits 75 when the office asks to be restarted and 76 when a new
// build didn't start (putting the previous one back on the next start); Launcher.cs starts it again
// on those two. The "office" here is a stand-in cli.js, so no real office starts.

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'office launcher test ';

function git(dir: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

/** A stand-in build: its cli.js says which build it is, and restarts itself when asked to. */
function build(dist: string, name: string, broken = false) {
  mkdirSync(path.join(dist, 'server', 'server'), { recursive: true });
  mkdirSync(path.join(dist, 'public'), { recursive: true });
  writeFileSync(path.join(dist, 'public', 'index.html'), name);
  writeFileSync(path.join(dist, 'server', 'server', 'server.js'), '');
  writeFileSync(path.join(dist, 'server', 'server', 'app-swap.js'), `export * from ${JSON.stringify(pathToFileURL(path.join(codeDir, 'src', 'server', 'app-swap.ts')).href)};\n`);
  writeFileSync(
    path.join(dist, 'server', 'server', 'cli.js'),
    broken
      ? 'throw new Error("this build is broken");\n'
      : `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 20));
process.on('SIGINT', () => setTimeout(() => process.exit(0), 20));
console.log('office up: ${name}');
if (process.env.ASK_RESTART) setTimeout(() => globalThis[Symbol.for('agent-office.launcher')].restart(), 200);
`,
  );
}

function host(app: string, env: Record<string, string> = {}, stdin?: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(codeDir, 'personal', 'windows', 'host.mjs'), app, app, '4999'], { cwd: codeDir, windowsHide: true, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`host.mjs didn't exit: ${out}`));
    }, 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    if (stdin) setTimeout(() => child.stdin.write(stdin), 1500);
  });
}

test('host.mjs: switches a staged build in, restarts on request, and puts the previous build back when a new one fails to start', async (t) => {
  const app = mkdtempSync(path.join(tmpdir(), PREFIX));
  t.after(() => {
    const resolved = realpathSync(app);
    assert.ok(path.basename(resolved).startsWith(PREFIX));
    rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  execFileSync('git', ['init', '-q', '-b', 'personal', app]);
  git(app, 'config', 'user.name', 'Launcher Test');
  git(app, 'config', 'user.email', 'launcher-test@example.invalid');
  git(app, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(app, '.gitignore'), 'dist\n.agent-office\n');
  git(app, 'add', '.');
  git(app, 'commit', '-qm', 'Initial');
  const head = git(app, 'rev-parse', 'HEAD');
  const p = stagePaths(app);
  const stage = (name: string, broken = false) => {
    build(path.join(p.next, 'dist'), name, broken);
    writeFileSync(p.ready, JSON.stringify({ commit: head, builtAt: Date.now(), packages: false }));
  };
  const running = () => readFileSync(path.join(app, 'dist', 'public', 'index.html'), 'utf8');
  build(path.join(app, 'dist'), 'old');

  // A good new build: switched in, started, and the office's restart request exits 75.
  stage('new');
  let r = await host(app, { ASK_RESTART: '1' });
  assert.match(r.out, /Switched to the new build/);
  assert.match(r.out, /office up: new/);
  assert.equal(r.code, 75, r.out);
  assert.equal(running(), 'new');
  assert.equal(readJson<Applied>(p.applied)?.confirmed, true);

  // A broken one: it doesn't start, so host.mjs exits 76 for the launcher to start the previous one.
  stage('broken', true);
  r = await host(app);
  assert.equal(r.code, 76, r.out);
  assert.match(r.out, /this build is broken/);
  assert.equal(running(), 'broken');

  // The next start puts the previous build back before anything loads.
  r = await host(app, { ASK_RESTART: '1' });
  assert.match(r.out, /went back to the previous one/);
  assert.match(r.out, /office up: new/);
  assert.equal(r.code, 75, r.out);
  assert.equal(running(), 'new');
  assert.equal(readJson<Applied>(p.applied)?.state, 'rolled-back');

  // An ordinary stop from the tray menu is still a plain exit.
  r = await host(app, {}, 'stop\n');
  assert.equal(r.code, 0, r.out);
});

test('Launcher.cs compiles, and starts the office again only on host.mjs’s restart and rollback exit codes', { skip: process.platform !== 'win32' }, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), PREFIX));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const harness = path.join(dir, 'Check.cs');
  writeFileSync(harness, 'public static class LauncherCheck { public static void Main() { foreach (int c in new[] { 0, 1, 75, 76 }) System.Console.WriteLine(c + "=" + OfficeContext.StartsAgain(c)); } }\n');
  const exe = path.join(dir, 'check.exe');
  const script = `$ErrorActionPreference = 'Stop'
$p = New-Object System.CodeDom.Compiler.CompilerParameters
$p.GenerateExecutable = $true; $p.OutputAssembly = '${exe.replace(/'/g, "''")}'; $p.CompilerOptions = '/target:exe /main:LauncherCheck'
foreach ($a in @('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Security.dll','System.Web.Extensions.dll')) { $null = $p.ReferencedAssemblies.Add($a) }
$prov = New-Object Microsoft.CSharp.CSharpCodeProvider
[string[]]$files = @('${path.join(codeDir, 'personal', 'windows', 'Launcher.cs').replace(/'/g, "''")}', '${harness.replace(/'/g, "''")}')
$r = $prov.CompileAssemblyFromFile($p, $files)
if ($r.Errors.HasErrors) { throw (($r.Errors | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine) }`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const out = execFileSync(exe, { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
  assert.deepEqual(out, ['0=False', '1=False', '75=True', '76=True']);
});
