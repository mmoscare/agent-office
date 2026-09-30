import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from '../bin/office-queue.js';
import { ago, buildRequest, formatWorkers, main, parseArgs } from '../bin/office-workers.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'office-workers.js');
const ENV = { AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:4455', AGENT_OFFICE_WORKER_ID: 'w1', AGENT_OFFICE_HOOK_TOKEN: 'tok' };
const OFFICE = { url: 'http://127.0.0.1:4455', worker: 'w1 &x', token: 'tok' };
const NOW = Date.parse('2026-09-29T12:00:00Z');

test('parses list and home, with their options', () => {
  assert.deepEqual(parseArgs([]), { cmd: 'help' });
  assert.deepEqual(parseArgs(['--help']), { cmd: 'help' });
  assert.deepEqual(parseArgs(['home', '-h']), { cmd: 'help' });
  assert.deepEqual(parseArgs(['list']), { cmd: 'list', json: false });
  assert.deepEqual(parseArgs(['ls', '--json']), { cmd: 'list', json: true });
  assert.deepEqual(parseArgs(['home', 'a1b2c3d4e5f6']), { cmd: 'home', id: 'a1b2c3d4e5f6', removeWorktree: false });
  assert.deepEqual(parseArgs(['home', 'a1b2c3d4e5f6', '--remove-worktree']), { cmd: 'home', id: 'a1b2c3d4e5f6', removeWorktree: true });
  assert.deepEqual(parseArgs(['home', '--remove-worktree', 'a1b2c3d4e5f6']), { cmd: 'home', id: 'a1b2c3d4e5f6', removeWorktree: true });
});

test('says what is wrong with a bad command line', () => {
  const bad: [string[], RegExp][] = [
    [['kill', 'a1'], /Unknown command: kill/],
    [['list', 'all'], /list takes only --json/],
    [['home'], /home takes one worker id/],
    [['home', 'a1', 'b2'], /home takes one worker id/],
    [['home', 'a1', '--force'], /Unknown option for home: --force/],
    [['home', 'a1', '--cleanup=all'], /Unknown option for home: --cleanup=all/],
  ];
  for (const [argv, message] of bad) assert.throws(() => parseArgs(argv), (e: Error) => e instanceof UsageError && message.test(e.message), argv.join(' '));
});

test('builds the /office/workers requests', () => {
  const auth = { authorization: 'Bearer tok' };
  assert.deepEqual(buildRequest({ cmd: 'list', json: true }, OFFICE), { method: 'GET', url: 'http://127.0.0.1:4455/office/workers?worker=w1+%26x', headers: auth });
  const home = buildRequest({ cmd: 'home', id: 'a1b2c3d4e5f6', removeWorktree: true }, OFFICE);
  assert.equal(home.method, 'POST');
  assert.equal(home.url, 'http://127.0.0.1:4455/office/workers?worker=w1+%26x');
  assert.deepEqual(home.headers, { ...auth, 'content-type': 'application/json' });
  assert.deepEqual(JSON.parse(home.body!), { action: 'home', id: 'a1b2c3d4e5f6', removeWorktree: true });
});

test('lists the floor readably: status, who and where, then its branch, PR, work and whether it can go', () => {
  assert.equal(formatWorkers({ workers: [] }), 'Nobody is working on this floor.');
  assert.equal(ago(NOW - 42 * 60_000, NOW), '42m');
  assert.equal(ago(NOW - 30_000, NOW), '30s');
  assert.equal(ago(NOW - 5 * 3600_000, NOW), '5h');
  assert.equal(ago(NOW - 3 * 86400_000, NOW), '3d');
  const text = formatWorkers(
    {
      workers: [
        { id: 'aaa111aaa111', name: 'Pixel', desk: 'Desk 3', kind: 'agent', provider: 'claude', model: 'claude-opus-5-5', status: 'done', since: NOW - 42 * 60_000, task: 'Fix Login Redirect', branch: 'office/pixel-2587', pr: { number: 80, state: 'merged', url: 'u' }, queued: { id: 't1', title: 'Fix login', status: 'done' }, work: { path: '.agent-office/worktrees/pixel-2587', dirty: 0, unpushed: 0, commits: 2 } },
        { id: 'bbb222bbb222', name: 'Byte', desk: 'Desk 5', kind: 'agent', provider: 'opencode', model: 'xai/grok-4', status: 'working', branch: 'office/byte-20f8', work: { path: '.agent-office/worktrees/byte-20f8', dirty: 3, unpushed: 1, commits: 1 }, blocked: 'Byte is working' },
        { id: 'ccc333ccc333', name: 'Pip', desk: 'Bean bag 1', kind: 'agent', provider: 'claude', status: 'idle', work: { path: '.', dirty: 0, unpushed: 0 } },
        { id: 'ddd444ddd444', name: 'PR agent', desk: 'PR board', board: true, kind: 'agent', provider: 'claude', status: 'needs input', since: NOW - 60_000, blocked: 'PR agent is a board agent: only a person clocks those out' },
        { id: 'eee555eee555', name: 'Dot', desk: 'Desk 1', kind: 'agent', status: 'asleep', work: { path: 'x', dirty: 0, unpushed: 0, error: 'not a git repository' }, blocked: "The office couldn't check" },
      ],
    },
    NOW,
  );
  assert.equal(text, [
    '5 workers on this floor',
    'aaa111aaa111  done 42m        Pixel · Desk 3 · claude claude-opus-5-5 · “Fix Login Redirect”',
    '    office/pixel-2587 · PR #80 merged · queue task t1 done · worktree clean, nothing unpushed, 2 commits of its own · ✓ can clock out',
    'bbb222bbb222  working         Byte · Desk 5 · opencode xai/grok-4',
    '    office/byte-20f8 · worktree 3 uncommitted changes, 1 commit no remote has, 1 commit of its own · ✗ stays: Byte is working',
    'ccc333ccc333  idle            Pip · Bean bag 1 · claude',
    "    in the floor's checkout clean, nothing unpushed · ✓ can clock out",
    'ddd444ddd444  needs input 1m  PR agent · PR board · claude',
    '    board agent · ✗ stays: PR agent is a board agent: only a person clocks those out',
    'eee555eee555  asleep          Dot · Desk 1',
    "    worktree: couldn't check (not a git repository) · ✗ stays: The office couldn't check",
  ].join('\n'));
});

/** Runs main() against a fake fetch; returns what it printed and what it sent. */
async function run(argv: string[], opts: { env?: Record<string, string>; status?: number; body?: unknown } = {}) {
  const sent: { url: string; init: RequestInit }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify(opts.body ?? {}), { status: opts.status ?? 200 });
  };
  const code = await main(argv, { env: opts.env ?? ENV, fetch, out: (s: string) => out.push(s), err: (s: string) => err.push(s), now: NOW });
  return { code, sent, out: out.join('\n'), err: err.join('\n') };
}

