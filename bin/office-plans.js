#!/usr/bin/env node
// office-plans: the 📒 To Do Next board from inside Agent Office, for the agents standing by the
// boards (see src/server/stations.ts). Same office and environment as office-queue; this talks to
// the /office/plans endpoint. Plain Node, no build step, no dependencies.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UsageError, officeEnv, refusal, send } from './office-queue.js';

const USAGE = `Usage:
  office-plans list                              the board: each item's id, column, text and who's on it
  office-plans add <<'EOF'                       add an item, its text on stdin (or --text "…");
  …what someone wants done, in their words…      prints the new item's id; --mail <tray item> emails
  EOF                                            that item's sender when a worker finishes it
  office-plans set <id> todo|progress|finished   move an item to that column
  office-plans remove <id>                       take an item off the board`;

const STATUSES = ['todo', 'progress', 'finished'];

/**
 * What the command line asks for:
 * { cmd: 'help' } | { cmd: 'list' } | { cmd: 'add', text?, mail? } | { cmd: 'set', id, status } | { cmd: 'remove', id }.
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
  if (cmd === 'remove' || cmd === 'rm') {
    if (rest.length !== 1 || rest[0].startsWith('-')) throw new UsageError('remove takes one item id, e.g. office-plans remove 3f9c2a1b-…');
    return { cmd: 'remove', id: rest[0] };
  }
  if (cmd === 'set' || cmd === 'move') {
    if (rest.length !== 2 || rest[0].startsWith('-')) throw new UsageError('set takes an item id and a column, e.g. office-plans set 3f9c2a1b-… progress');
    const status = rest[1].toLowerCase().replace(/^in-?progress$/, 'progress').replace(/^(to-?do)$/, 'todo').replace(/^done$/, 'finished');
    if (!STATUSES.includes(status)) throw new UsageError(`The column is one of ${STATUSES.join(', ')} (got ${rest[1]})`);
    return { cmd: 'set', id: rest[0], status };
  }
  if (cmd !== 'add') throw new UsageError(`Unknown command: ${cmd}`);
  /** @type {{ cmd: 'add', text?: string, mail?: string }} */
  const out = { cmd: 'add' };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    if (flag !== '--text' && flag !== '--mail') throw new UsageError(arg.startsWith('-') ? `Unknown option for add: ${flag}` : `Unexpected argument: ${arg} (give the item's text on stdin or with --text)`);
    let value;
    if (flag !== arg) value = arg.slice(eq + 1);
    else if (i + 1 < rest.length) value = rest[++i];
    else throw new UsageError(`${flag} needs a value`);
    if (flag === '--text') out.text = value;
    else {
      if (!value.trim()) throw new UsageError('--mail takes the in-tray item the email came in as (see office-inbox list)');
      out.mail = value.trim();
    }
  }
  return out;
}

/**
 * The HTTP request for a parsed command (anything but help). `text` is what came in on stdin for an
 * add that didn't give --text.
 * @param {ReturnType<typeof parseArgs>} cmd
 * @param {{ url: string, worker: string, token: string }} office
 * @param {string} [text]
 * @returns {{ method: string, url: string, headers: Record<string, string>, body?: string }}
 */
export function buildRequest(cmd, office, text) {
  const url = new URL(`${office.url}/office/plans`);
  url.searchParams.set('worker', office.worker);
  const headers = { authorization: `Bearer ${office.token}` };
  if (cmd.cmd === 'list') return { method: 'GET', url: url.href, headers };
  const json = (body) => ({ method: 'POST', url: url.href, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (cmd.cmd === 'remove') return json({ action: 'remove', id: cmd.id });
  if (cmd.cmd === 'set') return json({ action: 'edit', id: cmd.id, status: cmd.status });
  if (cmd.cmd !== 'add') throw new Error(`No request for ${cmd.cmd}`);
  const clean = (cmd.text ?? text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!clean) throw new UsageError(`The item needs its text: pipe it in (office-plans add <<'EOF' … EOF) or pass --text "…"`);
  return json({ action: 'add', text: clean, ...(cmd.mail !== undefined ? { mail: cmd.mail } : {}) });
}

/**
 * The board as the office returns it, a line per item, column by column.
 * @param {{ items?: Array<Record<string, any>> }} view
 */
export function formatPlans(view) {
  const items = view?.items ?? [];
  if (!items.length) return 'The To Do Next board is empty.';
  const count = (s) => items.filter((p) => p.status === s).length;
  const lines = [`${items.length} item${items.length === 1 ? '' : 's'} · ${count('todo')} to do, ${count('progress')} in progress, ${count('finished')} finished`];
  const width = Math.max(...STATUSES.map((s) => s.length));
  for (const status of STATUSES) {
    for (const p of items.filter((x) => x.status === status)) {
      const first = String(p.text ?? '').split('\n').map((l) => l.trim()).find((l) => l) ?? '';
      const parts = [first.length > 100 ? `${first.slice(0, 99)}…` : first];
      if (p.worker?.name) parts.push(`worker ${p.worker.name}`);
      if (p.task) parts.push(`task ${p.task}`);
      lines.push(`${p.id}  ${status.padEnd(width)}  ${parts.join(' · ')}`);
    }
  }
  return lines.join('\n');
}

function readStdin(stdin) {
  return new Promise((resolve, reject) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (c) => (data += c));
    stdin.on('end', () => resolve(data));
    stdin.on('error', reject);
  });
}

/**
 * Runs the command; resolves to its exit code.
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, stdin?: NodeJS.ReadableStream & { isTTY?: boolean }, fetch?: typeof fetch, out?: (s: string) => void, err?: (s: string) => void }} [io]
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const stdin = io.stdin ?? process.stdin;
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
    let text;
    if (cmd.cmd === 'add' && cmd.text === undefined) {
      if (stdin.isTTY) throw new UsageError(`The item needs its text: pipe it in (office-plans add <<'EOF' … EOF) or pass --text "…"`);
      text = await readStdin(stdin);
    }
    const req = buildRequest(cmd, office, text);
    const res = await send(req, fetchImpl);
    if (res.status < 200 || res.status >= 300) {
      err(`office-plans: ${refusal(res.status, res.body)}`);
      return 1;
    }
    if (cmd.cmd === 'list') out(formatPlans(res.body));
    else if (cmd.cmd === 'remove') out(`Took ${cmd.id} off the board.`);
    else if (cmd.cmd === 'set') out(`Moved ${cmd.id} to ${cmd.status}.`);
    else {
      const item = res.body?.item ?? {};
      out(item.id ?? '');
      err(`Added it to To Do${item.id ? ` (${item.id})` : ''}${cmd.mail !== undefined && !res.body?.warning ? '; its sender is emailed when a worker finishes it' : ''}.`);
      if (res.body?.warning) err(`Note: ${res.body.warning}.`);
    }
    return 0;
  } catch (e) {
    err(`office-plans: ${e.message}`);
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
