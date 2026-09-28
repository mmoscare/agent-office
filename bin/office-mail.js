#!/usr/bin/env node
// office-mail: the Receptionist's mailbox from inside Agent Office (see src/server/mailroom.ts). She
// replies to whoever emailed her, in their thread, and writes to the owner. Same office and
// environment as office-queue; this talks to the /office/mail endpoint. Plain Node, no dependencies.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UsageError, officeEnv, refusal, send } from './office-queue.js';

const USAGE = `Usage:
  office-mail status                         your mailbox: its address, who may email you, whether it works
  office-mail reply <item> <<'EOF'           reply to whoever emailed a tray item, in their thread
  …a few friendly lines…                     (the text on stdin, or --text "…")
  EOF
  office-mail send --subject "…" <<'EOF'     email the owner something they should know
  …
  EOF`;

/**
 * What the command line asks for: { cmd: 'help' } | { cmd: 'status' } | { cmd: 'reply', item, text? } | { cmd: 'send', subject, text? }.
 * @param {string[]} argv the arguments after the command's name
 */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const help = (a) => a === '-h' || a === '--help';
  if (cmd === undefined || cmd === 'help' || help(cmd) || help(rest[0])) return { cmd: 'help' };
  if (cmd === 'status') {
    if (rest.length) throw new UsageError(`status takes no arguments (got ${rest.join(' ')})`);
    return { cmd: 'status' };
  }
  if (cmd !== 'reply' && cmd !== 'send') throw new UsageError(`Unknown command: ${cmd}`);
  /** @type {{ cmd: 'reply' | 'send', item?: string, subject?: string, text?: string }} */
  const out = { cmd };
  const words = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    if (flag === '--text' || (flag === '--subject' && cmd === 'send')) {
      let value;
      if (flag !== arg) value = arg.slice(eq + 1);
      else if (i + 1 < rest.length) value = rest[++i];
      else throw new UsageError(`${flag} needs a value`);
      if (flag === '--text') out.text = value;
      else out.subject = value.trim();
      continue;
    }
    if (arg.startsWith('-')) throw new UsageError(`Unknown option for ${cmd}: ${flag}`);
    words.push(arg);
  }
  if (cmd === 'reply') {
    if (!words.length) throw new UsageError('reply takes the tray item, as office-inbox list shows it: office-mail reply <item>');
    out.item = words.join(' ');
  } else {
    if (words.length) throw new UsageError(`Unexpected argument: ${words[0]} (give the subject with --subject "…" and the text on stdin)`);
    if (!out.subject) throw new UsageError('Give the email a --subject');
  }
  return out;
}

/**
 * The HTTP request for a parsed command (anything but help). `text` is what came in on stdin.
 * @param {ReturnType<typeof parseArgs>} cmd
 * @param {{ url: string, worker: string, token: string }} office
 * @param {string} [text]
 */
export function buildRequest(cmd, office, text) {
  const url = new URL(`${office.url}/office/mail`);
  url.searchParams.set('worker', office.worker);
  const headers = { authorization: `Bearer ${office.token}` };
  if (cmd.cmd === 'status') return { method: 'GET', url: url.href, headers };
  const body = (cmd.text ?? text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!body) throw new UsageError(`The email needs its text: pipe it in (office-mail ${cmd.cmd} … <<'EOF' … EOF) or pass --text "…"`);
  const payload = cmd.cmd === 'reply' ? { action: 'reply', item: cmd.item, text: body } : { action: 'send', subject: cmd.subject, text: body };
  return { method: 'POST', url: url.href, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(payload) };
}

/** The mailbox as the office describes it. */
export function formatStatus(s) {
  if (!s?.configured) return "📧 Your mailbox isn't set up yet, so nobody can email you. Remind the people here: an admin sets it up in the office (press I for the In-tray, then 📧 Set up email).";
  const lines = [`📧 Your mailbox: ${s.address}`];
  if (s.owners?.length) lines.push(`Who may email you work (and the only people you can write to): ${s.owners.join(', ')}`);
  if (s.problem) lines.push(`⚠️ It isn't working right now: ${s.problem}`);
  else lines.push('✅ Working.');
  const extras = [s.autoTriage ? 'you are woken when new mail comes in' : 'new mail waits in the tray until someone asks you', s.briefing ? `a morning briefing goes out at ${s.briefing}` : '', s.awayAlerts ? 'the owner is emailed when a worker needs them and nobody is in the office' : ''].filter(Boolean);
  if (extras.length) lines.push(`Also: ${extras.join('; ')}.`);
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
    if (cmd.cmd !== 'status' && cmd.text === undefined) {
      if (stdin.isTTY) throw new UsageError(`The email needs its text: pipe it in (office-mail ${cmd.cmd} … <<'EOF' … EOF) or pass --text "…"`);
      text = await readStdin(stdin);
    }
    const res = await send(buildRequest(cmd, office, text), fetchImpl);
    if (res.status < 200 || res.status >= 300) {
      err(`office-mail: ${refusal(res.status, res.body)}`);
      return 1;
    }
    if (cmd.cmd === 'status') out(formatStatus(res.body));
    else out(`Sent to ${res.body?.to ?? 'them'}.`);
    return 0;
  } catch (e) {
    err(`office-mail: ${e.message}`);
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
