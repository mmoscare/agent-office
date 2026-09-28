// npm run build, then node tests/mail-ui.mjs [screenshot-prefix].
// An isolated office with idle Node fixtures and fake IMAP/SMTP servers on localhost (trusted through
// NODE_EXTRA_CA_CERTS): the Receptionist nags, gets set up in her window, sends her welcome, takes an
// email into the tray and is woken for it, and files a "todo:" email with a receipt.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { fakeImap, fakeSmtp, localCert, rawMail } from './fake-mail-servers.mjs';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(path.join(os.tmpdir(), 'office-mail-ui-'));
const floor = path.join(root, 'project');
const shots = process.argv[2];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** An email's text as sent: quoted-printable soft line breaks undone (the office's mail is plain ASCII where these tests look). */
const unwrap = (data) => data.replace(/=\r\n/g, '');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const until = async (what, fn, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await pause(200);
  }
};
let host, browser, imap, smtp, page;
let hostErrors = '';
try {
  mkdirSync(floor);
  git(floor, 'init', '-b', 'main');
  git(floor, 'config', 'user.name', 'Mail UI Test');
  git(floor, 'config', 'user.email', 'mail-ui@example.invalid');
  git(floor, 'config', 'commit.gpgsign', 'false');
  git(floor, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
  git(floor, 'commit', '--allow-empty', '-m', 'Fixture');
  const fixture = path.join(root, 'idle.cjs');
  writeFileSync(fixture, "process.stdout.write('Receptionist fixture ready\\r\\n'); process.stdin.resume();");
  const cert = await localCert();
  const caFile = path.join(root, 'ca.pem');
  writeFileSync(caFile, cert.cert);
  imap = await fakeImap({ cert });
  smtp = await fakeSmtp({ cert, security: 'tls' });
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const url = `http://localhost:${port}`;
  const password = randomUUID();
  host = spawn(process.execPath, [path.join(codeDir, 'personal/windows/host.mjs'), codeDir, floor, String(port)], {
    cwd: codeDir, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'],
    env: { ...process.env, AGENT_OFFICE_PASSWORD: password, AGENT_OFFICE_AGENT: process.execPath, AGENT_OFFICE_AGENT_ARGS: JSON.stringify(fixture), AGENT_OFFICE_HOME: path.join(root, 'home'), NODE_EXTRA_CA_CERTS: caFile },
  });
  host.stderr.on('data', (data) => { hostErrors = (hostErrors + data).slice(-4000); });
  await until('the office', () => fetch(`${url}/api/health`).then((r) => r.ok, () => false));
  browser = await chromium.launch({
    executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  context.setDefaultTimeout(20000);
  assert.equal((await context.request.post(`${url}/api/login`, { data: { password } })).status(), 200);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Mail Test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor);

  // Not set up: the chip on the top bar, her card over her head, and (after a few seconds) her reminder.
  assert.equal(await page.evaluate(() => window.__office.store.mail.configured), false);
  await page.locator('#hud').getByText('Set up email', { exact: true }).waitFor();
  const nag = page.locator('.mail-nag');
  await nag.waitFor({ timeout: 20000 });
  assert.match(await nag.innerText(), /I can’t read your email yet!/);
  // Her kiosk: the bun and bow, and her card saying what she wants.
  const look = await page.evaluate(() => {
    const o = window.__office;
    const kiosk = o.office.desks.get('station-inbox');
    let found = false;
    kiosk.group.traverse((x) => { if (x.name === 'receptionist-look') found = true; });
    const k = kiosk.group.getWorldPosition(o.camera.position.clone());
    o.player.update = () => {};
    o.player.updateCamera = () => {};
    o.player.pos.set(k.x + 2.5, 0, k.z - 4);
    // From the elevator side: she faces the doors.
    o.camera.position.set(k.x + 0.9, 1.6, k.z - 2.6);
    o.camera.lookAt(k.x, 1.05, k.z);
    o.camera.updateMatrixWorld();
    return found;
  });
  assert.ok(look, 'the Receptionist wears her look at the kiosk');
  await pause(800);
  if (shots) await page.screenshot({ path: `${shots}-nag.png` });

  // "Remind me tomorrow" puts her off; the chip stays.
  await nag.getByRole('button', { name: 'Remind me tomorrow' }).click();
  await nag.waitFor({ state: 'detached' });
  assert.ok(await page.evaluate(() => Number(localStorage.getItem('agent-office.mailNagSnoozedUntil')) > Date.now() + 19 * 3600_000));
  await page.locator('#hud').getByText('Set up email', { exact: true }).waitFor();

  // Set her up from the chip, pointing her at the fake servers.
  await page.locator('#hud').getByText('Set up email', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'The Receptionist’s email' });
  await dialog.getByRole('combobox', { name: 'Provider' }).waitFor();
  await dialog.getByRole('combobox', { name: 'Provider' }).selectOption('custom');
  await dialog.getByRole('textbox', { name: 'Her address' }).fill('receptionist@example.com');
  await dialog.getByLabel('App password').fill('app-password');
  await dialog.getByRole('textbox', { name: 'Incoming (IMAP) server' }).fill('localhost');
  await dialog.getByRole('spinbutton', { name: 'IMAP port' }).fill(String(imap.port));
  await dialog.getByRole('textbox', { name: 'Outgoing (SMTP) server' }).fill('localhost');
  await dialog.getByRole('spinbutton', { name: 'SMTP port' }).fill(String(smtp.port));
  await dialog.getByRole('combobox', { name: 'SMTP security' }).selectOption('tls');
  await dialog.getByRole('textbox', { name: 'Who can email her' }).fill('owner@example.com');
  await dialog.getByRole('button', { name: '🔌 Test' }).click();
  const tested = await until('the test result', async () => {
    const text = (await dialog.locator('.mail-result').innerText()).trim();
    return text && text !== 'Trying her mailbox…' ? text : undefined;
  }, 30000);
  assert.equal(tested, '✅ Both work: she can read and send mail.');
  if (shots) await page.screenshot({ path: `${shots}-setup.png` });
  await dialog.getByRole('button', { name: '💁‍♀️ Save and set her up' }).click();
  await dialog.getByText(/She's set up\. A welcome email/).waitFor();
  await until('the welcome email', () => smtp.sent.length >= 1);
  assert.deepEqual(smtp.sent[0].to, ['owner@example.com']);
  assert.match(smtp.sent[0].data, /Subject: =\?UTF-8\?B\?/);
  assert.match(unwrap(smtp.sent[0].data), /Email me at receptionist@example\.com/);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await until('the chip to go', async () => (await page.locator('#hud').getByText('Set up email', { exact: true }).count()) === 0);
  assert.equal(await page.evaluate(() => window.__office.store.mail.configured), true);

  // An email from her owner: it lands in the tray and she's woken at her kiosk to deal with it.
  imap.add(rawMail({ from: 'Owner <owner@example.com>', subject: 'Renew the car insurance', body: 'Before the 15th, please.' }));
  const checked = await context.request.post(`${url}/api/mail`, { headers: { Origin: url }, data: { action: 'check' } });
  assert.equal(checked.status(), 200);
  const tray = await until('the email in the tray', () => page.evaluate(() => window.__office.store.inbox.items.find((i) => i.title === 'Renew the car insurance')));
  assert.equal(tray.from, 'Owner <owner@example.com> · email');
  const her = await until('the Receptionist to be woken', () => page.evaluate(() => [...window.__office.store.workers.values()].find((w) => w.deskId === 'station-inbox')));
  assert.equal(her.name, 'Receptionist');
  assert.match(her.prompt ?? '', /An email just came into the in-tray/);
  assert.equal(imap.messages.at(-1).seen, true);

  // "todo:" skips her: straight onto To Do Next, with a receipt in the thread.
  imap.add(rawMail({ from: 'owner@example.com', subject: 'todo: Call the plumber', body: 'The kitchen tap drips.', messageId: '<plumber@example.com>' }));
  await context.request.post(`${url}/api/mail`, { headers: { Origin: url }, data: { action: 'check' } });
  await until('the To Do Next item', () => page.evaluate(() => window.__office.store.plans.items.some((p) => p.text === 'Call the plumber\n\nThe kitchen tap drips.')));
  const receipt = await until('the receipt', () => smtp.sent.find((m) => /In-Reply-To: <plumber@example\.com>/.test(m.data)));
  assert.match(receipt.data, /Subject: Re: todo: Call the plumber/);
  assert.match(unwrap(receipt.data), /Added to To Do Next/);

  // The In-tray window shows where to email her.
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => document.exitPointerLock());
  await page.keyboard.press('i');
  const inbox = page.getByRole('dialog', { name: 'In-tray' });
  await inbox.getByText('📧 Email me work at').waitFor();
  assert.match(await inbox.locator('.inbox-mail').innerText(), /receptionist@example\.com/);
  await inbox.waitFor({ state: 'visible' });
  // The window fades in.
  await pause(700);
  if (shots) await page.screenshot({ path: `${shots}-inbox.png` });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS: nag chip, card and snooze; her look at the kiosk; setup with test and welcome email; email into the tray waking her; todo: shortcut with a threaded receipt; the In-tray email line.');
} catch (err) {
  // What the screen looked like, and what the email window said, when it went wrong.
  if (page && shots) await page.screenshot({ path: `${shots}-failed.png` }).catch(() => {});
  if (page) console.error('Dialogs at failure:', await page.locator('[role=dialog]').allInnerTexts().catch(() => []));
  throw err;
} finally {
  if (browser) await browser.close();
  if (host && host.exitCode === null) {
    host.stdin.write('stop\n');
    for (let i = 0; i < 100 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  await imap?.close();
  await smtp?.close();
  if (hostErrors.trim()) console.error(hostErrors.slice(-2000));
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}
