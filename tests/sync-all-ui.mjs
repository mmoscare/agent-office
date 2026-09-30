// npm run build, then node tests/sync-all-ui.mjs. 🔄 Sync everything end to end in a throwaway office:
// two temporary "GitHubs" (bare repositories), an app folder the office runs from (a clone whose build
// copies this checkout's dist) and a floor that is a clone of the other. Walks up to the button by the
// gong, presses E, checks the review (a secret-looking file unticked, the office's own folder never
// uploaded), presses Go, and checks the next-steps checklist and what reached "GitHub". Nothing here
// touches the live office, its port or the real app folder. Screenshots go to SYNC_UI_SHOTS (default:
// <temp>/sync-all-ui-shots), outside the repository.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sync-all-ui-')));
const shots = process.env.SYNC_UI_SHOTS || path.join(os.tmpdir(), 'sync-all-ui-shots');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The same git settings for this script's git and the office's, whatever the machine's global config says.
const SETTINGS = [['user.name', 'Sync UI Test'], ['user.email', 'sync-ui@example.invalid'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(root, 'no-hooks')], ['core.excludesFile', path.join(root, 'no-excludes')], ['init.defaultBranch', 'personal']];
const gitEnv = { GIT_CONFIG_COUNT: String(SETTINGS.length), ...Object.fromEntries(SETTINGS.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])) };
Object.assign(process.env, gitEnv);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, file, text) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};
let host;
let browser;
let log = '';
let report = async () => {};

/** A bare "GitHub" repository and a checkout that pushes to it. */
function repo(name, files) {
  const seed = path.join(root, `${name}-seed`);
  mkdirSync(seed);
  for (const [f, text] of Object.entries(files)) write(seed, f, text);
  git(seed, 'init', '-q');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'Initial');
  git(root, 'clone', '-q', '--bare', `${name}-seed`, `${name}.git`);
  git(seed, 'remote', 'add', 'origin', path.join(root, `${name}.git`));
  git(seed, 'fetch', '-q', 'origin');
  git(seed, 'branch', '-q', '-u', 'origin/personal');
  return { origin: path.join(root, `${name}.git`), seed };
}

/** A pull request merged on "GitHub". */
function mergePr(seed, number, title, files) {
  git(seed, 'checkout', '-q', '-b', `pr-${number}`);
  for (const [f, text] of Object.entries(files)) write(seed, f, text);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', title);
  git(seed, 'checkout', '-q', 'personal');
  git(seed, 'merge', '-q', '--no-ff', `pr-${number}`, '-m', `Merge pull request #${number} from mmoscare/pr-${number}`, '-m', title);
  git(seed, 'push', '-q', 'origin', 'personal');
}

