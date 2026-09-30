import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VpDesk, handleVp, type VpFloor } from '../src/server/vp.js';
import { RESTART_ERROR } from '../src/shared/task-status.js';
import type { QueueTask, WorkerInfo } from '../src/shared/protocol.js';

// The VP's desk on a floor, with the floor faked: standing duty, and the help he gives stuck workers.

const MIN = 60_000;

function worker(over: Partial<WorkerInfo>): WorkerInfo {
  return { id: 'w1', kind: 'agent', provider: 'claude', deskId: 'desk-3', name: 'Pixel', color: '#fff', status: 'idle', acked: true, createdBy: 'me', createdAt: 0, cols: 80, rows: 24, viewers: [], viewerIds: [], ...over } as WorkerInfo;
}

function floor(t: { after(fn: () => void): void }, workers: WorkerInfo[], tasks: QueueTask[] = [], tails: Record<string, string> = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'vpd-')));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  let now = 100 * MIN;
  const did = { prompts: [] as { id: string; text: string; by?: string }[], resumes: [] as { id: string; prompt?: string }[], plans: [] as string[], views: 0, toasts: [] as string[] };
  const f: VpFloor = {
    id: 'f',
    dir,
    dataDir: dir,
    workers: {
      list: () => workers,
      get: (id) => workers.find((w) => w.id === id),
      prompt: (id, text, by) => {
        did.prompts.push({ id, text, by });
        return undefined;
      },
      resume: (id, prompt) => {
        did.resumes.push({ id, prompt });
        return undefined;
      },
      peek: (id) => {
        const w = workers.find((x) => x.id === id);
        return w && { tail: tails[id] ?? '', running: w.status !== 'exited' && w.status !== 'offline' };
      },
    },
    tasks: () => tasks,
    queue: () => 'no queue here',
    plan: (text) => {
      did.plans.push(text);
      return undefined;
    },
    pressure: () => undefined,
    toast: (text) => did.toasts.push(text),
    emit: () => did.views++,
    gh: async () => '[]',
    office: null,
    now: () => now,
  };
  return { f, did, dir, later: (ms: number) => (now += ms) };
}

test('standing duty is kept on disk with who turned it on and when, like go-home-on-merge', async (t) => {
  const { f, dir } = floor(t, []);
  const desk = new VpDesk(f);
  assert.equal(desk.duty, undefined);
  assert.equal(desk.setDuty(true, 'Michael', 15 * MIN), undefined);
  desk.stop();
  const again = new VpDesk({ ...f, dataDir: dir });
  assert.deepEqual({ on: again.duty?.on, by: again.duty?.by, every: again.duty?.everyMs }, { on: true, by: 'Michael', every: 15 * MIN });
  assert.match(again.setDuty(true, 'Michael', 30_000) ?? '', /at most every 2 minutes/);
  again.setDuty(false, 'Sam');
  assert.equal(new VpDesk(f).duty?.on, false);
});

test('on duty: a worker stopped by a restart is woken and told "continue"; a permission prompt goes to the owner and is never typed into', async (t) => {
  const pixel = worker({ id: 'pix', name: 'Pixel', deskId: 'desk-3', status: 'exited', worktree: { path: 'x', branch: 'office/pixel-2587', base: 'b' } });
  const byte = worker({ id: 'byt', name: 'Byte', deskId: 'desk-5', status: 'needs_input', activity: 'Wants permission: Bash(git push --force)', waitingSince: 90 * MIN, worktree: { path: 'y', branch: 'office/byte-1', base: 'b' } });
  const tasks = [{ id: 't1', title: 'Update walkthrough', prompt: 'p', status: 'done', outcome: 'exited', error: RESTART_ERROR, workerId: 'pix', addedBy: 'me', addedAt: 0 }] as QueueTask[];
  const { f, did } = floor(t, [pixel, byte], tasks);
  const desk = new VpDesk(f);
  const job = { id: 'j', kind: 'sweep', what: 'duty', by: 'duty', startedAt: 0, log: [] as string[], done: Promise.resolve() };
  const help = await desk.helpWorkers(job as never, true);
  assert.deepEqual(did.resumes, [{ id: 'pix', prompt: 'continue' }]);
  assert.equal(did.prompts.filter((p) => p.id === 'byt').length, 0, 'nothing is typed into a permission prompt');
  assert.equal(did.plans.length, 1);
  assert.match(did.plans[0], /^VP needs you: Byte at Desk 5 \(office\/byte-1\) a permission prompt has been open for .*Bash\(git push --force\).*never approves/);
  assert.equal(help.done.length, 1);
  // Once per spell: the next duty round leaves them be.
  await desk.helpWorkers(job as never, true);
  assert.equal(did.resumes.length, 1);
  assert.equal(did.plans.length, 1);
});

test('office-vp nudge and wake: never into an open prompt; wake resumes an asleep worker', async (t) => {
  const pixel = worker({ id: 'pix', status: 'exited' });
  const byte = worker({ id: 'byt', name: 'Byte', status: 'needs_input' });
  const dot = worker({ id: 'dot', name: 'Dot', status: 'done' });
  const { f, did } = floor(t, [pixel, byte, dot]);
  const desk = new VpDesk(f);
  const call = (body: Record<string, unknown>) => handleVp(desk, { method: 'POST', query: new URLSearchParams(), body, by: 'VP, asked by Michael' });
  assert.match(JSON.stringify((await call({ action: 'nudge', worker: 'Byte', text: 'yes' })).body), /typing into it would answer it/);
  assert.match(JSON.stringify((await call({ action: 'nudge', worker: 'Pixel', text: 'hi' })).body), /asleep: wake it/);
  assert.equal((await call({ action: 'wake', worker: 'Pixel' })).status, 200);
  assert.deepEqual(did.resumes, [{ id: 'pix', prompt: 'continue' }]);
  assert.equal((await call({ action: 'nudge', worker: 'dot', text: 'Commit and push, then open the PR.' })).status, 200);
  assert.deepEqual(did.prompts, [{ id: 'dot', text: 'Commit and push, then open the PR.', by: 'VP, asked by Michael' }]);
  assert.equal((await call({ action: 'frob' })).status, 400);
  const status = await handleVp(desk, { method: 'GET', query: new URLSearchParams('view=workers'), by: 'VP' });
  assert.equal((status.body as { workers: unknown[] }).workers.length, 3);
});
