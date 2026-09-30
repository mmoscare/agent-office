import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChangeNotes, PlainWriter, claudeSummarizer, cleanNotes, describeChanges, floorSources, inTurn, parseLines, tidyTitle, type PlainInput, type Summarize } from '../src/server/change-notes.js';
import { mergedPulls } from '../src/server/github-rest.js';
import { WHATS_NEW_SEEN, byDay, dayLabel, markSeen, seenAt, seenKey, type WhatsNew } from '../src/shared/whats-new.js';

// No real Claude or GitHub here: the summarizer and gh are stand-ins, and fetching is switched off.
// The history is built once (git is slow to start on Windows) and only read; each test keeps its
// lines in a data folder of its own.

/** Seconds since the epoch of the fixture's first commit. */
const T0 = 1_760_000_000;
const at = (s: number) => (T0 + s) * 1000;

type Git = (args: string[], when?: number) => string;

const root = mkdtempSync(path.join(tmpdir(), 'office-notes-'));
// A background read may still be starting git in there: retry the way Windows needs.
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

const gitIn =
  (dir: string): Git =>
  (args, when) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(when === undefined ? {} : { GIT_AUTHOR_DATE: `${T0 + when} +0000`, GIT_COMMITTER_DATE: `${T0 + when} +0000` }) },
    }).trim();

/** A folder for a test's whats-new.json. */
const dataDir = () => mkdtempSync(path.join(root, 'data-'));

/** A git repository to build history in. Commits are dated T0 + `when` seconds. */
function fixture() {
  const dir = mkdtempSync(path.join(root, 'project-'));
  const git = gitIn(dir);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Notes Test']);
  git(['config', 'user.email', 'notes@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', path.join(dir, '.no-hooks')]);
  let n = 0;
  const commit = (message: string, when: number) => {
    writeFileSync(path.join(dir, `change-${++n}.txt`), `${message}\n`);
    git(['add', '-A']);
    git(['commit', '-q', '-m', message], when);
    return git(['rev-parse', 'HEAD']);
  };
  const merge = (branch: string, when: number, ...message: string[]) => {
    git(['merge', '-q', '--no-ff', branch, ...message.flatMap((m) => ['-m', m])], when);
    return git(['rev-parse', 'HEAD']);
  };
  return { dir, git, commit, merge };
}

/**
 * main, oldest first: a first commit; a pull request merged on GitHub; a commit pushed straight to
 * main; a squash-merged one; the author's updates; a `git pull` that brought another pull request;
 * a direct commit; and a branch merged by hand. Built once.
 */
let built: ReturnType<typeof build> | undefined;
const history = () => (built ??= build());

function build() {
  const f = fixture();
  const { git, commit, merge } = f;
  const first = commit('Initial scaffold', 0);
  git(['checkout', '-q', '-b', 'feature/notepad']);
  commit('Add the notepad', 10);
  git(['checkout', '-q', 'main']);
  const notepad = merge('feature/notepad', 20, 'Merge pull request #1 from me/feature/notepad', 'A notepad you can click');
  const typo = commit('fix: typo on the help screen', 30);
  const logos = commit('Show logos above task cards (#2)', 40);
  git(['checkout', '-q', '-b', 'author', first]);
  commit('A jukebox in the lounge (#75)', 45);
  commit('Day and night outside the windows (#76)', 46);
  git(['checkout', '-q', 'main']);
  const author = merge('author', 50, "Merge remote-tracking branch 'upstream/main' into main");
  // GitHub's copy of main got a pull request while this one got a commit; `git pull` merged them.
  git(['checkout', '-q', '-b', 'github-main']);
  git(['checkout', '-q', '-b', 'feature/wave']);
  commit('Wave goodbye', 55);
  git(['checkout', '-q', 'github-main']);
  const wave = merge('feature/wave', 60, 'Merge pull request #3 from me/feature/wave', 'Clock workers out with a wave');
  git(['checkout', '-q', 'main']);
  const readme = commit('Tidy the README', 58);
  const pull = merge('github-main', 70, "Merge branch 'main' of https://github.com/me/app into main");
  git(['checkout', '-q', '-b', 'feature/bells']);
  commit('Ring a bell when a task is done', 75);
  git(['checkout', '-q', 'main']);
  const bells = merge('feature/bells', 80, "Merge branch 'feature/bells'");
  return { ...f, sha: { first, notepad, typo, logos, author, wave, readme, pull, bells } };
}