test('list prints the floor, or the office\'s JSON with --json', async () => {
  const body = { workers: [{ id: 'aaa111aaa111', name: 'Pixel', desk: 'Desk 3', kind: 'agent', status: 'idle' }] };
  const list = await run(['list'], { body });
  assert.equal(list.code, 0);
  assert.equal(list.sent[0].init.method, 'GET');
  assert.equal(list.out, '1 worker on this floor\naaa111aaa111  idle  Pixel · Desk 3\n    ✓ can clock out');
  const json = await run(['list', '--json'], { body });
  assert.deepEqual(JSON.parse(json.out), body);
});

test('home says who went and what became of the worktree', async () => {
  const gone = await run(['home', 'aaa111aaa111', '--remove-worktree'], { body: { ok: true, worker: { id: 'aaa111aaa111', name: 'Pixel' }, cleanup: 'all', note: "Deleted Pixel's worktree and branch office/pixel-2587" } });
  assert.equal(gone.code, 0);
  assert.equal(gone.sent[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(gone.sent[0].init.body)), { action: 'home', id: 'aaa111aaa111', removeWorktree: true });
  assert.equal(gone.out, "Clocked out Pixel (aaa111aaa111).\nDeleted Pixel's worktree and branch office/pixel-2587.");

  const kept = await run(['home', 'aaa111aaa111', '--remove-worktree'], { body: { ok: true, worker: { id: 'aaa111aaa111', name: 'Pixel' }, cleanup: 'keep', kept: 'office/pixel-2587 has 1 commit not merged into personal', note: "Kept Pixel's worktree and branch office/pixel-2587" } });
  assert.equal(kept.out, "Clocked out Pixel (aaa111aaa111).\nKept its worktree and branch: office/pixel-2587 has 1 commit not merged into personal.\nKept Pixel's worktree and branch office/pixel-2587.");

  const slow = await run(['home', 'aaa111aaa111', '--remove-worktree'], { body: { ok: true, worker: { id: 'aaa111aaa111', name: 'Pixel' }, cleanup: 'all', pending: true } });
  assert.match(slow.out, /still being deleted; the office will say how that went/);

  const failed = await run(['home', 'aaa111aaa111', '--remove-worktree'], { body: { ok: true, worker: { id: 'aaa111aaa111', name: 'Pixel' }, cleanup: 'all', error: "Couldn't delete Pixel's worktree: locked" } });
  assert.equal(failed.code, 0);
  assert.equal(failed.err, "office-workers: Couldn't delete Pixel's worktree: locked");
});

