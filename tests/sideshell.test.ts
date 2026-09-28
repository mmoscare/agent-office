import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SideShells, sideShellLaunch } from '../src/server/sideshell.js';
import { childEnv } from '../src/server/workers.js';

/** Resolves once `pred` holds, polling; fails after a few seconds. */
async function until(pred: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!pred()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('a side shell starts in the worker checkout, is shared, and goes with the worker', async (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'agent-office-side-')));
  const out: Record<string, string> = {};
  const sizes: ({ cols: number; rows: number } | undefined)[] = [];
  const sides = new SideShells({
    data: (_id, data, viewers) => {
      for (const v of viewers) out[v] = (out[v] ?? '') + data;
    },
    size: (_id, size) => sizes.push(size),
  });
  t.after(() => {
    sides.killAll();
    rmSync(dir, { recursive: true, force: true });
  });

  const first = sides.attach('w1', 'alice', dir, childEnv(), 90, 20);
  assert.equal(typeof first, 'object');
  assert.deepEqual(sizes, [{ cols: 90, rows: 20 }]);
  // A second viewer joins the same shell rather than starting another.
  const second = sides.attach('w1', 'bob', dir, childEnv(), 120, 40);
  assert.ok(typeof second === 'object' && second.cols === 90 && second.rows === 20);
  assert.equal(sizes.length, 1);

  const cmd = process.platform === 'win32' ? 'cd\r' : 'pwd\r';
  sides.write('w1', cmd);
  const leaf = path.basename(dir);
  await until(() => (out.alice ?? '').includes(leaf) && (out.bob ?? '').includes(leaf), 'the shell to print its directory');

  sides.resize('w1', 100, 30);
  assert.deepEqual(sizes.at(-1), { cols: 100, rows: 30 });

  sides.detach('w1', 'bob');
  sides.kill('w1');
  // Killed on purpose (the worker went home): nobody is told it exited.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sizes.length, 2);
});

test('the side shell runs a login $SHELL off Windows and the console shell on Windows', () => {
  const none = () => false;
  assert.deepEqual(sideShellLaunch('linux', { SHELL: '/bin/zsh' }, none), { file: '/bin/zsh', args: ['-l'] });
  assert.deepEqual(sideShellLaunch('darwin', {}, none), { file: '/bin/bash', args: ['-l'] });
  // cmd.exe takes no -l; a stray POSIX $SHELL (inherited from Git Bash) that isn't a real file is ignored.
  assert.deepEqual(sideShellLaunch('win32', { COMSPEC: 'C:\Windows\system32\cmd.exe', SHELL: '/usr/bin/bash' }, none), { file: 'C:\Windows\system32\cmd.exe', args: [] });
  assert.deepEqual(sideShellLaunch('win32', {}, none), { file: 'cmd.exe', args: [] });
  const bash = 'C:\Program Files\Git\bin\bash.exe';
  assert.deepEqual(sideShellLaunch('win32', { SHELL: bash, COMSPEC: 'cmd.exe' }, (f) => f === bash), { file: bash, args: ['-l'] });
});
