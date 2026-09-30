import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentOfficeRecipe, detectRecipe, exclusive, relatedTests, runLow, tapFailures, verifyMerge, verifySlot } from '../src/server/vp-verify.js';
import { codexFindings, codexPriority } from '../src/server/vp-github.js';

function scratch(t: { after(fn: () => void): void }): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'vpv-')));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

test("node's TAP output gives each failing test with where it's nested, so a base run's failures can be told apart", async (t) => {
  const dir = scratch(t);
  writeFileSync(path.join(dir, 'a.test.mjs'), `import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('outer', async (t) => { await t.test('inner fails', () => assert.equal(1, 2)); await t.test('inner passes', () => {}); });\ntest('top fails', () => { throw new Error('boom'); });\ntest('top passes', () => {});\n`);
  const r = await runLow(process.execPath, ['--test', '--test-reporter=tap', 'a.test.mjs'], dir, 60_000);
  assert.notEqual(r.code, 0);
  const failed = tapFailures(r.out);
  assert.ok(failed.some((f) => /outer › inner fails$/.test(f)), failed.join('\n'));
  assert.ok(failed.some((f) => /top fails$/.test(f)), failed.join('\n'));
  assert.ok(!failed.some((f) => /passes/.test(f)));
});

test('test output it cannot read stays failed, even when the base fails too', async (t) => {
  const dir = scratch(t);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'VP Test');
  git('config', 'user.email', 'vp-test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  // Jest-style output (not TAP): the base already fails one test; the PR breaks another.
  writeFileSync(path.join(dir, 't.js'), "console.log('FAIL src/old.test.js\\n  ● old thing broke'); process.exit(1);\n");
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(path.join(dir, 't.js'), "console.log('FAIL src/old.test.js\\n  ● old thing broke\\nFAIL src/new.test.js\\n  ● the PR broke this'); process.exit(1);\n");
  git('commit', '-q', '-am', 'the PR');
  const head = git('rev-parse', 'HEAD');
  const r = await verifyMerge(
    { repoDir: dir, base, head, label: 'fixture', recipe: { source: 'saved', install: false, steps: [{ name: 'test', node: ['t.js'], baseline: true }] } },
    { pressure: () => undefined, tmpRoot: path.join(dir, 'aovp') },
  );
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'failed');
  assert.equal(r.steps[0].ok, false);
  assert.equal(r.steps[0].baseline, undefined, 'nothing was waved through as a base failure');
});

test('a step that runs too long is stopped with everything it started, and says so', async (t) => {
  const dir = scratch(t);
  writeFileSync(path.join(dir, 'slow.mjs'), `import { spawn } from 'node:child_process';\nspawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });\nsetTimeout(() => {}, 60000);\n`);
  const started = Date.now();
  const r = await runLow(process.execPath, ['slow.mjs'], dir, 1500);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 20_000);
});

test('the related tests: changed tests, tests named after changed files, and tests importing them; never console-shell', (t) => {
  const dir = scratch(t);
  mkdirSync(path.join(dir, 'tests'));
  writeFileSync(path.join(dir, 'tests', 'queue.test.ts'), "import { TaskQueue } from '../src/server/queue.js';\n");
  writeFileSync(path.join(dir, 'tests', 'floor-ish.test.ts'), "import { x } from '../src/server/queue.js';\n");
  writeFileSync(path.join(dir, 'tests', 'other.test.ts'), "import { y } from '../src/server/other.js';\n");
  writeFileSync(path.join(dir, 'tests', 'console-shell.test.ts'), "import { z } from '../src/server/queue.js';\n");
  writeFileSync(path.join(dir, 'tests', 'office-vp.test.ts'), "import { main } from '../bin/office-vp.js';\n");
  assert.deepEqual(relatedTests(dir, ['src/server/queue.ts']), ['tests/floor-ish.test.ts', 'tests/queue.test.ts']);
  assert.deepEqual(relatedTests(dir, ['tests/other.test.ts', 'README.md']), ['tests/other.test.ts']);
  assert.deepEqual(relatedTests(dir, ['bin/office-vp.js']), ['tests/office-vp.test.ts']);
});

test('the recipes: the office checks itself with both typechecks, related tests and a build; other repos with their own scripts', (t) => {
  const r = agentOfficeRecipe();
  assert.deepEqual(r.steps.map((s) => s.name), ['typecheck (server)', 'typecheck (client)', 'related tests', 'build']);
  const dir = scratch(t);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agent-office' }));
  assert.equal(detectRecipe(dir).source, 'agent-office');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'site', scripts: { lint: 'next lint', build: 'next build', test: 'echo "Error: no test specified" && exit 1', typecheck: 'tsc --noEmit' } }));
  assert.deepEqual(detectRecipe(dir).steps.map((s) => s.name), ['typecheck', 'lint', 'build']);
});

test('one verify at a time: the slot is held until the one before finishes', async () => {
  const order: string[] = [];
  const job = (name: string, ms: number) => exclusive(name, async () => {
    order.push(`${name}+`);
    assert.equal(verifySlot().holder, name);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${name}-`);
  });
  await Promise.all([job('a', 60), job('b', 10), job('c', 1)]);
  assert.deepEqual(order, ['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
  assert.equal(verifySlot().holder, undefined);
});

test("Codex's findings: the badge, and when one counts as fixed", () => {
  const body = '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Guard the empty list**\n\nDetails';
  assert.equal(codexPriority(body), 'P1');
  assert.equal(codexPriority('Looks fine'), undefined);
  const bot = 'chatgpt-codex-connector[bot]';
  const f = (id: number, line: number | null) => ({ id, url: `https://github.com/o/r/pull/1#discussion_r${id}`, author: bot, body, path: 'a.ts', line, createdAt: '2026-09-29T10:00:00Z' });
  // Unfixed: its lines haven't changed.
  assert.equal(codexFindings([f(1, 5)], [])[0].status, 'unfixed');
  // Outdated but nobody said anything: still unfixed (when unsure, no merge).
  assert.equal(codexFindings([f(2, null)], [])[0].status, 'unfixed');
  // Outdated and a handoff comment points at it: addressed.
  assert.equal(codexFindings([f(3, null)], [{ id: 9, url: 'u', author: 'owner', body: 'Fixed https://github.com/o/r/pull/1#discussion_r3 in abc123', createdAt: '2026-09-29T12:00:00Z' }])[0].status, 'addressed');
  // A handoff from before the finding doesn't count.
  assert.equal(codexFindings([f(4, null)], [{ id: 9, url: 'u', author: 'owner', body: 'Addressed the Codex review', createdAt: '2026-09-29T09:00:00Z' }])[0].status, 'unfixed');
  // Resolved on GitHub: fixed whatever its lines.
  assert.equal(codexFindings([f(5, 7)], [], new Map([[5, true]]))[0].status, 'resolved');
  // Other people's comments and Codex's replies aren't findings.
  assert.equal(codexFindings([{ ...f(6, 1), author: 'someone' }, { ...f(7, 1), inReplyTo: 1 }], []).length, 0);
});