try {
  mkdirSync(shots, { recursive: true });
  // The office's code: "building" copies this checkout's real build, so the office really runs from the app folder.
  const office = repo('office', {
    'package.json': `${JSON.stringify({ name: 'agent-office', version: '0.1.0', type: 'module', scripts: { build: 'node build.mjs' } }, null, 2)}\n`,
    'package-lock.json': `${JSON.stringify({ name: 'agent-office', version: '0.1.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'agent-office', version: '0.1.0' } } }, null, 2)}\n`,
    'build.mjs': `import { cpSync, rmSync } from 'node:fs';\nrmSync('dist', { recursive: true, force: true });\ncpSync(${JSON.stringify(path.join(codeDir, 'dist'))}, 'dist', { recursive: true });\n`,
    '.gitignore': 'node_modules\ndist\n.agent-office\n',
    'src/server/server.ts': 'export {};\n',
  });
  const project = repo('portfolio', { 'index.html': '<h1>Portfolio</h1>\n', 'notes.md': '# Notes\n' });
  const app = path.join(root, 'app');
  git(root, 'clone', '-q', '-b', 'personal', office.origin, 'app');
  symlinkSync(path.join(codeDir, 'node_modules'), path.join(app, 'node_modules'), 'junction');
  execFileSync(process.execPath, ['build.mjs'], { cwd: app, windowsHide: true });
  const floor = path.join(root, 'Personal-Portfolio');
  git(root, 'clone', '-q', '-b', 'personal', project.origin, 'Personal-Portfolio');

  // What's new on "GitHub": for the app, new packages and server code; for the floor, a teammate's notes.
  mergePr(office.seed, 91, 'feat: Grok is the default model.', { 'package.json': `${JSON.stringify({ name: 'agent-office', version: '0.2.0', type: 'module', scripts: { build: 'node build.mjs' } }, null, 2)}\n`, 'src/server/server.ts': 'export const grok = true;\n' });
  mergePr(office.seed, 92, 'Bigger buttons on the Git board', { 'src/client/main.ts': 'export {};\n' });
  mergePr(project.seed, 12, 'Notes from a teammate', { 'notes.md': '# Notes\n\nFrom GitHub.\n' });
  // Unsaved work: a page and a new file on the floor, a secret-looking file, and an idea in the app folder.
  write(floor, 'index.html', '<h1>Portfolio</h1>\n<p>New project card</p>\n');
  write(floor, 'projects/sync-button.md', '# The sync button\n');
  write(floor, '.env', 'OPENAI_API_KEY=not-a-real-key\n');
  write(app, 'docs/ideas.md', '# Ideas\n\n- A sync button by the gong\n');

  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const url = `http://localhost:${port}`;
  const password = randomUUID();
  host = spawn(process.execPath, [path.join(codeDir, 'personal', 'windows', 'host.mjs'), app, floor, String(port)], {
    cwd: app, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...gitEnv, AGENT_OFFICE_PASSWORD: password, AGENT_OFFICE_HOME: path.join(root, 'home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'), CODEX_HOME: path.join(root, 'codex-home') },
  });
  host.stdout.on('data', (d) => { log = (log + d).slice(-20000); });
  host.stderr.on('data', (d) => { log = (log + d).slice(-20000); });
  for (let i = 0; ; i++) {
    if (await fetch(url + '/api/health').then((r) => r.ok, () => false)) break;
    if (i > 600) throw new Error(`The office didn't come up: ${log}`);
    await pause(100);
  }

  browser = await chromium.launch({ executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(180_000);
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Sync Test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor);
  // The repository is public: the owner's real chores card never goes in a screenshot.
  await page.addStyleTag({ content: '.calendar-nag { display: none !important; }' });
  const floorId = await page.evaluate(() => window.__office.store.floor);
  report = async () => {
    console.log('page:', await page.evaluate(() => [...document.querySelectorAll('[role=dialog], #hint')].map((e) => e.textContent).join(' --- ')).catch((e) => e.message));
    console.log('office log:', log.slice(-4000));
  };

  // The same guards as the rest of /api/git.
  assert.equal((await fetch(`${url}/api/git/sync-all?floor=${floorId}`)).status, 401);
  assert.equal((await context.request.post(`${url}/api/git/sync-all/run?floor=${floorId}`, { headers: { Origin: 'https://example.invalid' }, data: {} })).status(), 403);

  // Walk up to the button beside the gong, facing the wall.
  await page.evaluate(() => {
    const { player, office } = window.__office;
    player.unlock();
    const it = office.interactables.find((i) => i.kind === 'sync');
    player.pos.set(it.x - 0.35, 0, it.z + 0.35);
    player.vy = 0;
    player.camYaw = 0.35;
    player.facing = player.camYaw + Math.PI;
  });
  await page.waitForFunction(() => document.querySelector('#hint')?.textContent.includes('Sync everything'));
  const hint = await page.locator('#hint').innerText();
  assert.match(hint, /🔄 Sync everything/);
  assert.match(hint, /E\s*Press it/);
  // The gong is still its own thing, a step to the west.
  await page.evaluate(() => {
    const it = window.__office.office.interactables.find((i) => i.kind === 'gong');
    window.__office.player.pos.set(it.x, 0, it.z);
  });
  await page.waitForFunction(() => document.querySelector('#hint')?.textContent.includes('Merge gong'));
  await page.evaluate(() => {
    const { player, office } = window.__office;
    const it = office.interactables.find((i) => i.kind === 'sync');
    player.pos.set(it.x - 0.35, 0, it.z + 0.35);
    player.camYaw = 0.35;
    player.facing = player.camYaw + Math.PI;
  });
  await page.waitForFunction(() => document.querySelector('#hint')?.textContent.includes('Sync everything'));
  await pause(800);
  await page.screenshot({ path: path.join(shots, '1-button-by-the-gong.png') });

  // E: the review.
  await page.keyboard.press('e');
  const dialog = page.getByRole('dialog', { name: 'Sync everything' });
  await dialog.getByRole('button', { name: /Go: save, pull and upload/ }).waitFor();
  const floorCard = dialog.getByRole('region', { name: 'Personal-Portfolio' });
  const appCard = dialog.getByRole('region', { name: 'Agent Office app' });
  await floorCard.getByText('🌿 personal → origin/personal').waitFor();
  assert.equal(await floorCard.getByRole('checkbox', { name: 'Save index.html' }).isChecked(), true);
  assert.equal(await floorCard.getByRole('checkbox', { name: 'Save projects/sync-button.md' }).isChecked(), true);
  assert.equal(await floorCard.getByRole('checkbox', { name: 'Save .env' }).isChecked(), false);
  await floorCard.getByText(/left unticked: an environment file/).waitFor();
  await floorCard.getByText(/never uploaded: the office’s own data/).waitFor();
  assert.equal(await floorCard.getByRole('checkbox', { name: /Save \.agent-office/ }).isDisabled(), true);
  assert.equal(await floorCard.getByRole('textbox', { name: 'Commit message for Personal-Portfolio' }).inputValue(), 'Update index.html and sync-button.md');
  await floorCard.getByText('⬇️ GitHub has 1 new change to pull in.').waitFor();
  assert.equal(await appCard.getByRole('checkbox', { name: 'Save docs/ideas.md' }).isChecked(), true);
  // Unticking changes the suggestion, until the owner writes their own.
  await floorCard.getByRole('checkbox', { name: 'Save projects/sync-button.md' }).uncheck();
  assert.equal(await floorCard.getByRole('textbox', { name: 'Commit message for Personal-Portfolio' }).inputValue(), 'Update index.html');
  await floorCard.getByRole('checkbox', { name: 'Save projects/sync-button.md' }).check();
  await floorCard.getByRole('textbox', { name: 'Commit message for Personal-Portfolio' }).fill('Add the sync button project card');
  await dialog.screenshot({ path: path.join(shots, '2-review.png') });

  // Go.
  await dialog.getByRole('button', { name: /Go: save, pull and upload/ }).click();
  const next = dialog.getByRole('region', { name: 'What to do next' });
  await next.waitFor();
  const text = await dialog.innerText();
  assert.match(text, /Personal-Portfolio: Saved 2 files \([0-9a-f]{7}\), uploaded 2 commits, pulled 1 new change\./);
  assert.match(text, /Agent Office app: Saved 1 file \([0-9a-f]{7}\), uploaded 2 commits, pulled 2 new changes\./);
  assert.match(text, /Agent Office: Grok is the default model \(#91\)/);
  assert.match(text, /Agent Office: Bigger buttons on the Git board \(#92\)/);
  assert.match(text, /Personal-Portfolio: Notes from a teammate \(#12\)/);
  const steps = await next.locator('.sa-step > b').allInnerTexts();
  assert.deepEqual(steps, ['Install the new packages', 'Build the new version', 'Restart the office']);
  await next.getByRole('button', { name: /Do it with the step-by-step update/ }).waitFor();
  await next.getByText('No workers are mid-task, so now is a good time.', { exact: false }).waitFor();
  await dialog.screenshot({ path: path.join(shots, '3-next-steps.png') });

  // What reached "GitHub": the ticked files, never the secret-looking one or the office's own folder.
  const uploaded = git(project.origin, 'ls-tree', '-r', '--name-only', 'personal').split('\n');
  assert.deepEqual(uploaded.sort(), ['index.html', 'notes.md', 'projects/sync-button.md']);
  assert.equal(git(project.origin, 'log', '-1', '--format=%s', 'personal^2'), 'Add the sync button project card');
  assert.equal(git(floor, 'rev-parse', 'HEAD'), git(project.origin, 'rev-parse', 'personal'));
  assert.ok(existsSync(path.join(floor, '.env')));
  assert.match(git(office.origin, 'ls-tree', '-r', '--name-only', 'personal'), /docs\/ideas\.md/);
  assert.equal(git(app, 'status', '--porcelain'), '');

  // The walkthrough takes over from there.
  await next.getByRole('button', { name: /Do it with the step-by-step update/ }).click();
  await page.getByRole('dialog', { name: 'Update the office' }).getByText(/Step \d of 5/).waitFor();
  await page.getByRole('dialog', { name: 'Update the office' }).screenshot({ path: path.join(shots, '4-walkthrough.png') });
  await page.keyboard.press('Escape');

  // Also in the ☰ menu.
  await page.evaluate(() => document.querySelectorAll('.modal').forEach((m) => m.closest('.modal-backdrop, .backdrop')?.remove()));
  const menuHas = await page.evaluate(() => [...document.querySelectorAll('button, [role=menuitem]')].some((b) => /Sync everything/.test(b.textContent ?? '') || /Sync everything/.test(b.getAttribute('title') ?? '')));
  if (!menuHas) {
    await page.locator('#menu-btn, button[aria-label*="menu" i]').first().click().catch(() => {});
    await page.getByText('Sync everything').first().waitFor({ timeout: 10_000 });
  }

  // Narrow screens: no sideways scrolling in the window.
  assert.deepEqual(pageErrors, []);
  console.log(`PASS: button beside the gong with its own hint; E opens the review (secret-looking .env unticked, .agent-office never uploaded, suggestion follows the ticks); Go saved, pulled and uploaded both repositories to local bare "GitHubs"; checklist: packages → build → restart with the step-by-step update; What's new from the PR titles; ☰ menu entry; guards. Screenshots in ${shots}`);
} catch (err) {
  await report().catch(() => {});
  throw err;
} finally {
  await browser?.close();
  if (host && host.exitCode === null) {
    host.stdin.write('stop\n');
    for (let i = 0; i < 100 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  assert.equal(path.dirname(root), realpathSync(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('sync-all-ui-'));
  const link = path.join(root, 'app', 'node_modules');
  if (existsSync(link)) unlinkSync(link);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
