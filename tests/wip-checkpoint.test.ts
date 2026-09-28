import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkpointWorktrees } from '../src/server/wip-checkpoint.js';
import { WorkerManager, type WorkerEvents } from '../src/server/workers.js';
import { Ledger } from '../src/server/usage.js';
import { TaskQueue, type QueueWorkers } from '../src/server/queue.js';
import { checkpointNotice, withCheckpointNotice, withWorkerHandoff, withoutWorkerHandoff } from '../src/server/handoff.js';
import { taskStatus } from '../src/shared/task-status.js';

const NOW = new Date('2026-09-28T12:00:00.000Z');
// Time enough on a busy machine: only the deadline test is about the deadline.
const ROOMY = { now: NOW, deadlineMs: 60_000, pushTimeoutMs: 60_000 };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A project with one commit and an office worktree for worker `slug`, like Worktrees.create makes. */
function project(t: { after(fn: () => void): void }, slug = 'pip-1234') {
  const root = mkdtempSync(path.join(tmpdir(), 'office-wip-'));
  t.after(() => {
    // On Windows a killed git leaves its ssh child running in the folder for a while (the deadline test).
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // a temp folder left behind
    }
  });
  const dir = path.join(root, 'project');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(path.join(dir, '.gitignore'), '.agent-office/\nignored.log\n');
  writeFileSync(path.join(dir, 'app.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  const rel = path.join('.agent-office', 'worktrees', slug);
  const branch = `office/${slug}`;
  git(dir, 'worktree', 'add', '-q', '-b', branch, rel);
  return { root, dir, rel, wt: path.join(dir, rel), branch };
}

const quiet = () => {};

test('a dirty worktree gets a WIP commit on its branch; ignored files stay out', async (t) => {
  const p = project(t);
  writeFileSync(path.join(p.wt, 'app.txt'), 'two\n');
  writeFileSync(path.join(p.wt, 'new.txt'), 'new\n');
  writeFileSync(path.join(p.wt, 'ignored.log'), 'noise\n');
  const [r] = await checkpointWorktrees([{ dir: p.wt, branch: p.branch }], { ...ROOMY, log: quiet });
  assert.equal(r.error, undefined);
  assert.ok(r.hash);
  assert.equal(r.branch, p.branch);
  assert.equal(git(p.wt, 'rev-parse', 'HEAD'), r.hash);
  assert.equal(git(p.wt, 'log', '-1', '--format=%s'), 'WIP checkpoint: office restart 2026-09-28T12:00:00.000Z');
  assert.deepEqual(git(p.wt, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['app.txt', 'new.txt']);
  // Only the untracked ignored file is left, as before.
  assert.equal(git(p.wt, 'status', '--porcelain'), '');
  // The main checkout is untouched.
  assert.equal(git(p.dir, 'log', '-1', '--format=%s'), 'init');
  assert.equal(readFileSync(path.join(p.dir, 'app.txt'), 'utf8'), 'one\n');
});

test('a clean worktree is left alone, and no origin means no push', async (t) => {
  const p = project(t);
  const before = git(p.wt, 'rev-parse', 'HEAD');
  const [r] = await checkpointWorktrees([{ dir: p.wt, branch: p.branch }], { ...ROOMY, log: quiet });
  assert.deepEqual(r, { dir: p.wt, branch: p.branch });
  assert.equal(git(p.wt, 'rev-parse', 'HEAD'), before);
});

test('unpushed commits are pushed to origin with an upstream', async (t) => {
  const p = project(t);
  const origin = path.join(p.root, 'origin.git');
  git(p.root, 'init', '-q', '--bare', origin);
  git(p.dir, 'remote', 'add', 'origin', origin);
  writeFileSync(path.join(p.wt, 'app.txt'), 'two\n');
  const [r] = await checkpointWorktrees([{ dir: p.wt, branch: p.branch }], { ...ROOMY, log: quiet });
  assert.equal(r.pushed, true);
  assert.equal(r.pushError, undefined);
  assert.equal(git(origin, 'rev-parse', p.branch), r.hash);
  assert.equal(git(p.wt, 'rev-parse', '--abbrev-ref', '@{u}'), `origin/${p.branch}`);
});

test('a push failure is logged, never thrown, and the commit is kept', async (t) => {
  const p = project(t);
  git(p.dir, 'remote', 'add', 'origin', path.join(p.root, 'no-such-remote.git'));
  writeFileSync(path.join(p.wt, 'app.txt'), 'two\n');
  const lines: string[] = [];
  const [r] = await checkpointWorktrees([{ dir: p.wt, branch: p.branch }], { ...ROOMY, log: (l) => lines.push(l) });
  assert.ok(r.hash);
  assert.equal(r.pushed, undefined);
  assert.ok(r.pushError);
  assert.equal(git(p.wt, 'rev-parse', 'HEAD'), r.hash);
  assert.ok(lines.some((l) => l.includes("couldn't push") && l.includes(p.branch)));
});

test('the deadline is honoured: a hanging push is cut off and the commit still counts', async (t) => {
  const p = project(t);
  // A push over "ssh" whose ssh never answers.
  git(p.wt, 'config', 'core.sshCommand', `node -e "setTimeout(() => {}, 10000)"`);
  git(p.dir, 'remote', 'add', 'origin', 'ssh://example.invalid/repo.git');
  writeFileSync(path.join(p.wt, 'app.txt'), 'two\n');
  const started = Date.now();
  const [r] = await checkpointWorktrees([{ dir: p.wt, branch: p.branch }], { now: NOW, deadlineMs: 3000, pushTimeoutMs: 20_000, log: quiet });
  const took = Date.now() - started;
  assert.ok(took < 5000, `took ${took}ms`);
  assert.ok(r.hash, 'the commit was made before the push hung');
  assert.equal(r.pushed, undefined);
  assert.equal(r.pushError, 'ran out of time');
});

/** `p` with a bare origin its branch is pushed to, holding one commit of work. */
function pushed(p: ReturnType<typeof project>) {
  const origin = path.join(p.root, 'origin.git');
  git(p.root, 'init', '-q', '--bare', origin);
  git(p.dir, 'remote', 'add', 'origin', origin);
  writeFileSync(path.join(p.wt, 'app.txt'), 'two\n');
  git(p.wt, 'commit', '-q', '-am', 'work');
  git(p.wt, 'push', '-q', '-u', 'origin', p.branch);
  return { origin, tip: git(p.wt, 'rev-parse', 'HEAD') };
}

test('on a detached HEAD the WIP commit itself goes to the branch at origin, and only then counts as pushed', async (t) => {
  const p = project(t);
  const { origin, tip } = pushed(p);
  git(p.wt, 'checkout', '-q', '--detach');
  writeFileSync(path.join(p.wt, 'app.txt'), 'three\n');
  const [r] = await checkpointWorktrees([{ dir: p.wt, branch: p.branch }], { ...ROOMY, log: quiet });
  assert.ok(r.hash);
  assert.equal(r.branch, p.branch);
  assert.equal(r.pushError, undefined);
  assert.equal(r.pushed, true);
  // Pushing the branch by name would have sent the stale branch ("Everything up-to-date") and said pushed.
  assert.equal(git(origin, 'rev-parse', p.branch), r.hash);
  assert.equal(git(p.wt, 'rev-parse', p.branch), tip, 'the local branch is left where it was');
});

test("a detached HEAD that origin's branch has moved past is turned down, never forced, and not reported pushed", async (t) => {
  const p = project(t);
  const { origin, tip } = pushed(p);
  git(p.wt, 'checkout', '-q', '--detach', 'HEAD~1');
  writeFileSync(path.join(p.wt, 'app.txt'), 'elsewhere\n');
  const lines: string[] = [];
  const [r] = await checkpointWorktrees([{ dir: p.wt, branch: p.branch }], { ...ROOMY, log: (l) => lines.push(l) });
  assert.ok(r.hash, 'the commit is kept locally');
  assert.equal(r.pushed, undefined);
  assert.ok(r.pushError);
  assert.equal(git(origin, 'rev-parse', p.branch), tip);
  assert.ok(lines.some((l) => l.includes("couldn't push")));
  assert.ok(!lines.some((l) => l.includes('(pushed)')));
});

for (const op of ['merge', 'rebase'] as const) {
  test(`a worktree in the middle of a ${op} is left alone: no commit of conflict markers, nothing pushed`, async (t) => {
    const p = project(t);
    const { origin, tip } = pushed(p);
    writeFileSync(path.join(p.dir, 'app.txt'), 'main side\n');
    git(p.dir, 'commit', '-q', '-am', 'main side');
    assert.throws(() => git(p.wt, op, 'main'), 'the fixture conflicts');
    const head = git(p.wt, 'rev-parse', 'HEAD');
    const [r] = await checkpointWorktrees([{ dir: p.wt, branch: p.branch }], { ...ROOMY, log: quiet });
    assert.equal(r.hash, undefined);
    assert.equal(r.error, `a ${op} is in progress`);
    assert.equal(r.pushed, undefined);
    assert.equal(git(p.wt, 'rev-parse', 'HEAD'), head);
    assert.match(git(p.wt, 'status', '--porcelain'), /^(UU|AA) app\.txt/m, 'still mid-way, for the worker to finish');
    assert.equal(git(origin, 'rev-parse', p.branch), tip);
  });
}

test('the resume notice names the commit and branch, and task cards never show it', () => {
  const notice = checkpointNotice([{ hash: '0123456789abcdef0123', branch: 'office/pip-1234' }])!;
  assert.equal(notice, 'The office saved your uncommitted work as WIP commit 0123456789ab on office/pip-1234 when it restarted; run `git log -1 --stat` and continue from it. Squash or reword it before opening the PR if you like.');
  assert.equal(checkpointNotice(undefined), undefined);
  const prompt = withWorkerHandoff(withCheckpointNotice('Fix the login redirect', notice))!;
  assert.ok(prompt.includes(notice));
  assert.equal(withoutWorkerHandoff(prompt), 'Fix the login redirect');
  // A resumed session with nothing else to say still gets told.
  assert.equal(withoutWorkerHandoff(withWorkerHandoff(withCheckpointNotice(undefined, notice), 'session-1')!), '');
  // The same words inside someone's own request are theirs.
  const quoted = `Tell workers "${notice}"`;
  assert.equal(withoutWorkerHandoff(withWorkerHandoff(quoted)!), quoted);
});

function events(): WorkerEvents {
  return { update() {}, remove() {}, data() {}, sideData() {}, screen() {}, toast() {} };
}

function manager(dir: string, data: string) {
  return new WorkerManager(dir, data, 'claude', [], { url: 'http://127.0.0.1:1', token: '' }, events(), new Ledger(data, { pauseHiring: false }, () => {}, () => {}));
}

test('shutdown checkpoints agents in worktrees only, remembers the hash across a restart, and tells the resumed worker once', async (t) => {
  const p = project(t);
  const data = path.join(p.root, 'data');
  mkdirSync(data);
  const merged = path.join('.agent-office', 'worktrees', 'done-1');
  git(p.dir, 'worktree', 'add', '-q', '-b', 'office/done-1', merged);
  const base = git(p.dir, 'rev-parse', 'HEAD');
  const saved = [
    { id: 'w1', kind: 'agent', provider: 'claude', deskId: 'desk-1', name: 'Pip', sessionId: 'session-1', prompt: 'Fix the login redirect', worktree: { path: p.rel, branch: p.branch, base } },
    // Finished with a merged PR: its leftovers are not work in progress.
    { id: 'w2', kind: 'agent', provider: 'claude', deskId: 'desk-2', name: 'Dot', worktree: { path: merged, branch: 'office/done-1', base }, pr: { number: 7, url: 'https://example.invalid/7', state: 'MERGED' } },
    // In the main checkout: never committed in.
    { id: 'w3', kind: 'agent', provider: 'claude', deskId: 'desk-3', name: 'Main' },
  ];
  writeFileSync(path.join(data, 'workers.json'), JSON.stringify(saved));
  writeFileSync(path.join(p.wt, 'app.txt'), 'two\n');
  writeFileSync(path.join(p.dir, merged, 'app.txt'), 'leftover\n');
  writeFileSync(path.join(p.dir, 'app.txt'), 'main checkout edit\n');

  const first = manager(p.dir, data);
  // Restored workers are offline; mark w2 finished as the live office would have it.
  const w2 = first.list().find((w) => w.id === 'w2')!;
  w2.status = 'done';
  first.shutdown();
  await first.checkpoint(false, ROOMY.deadlineMs, NOW);

  const hash = git(p.wt, 'rev-parse', 'HEAD');
  assert.equal(git(p.wt, 'log', '-1', '--format=%s'), `WIP checkpoint: office restart ${NOW.toISOString()}`);
  assert.equal(git(p.dir, 'status', '--porcelain'), 'M app.txt', 'the main checkout keeps its uncommitted edit');
  assert.equal(git(path.join(p.dir, merged), 'status', '--porcelain'), 'M app.txt', 'a merged worker is left alone');
  assert.deepEqual(first.get('w1')?.checkpoints, [{ hash, branch: p.branch, at: NOW.getTime() }]);
  assert.equal(first.get('w3')?.checkpoints, undefined);

  // The next office has it from disk, and the queue card says the work was saved.
  const second = manager(p.dir, data);
  t.after(() => second.shutdown());
  assert.equal(second.get('w1')?.checkpoints?.[0]?.hash, hash);

  const queueData = mkdtempSync(path.join(tmpdir(), 'office-wip-queue-'));
  t.after(() => rmSync(queueData, { recursive: true, force: true }));
  writeFileSync(path.join(queueData, 'queue.json'), JSON.stringify({ maxWorkers: 0, tasks: [{ id: 't1', title: 'Login', prompt: 'Fix the login redirect', status: 'running', workerId: 'w1', branch: p.branch }] }));
  const qw: QueueWorkers = { defaultProvider: 'claude', list: () => second.list(), deskOccupied: () => true, spawn: () => 'no', kill: () => Promise.resolve({}) };
  const q = new TaskQueue(queueData, qw, true, { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {} });
  t.after(() => q.shutdown());
  const task = q.state().tasks[0];
  assert.equal(task.checkpoint, hash);
  assert.equal(taskStatus(task).text, 'stopped by restart (work saved as WIP commit)');

  // Resumed on request (R): the resume prompt carries the notice, once.
  const launched: (string | undefined)[] = [];
  (second as unknown as { launch: (w: unknown, prompt: string | undefined) => void }).launch = (_w, prompt) => launched.push(prompt);
  assert.equal(second.resume('w1'), undefined);
  assert.ok(launched[0]?.includes(`WIP commit ${hash.slice(0, 12)} on ${p.branch}`));
  assert.ok(launched[0]?.includes('git log -1 --stat'));
  assert.equal(second.get('w1')?.checkpoints, undefined);
  assert.equal(second.resume('w1'), undefined);
  assert.equal(launched[1], undefined, 'a later resume is bare again');
});

test('a worker with nothing uncommitted gets no checkpoint and no notice', async (t) => {
  const p = project(t);
  const data = path.join(p.root, 'data');
  mkdirSync(data);
  const base = git(p.dir, 'rev-parse', 'HEAD');
  writeFileSync(path.join(data, 'workers.json'), JSON.stringify([{ id: 'w1', kind: 'agent', provider: 'claude', deskId: 'desk-1', name: 'Pip', sessionId: 's', worktree: { path: p.rel, branch: p.branch, base } }]));
  const workers = manager(p.dir, data);
  workers.shutdown();
  await workers.checkpoint(false, ROOMY.deadlineMs, NOW);
  assert.equal(git(p.wt, 'rev-parse', 'HEAD'), base);
  assert.equal(workers.get('w1')?.checkpoints, undefined);
});

/** A fake terminal: `id` makes it one the host keeps running through a restart. */
function fakePty(id?: string, typed: string[] = [], killed: string[] = []) {
  return { id, pid: 1, write: (d: string) => typed.push(d), resize() {}, kill: () => killed.push(id ?? 'pty'), onData() {}, onExit() {} };
}

type Inside = { workers: Map<string, { pty?: unknown }>; setStatus(w: unknown, status: string): void; launch: (w: unknown, prompt: string | undefined) => void };
const inside = (m: WorkerManager) => m as unknown as Inside;

test('a restart (keep) leaves alone every worktree a surviving terminal works in, and still saves the others', async (t) => {
  const p = project(t);
  const data = path.join(p.root, 'data');
  mkdirSync(data);
  const other = path.join('.agent-office', 'worktrees', 'dot-5678');
  git(p.dir, 'worktree', 'add', '-q', '-b', 'office/dot-5678', other);
  const base = git(p.dir, 'rev-parse', 'HEAD');
  writeFileSync(path.join(data, 'workers.json'), JSON.stringify([
    // Its terminal is kept running in the host for the next office: the agent is still at work there.
    { id: 'w1', kind: 'agent', provider: 'claude', deskId: 'desk-1', name: 'Pip', sessionId: 's1', worktree: { path: p.rel, branch: p.branch, base } },
    // Shares that worktree (as at the meeting table), but its own terminal dies with the office.
    { id: 'w2', kind: 'agent', provider: 'claude', deskId: 'desk-2', name: 'Pal', sessionId: 's2', worktree: { path: p.rel, branch: p.branch, base } },
    // In a worktree of its own, with no terminal left to it: saved as on any stop.
    { id: 'w3', kind: 'agent', provider: 'claude', deskId: 'desk-3', name: 'Dot', sessionId: 's3', worktree: { path: other, branch: 'office/dot-5678', base } },
  ]));
  writeFileSync(path.join(p.wt, 'app.txt'), 'half-written\n');
  const dot = path.join(p.dir, other);
  writeFileSync(path.join(dot, 'app.txt'), 'dot\n');
  const workers = manager(p.dir, data);
  const killed: string[] = [];
  inside(workers).workers.get('w1')!.pty = fakePty('host-pty-1', [], killed);
  workers.shutdown(true);
  await workers.checkpoint(true, ROOMY.deadlineMs, NOW);

  assert.deepEqual(killed, [], 'the surviving terminal was left running');
  assert.equal(git(p.wt, 'rev-parse', 'HEAD'), base, 'nothing was committed under the running agent');
  assert.equal(git(p.wt, 'status', '--porcelain'), 'M app.txt');
  assert.equal(workers.get('w1')?.checkpoints, undefined);
  assert.equal(workers.get('w2')?.checkpoints, undefined);
  assert.equal(git(dot, 'log', '-1', '--format=%s'), `WIP checkpoint: office restart ${NOW.toISOString()}`);
  assert.equal(workers.get('w3')?.checkpoints?.[0]?.hash, git(dot, 'rev-parse', 'HEAD'));
});

/**
 * A queue worker the office went down under (its terminal went with it), with uncommitted work, then
 * the next office's workers and queue, restored from disk as a floor restores them.
 */
async function restarted(t: { after(fn: () => void): void }, withSession = true) {
  const p = project(t);
  const data = path.join(p.root, 'data');
  mkdirSync(data);
  const base = git(p.dir, 'rev-parse', 'HEAD');
  writeFileSync(path.join(data, 'workers.json'), JSON.stringify([{ id: 'w1', kind: 'agent', provider: 'claude', deskId: 'desk-1', name: 'Pip', sessionId: withSession ? 'session-1' : undefined, prompt: 'Fix the login redirect', worktree: { path: p.rel, branch: p.branch, base } }]));
  writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ maxWorkers: 0, tasks: [{ id: 't1', title: 'Login', prompt: 'Fix the login redirect', status: 'running', workerId: 'w1', workerName: 'Pip', branch: p.branch }] }));
  writeFileSync(path.join(p.wt, 'app.txt'), 'two\n');
  const first = manager(p.dir, data);
  first.shutdown();
  await first.checkpoint(false, ROOMY.deadlineMs, NOW);
  const hash = git(p.wt, 'rev-parse', 'HEAD');

  const workers = manager(p.dir, data);
  t.after(() => workers.shutdown());
  const launched: (string | undefined)[] = [];
  inside(workers).launch = (_w, prompt) => launched.push(prompt);
  // The floor hands the queue the worker manager itself. With no room (0 workers), it seats nobody.
  const queue = new TaskQueue(data, workers, true, { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {} });
  t.after(() => queue.shutdown());
  return { p, workers, queue, launched, hash };
}

