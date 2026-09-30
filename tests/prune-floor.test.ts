import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { floorPrune, neededBy, renderReport, suggestFor, LOOK_MS, type FloorPruneOptions, type FloorPruneReport, type PruneRow, type PullRef } from '../src/server/prune-floor.js';
import { Worktrees } from '../src/server/worktrees.js';

// CleanBot's sweep (`agent-office prune --floor`, and office-cleanbot through the office) on fixture
// repositories only: nothing here touches a real floor. Origin's URL is on GitHub, so PRs are looked
// up (through a stand-in list), but git's insteadOf sends fetches and pushes to a local bare repository.

// Identity and settings for every git call, the fixtures' and the code's, with no global hooks or excludes.
const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'CleanBot Test',
  GIT_AUTHOR_EMAIL: 'cleanbot-test@example.invalid',
  GIT_COMMITTER_NAME: 'CleanBot Test',
  GIT_COMMITTER_EMAIL: 'cleanbot-test@example.invalid',
  GIT_CONFIG_COUNT: '4',
  GIT_CONFIG_KEY_0: 'core.autocrlf',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'commit.gpgsign',
  GIT_CONFIG_VALUE_1: 'false',
  GIT_CONFIG_KEY_2: 'core.hooksPath',
  GIT_CONFIG_VALUE_2: path.join(tmpdir(), 'cleanbot-test-no-hooks'),
  GIT_CONFIG_KEY_3: 'core.excludesFile',
  GIT_CONFIG_VALUE_3: path.join(tmpdir(), 'cleanbot-test-no-excludes'),
};
Object.assign(process.env, GIT_ENV);

const DAY = 24 * 60 * 60_000;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(dir: string, file: string, text: string, msg: string) {
  writeFileSync(path.join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', msg);
}

interface Saved {
  name: string;
  deskId?: string;
  sessionId?: string;
  worktree?: { path: string; branch: string };
  ask?: { first?: string; latest?: string };
}

function fixture(t: { after(fn: () => void): void }) {
  const top = realpathSync(mkdtempSync(path.join(tmpdir(), 'cleanbot-')));
  t.after(() => rmSync(top, { recursive: true, force: true, maxRetries: 3 }));
  // Never the real building's floors.json.
  const home = process.env.AGENT_OFFICE_HOME;
  process.env.AGENT_OFFICE_HOME = path.join(top, 'home');
  t.after(() => (home === undefined ? delete process.env.AGENT_OFFICE_HOME : (process.env.AGENT_OFFICE_HOME = home)));
  const root = path.join(top, 'floor');
  const origin = path.join(top, 'origin.git').split(path.sep).join('/');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'personal');
  writeFileSync(path.join(root, 'app.txt'), 'one\n');
  writeFileSync(path.join(root, '.gitignore'), '.agent-office/\nnode_modules/\n.env\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Initial');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'personal', origin], { stdio: 'ignore' });
  git(root, 'remote', 'add', 'origin', 'https://github.com/test/floor.git');
  git(root, 'config', `url.${origin}.insteadOf`, 'https://github.com/test/floor.git');
  git(root, 'push', '-q', '-u', 'origin', 'personal');
  git(root, 'remote', 'set-head', 'origin', 'personal');
  const trees = new Worktrees(root);
  const hire = (slug: string) => {
    const wt = trees.create(slug);
    assert.notEqual(typeof wt, 'string', String(wt));
    const w = wt as { path: string; branch: string };
    return { ...w, abs: path.join(root, w.path) };
  };
  /** A worker's branch whose PR merged: its commit pushed, merged into personal and pushed. */
  const merged = (slug: string) => {
    const w = hire(slug);
    commit(w.abs, `${slug}.txt`, `${slug}\n`, slug);
    git(w.abs, 'push', '-q', 'origin', w.branch);
    git(root, 'merge', '-q', '--no-ff', '-m', `Merge ${slug}`, w.branch);
    git(root, 'push', '-q', 'origin', 'personal');
    return w;
  };
  const prs: PullRef[] = [];
  const pr = (number: number, head: string, state: PullRef['state']) => prs.push({ number, head, state, url: `https://github.com/test/floor/pull/${number}` });
  const data = path.join(root, '.agent-office');
  const workers: Saved[] = [];
  const saveWorkers = () => writeFileSync(path.join(data, 'workers.json'), JSON.stringify(workers));
  const saveQueue = (tasks: Record<string, unknown>[]) => writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ maxWorkers: 4, tasks }));
  const tmp = path.join(top, 'tmp');
  const projects = path.join(top, 'projects');
  mkdirSync(projects, { recursive: true });
  const office = async () => ({ floors: [{ name: 'Test floor', dir: root }], busy: [] });
  const run = (extra: Partial<FloorPruneOptions> = {}): Promise<FloorPruneReport> =>
    floorPrune({ floor: root, pulls: async () => prs, office, tmp, claudeProjects: projects, by: 'test', now: () => Date.now() + 3 * DAY, ...extra });
  return { top, root, origin, hire, merged, pr, workers, saveWorkers, saveQueue, tmp, run, office };
}

