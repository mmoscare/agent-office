#!/usr/bin/env node
// office-ask: the Receptionist hands a request to another board agent (the Issues agent or the PR
// agent), the way a person walking up to their kiosk would. Same office and environment as
// office-queue; this talks to the /office/ask endpoint. Plain Node, no dependencies.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UsageError, officeEnv, refusal, send } from './office-queue.js';

const USAGE = `Usage:
  office-ask issues <<'EOF'     hand a request to the Issues agent (file, find, label, close issues)
  …the request, complete on its own…
  EOF
  office-ask pulls <<'EOF'      hand a request to the PR agent (review, comment on, merge pull requests)
  …
  EOF
  (or --text "…" instead of stdin)`;

const WHO = { issues: 'issues', issue: 'issues', pulls: 'pulls', pull: 'pulls', prs: 'pulls', pr: 'pulls' };

/**
 * What the command line asks for: { cmd: 'help' } | { cmd: 'ask', to, text? }.
 * @param {string[]} argv the arguments after the command's name
 */
export function parseArgs(argv) {
  const [first, ...rest] = argv;
  const help = (a) => a === '-h' || a === '--help';
  if (first === undefined || first === 'help' || help(first) || help(rest[0])) return { cmd: 'help' };
  const to = WHO[first.toLowerCase()];
  if (!to) throw new UsageError(`Ask the issues or the pulls agent (got ${first})`);
  /** @type {{ cmd: 'ask', to: 'issues' | 'pulls', text?: string }} */
  const out = { cmd: 'ask', to };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    if (flag !== '--text') throw new UsageError(arg.startsWith('-') ? `Unknown option: ${flag}` : `Unexpected argument: ${arg} (give the request on stdin or with --text)`);
    if (flag !== arg) out.text = arg.slice(eq + 1);
    else if (i + 1 < rest.length) out.text = rest[++i];
    else throw new UsageError('--text needs a value');
  }
  return out;
}

/**
 * @param {ReturnType<typeof parseArgs>} cmd
 * @param {{ url: string, worker: string, token: string }} office
 * @param {string} [text]
 */
export function buildRequest(cmd, office, text) {
  const url = new URL(`${office.url}/office/ask`);
  url.searchParams.set('worker', office.worker);
  const body = (cmd.text ?? text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!body) throw new UsageError(`The request needs its text: pipe it in (office-ask ${cmd.to} <<'EOF' … EOF) or pass --text "…"`);
  return { method: 'POST', url: url.href, headers: { authorization: `Bearer ${office.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ to: cmd.to, text: body }) };
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
    if (cmd.text === undefined) {
      if (stdin.isTTY) throw new UsageError(`The request needs its text: pipe it in (office-ask ${cmd.to} <<'EOF' … EOF) or pass --text "…"`);
      text = await readStdin(stdin);
    }
    const res = await send(buildRequest(cmd, office, text), fetchImpl);
    if (res.status < 200 || res.status >= 300) {
      err(`office-ask: ${refusal(res.status, res.body)}`);
      return 1;
    }
    out(`Asked the ${res.body?.agent ?? `${cmd.to} agent`}${res.body?.hired ? ' (it came in for it)' : ''}.`);
    return 0;
  } catch (e) {
    err(`office-ask: ${e.message}`);
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