test('woken after a restart, a queue worker with a session gets no turn behind its stopped task; the note waits for the next request', async (t) => {
  const { p, workers, queue, launched, hash } = await restarted(t);
  const task = () => queue.state().tasks[0];
  assert.equal(task().status, 'done');
  assert.equal(taskStatus(task()).text, 'stopped by restart (work saved as WIP commit)');

  workers.wakeAll();
  assert.deepEqual(launched, [undefined], 'its session is carried on with nothing submitted: no turn starts');
  assert.equal(workers.get('w1')?.checkpoints?.[0]?.hash, hash, 'the note is held');
  assert.equal(task().status, 'done', 'the queue and the worker agree: nobody is on the task');
  assert.ok(!queue.state().tasks.some((x) => x.status === 'running'));

  // Its carried-on session is running; someone asks it for something. A slash command runs as typed...
  const typed: string[] = [];
  inside(workers).workers.get('w1')!.pty = fakePty(undefined, typed);
  assert.equal(workers.prompt('w1', '/compact'), undefined);
  assert.equal(typed[0], '\x1b[200~/compact\x1b[201~');
  assert.ok(workers.get('w1')?.checkpoints, 'still held');
  // ...and the next real request carries the note, once.
  assert.equal(workers.prompt('w1', 'Carry on with the login fix'), undefined);
  const asked = typed.find((d) => d.includes('Carry on'))!;
  assert.ok(asked.includes(`Carry on with the login fix\n\nThe office saved your uncommitted work as WIP commit ${hash.slice(0, 12)} on ${p.branch}`));
  assert.equal(workers.get('w1')?.checkpoints, undefined);
  assert.equal(workers.prompt('w1', 'And then?'), undefined);
  assert.ok(!typed.find((d) => d.includes('And then?'))!.includes('WIP commit'), 'told once');
});

