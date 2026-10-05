import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import headless from '@xterm/headless';
import { ConsoleShells, consoleShellLaunch, POWERSHELL_CWD_PROMPT, reportedCwd } from '../src/server/console-shell.js';
import type { ServerMsg } from '../src/shared/protocol.js';

test('standalone shell uses PowerShell with profiles on Windows, told to say where it is, and preserves Unix shells', () => {
  const args = ['-NoLogo', '-NoExit', '-Command', POWERSHELL_CWD_PROMPT];
  assert.deepEqual(consoleShellLaunch('win32', { SystemRoot: 'D:\\Windows', SHELL: '/bin/bash' }, () => false), {
    file: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args,
  });
  const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  assert.deepEqual(consoleShellLaunch('win32', { Path: 'C:\\other;"C:\\Program Files\\PowerShell\\7"' }, f => f === pwsh), { file: pwsh, args });
  assert.ok(!POWERSHELL_CWD_PROMPT.includes('"'), 'no double quotes: it travels on the command line');
  assert.match(POWERSHELL_CWD_PROMPT, /\$function:prompt/, 'it wraps the prompt the profile left');
  assert.deepEqual(consoleShellLaunch('linux', { SHELL: '/bin/zsh' }), { file: '/bin/zsh', args: ['-l'] });
  assert.deepEqual(consoleShellLaunch('darwin', {}), { file: '/bin/bash', args: ['-l'] });
});

test('where a shell says it is: OSC 7 and OSC 9;9 from its prompt, split across chunks or not', () => {
  const esc = '\x1b';
  assert.deepEqual(reportedCwd(`${esc}]7;file:///C:/Users/Owner/x%20y${'\x07'}PS C:\\Users\\Owner\\x y> `, '', 'win32'), { cwd: 'C:\\Users\\Owner\\x y', tail: '' });
  assert.deepEqual(reportedCwd(`${esc}]7;file://localhost/home/me/a%20b${esc}\\$ `, '', 'linux'), { cwd: '/home/me/a b', tail: '' });
  assert.deepEqual(reportedCwd(`${esc}]9;9;"C:\\Users\\Owner"${'\x07'}`, '', 'win32').cwd, 'C:\\Users\\Owner');
  // The last one in a chunk wins; colour codes after it are carried for the next chunk, which may complete a split sequence.
  const first = reportedCwd(`${esc}]7;file:///C:/one${'\x07'}${esc}]7;file:///C:/two${'\x07'}${esc}[m${esc}]7;file:///C:/Us`, '', 'win32');
  assert.equal(first.cwd, 'C:\\two');
  assert.equal(first.tail, `${esc}]7;file:///C:/Us`);
  const second = reportedCwd(`ers/Owner${'\x07'}> `, first.tail, 'win32');
  assert.deepEqual(second, { cwd: 'C:\\Users\\Owner', tail: '' });
  assert.deepEqual(reportedCwd('plain output\n', 'stale tail', 'linux'), { cwd: undefined, tail: '' });
  assert.equal(reportedCwd(`${esc}]7;file:///C:/bad%ZZ${'\x07'}`, '', 'win32').cwd, undefined, 'a path that is no URI is ignored');
});

