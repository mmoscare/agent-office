#!/usr/bin/env node
// office-cleanbot: CleanBot's own command (see src/server/cleanbot.ts). The office puts it on the board
// agents' PATH with the same address and token as office-queue; only CleanBot may use it. It talks to
// the /office/cleanbot endpoint, where the office runs the whole-floor sweep and its safety checks
// (src/server/prune-floor.ts). Plain Node, no build step, no dependencies.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UsageError, officeEnv, refusal, send } from './office-queue.js';

const USAGE = `Usage:
  office-cleanbot list [--repo <path>] [--recent <hours>]
      every repository on the floor: the office's leftover branches and worktrees, a verdict for
      each, and what CleanBot suggests deleting (the safe ones), with the command that deletes them
  office-cleanbot delete <names> [--repo <path>] [--dry-run] [--remote] [--discard <names>]
      delete the rows named (branches, or worktree paths as the list shows them; comma-separated),
      each checked again first. --remote also deletes GitHub's copy of branches whose PR merged or
      closed. --discard deletes named rows that hold work or were recently active anyway, losing that.
  office-cleanbot keep <names> [--repo <path>]     always keep them (remembered for this floor)
  office-cleanbot forget <names> [--repo <path>]   take them off the always-keep list
  --json prints the office's answer. list and delete can take several minutes.`;

/** list and delete fetch from GitHub and read every worktree: give them time. */
const SWEEP_TIMEOUT_MS = 15 * 60_000;

/**
 * What the command line asks for.
 * @param {string[]} argv the arguments after the command's name
 */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const help = (a) => a === '-h' || a === '--help';
  if (cmd === undefined || cmd === 'help' || help(cmd) || help(rest[0])) return { cmd: 'help' };
  const out = { cmd, json: false, names: [] };
  const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const value = () => {
      if (flag !== arg) return arg.slice(eq + 1);
      if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) return rest[++i];
      throw new UsageError(`${flag} needs a value`);
    };
    if (flag === '--json') out.json = true;
    else if (flag === '--dry-run' || flag === '-n') out.dryRun = true;
    else if (flag === '--remote') out.remote = true;
    else if (flag === '--no-fetch') out.noFetch = true;
    else if (flag === '--repo') out.repo = value().trim();
    else if (flag === '--discard') out.discard = [...(out.discard ?? []), ...list(value())];
    else if (flag === '--keep') out.keep = [...(out.keep ?? []), ...list(value())];
    else if (flag === '--recent') {
      const h = Number(value());
      if (!Number.isFinite(h) || h <= 0) throw new UsageError('--recent takes a number of hours, e.g. --recent 48');
      out.recent = h;
    } else if (flag === '--force' || flag === '-f') throw new UsageError('there is no --force: name the rows to delete anyway with --discard, after seeing what they hold');
    else if (arg.startsWith('-')) throw new UsageError(`Unknown option: ${flag}`);
    else out.names.push(...list(arg));
  }
  switch (cmd) {
    case 'list':
      if (out.names.length) throw new UsageError(`list takes no names (got ${out.names.join(' ')}): it lists them all`);
      return out;
    case 'delete':
      if (!out.names.length) throw new UsageError('Say which rows to delete, e.g. office-cleanbot delete office/pixel-1234,office/dot-5678');
      if (out.discard?.some((d) => !out.names.includes(d))) throw new UsageError('--discard only applies to rows you also name to delete');
      return out;
    case 'keep':
    case 'forget':
      if (!out.names.length) throw new UsageError(`Say which, e.g. office-cleanbot ${cmd} office/pixel-1234`);
      return out;
    default:
      throw new UsageError(`Unknown command: ${cmd}`);
  }
}

/**
 * The HTTP request for a parsed command.
 * @param {Record<string, any>} cmd
 * @param {{ url: string, worker: string, token: string }} office
 */
export function buildRequest(cmd, office) {
  const url = new URL(`${office.url}/office/cleanbot`);
  url.searchParams.set('worker', office.worker);
  const headers = { authorization: `Bearer ${office.token}` };
  if (cmd.cmd === 'list') {
    url.searchParams.set('view', 'list');
    if (cmd.repo) url.searchParams.set('repo', cmd.repo);
    if (cmd.recent) url.searchParams.set('recent', String(cmd.recent));
    if (cmd.noFetch) url.searchParams.set('fetch', '0');
    return { method: 'GET', url: url.href, headers };
  }
  let body;
  if (cmd.cmd === 'delete') body = { action: 'delete', only: cmd.names, ...(cmd.discard ? { discard: cmd.discard } : {}), ...(cmd.keep ? { keep: cmd.keep } : {}), remote: !!cmd.remote, dryRun: !!cmd.dryRun };
  else if (cmd.cmd === 'keep' || cmd.cmd === 'forget') body = { action: cmd.cmd, names: cmd.names };
  else throw new Error(`No request for ${cmd.cmd}`);
  if (cmd.repo) body.repo = cmd.repo;
  return { method: 'POST', url: url.href, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) };
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
    const res = await send(buildRequest(cmd, office), fetchImpl, SWEEP_TIMEOUT_MS);
    if (res.status < 200 || res.status >= 300) {
      err(`office-cleanbot: ${refusal(res.status, res.body).replace('the queue', 'office-cleanbot')}`);
      return 1;
    }
    if (cmd.json) {
      out(JSON.stringify(res.body, null, 2));
      return 0;
    }
    if (cmd.cmd === 'keep' || cmd.cmd === 'forget') {
      const repos = res.body?.repos ?? [];
      out(`${cmd.cmd === 'keep' ? 'Always kept from now on' : 'Off the always-keep list'}: ${cmd.names.join(', ')}.`);
      for (const r of repos) out(`  ${r.repo === '.' ? 'this repository' : r.repo}: always keep ${r.alwaysKeep.length ? r.alwaysKeep.join(', ') : 'nothing'}`);
      return 0;
    }
    out(res.body?.text ?? JSON.stringify(res.body, null, 2));
    const run = res.body?.report?.run;
    return run && (run.failed?.length || run.refused?.length) ? 1 : 0;
  } catch (e) {
    err(`office-cleanbot: ${e.message}`);
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