/** A repository at `dir` whose main has these commits, oldest first, dated T0 + `start` s on: one `git fast-import`. */
function tinyRepo(dir: string, messages: string[], start = 100) {
  mkdirSync(dir, { recursive: true });
  gitIn(dir)(['init', '-q', '-b', 'main']);
  const data = (s: string) => `data ${Buffer.byteLength(s)}\n${s}\n`;
  const stream = messages
    .map((m, i) => `commit refs/heads/main\nmark :${i + 1}\ncommitter Test <t@example.invalid> ${T0 + start + i} +0000\n${data(m)}${i ? `from :${i}\n` : ''}M 644 inline f${i}.txt\n${data(m)}`)
    .join('');
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, input: stream, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
}

/** A summarizer that writes "Plain: <title>", counting its calls; `fail` makes every call fail. */
function stub(fail = false) {
  const calls: PlainInput[][] = [];
  const summarize: Summarize = async (items) => {
    calls.push(items);
    return fail ? null : items.map((i) => `Plain: ${i.title}.`);
  };
  return { calls, summarize };
}

const noFetch = { fetch: async () => {} };

/** Asks until nothing is waiting to be written (or GitHub asked). */
async function whenWritten(notes: ChangeNotes, show?: number): Promise<WhatsNew> {
  for (let i = 0; i < 200; i++) {
    await notes.settled();
    const r = await notes.list(show);
    if (!r.writing && !r.refreshing) return r;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('still writing');
}

test('a floor without GitHub: its first-parent history, pull requests, direct commits, the author and a pull read through', async () => {
  const h = history();
  const notes = new ChangeNotes('f1', dataDir(), () => [{ dir: h.dir }], new PlainWriter(null), noFetch);
  const r = await whenWritten(notes);
  assert.equal(r.branch, 'main');
  assert.equal(r.total, 8);
  assert.deepEqual(
    r.notes.map((n) => [n.key, n.title, n.text, n.at, !!n.author]),
    [
      [`commit:${h.sha.bells}`, "Merge branch 'feature/bells'", 'Brought in the work on “feature/bells”.', at(80), false],
      [`commit:${h.sha.wave}`, 'Clock workers out with a wave', 'Clock workers out with a wave.', at(60), false],
      [`commit:${h.sha.readme}`, 'Tidy the README', 'Tidy the README.', at(58), false],
      [`commit:${h.sha.author}`, "Merge remote-tracking branch 'upstream/main' into main", "Brought in the original author's latest updates.", at(50), true],
      [`commit:${h.sha.logos}`, 'Show logos above task cards', 'Show logos above task cards.', at(40), false],
      [`commit:${h.sha.typo}`, 'fix: typo on the help screen', 'Typo on the help screen.', at(30), false],
      [`commit:${h.sha.notepad}`, 'A notepad you can click', 'A notepad you can click.', at(20), false],
      [`commit:${h.sha.first}`, 'Initial scaffold', 'Initial scaffold.', at(0), false],
    ],
  );
  // The `git pull` itself isn't a change; the branch's own commits never show; nothing links anywhere.
  assert.ok(!r.notes.some((n) => n.key.includes(h.sha.pull) || n.url));
  assert.ok(r.notes.every((n) => !n.plain));
  assert.match(r.writer ?? '', /isn't set up/);
  assert.equal(r.error, undefined);
});

test('a GitHub floor: merged pull requests over REST tell of their merges, keys stay the commits, and one merged since the last fetch comes too', async () => {
  const h = history();
  // A copy of it whose origin is on GitHub; fetching is switched off, so it's never asked.
  const dir = path.join(root, 'github-copy');
  execFileSync('git', ['clone', '-q', '--no-hardlinks', h.dir, dir], { windowsHide: true, stdio: 'ignore' });
  gitIn(dir)(['remote', 'set-url', 'origin', 'https://github.com/me/app.git']);
  const data = dataDir();
  const pr = (number: number, sha: string | null, mergedAt: number | null, title: string, head: string, body = '') => ({
    number,
    title,
    body,
    html_url: `https://github.com/me/app/pull/${number}`,
    merged_at: mergedAt === null ? null : new Date(at(mergedAt)).toISOString(),
    updated_at: new Date(at(mergedAt ?? 90)).toISOString(),
    merge_commit_sha: sha,
    head: { ref: head },
  });
  const pulls = [
    pr(5, 'e'.repeat(40), 100, 'Hiring no longer waits for the repository list', 'office/fix-hire', 'Fixes the hang.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'),
    pr(3, h.sha.wave, 60, 'Clock workers out with a wave instead of a layoff', 'feature/wave'),
    // The fork's own #2, merged somewhere this history doesn't have: never the squashed "(#2)" here.
    pr(2, 'd'.repeat(40), 39, 'Something else entirely', 'office/other'),
    pr(1, h.sha.notepad, 20, 'Add a notepad you can click to jot notes', 'feature/notepad', '## Summary\n<!-- hidden -->A notepad on the desk. ![shot](x.png) See [the doc](https://x).'),
    pr(4, null, null, 'Closed without merging', 'office/nope'),
  ];
  const calls: string[][] = [];
  const query = async (args: string[]) => {
    calls.push(args);
    return `HTTP/2.0 200 OK\r\nx-ratelimit-remaining: 4999\r\n\r\n${JSON.stringify(pulls)}`;
  };
  const notes = new ChangeNotes('f2', data, () => [{ dir }], new PlainWriter(null), { query, ...noFetch });
  const before = await notes.list();
  assert.equal(before.refreshing, true);
  assert.equal(before.notes[0].url, `https://github.com/me/app/commit/${h.sha.bells}`);
  await notes.settled();
  const r = await notes.list();
  assert.deepEqual(calls, [['api', '-i', 'repos/me/app/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=1']]);
  assert.equal(r.total, 9);
  const by = new Map(r.notes.map((n) => [n.key, n]));
  const newest = r.notes[0];
  assert.deepEqual([newest.key, newest.title, newest.url, newest.at], ['pr:5', 'Hiring no longer waits for the repository list', 'https://github.com/me/app/pull/5', at(100)]);
  assert.equal(by.get(`commit:${h.sha.notepad}`)?.title, 'Add a notepad you can click to jot notes');
  assert.equal(by.get(`commit:${h.sha.notepad}`)?.url, 'https://github.com/me/app/pull/1');
  assert.equal(by.get(`commit:${h.sha.wave}`)?.title, 'Clock workers out with a wave instead of a layoff');
  assert.equal(by.get(`commit:${h.sha.logos}`)?.title, 'Show logos above task cards');
  assert.equal(by.get(`commit:${h.sha.logos}`)?.url, `https://github.com/me/app/commit/${h.sha.logos}`);
  assert.ok(!r.notes.some((n) => /Something else|Closed without/.test(n.title)));
  // What GitHub said is kept, its descriptions without the markup.
  const stored = JSON.parse(readFileSync(path.join(data, 'whats-new.json'), 'utf8'));
  assert.equal(stored.pulls[''].base, 'main');
  assert.equal(stored.pulls[''].items.find((p: { number: number }) => p.number === 1).body, 'Summary\nA notepad on the desk. See the doc.');
  assert.equal(stored.pulls[''].items.find((p: { number: number }) => p.number === 5).body, 'Fixes the hang.');
});

test('each change is put in plain words once, only when shown, and kept: a second look (and a restart) asks nobody', async () => {
  const h = history();
  const data = dataDir();
  const first = stub();
  const notes = new ChangeNotes('f3', data, () => [{ dir: h.dir }], new PlainWriter(first.summarize), noFetch);
  // Only the three shown are written.
  const three = await whenWritten(notes, 3);
  assert.equal(first.calls.length, 1);
  assert.deepEqual(first.calls[0].map((i) => i.title), ["Merge branch 'feature/bells'", 'Clock workers out with a wave', 'Tidy the README']);
  // A merge with few notes says what it brought in; notes that only repeat the title are left out.
  assert.match(first.calls[0][0].about, /What it brought in:\n- Ring a bell when a task is done/);
  assert.equal(first.calls[0][1].about, 'What it brought in:\n- Wave goodbye');
  assert.deepEqual(three.notes.map((n) => [n.text, n.plain]), [
    ["Plain: Merge branch 'feature/bells'.", true],
    ['Plain: Clock workers out with a wave.', true],
    ['Plain: Tidy the README.', true],
  ]);
  const all = await whenWritten(notes);
  assert.equal(first.calls.length, 2);
  assert.ok(all.notes.every((n) => n.plain));
  const author = first.calls[1].find((i) => i.author);
  assert.match(author?.about ?? '', /- A jukebox in the lounge \(#75\)/);
  await whenWritten(notes);
  assert.equal(first.calls.length, 2, 'a second look asks nobody');

  const again = stub();
  const restarted = new ChangeNotes('f3', data, () => [{ dir: h.dir }], new PlainWriter(again.summarize), noFetch);
  const r = await whenWritten(restarted);
  assert.equal(again.calls.length, 0, 'the lines were kept in whats-new.json');
  assert.deepEqual(r.notes.map((n) => n.text), all.notes.map((n) => n.text));
  assert.ok(existsSync(path.join(data, 'whats-new.json')));
});

test('when the summarizer fails the titles stay, tidied up, and after a few failures it rests', async () => {
  const h = history();
  const failing = stub(true);
  const notes = new ChangeNotes('f4', dataDir(), () => [{ dir: h.dir }], new PlainWriter(failing.summarize), noFetch);
  let r = await whenWritten(notes);
  for (let i = 0; i < 5 && !r.writer; i++) r = await whenWritten(notes);
  // Two calls run at once, so the one beside the third failure may fail too.
  const calls = failing.calls.length;
  assert.ok(calls >= 3 && calls <= 4, `${calls} calls`);
  assert.match(r.writer ?? '', /didn't answer/);
  assert.ok(r.notes.every((n) => !n.plain));
  assert.equal(r.notes[5].text, 'Typo on the help screen.');
  await whenWritten(notes);
  assert.equal(failing.calls.length, calls, 'resting: no more calls');
  // A summarizer that throws is a failure too, not a crash.
  const throwing = new ChangeNotes('f5', dataDir(), () => [{ dir: h.dir }], new PlainWriter(async () => { throw new Error('boom'); }), noFetch);
  assert.ok((await whenWritten(throwing)).notes.every((n) => !n.plain));
});

test("nothing is written while today's budget is spent, or without Claude", async () => {
  const s = stub();
  const writer = new PlainWriter(s.summarize, () => true);
  writer.want([{ id: 'x|a', input: async () => ({ title: 'A', about: '' }), done: () => assert.fail('written') }]);
  assert.equal(writer.writing('x|'), 0);
  assert.match(writer.resting ?? '', /budget is spent/);
  assert.equal(s.calls.length, 0);
  assert.equal(claudeSummarizer(null, {}), null);
  assert.match(new PlainWriter(null).resting ?? '', /isn't set up/);
});

test('the stubbed CLI answer becomes a line per change; bad answers are failures', () => {
  const out = JSON.stringify({ type: 'result', is_error: false, structured_output: { lines: [{ id: 'c2', line: 'you can now wave' }, { id: 'c1', line: '  "Hiring no longer gets stuck"  ' }, { id: 'c9', line: 'stray' }] } });
  assert.deepEqual(parseLines(out, 3), ['Hiring no longer gets stuck.', 'You can now wave.', undefined]);
  assert.deepEqual(parseLines(JSON.stringify({ result: '```json\n{"lines":[{"id":"c1","line":"A notepad!"}]}\n```' }), 1), ['A notepad!']);
  assert.equal(parseLines(JSON.stringify({ is_error: true, result: 'Not logged in' }), 1), null);
  assert.equal(parseLines('not json', 1), null);
  assert.equal(parseLines(JSON.stringify({ structured_output: { lines: [] } }), 1), null);
  // A line about the job, not the change, is never kept: it's asked for again another time.
  const refusing = JSON.stringify({ structured_output: { lines: [{ id: 'c1', line: 'Unable to write - needs clarification on feature context.' }, { id: 'c2', line: 'Fixed a bug where you were unable to open the terminal.' }] } });
  assert.deepEqual(parseLines(refusing, 2), [undefined, 'Fixed a bug where you were unable to open the terminal.']);
  assert.equal(parseLines(JSON.stringify({ structured_output: { lines: [{ id: 'c1', line: 'Needs more context to describe this.' }] } }), 1), null);
  const told = describeChanges([{ title: 'Add a notepad', about: 'A notepad on the desk.' }, { title: 'Bring in the latest', about: '', author: true }]);
  assert.equal(told, "Change c1\nTitle: Add a notepad\nNotes:\nA notepad on the desk.\n\nChange c2\nTitle: Bring in the latest\n(This brings in the original author's latest updates.)");
});

test('titles are tidied into sentences; notes lose their markup', () => {
  assert.equal(tidyTitle('feat(ui): add a notepad (#12)'), 'Add a notepad.');
  assert.equal(tidyTitle('[WIP] Show logos above task cards.'), 'Show logos above task cards.');
  assert.equal(tidyTitle('Merge the two settings pages'), 'Merge the two settings pages.');
  assert.equal(tidyTitle("Merge remote-tracking branch 'origin/office/sprocket-5cf7' into personal"), 'Brought in the work on “office/sprocket-5cf7”.');
  assert.equal(tidyTitle("Bring in the author's latest through 44aecc1", true), "Brought in the original author's latest updates.");
  assert.equal(tidyTitle('   '), 'A change without a description.');
  assert.equal(cleanNotes('# Title\n\n```ts\ncode()\n```\nSee <b>this</b>.\n\nCo-Authored-By: X <x@y>'), 'Title\nSee this .');
  assert.equal(cleanNotes('a'.repeat(20), 10), `${'a'.repeat(9)}…`);
});

test('merged pull requests are paged until they reach back past the last look', async () => {
  const dir = mkdtempSync(path.join(root, 'rest-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:me/app.git'], { cwd: dir });
  const page = (from: number, count: number, updated: number) =>
    Array.from({ length: count }, (_, i) => ({ number: from - i, title: `#${from - i}`, merged_at: i % 2 ? null : new Date(updated).toISOString(), updated_at: new Date(updated).toISOString(), head: { ref: 'x' }, html_url: '' }));
  const asked: string[] = [];
  const query = async (args: string[]) => {
    const p = args[args.length - 1];
    asked.push(p.replace(/^.*page=/, 'page '));
    return JSON.stringify(p.endsWith('page=1') ? page(300, 100, at(500)) : p.endsWith('page=2') ? page(200, 100, at(100)) : page(100, 3, at(50)));
  };
  const all = await mergedPulls('personal', dir, query);
  assert.deepEqual(asked, ['page 1', 'page 2', 'page 3']);
  assert.equal(all.pulls.length, 102);
  assert.equal(all.complete, true);
  assert.equal(all.web, 'https://github.com/me/app');
  asked.length = 0;
  const since = await mergedPulls('personal', dir, query, at(200));
  assert.deepEqual(asked, ['page 1', 'page 2'], 'page 2 reaches back past the last look');
  assert.equal(since.complete, true);
  asked.length = 0;
  assert.equal((await mergedPulls('personal', dir, query, 0, 1)).complete, false);
});

test('a floor that is a folder of repositories: GitHub ones and local-only ones alike, each under its own path', async () => {
  const h = history();
  const folder = mkdtempSync(path.join(root, 'folder-'));
  // A GitHub repository (a copy of the history), a local-only one two levels down, one with no commits
  // yet, and a checkout inside node_modules that isn't the floor's.
  const app = path.join(folder, 'app');
  execFileSync('git', ['clone', '-q', '--no-hardlinks', h.dir, app], { windowsHide: true, stdio: 'ignore' });
  gitIn(app)(['remote', 'set-url', 'origin', 'https://github.com/me/app.git']);
  tinyRepo(path.join(folder, 'tools', 'notes'), ['Start a notes app', 'Notes can be pinned']);
  mkdirSync(path.join(folder, 'empty'));
  gitIn(path.join(folder, 'empty'))(['init', '-q']);
  tinyRepo(path.join(folder, 'node_modules', 'dep'), ['Not ours']);

  const found = await floorSources(folder);
  assert.deepEqual(found.sources.map((s) => s.path), ['app', 'tools/notes']);
  assert.equal(found.truncated, false);

  const calls: string[][] = [];
  const query = async (args: string[]) => {
    calls.push(args);
    return JSON.stringify([{ number: 1, title: 'Add a notepad you can click to jot notes', body: '', html_url: 'https://github.com/me/app/pull/1', merged_at: new Date(at(20)).toISOString(), updated_at: new Date(at(20)).toISOString(), merge_commit_sha: h.sha.notepad, head: { ref: 'feature/notepad' } }]);
  };
  const data = dataDir();
  const notes = new ChangeNotes('f6', data, () => floorSources(folder), new PlainWriter(null), { query, ...noFetch });
  const r = await whenWritten(notes);
  assert.equal(r.error, undefined);
  assert.equal(r.branch, undefined, 'a floor of several has no one branch');
  assert.equal(r.total, 10);
  const byRepo = (repo: string) => r.notes.filter((n) => n.repo === repo);
  assert.equal(byRepo('me/app').length, 8, 'the GitHub one goes by its GitHub name');
  assert.deepEqual(byRepo('tools/notes').map((n) => [n.key.split(' ')[0], n.text]), [
    ['tools/notes', 'Notes can be pinned.'],
    ['tools/notes', 'Start a notes app.'],
  ]);
  assert.ok(r.notes.every((n) => n.key.startsWith(n.repo === 'me/app' ? 'app commit:' : 'tools/notes commit:')));
  // GitHub is asked about the one with a GitHub origin, and its answer kept under its path.
  assert.deepEqual(calls.map((c) => c[c.length - 1].split('?')[0]), ['repos/me/app/pulls']);
  assert.equal(r.notes.find((n) => n.key === `app commit:${h.sha.notepad}`)?.title, 'Add a notepad you can click to jot notes');
  assert.ok(JSON.parse(readFileSync(path.join(data, 'whats-new.json'), 'utf8')).pulls.app);

  // A folder of local-only repositories has history too.
  const local = new ChangeNotes('f7', dataDir(), () => floorSources(path.join(folder, 'tools')), new PlainWriter(null), noFetch);
  const l = await whenWritten(local);
  assert.equal(l.error, undefined);
  assert.deepEqual(l.notes.map((n) => [n.repo, n.title]), [['notes', 'Notes can be pinned'], ['notes', 'Start a notes app']]);
});

test('every repository on the floor is read, however many, a few at a time', async () => {
  const folder = mkdtempSync(path.join(root, 'many-'));
  const names = Array.from({ length: 11 }, (_, i) => `r${String(i + 1).padStart(2, '0')}`);
  names.forEach((name, i) => tinyRepo(path.join(folder, name), [`Change in ${name}`], 200 + i));
  const notes = new ChangeNotes('f8', dataDir(), () => floorSources(folder), new PlainWriter(null), noFetch);
  const r = await whenWritten(notes);
  assert.equal(r.total, 11);
  assert.deepEqual(new Set(r.notes.map((n) => n.repo)), new Set(names));
  assert.equal(r.notes[0].title, 'Change in r11', 'newest first across them all');

  // At most `limit` at once, each item once, results in order.
  let now = 0;
  let most = 0;
  const done = await inTurn(Array.from({ length: 12 }, (_, i) => i), 3, async (i) => {
    most = Math.max(most, ++now);
    await new Promise((resolve) => setTimeout(resolve, 5 + (i % 4) * 3));
    now--;
    return i * 2;
  });
  assert.equal(most, 3);
  assert.deepEqual(done, Array.from({ length: 12 }, (_, i) => i * 2));
  assert.deepEqual(await inTurn([], 3, async () => 1), []);
});

test("a floor's New marks go by its folder, so an id used again for another folder starts afresh", () => {
  const box = new Map<string, string>();
  const storage = { getItem: (k: string) => box.get(k) ?? null, setItem: (k: string, v: string) => void box.set(k, v) };
  const before = seenKey({ id: 'app', dir: 'C:\\Users\\me\\one\\app\\' });
  const after = seenKey({ id: 'app', dir: 'C:\\Users\\me\\two\\app' });
  assert.equal(before, 'dir:C:/Users/me/one/app');
  assert.notEqual(before, after);
  assert.equal(seenKey({ id: 'app' }), 'id:app');
  markSeen(storage, before, 500);
  assert.equal(seenAt(storage, before), 500);
  assert.equal(seenAt(storage, after), undefined, "the new folder doesn't inherit the old one's mark");
  markSeen(storage, before, 300);
  assert.equal(seenAt(storage, before), 500, 'never moves back');
  markSeen(storage, after, 100);
  assert.deepEqual(JSON.parse(box.get(WHATS_NEW_SEEN)!), { [before]: 500, [after]: 100 });
  // No storage, broken storage or garbage in it: nothing is marked, nothing throws.
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(seenAt(broken, before), undefined);
  assert.doesNotThrow(() => markSeen(broken, before, 1));
  assert.equal(seenAt(undefined, before), undefined);
  box.set(WHATS_NEW_SEEN, '[1,2]');
  assert.equal(seenAt(storage, before), undefined);
});

test('changes go under Today, Yesterday, then their dates', () => {
  const now = new Date(2026, 8, 30, 15, 0).getTime();
  assert.equal(dayLabel(new Date(2026, 8, 30, 0, 5).getTime(), now), 'Today');
  assert.equal(dayLabel(new Date(2026, 8, 29, 23, 59).getTime(), now), 'Yesterday');
  assert.match(dayLabel(new Date(2026, 8, 27, 12).getTime(), now), /27/);
  assert.match(dayLabel(new Date(2025, 0, 2, 12).getTime(), now), /2025/);
  const days = byDay([{ at: now }, { at: now - 3600_000 }, { at: now - 86_400_000 }], now);
  assert.deepEqual(days.map((d) => [d.day, d.notes.length]), [['Today', 2], ['Yesterday', 1]]);
});
