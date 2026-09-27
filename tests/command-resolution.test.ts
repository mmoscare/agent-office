import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveCommand } from '../src/server/workers.js';

test('resolves agent commands from PATH and explicit paths', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-office-command-'));
  const bin = path.join(root, 'bin with spaces');
  mkdirSync(bin);
  const executable = path.join(bin, process.platform === 'win32' ? 'test-agent.exe' : 'test-agent');
  writeFileSync(executable, 'test executable');
  chmodSync(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    assert.equal(resolveCommand('test-agent'), executable, 'find a native executable by its short name');
    assert.equal(resolveCommand(path.basename(executable)), executable, 'keep explicit executable names working');
    assert.equal(resolveCommand(executable), executable, 'accept a full path with the native path separators');
    assert.equal(resolveCommand(path.join(bin, 'missing-agent')), null, 'reject a missing explicit executable');
    if (process.platform === 'win32') {
      process.env.PATH = `"${bin}"`;
      assert.equal(resolveCommand('test-agent'), executable, 'handle quoted Windows PATH entries');
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    unlinkSync(executable);
    rmdirSync(bin);
    rmdirSync(root);
  }
});