test('standalone shells navigate outside the floor, keep their directory on reopen, follow a floor change, and isolate clients', async t => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'office-console-test-')));
  const floor = path.join(root, 'floor');
  const other = path.join(root, 'folder with spaces');
  mkdirSync(floor);
  mkdirSync(other);
  const messages: { id: string; msg: ServerMsg }[] = [];
  const output = new Map<string, string>();
  const terminals = new Map<string, InstanceType<typeof headless.Terminal>>();
  const shells = new ConsoleShells((id, msg) => {
    messages.push({ id, msg });
    if (msg.t === 'console.data') {
      output.set(id, (output.get(id) ?? '') + msg.data);
      terminals.get(id)?.write(msg.data);
    }
  });
  t.after(() => {
    shells.shutdown();
    for (const term of terminals.values()) term.dispose();
    assert.equal(path.dirname(root), realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('office-console-test-'));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const attach = (id: string, cwd = floor, fresh = false) => {
    if (!terminals.has(id)) {
      const term = new headless.Terminal({ cols: 120, rows: 30 });
      // Like the browser, answer PowerShell's cursor-position and other terminal queries.
      term.onData(data => shells.handle(id, { t: 'console.input', data }, floor));
      terminals.set(id, term);
    }
    shells.handle(id, { t: 'console.attach', cols: 120, rows: 30, fresh }, cwd);
  };
  const write = (id: string, data: string) => shells.handle(id, { t: 'console.input', data: data + '\r' }, floor);
  const until = async (pred: () => boolean) => {
    const deadline = Date.now() + 20000;
    while (!pred()) {
      assert.ok(Date.now() < deadline, 'timed out waiting for shell output');
      await new Promise(r => setTimeout(r, 50));
    }
  };
  const win = process.platform === 'win32';
  const marker = win ? "Write-Output ('HELLO_' + 'SHELL')" : "printf 'HELLO_%s\\n' SHELL";
  attach('alice');
  write('alice', marker);
  await until(() => (output.get('alice') ?? '').includes('HELLO_SHELL'));
  // Go up outside the floor, then enter a sibling whose path needs quoting.
  write('alice', win ? "cd ..; cd 'folder with spaces'; $global:officeConsoleValue = 'ALICE_ONLY'; Write-Output ('PATH_' + (Get-Location).Path)" : "cd ..; cd 'folder with spaces'; officeConsoleValue=ALICE_ONLY; printf 'PATH_%s\\n' \"$PWD\"");
  await until(() => (output.get('alice') ?? '').includes('PATH_' + other));
  // CleanBot asks where the terminals are: the folder alice's shell moved into (its prompt says so on
  // Windows; /proc or lsof say elsewhere) and the one it started in are both protected.
  const folders = async () => (await shells.folders()).map(f => path.resolve(f));
  await (async () => {
    const deadline = Date.now() + 20000;
    while (!(await folders()).includes(other)) {
      assert.ok(Date.now() < deadline, `timed out waiting for the shell's folder: ${JSON.stringify(await folders())}`);
      await new Promise(r => setTimeout(r, 100));
    }
  })();
  assert.ok((await folders()).includes(floor), 'where it started stays protected too');
  shells.handle('alice', { t: 'console.detach' }, floor);
  attach('alice');
  output.set('alice', '');
  write('alice', win ? "Write-Output ('AGAIN_' + (Get-Location).Path + $officeConsoleValue)" : "printf 'AGAIN_%s%s\\n' \"$PWD\" \"$officeConsoleValue\"");
  await until(() => (output.get('alice') ?? '').includes('AGAIN_' + other + 'ALICE_ONLY'));
  attach('alice', root);
  output.set('alice', '');
  write('alice', win ? "Write-Output ('FLOOR_' + (Get-Location).Path + '_' + [string]::IsNullOrEmpty($officeConsoleValue))" : "printf 'FLOOR_%s_%s\\n' \"$PWD\" \"$officeConsoleValue\"");
  await until(() => (output.get('alice') ?? '').includes('FLOOR_' + root + '_'));
  assert.ok(!(output.get('alice') ?? '').includes('ALICE_ONLY'));
  attach('bob');
  write('bob', marker);
  await until(() => (output.get('bob') ?? '').includes('HELLO_SHELL'));
  assert.ok(!(output.get('bob') ?? '').includes('ALICE_ONLY'));
  const count = messages.length;
  shells.handle('bob', { t: 'console.resize', cols: NaN, rows: Infinity }, floor);
  shells.resync('bob');
  assert.ok(messages.slice(count).some(({ id, msg }) => id === 'bob' && msg.t === 'console.snapshot' && msg.cols === 80 && msg.rows === 24));
  write('bob', 'exit');
  await until(() => messages.some(({ id, msg }) => id === 'bob' && msg.t === 'console.exited'));
  attach('alice', floor, true);
  output.set('alice', '');
  write('alice', win ? "Write-Output ('FRESH_' + (Get-Location).Path)" : "printf 'FRESH_%s\\n' \"$PWD\"");
  await until(() => (output.get('alice') ?? '').includes('FRESH_' + floor));
  assert.ok(!(output.get('alice') ?? '').includes('ALICE_ONLY'));
  shells.close('alice');
  const closedCount = messages.length;
  shells.resync('alice');
  write('alice', marker);
  assert.equal(messages.length, closedCount);
  attach('missing', path.join(root, 'missing'));
  assert.ok(messages.some(({ id, msg }) => id === 'missing' && msg.t === 'console.error'));
  attach('missing', floor);
  assert.ok(messages.some(({ id, msg }) => id === 'missing' && msg.t === 'console.snapshot'));
  write('missing', marker);
  await until(() => (output.get('missing') ?? '').includes('HELLO_SHELL'));
});


test('a failed cwd probe keeps worktrees protected even after detaching', async t => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'office-console-test-')));
  const shells = new ConsoleShells(() => {}, async () => undefined);
  t.after(() => { shells.shutdown(); rmSync(root, { recursive: true, force: true }); });
  assert.equal((await shells.locations()).unlocated, false);
  shells.handle('probe', { t: 'console.attach', cols: 80, rows: 24 }, root);
  // Windows may report its prompt: a command invalidates that cached location.
  shells.handle('probe', { t: 'console.input', data: '\r' }, root);
  shells.handle('probe', { t: 'console.detach' }, root);
  assert.equal((await shells.locations()).unlocated, true);
  // The next prompt arrives with the view still closed: it locates the shell again.
  const inside = path.join(root, 'inside');
  shells.observe('probe', `\x1b]7;file://host${process.platform === 'win32' ? '/' : ''}${inside.split(path.sep).join('/')}\x07> `);
  const located = await shells.locations();
  assert.equal(located.unlocated, false);
  assert.ok(located.folders.includes(inside));
  shells.close('probe');
  assert.equal((await shells.locations()).unlocated, false);
});
