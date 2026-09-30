import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UsageError } from '../bin/office-queue.js';
import { buildRequest, main, parseArgs } from '../bin/office-cleanbot.js';
import { handleCleanbot } from '../src/server/cleanbot.js';
import { CLEANBOT_DISALLOWED_COMMANDS, stationBrief, stationDisallowedTools } from '../src/server/stations.js';
import { BOTS, botDesk } from '../src/shared/bots.js';
import { STATIONS } from '../src/shared/layout.js';

const ENV = { AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:4455', AGENT_OFFICE_WORKER_ID: 'cb1', AGENT_OFFICE_HOOK_TOKEN: 'tok' };
const OFFICE = { url: 'http://127.0.0.1:4455', worker: 'cb1', token: 'tok' };

test('office-cleanbot parses its commands, and has no blanket force', () => {
  assert.deepEqual(parseArgs([]), { cmd: 'help' });
  assert.deepEqual(parseArgs(['list']), { cmd: 'list', json: false, names: [] });
  assert.deepEqual(parseArgs(['list', '--repo', 'app', '--recent', '48', '--json']), { cmd: 'list', json: true, names: [], repo: 'app', recent: 48 });
  assert.deepEqual(parseArgs(['delete', 'office/a,office/b', 'office/c', '--dry-run']), { cmd: 'delete', json: false, names: ['office/a', 'office/b', 'office/c'], dryRun: true });
  assert.deepEqual(parseArgs(['delete', 'office/a', '--discard=office/a', '--remote']), { cmd: 'delete', json: false, names: ['office/a'], discard: ['office/a'], remote: true });
  assert.deepEqual(parseArgs(['keep', 'office/a']), { cmd: 'keep', json: false, names: ['office/a'] });
  const bad: [string[], RegExp][] = [
    [['frob'], /Unknown command/],
    [['delete'], /Say which rows to delete/],
    [['delete', 'office/a', '--force'], /there is no --force/],
    [['delete', 'office/a', '-f'], /there is no --force/],
    [['delete', 'office/a', '--discard', 'office/b'], /--discard only applies to rows you also name/],
    [['list', 'office/a'], /list takes no names/],
    [['list', '--recent', 'soon'], /--recent takes a number of hours/],
    [['keep'], /Say which/],
  ];
  for (const [argv, re] of bad) assert.throws(() => parseArgs(argv), (e: Error) => e instanceof UsageError && re.test(e.message), argv.join(' '));
});

test('builds the /office/cleanbot requests', () => {
  const auth = { authorization: 'Bearer tok' };
  assert.deepEqual(buildRequest(parseArgs(['list', '--repo', 'app', '--no-fetch']), OFFICE), { method: 'GET', url: 'http://127.0.0.1:4455/office/cleanbot?worker=cb1&view=list&repo=app&fetch=0', headers: auth });
  const del = buildRequest(parseArgs(['delete', 'office/a', '--discard', 'office/a', '--remote']), OFFICE);
  assert.equal(del.method, 'POST');
  assert.deepEqual(JSON.parse(del.body!), { action: 'delete', only: ['office/a'], discard: ['office/a'], remote: true, dryRun: false });
  assert.deepEqual(JSON.parse(buildRequest(parseArgs(['forget', 'office/a', '--repo', 'app']), OFFICE).body!), { action: 'forget', names: ['office/a'], repo: 'app' });
});

test('office-cleanbot prints the office\'s table, and fails when a named row was kept', async () => {
  const calls: string[] = [];
  const fetch = (async (url: string, init: { method: string; body?: string }) => {
    calls.push(`${init.method} ${url}`);
    const run = init.method === 'POST' ? { removed: [{ what: 'worktree', name: 'office/a' }], failed: [], refused: [{ name: 'office/b', why: "live worker's: Pixel" }] } : undefined;
    return new Response(JSON.stringify({ report: { run }, text: init.method === 'POST' ? 'removed office/a; kept office/b' : '🗑 Suggested to delete (1): 1 office/a' }), { status: 200 });
  }) as unknown as typeof fetch;
  const out: string[] = [];
  assert.equal(await main(['list'], { env: ENV, fetch, out: (s) => out.push(s), err: () => {} }), 0);
  assert.match(out.join('\n'), /Suggested to delete/);
  assert.match(calls[0], /^GET http:\/\/127\.0\.0\.1:4455\/office\/cleanbot\?worker=cb1&view=list$/);
  assert.equal(await main(['delete', 'office/a,office/b'], { env: ENV, fetch, out: (s) => out.push(s), err: () => {} }), 1, 'a refused row is a failure to report');
  const refused = (async () => new Response(JSON.stringify({ error: 'Only CleanBot can use office-cleanbot' }), { status: 403 })) as unknown as typeof fetch;
  const err: string[] = [];
  assert.equal(await main(['list'], { env: ENV, fetch: refused, out: () => {}, err: (s) => err.push(s) }), 1);
  assert.match(err[0], /office-cleanbot: The office said no \(403\): Only CleanBot can use office-cleanbot/);
});

test('CleanBot is a deployable bot with his own kiosk, brief and command, and no way to delete by hand', () => {
  const bot = BOTS.cleanbot;
  assert.equal(bot.name, 'CleanBot');
  assert.match(bot.deployPrompt, /office-cleanbot list/);
  assert.match(bot.deployPrompt, /what you suggest deleting/);
  assert.match(bot.deployPrompt, /Don't delete anything until I say so/);
  assert.ok(STATIONS.some((s) => s.id === botDesk('cleanbot') && s.station === 'cleanbot'));
  const brief = stationBrief('cleanbot');
  assert.match(brief, /office-cleanbot list/);
  assert.match(brief, /office-cleanbot delete <names>/);
  assert.match(brief, /what you suggest deleting|suggest deleting/);
  assert.match(brief, /the PR agent, the VP or a queued task/);
  assert.match(brief, /Never add a row they didn't choose/);
  assert.doesNotMatch(brief, /curl|\/office\/cleanbot|AGENT_OFFICE_HOOK_TOKEN/);
  assert.ok(brief.endsWith('The request:'));
  const denied = stationDisallowedTools('cleanbot');
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Bash(git branch -D:*)', 'Bash(git worktree remove:*)', 'Bash(git push:*)', 'Bash(rm:*)']) assert.ok(denied.includes(tool), tool);
  assert.deepEqual(denied.slice(3), CLEANBOT_DISALLOWED_COMMANDS);
  assert.deepEqual(stationDisallowedTools('vp'), ['Edit', 'Write', 'NotebookEdit'], "the VP's tools are as they were");
});

test('the endpoint checks what it is asked, runs one sweep per floor at a time, and answers with the table as text', { timeout: 300_000 }, async (t) => {
  const top = realpathSync(mkdtempSync(path.join(tmpdir(), 'cleanbot-ep-')));
  t.after(() => rmSync(top, { recursive: true, force: true, maxRetries: 3 }));
  const home = process.env.AGENT_OFFICE_HOME;
  process.env.AGENT_OFFICE_HOME = path.join(top, 'home');
  t.after(() => (home === undefined ? delete process.env.AGENT_OFFICE_HOME : (process.env.AGENT_OFFICE_HOME = home)));
  const root = path.join(top, 'floor');
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'personal');
  writeFileSync(path.join(root, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('branch', 'office/left-behind');
  const office = async () => ({ floors: [{ name: 'Test', dir: root }], busy: [] });
  const req = (method: string, body?: Record<string, unknown>, query = '') => handleCleanbot({ method, query: new URLSearchParams(query), body, floorDir: root, by: 'CleanBot, asked by Michael', office, prune: { now: () => Date.now() + 3 * 86_400_000 } });

  assert.deepEqual((await req('POST', { action: 'delete', only: [] })).status, 400);
  assert.match(JSON.stringify((await req('POST', { action: 'delete', only: ['office/a'], discard: ['office/b'] })).body), /--discard only applies to rows you also name/);
  assert.equal((await req('GET', undefined, 'view=list&recent=soon')).status, 400);
  assert.equal((await req('POST', { action: 'wipe' })).status, 400);
  assert.deepEqual((await req('GET', undefined, 'view=office')).body, await office());

  // Two at once on the same floor: the second is told to wait.
  const [a, b] = await Promise.all([req('GET', undefined, 'view=list'), req('GET', undefined, 'view=list')]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const ok = (a.status === 200 ? a : b).body as { text: string; report: { suggested: { delete: { name: string }[] } } };
  assert.match(ok.text, /🧹 CleanBot/);
  assert.deepEqual(ok.report.suggested.delete.map((r) => r.name), ['office/left-behind']);
  assert.match(ok.text, /office-cleanbot delete office\/left-behind/);
  assert.match(JSON.stringify((a.status === 409 ? a : b).body), /already running a list/);

  // Pins are remembered for the floor, and the next list keeps them.
  const pin = await req('POST', { action: 'keep', names: ['office/left-behind'] });
  assert.deepEqual(pin.body, { ok: true, repos: [{ repo: '.', alwaysKeep: ['office/left-behind'] }] });
  const after = (await req('GET', undefined, 'view=list')).body as { report: { rows: { name: string; kept?: string; suggest: string }[] } };
  const r = after.report.rows.find((x) => x.name === 'office/left-behind')!;
  assert.equal(r.kept, 'always');
  assert.equal(r.suggest, 'keep');
});
