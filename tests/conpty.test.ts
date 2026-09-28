import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { IPty } from '@lydell/node-pty';
import { spawnLocal } from '../src/server/conpty.js';

/** A node-pty stand-in whose output and exit the test drives. */
function fakePty(pid: number) {
  const data: ((d: string) => void)[] = [];
  const exit: ((e: { exitCode: number }) => void)[] = [];
  const fake = {
    pid,
    killed: false,
    size: [0, 0],
    written: [] as string[],
    onData: (cb: (d: string) => void) => void data.push(cb),
    onExit: (cb: (e: { exitCode: number }) => void) => void exit.push(cb),
    write: (d: string) => void fake.written.push(d),
    resize: (cols: number, rows: number) => void (fake.size = [cols, rows]),
    kill: () => void (fake.killed = true),
    emit: (d: string) => data.forEach((cb) => cb(d)),
    end: (exitCode: number) => exit.forEach((cb) => cb({ exitCode })),
  };
  return fake;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a terminal whose ConPTY never got its program going starts once more; its output and exit carry on', async () => {
  const made: ReturnType<typeof fakePty>[] = [];
  const sizes: (number | undefined)[][] = [];
  const t = spawnLocal((cols, rows) => {
    sizes.push([cols, rows]);
    const f = fakePty(100 + made.length);
    made.push(f);
    return f as unknown as IPty;
  }, 'fake', 1, 10);
  const seen: string[] = [];
  const exits: number[] = [];
  t.onData((d) => seen.push(d));
  t.onExit((e) => exits.push(e.exitCode));
  assert.equal(t.pid, 100);
  t.resize(120, 40);
  made[0].end(-1);
  assert.deepEqual(exits, [], 'the failed start is not the program exiting');
  await pause(40);
  assert.equal(made.length, 2);
  assert.deepEqual(sizes[1], [120, 40], 'the second start keeps the latest size');
  assert.equal(t.pid, 101);
  made[1].emit('agent up');
  t.write('x');
  assert.deepEqual(made[1].written, ['x']);
  made[1].end(-1);
  await pause(40);
  assert.deepEqual(seen, ['agent up']);
  assert.deepEqual(exits, [-1], 'after output, -1 is the program\'s own exit');
  assert.equal(made.length, 2);
});

test('real exits, exits after output, a second failure and a kill are passed on as they are', async () => {
  const run = async (script: (f: ReturnType<typeof fakePty>[], t: ReturnType<typeof spawnLocal>) => void | Promise<void>) => {
    const made: ReturnType<typeof fakePty>[] = [];
    const t = spawnLocal(() => {
      const f = fakePty(made.length);
      made.push(f);
      return f as unknown as IPty;
    }, 'fake', 1, 10);
    const exits: number[] = [];
    t.onExit((e) => exits.push(e.exitCode));
    await script(made, t);
    await pause(40);
    return { exits, starts: made.length };
  };
  assert.deepEqual(await run((f) => f[0].end(1)), { exits: [1], starts: 1 });
  assert.deepEqual(await run((f) => { f[0].emit('hi'); f[0].end(-1); }), { exits: [-1], starts: 1 });
  assert.deepEqual(await run(async (f) => { f[0].end(-1); await pause(40); f[1].end(-1); }), { exits: [-1], starts: 2 });
  assert.deepEqual(await run((f, t) => { t.kill(); f[0].end(-1); }), { exits: [-1], starts: 1 });
});

test('Windows: a ConPTY spawn survives the office being busy for longer than node-pty waits', { skip: process.platform !== 'win32' }, () => {
  // In a process of its own, so the event loop is really held up before node-pty's timer runs
  // (inside the test runner, the loop can pick the ConPTY up first).
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-conpty-'));
  const url = (file: string) => pathToFileURL(file).href;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const script = path.join(dir, 'busy.ts');
  writeFileSync(script, `import * as pty from ${JSON.stringify(url(path.join(root, 'node_modules/@lydell/node-pty/index.js')))};
import { spawnLocal } from ${JSON.stringify(url(path.join(root, 'src/server/conpty.ts')))};
let starts = 0;
let out = '';
const t = spawnLocal(() => {
  starts++;
  return pty.spawn(process.execPath, ['-e', "process.stdout.write('child ran'); setTimeout(() => {}, 300)"], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> });
}, 'node');
t.onData((d) => (out += d));
t.onExit((e) => { process.stdout.write(JSON.stringify({ exitCode: e.exitCode, starts, ran: out.includes('child ran') })); process.exit(0); });
// A few synchronous \`git worktree add\`s in a row: past node-pty's 5 second ConPTY timeout.
const end = Date.now() + 7000;
while (Date.now() < end) { /* busy */ }
`);
  try {
    const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', script], { cwd: root, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] }));
    assert.deepEqual(result, { exitCode: 0, starts: 2, ran: true }, 'the first ConPTY timed out, and the terminal started again and ran');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