test('clear errors when the environment is missing, the command line is wrong, or the office says no', async () => {
  const noEnv = await run(['list'], { env: {} });
  assert.equal(noEnv.code, 1);
  assert.equal(noEnv.sent.length, 0);
  assert.match(noEnv.err, /^office-workers: AGENT_OFFICE_HOOK_URL, AGENT_OFFICE_WORKER_ID, AGENT_OFFICE_HOOK_TOKEN aren't set/);

  const usage = await run(['home']);
  assert.equal(usage.code, 2);
  assert.equal(usage.sent.length, 0);
  assert.match(usage.err, /home takes one worker id[\s\S]*Usage:/);

  const busy = await run(['home', 'bbb222bbb222'], { status: 409, body: { error: 'Byte has 3 uncommitted changes in .agent-office/worktrees/byte-20f8: clocking it out would leave that work unshipped with nobody on it. Name it for the owner instead' } });
  assert.equal(busy.code, 1);
  assert.equal(busy.out, '');
  assert.equal(busy.err, 'office-workers: The office said no (409): Byte has 3 uncommitted changes in .agent-office/worktrees/byte-20f8: clocking it out would leave that work unshipped with nobody on it. Name it for the owner instead.');

  const desk = await run(['list'], { status: 403, body: { error: 'Only the agents standing by the boards can use office-workers' } });
  assert.equal(desk.err, 'office-workers: The office said no (403): Only the agents standing by the boards can use office-workers.');
});

test('runs as a command: home goes over HTTP with the agent\'s own token', async (t) => {
  const seen: { method?: string; url?: string; auth?: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const ok = req.headers.authorization === 'Bearer tok';
      res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { ok: true, worker: { id: 'aaa111aaa111', name: 'Pixel' }, cleanup: 'keep', note: "Kept Pixel's worktree and branch office/pixel-2587" } : { error: 'Only the agents standing by the boards can use office-workers' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cli = (env: Record<string, string>) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [SCRIPT, 'home', 'aaa111aaa111'], { env: { PATH: process.env.PATH ?? '', ...env } }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }));
    });

  const ok = await cli({ ...ENV, AGENT_OFFICE_HOOK_URL: url });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout, "Clocked out Pixel (aaa111aaa111).\nKept Pixel's worktree and branch office/pixel-2587.\n");
  assert.deepEqual(seen[0], { method: 'POST', url: '/office/workers?worker=w1', auth: 'Bearer tok', body: JSON.stringify({ action: 'home', id: 'aaa111aaa111', removeWorktree: false }) });

  const desk = await cli({ ...ENV, AGENT_OFFICE_HOOK_URL: url, AGENT_OFFICE_HOOK_TOKEN: 'desk-token' });
  assert.equal(desk.code, 1);
  assert.equal(desk.stdout, '');
  assert.match(desk.stderr, /The office said no \(403\): Only the agents standing by the boards/);
});