function row(report: FloorPruneReport, name: string): PruneRow {
  const r = report.rows.find((x) => x.name === name || x.branch === name);
  assert.ok(r, `no row ${name} in ${report.rows.map((x) => x.name).join(', ')}`);
  return r;
}

test("every verdict, and what the PR agent, the VP, the queue and live workers still need is kept", { timeout: 600_000 }, async (t) => {
  const f = fixture(t);
  const m1 = f.merged('merged-1');
  f.pr(1, m1.branch, 'MERGED');
  const o2 = f.hire('open-2');
  commit(o2.abs, 'o.txt', 'o\n', 'open');
  git(o2.abs, 'push', '-q', 'origin', o2.branch);
  f.pr(2, o2.branch, 'OPEN');
  const d3 = f.hire('dirty-3');
  writeFileSync(path.join(d3.abs, 'app.txt'), 'changed\n');
  const e4 = f.hire('env-4');
  writeFileSync(path.join(e4.abs, '.env'), 'SECRET=1\n');
  const l5 = f.hire('local-5');
  commit(l5.abs, 'l.txt', 'l\n', 'local only');
  const u6 = f.hire('unshipped-6');
  commit(u6.abs, 'u.txt', 'u\n', 'pushed, no PR');
  git(u6.abs, 'push', '-q', 'origin', u6.branch);
  const live = f.hire('live-7');
  const n8 = f.merged('needed-8');
  f.pr(8, n8.branch, 'MERGED');
  const q9 = f.merged('queued-9');
  f.pr(9, q9.branch, 'MERGED');
  const d10 = f.merged('done-10');
  f.pr(10, d10.branch, 'MERGED');
  const g12 = f.hire('gone-12');
  commit(g12.abs, 'g.txt', 'g\n', 'remote deleted');
  git(g12.abs, 'push', '-q', 'origin', g12.branch);
  git(f.origin, 'branch', '-q', '-D', g12.branch);
  git(f.root, 'branch', '-q', 'pr-assets/shots');
  git(f.root, 'branch', '-q', 'feature/mine');
  // Claude scratchpad worktrees: one made in a live worker's session, one in a session long gone.
  const pad = (session: string) => path.join(f.tmp, 'claude', 'C--some-project', session, 'scratchpad', 'base');
  git(f.root, 'worktree', 'add', '-q', '--detach', pad('sess-live'), 'personal');
  git(f.root, 'worktree', 'add', '-q', '--detach', pad('sess-gone'), 'personal');
  // Half-deleted worktrees (what a Windows `git worktree remove` that failed partway leaves): one clean, one with an edit.
  const s11 = f.merged('stray-11');
  f.pr(11, s11.branch, 'MERGED');
  const s13 = f.merged('stray-13');
  f.pr(13, s13.branch, 'MERGED');
  writeFileSync(path.join(s13.abs, 'app.txt'), 'an edit nobody committed\n');
  for (const slug of ['stray-11', 'stray-13']) {
    rmSync(path.join(f.root, '.git', 'worktrees', slug), { recursive: true, force: true });
    git(f.root, 'worktree', 'prune');
  }

  f.workers.push(
    { name: 'Pixel', deskId: 'desk-1', sessionId: 'sess-live', worktree: { path: live.path, branch: live.branch }, ask: { first: 'Fix the login' } },
    { name: 'PR agent', deskId: 'station-pulls', sessionId: 'sess-pr', ask: { first: 'merge the PRs', latest: 'Merged #8, checking the result before I clock its worker out' } },
    // CleanBot's own request names rows the person wants gone: never a reason to keep them.
    { name: 'CleanBot', deskId: 'station-cleanbot', ask: { latest: 'delete office/done-10 please' } },
  );
  f.saveWorkers();
  f.saveQueue([
    { id: 't1', status: 'queued', title: 'Fix a conflict', prompt: `Check out ${q9.branch} and fix it`, addedBy: 'VP' },
    { id: 't2', status: 'done', title: 'Old', prompt: `Worked on ${d10.branch}` },
  ]);

  const report = await f.run();
  assert.equal(report.repos[0].fetch, 'ok');
  assert.equal(report.repos[0].github, 'test/floor');
  const v = (name: string) => row(report, name).verdict;
  assert.equal(v('office/merged-1'), 'safe');
  assert.equal(v('office/open-2'), 'open-pr');
  assert.equal(v('office/dirty-3'), 'work');
  assert.match(row(report, 'office/dirty-3').why, /1 uncommitted change/);
  assert.equal(v('office/env-4'), 'work');
  assert.match(row(report, 'office/env-4').why, /ignored files: \.env/);
  assert.equal(v('office/local-5'), 'work');
  assert.match(row(report, 'office/local-5').why, /1 unpushed commit/);
  assert.equal(v('office/unshipped-6'), 'work');
  assert.match(row(report, 'office/unshipped-6').why, /1 commit no open or merged PR carries \(unshipped work on the PR board\)/);
  assert.equal(v('office/live-7'), 'worker');
  assert.match(row(report, 'office/live-7').why, /Pixel/);
  assert.equal(v('office/needed-8'), 'needed');
  assert.match(row(report, 'office/needed-8').why, /the PR agent is working on it/);
  assert.equal(v('office/queued-9'), 'needed');
  assert.match(row(report, 'office/queued-9').why, /task t1 "Fix a conflict" \(queued by VP\) is waiting/);
  assert.equal(v('office/done-10'), 'safe', 'a finished task and CleanBot\'s own request need nothing');
  assert.equal(v('office/gone-12'), 'work', 'its remote branch was deleted: after fetch --prune its commit is only here');
  assert.match(row(report, 'office/gone-12').why, /1 unpushed commit/);
  assert.equal(v('pr-assets/shots'), 'protected');
  assert.equal(v('feature/mine'), 'not-office');
  assert.equal(v('personal'), 'protected');
  const pads = report.rows.filter((r) => r.worktree?.kind === 'scratchpad');
  assert.equal(pads.length, 2);
  assert.equal(pads.find((r) => r.name.includes('sess-live'))?.verdict, 'worker');
  assert.match(pads.find((r) => r.name.includes('sess-live'))!.why, /Pixel.*Claude session/);
  assert.equal(pads.find((r) => r.name.includes('sess-gone'))?.verdict, 'safe');
  assert.equal(v('office/stray-11'), 'safe');
  assert.deepEqual(row(report, 'office/stray-11').removes, ['folder', 'branch', 'origin']);
  assert.equal(v('office/stray-13'), 'work');
  assert.match(row(report, 'office/stray-13').why, /1 edited file git has nowhere else/);

  // The suggestion: delete exactly the safe rows, and a command that deletes just those.
  const want = ['office/done-10', 'office/merged-1', 'office/stray-11', pads.find((r) => r.name.includes('sess-gone'))!.name].sort();
  assert.deepEqual(report.suggested.delete.map((r) => r.name).sort(), want);
  for (const r of report.rows) assert.equal(r.suggest === 'delete', r.verdict === 'safe', `${r.name}: only safe rows are suggested for deleting`);
  assert.deepEqual(report.suggested.look, [], 'nothing has sat a week yet');
  const text = renderReport(report, false, 'cleanbot');
  assert.match(text, /🗑 Suggested to delete \(4, safe/);
  assert.ok(text.includes(`office-cleanbot delete ${report.suggested.delete.map((r) => r.name).join(',')}`), text);
  assert.match(text, /Nothing was deleted/);
  assert.match(renderReport(report, false), /agent-office prune --floor --only /);
  // Listing deletes nothing.
  assert.ok(existsSync(m1.abs));
  assert.ok(git(f.root, 'branch', '--list', m1.branch));

  // A week on, the unshipped work is worth a look (the person decides); still never suggested for deleting.
  const later = await f.run({ now: () => Date.now() + LOOK_MS + DAY, fetch: false });
  assert.equal(row(later, 'office/unshipped-6').suggest, 'look');
  assert.ok(later.suggested.look.some((r) => r.name === 'office/unshipped-6'));
  assert.ok(!later.suggested.delete.some((r) => r.name === 'office/unshipped-6'));
});

test('fresh and recently changed rows are kept', { timeout: 600_000 }, async (t) => {
  const f = fixture(t);
  const m = f.merged('merged-1');
  f.pr(1, m.branch, 'MERGED');
  // Made moments ago: may be a worker being hired whose workers.json entry isn't saved yet.
  const now = await f.run({ now: () => Date.now() });
  assert.equal(row(now, m.branch).verdict, 'new');
  assert.equal(row(now, m.branch).suggest, 'keep');
  // Two hours on: past the hiring window, but its files changed within the day.
  const soon = await f.run({ now: () => Date.now() + 2 * 60 * 60_000, fetch: false });
  assert.equal(row(soon, m.branch).verdict, 'recent');
  assert.match(row(soon, m.branch).why, /something may still be using it/);
});

test('deleting: only the rows named, each checked again right before it goes, and a log of the run', { timeout: 600_000 }, async (t) => {
  const f = fixture(t);
  const a = f.merged('a-1');
  f.pr(1, a.branch, 'MERGED');
  const live = f.hire('live-2');
  const open = f.hire('open-3');
  commit(open.abs, 'o.txt', 'o\n', 'open');
  git(open.abs, 'push', '-q', 'origin', open.branch);
  f.pr(3, open.branch, 'OPEN');
  const dirty = f.merged('dirty-4');
  f.pr(4, dirty.branch, 'MERGED');
  writeFileSync(path.join(dirty.abs, 'app.txt'), 'unsaved\n');
  const needed = f.merged('needed-5');
  f.pr(5, needed.branch, 'MERGED');
  const hired = f.merged('hired-6');
  f.pr(6, hired.branch, 'MERGED');
  const dry = f.merged('dry-7');
  f.pr(7, dry.branch, 'MERGED');
  f.workers.push({ name: 'Pixel', deskId: 'desk-1', worktree: { path: live.path, branch: live.branch } }, { name: 'VP', deskId: 'station-vp', ask: { latest: 'Verifying pull request #5 now' } });
  f.saveWorkers();

  // hired-6 gets a worker between the table and the deletion: the check right before it goes sees it.
  let asked = 0;
  const office = async () => {
    if (++asked > 1) {
      f.workers.push({ name: 'Dot', deskId: 'desk-2', worktree: { path: hired.path, branch: hired.branch } });
      f.saveWorkers();
    }
    return f.office();
  };
  const only = [a.branch, live.branch, open.branch, dirty.branch, needed.branch, hired.branch, 'office/nope'];
  const report = await f.run({ only, office });
  const run = report.run!;
  assert.deepEqual(run.removed.filter((s) => s.name === a.branch).map((s) => s.what), ['worktree', 'branch']);
  assert.ok(!existsSync(a.abs), 'its worktree folder is gone');
  assert.equal(git(f.root, 'branch', '--list', a.branch), '', 'its branch is gone');
  assert.ok(git(f.root, 'ls-remote', 'origin', a.branch), "GitHub's copy stays without --remote");
  const refused = (name: string) => run.refused.find((r) => r.name === name)?.why ?? '';
  assert.match(refused(live.branch), /live worker's/);
  assert.match(refused(open.branch), /open PR/);
  assert.match(refused(dirty.branch), /holds work.*--discard deletes it anyway/);
  assert.match(refused(needed.branch), /still needed: the VP is working on it/);
  assert.match(refused(hired.branch), /live worker's: Dot/);
  assert.match(refused('office/nope'), /no such row/);
  for (const w of [live, open, dirty, needed, hired]) assert.ok(existsSync(w.abs), `${w.branch} is still there`);
  const log = readFileSync(path.join(f.root, '.agent-office', 'cleanup-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].by, 'test');
  assert.ok(log[0].removed.some((s: { name: string }) => s.name === a.branch));

  // --discard deletes a row that holds work, once it's named, losing that; --remote takes GitHub's copy of a merged one.
  const discarded = await f.run({ only: [dirty.branch], discard: [dirty.branch], remote: true });
  assert.deepEqual(discarded.run!.removed.map((s) => s.what), ['worktree', 'branch', 'origin']);
  assert.ok(!existsSync(dirty.abs));
  assert.equal(git(f.root, 'ls-remote', 'origin', dirty.branch), '');
  // --keep wins over --only, and a dry run changes nothing.
  const kept = await f.run({ only: [dry.branch], keep: [dry.branch], fetch: false });
  assert.match(kept.run!.refused[0].why, /named in --keep/);
  const dryRun = await f.run({ only: [dry.branch], dryRun: true, fetch: false });
  assert.deepEqual(dryRun.run!.removed.map((s) => s.what), ['worktree', 'branch']);
  assert.ok(existsSync(dry.abs), 'a dry run deletes nothing');
  assert.equal(readFileSync(path.join(f.root, '.agent-office', 'cleanup-log.jsonl'), 'utf8').trim().split('\n').length, 2, 'dry runs are not logged');
});

test('what names a row: its branch, its seat, or its PR (in its own repository)', () => {
  const rowOf = { branch: 'office/nibble-c2af', worktree: { path: '.agent-office/worktrees/nibble-c2af', kind: 'office' }, pr: { number: 92 } };
  const need = (text: string, repo?: string) => neededBy([{ what: 'x', text, ...(repo ? { repo } : {}) }], rowOf, 'test/floor');
  assert.ok(need('please continue office/nibble-c2af.'));
  assert.ok(need('`office/nibble-c2af`'));
  assert.ok(need('carry on in the nibble-c2af worktree'));
  assert.ok(need('Sync button PR is open: #92'));
  assert.ok(need('see PR 92'));
  assert.ok(need('https://github.com/test/floor/pull/92'));
  assert.ok(!need('office/nibble-c2af-2 is another branch'));
  assert.ok(need('.agent-office/worktrees/nibble-c2af/src/app.ts'), 'a path into its folder');
  assert.ok(!need('#920 and #9'));
  assert.ok(!need('fix #92', 'other/repo'), "a task for another repository's #92");
  assert.ok(need('fix #92', 'Test/Floor'));
});

test('the suggestion never says delete for anything but a safe row nobody pinned', () => {
  const now = Date.now();
  const old = new Date(now - LOOK_MS - DAY).toISOString();
  assert.equal(suggestFor({ verdict: 'safe' }, now), 'delete');
  assert.equal(suggestFor({ verdict: 'safe', kept: 'always' }, now), 'keep');
  assert.equal(suggestFor({ verdict: 'work', lastCommit: old, changed: old }, now), 'look');
  assert.equal(suggestFor({ verdict: 'work', lastCommit: old, changed: new Date(now).toISOString() }, now), 'keep');
  for (const verdict of ['needed', 'worker', 'open-pr', 'recent', 'new', 'protected', 'not-office'] as const) assert.equal(suggestFor({ verdict, lastCommit: old }, now), 'keep', verdict);
});
