#!/usr/bin/env node
// office-inbox: the 📥 in-tray from inside Agent Office, for the agents standing by the boards (the
// receptionist above all; see src/server/stations.ts). Same office and environment as office-queue;
// this talks to the /office/inbox endpoint. Plain Node, no build step, no dependencies.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UsageError, officeEnv, refusal, send } from './office-queue.js';

const USAGE = `Usage:
  office-inbox list              what's in the tray: each item's name, kind, title and a preview
  office-inbox read <name>       a note's text; for a file, its path, to open with your own tools
  office-inbox archive <name>    put a dealt-with item away (it goes to the tray's archive/ folder)`;

/**
 * What the command line asks for:
 * { cmd: 'help' } | { cmd: 'list' } | { cmd: 'read', name } | { cmd: 'archive', name }.
 * @param {string[]} argv the arguments after the command's name
 */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const help = (a) => a === '-h' || a === '--help';
  if (cmd === undefined || cmd === 'help' || help(cmd) || help(rest[0])) return { cmd: 'help' };
  if (cmd === 'list' || cmd === 'ls') {
    if (rest.length) throw new UsageError(`list takes no arguments (got ${rest.join(' ')})`);
    return { cmd: 'list' };
  }
  if (cmd === 'read' || cmd === 'cat' || cmd === 'archive' || cmd === 'done') {
    const name = rest.join(' ');
    if (!name || name.startsWith('-')) throw new UsageError(`${cmd} takes the item's name, as office-inbox list shows it`);
    return { cmd: cmd === 'cat' ? 'read' : cmd === 'done' ? 'archive' : cmd, name };
  }
  throw new UsageError(`Unknown command: ${cmd}`);
}

/**
 * The HTTP request for a parsed command (anything but help).
 * @param {ReturnType<typeof parseArgs>} cmd
 * @param {{ url: string, worker: string, token: string }} office
 * @returns {{ method: string, url: string, headers: Record<string, string>, body?: string }}
 */
export function buildRequest(cmd, office) {
  const url = new URL(`${office.url}/office/inbox`);
  url.searchParams.set('worker', office.worker);
  const headers = { authorization: `Bearer ${office.token}` };
  if (cmd.cmd === 'list') return { method: 'GET', url: url.href, headers };
  if (cmd.cmd === 'read') {
    url.searchParams.set('read', cmd.name);
    return { method: 'GET', url: url.href, headers };
  }
  if (cmd.cmd !== 'archive') throw new Error(`No request for ${cmd.cmd}`);
  return { method: 'POST', url: url.href, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'archive', name: cmd.name }) };
}

/**
 * The tray as the office returns it, a line per item, newest first.
 * @param {{ dir?: string, items?: Array<Record<string, any>> }} view
 */
export function formatInbox(view) {
  const items = view?.items ?? [];
  const where = view?.dir ? ` (${view.dir})` : '';
  const mail = mailLine(view?.mail);
  if (!items.length) return [`The in-tray is empty${where}.`, mail].filter(Boolean).join('\n');
  const lines = [`${items.length} item${items.length === 1 ? '' : 's'} in the tray${where}`];
  if (mail) lines.push(mail);
  for (const i of items) {
    const parts = [`${i.mail ? '📧' : i.kind === 'note' ? '📝' : '📎'} ${i.title ?? i.name}`];
    if (i.title && i.title !== i.name) parts.push(`file ${i.name}`);
    if (i.mail) parts.push(`email from ${i.mail.name ? `${i.mail.name} <${i.mail.from}>` : i.mail.from}, ${i.mail.trusted ? '✅ allowed sender' : '⚠️ not an allowed sender'}`);
    else if (i.from) parts.push(`from ${i.from}`);
    if (i.preview) parts.push(i.preview.length > 120 ? `${i.preview.slice(0, 119)}…` : i.preview);
    lines.push(`${i.name}\n    ${parts.join(' · ')}`);
  }
  return lines.join('\n');
}

/** How the Receptionist's mailbox stands, when the office said. */
export function mailLine(mail) {
  if (!mail) return '';
  if (!mail.configured) return "📧 Email isn't set up yet: remind the people here (an admin sets it up with I → 📧 Set up email).";
  return mail.problem ? `📧 Email (${mail.address}) isn't working: ${mail.problem}` : `📧 Email: ${mail.address}`;
}

/**
 * One item as the office returns it: a note's text, or where a file is.
 * @param {{ item?: Record<string, any>, body?: string, path?: string, truncated?: boolean }} view
 */
export function formatItem(view) {
  const item = view?.item ?? {};
  const mail = view?.mail;
  const head = [`${mail ? '📧' : item.kind === 'note' ? '📝' : '📎'} ${item.title ?? item.name ?? ''}`, mail ? '' : item.from ? `from ${item.from}` : '', view?.path ? `at ${view.path}` : ''].filter(Boolean).join(' · ');
  const from = mail
    ? `\nAn email from ${mail.name ? `${mail.name} <${mail.from}>` : mail.from}: ${mail.trusted ? `✅ an allowed sender, so reply with office-mail reply ${item.name}, and pass --mail ${item.name} when you queue or file it` : '⚠️ not an allowed sender, so file it for a person; you cannot reply to it'}.`
    : '';
  if (item.kind !== 'note') return `${head}${from}\nA file, not a note: open it with your own tools by that path.`;
  return `${head}${from}\n\n${view?.body ?? ''}${view?.truncated ? '\n\n[…the note goes on; read the file by its path for the rest]' : ''}`;
}

/**
 * Runs the command; resolves to its exit code.
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, fetch?: typeof fetch, out?: (s: string) => void, err?: (s: string) => void }} [io]
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const fetchImpl = io.fetch ?? fetch;
  const out = io.out ?? ((s) => process.stdout.write(s + '\n'));
  const err = io.err ?? ((s) => process.stderr.write(s + '\n'));
  try {
    const cmd = parseArgs(argv);
    if (cmd.cmd === 'help') {
      out(USAGE);
      return 0;
    }
    const office = officeEnv(env);
    const res = await send(buildRequest(cmd, office), fetchImpl);
    if (res.status < 200 || res.status >= 300) {
      err(`office-inbox: ${refusal(res.status, res.body)}`);
      return 1;
    }
    if (cmd.cmd === 'list') out(formatInbox(res.body));
    else if (cmd.cmd === 'read') out(formatItem(res.body));
    else out(`Put ${cmd.name} away${res.body?.path ? ` (${res.body.path})` : ''}.`);
    return 0;
  } catch (e) {
    err(`office-inbox: ${e.message}`);
    if (e instanceof UsageError) err(`\n${USAGE}`);
    return e instanceof UsageError ? 2 : 1;
  }
}

const invoked = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) process.exitCode = await main(process.argv.slice(2));
