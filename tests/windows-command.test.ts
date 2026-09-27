import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commandLaunch, resolveWindowsCommand } from '../src/server/windows-command.js';

const windows = { skip: process.platform !== 'win32' };

function fixture(run: (dir: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office npm launch '));
  try { run(dir); }
  finally {
    for (const file of readdirSync(dir)) unlinkSync(path.join(dir, file));
    rmdirSync(dir);
  }
}

test('Windows npm command lookup prefers the .cmd shim over the POSIX script', windows, () => fixture((dir) => {
  writeFileSync(path.join(dir, 'agent'), '#!/bin/sh\n');
  writeFileSync(path.join(dir, 'agent.cmd'), '@ECHO off\n');
  const before = process.env.PATH;
  process.env.PATH = dir;
  try {
    assert.equal(resolveWindowsCommand('agent'), path.join(dir, 'agent.cmd'));
  } finally {
    if (before === undefined) delete process.env.PATH;
    else process.env.PATH = before;
  }
}));

test('npm Node launchers preserve prompts literally, including shell metacharacters', windows, () => fixture((dir) => {
  const script = path.join(dir, 'echo args.cjs');
  const shim = path.join(dir, 'agent.cmd');
  writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  writeFileSync(shim, '@ECHO off\r\nSET dp0=%~dp0\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\echo args.cjs" %*\r\n');
  const args = ['a task with spaces', '"quoted" & echo injected | more ^', '%PATH%', 'first\nsecond', ''];
  const launch = commandLaunch(shim, args);
  assert.equal(launch.file, process.execPath);
  assert.deepEqual(JSON.parse(execFileSync(launch.file, launch.args, { encoding: 'utf8' })), args);
}));

test('npm native launchers use their executable directly', windows, () => fixture((dir) => {
  const exe = path.join(dir, 'native agent.exe');
  const shim = path.join(dir, 'agent.cmd');
  copyFileSync(process.execPath, exe);
  writeFileSync(shim, '@ECHO off\r\nSET dp0=%~dp0\r\n"%dp0%\\native agent.exe"   %*\r\n');
  const args = ['--version'];
  const launch = commandLaunch(shim, args);
  assert.deepEqual(launch, { file: exe, args });
  assert.equal(execFileSync(launch.file, launch.args, { encoding: 'utf8' }).trim(), process.version);
}));

test('unrecognized or broken Windows shims fail clearly', windows, () => fixture((dir) => {
  const shim = path.join(dir, 'agent.cmd');
  writeFileSync(shim, '@ECHO off\r\necho custom behavior\r\n');
  assert.throws(() => commandLaunch(shim, []), /not a supported npm launcher/);
  writeFileSync(shim, '@ECHO off\r\nSET dp0=%~dp0\r\n"%dp0%\\missing.exe" %*\r\n');
  assert.throws(() => commandLaunch(shim, []), /entrypoint .* is missing/);
}));

test('native commands keep their arguments, and non-Windows commands pass through', () => {
  const args = ['--version'];
  assert.deepEqual(commandLaunch(process.execPath, args), { file: process.execPath, args });
  if (process.platform !== 'win32') assert.deepEqual(commandLaunch('/custom/agent.cmd', args), { file: '/custom/agent.cmd', args });
});