test('requeueing a task a restart stopped drops the note, so its old worker is never set going on it again', async (t) => {
  const { workers, queue, launched } = await restarted(t);
  workers.wakeAll();
  assert.deepEqual(launched, [undefined]);
  assert.equal(queue.retry('t1'), undefined);
  assert.equal(queue.state().tasks[0].status, 'queued');
  assert.equal(queue.state().tasks[0].checkpoint, undefined);
  assert.equal(workers.get('w1')?.checkpoints, undefined, 'the old worker is owed no note now');
  const typed: string[] = [];
  inside(workers).workers.get('w1')!.pty = fakePty(undefined, typed);
  assert.equal(workers.prompt('w1', 'What did you get done?'), undefined);
  assert.ok(!typed.find((d) => d.includes('What did you get done?'))!.includes('WIP commit'));
});

test('a held note goes once the worker is back at work without it (typed straight into its terminal)', async (t) => {
  const { workers } = await restarted(t);
  workers.wakeAll();
  assert.ok(workers.get('w1')?.checkpoints);
  inside(workers).setStatus(inside(workers).workers.get('w1'), 'working');
  assert.equal(workers.get('w1')?.checkpoints, undefined);
});

test('a queue worker with no session is woken with its task and the note, and its task stays running', async (t) => {
  const { workers, queue, launched, hash } = await restarted(t, false);
  assert.equal(queue.state().tasks[0].status, 'running', 'restoring keeps it: it is woken with its task (as before)');
  workers.wakeAll();
  assert.equal(launched.length, 1);
  assert.ok(launched[0]?.startsWith('Fix the login redirect'));
  assert.ok(launched[0]?.includes(`WIP commit ${hash.slice(0, 12)}`));
  assert.equal(workers.get('w1')?.checkpoints, undefined);
  assert.equal(queue.state().tasks[0].status, 'running');
});
