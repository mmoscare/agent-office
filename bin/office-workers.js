#!/usr/bin/env node
// office-workers: the floor's workers from inside Agent Office, for the agents standing by the boards
// (the PR agent above all, to clock out a worker once its pull request is merged; see
// src/server/stations.ts). Same office and environment as office-queue; this talks to the
// /office/workers endpoint, which does the safety checks. Plain Node, no build step, no dependencies.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UsageError, officeEnv, refusal, send } from './office-queue.js';

const USAGE = `Usage:
  office-workers list [--json]                  every worker on this floor: id, name, desk, provider and
                                                model, status, branch, PR, what its worktree holds, and
                                                whether the office would clock it out
  office-workers home <id> [--remove-worktree]  clock a worker out, as X at its desk does. By id, since
                                                names are reused. The office refuses, and says why, when
                                                it's busy, on a running queue task, or has uncommitted or
                                                unpushed work. Its worktree and branch are kept, or with
                                                --remove-worktree deleted once its branch has merged`;

/** The office asks git about every worker's checkout, which a busy machine can make slow. */
const TIMEOUT_MS = 120_000;

/**
 * What the command line asks for:
 * { cmd: 'help' } | { cmd: 'list', json } | { cmd: 'home', id, removeWorktree }.
 * @param {string[]} argv the arguments after the command's name
 */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const help = (a) => a === '-h' || a === '--help';
  if (cmd === undefined || cmd === 'help' || help(cmd) || rest.some(help)) return { cmd: 'help' };
  if (cmd === 'list' || cmd === 'ls') {
    const other = rest.filter((a) => a !== '--json');
    if (other.length) throw new UsageError(`list takes only --json (got ${other.join(' ')})`);
    return { cmd: 'list', json: rest.includes('--json') };
  }
  if (cmd !== 'home') throw new UsageError(`Unknown command: ${cmd}`);
  const flags = rest.filter((a) => a.startsWith('-'));
  const ids = rest.filter((a) => !a.startsWith('-'));
  const unknown = flags.filter((a) => a !== '--remove-worktree');
  if (unknown.length) throw new UsageError(`Unknown option for home: ${unknown[0]}`);
  if (ids.length !== 1 || !ids[0].trim()) throw new UsageError('home takes one worker id, as office-workers list shows it, e.g. office-workers home 3f9c2a1b7d4e');
  return { cmd: 'home', id: ids[0].trim(), removeWorktree: flags.includes('--remove-worktree') };
}

/**
 * The HTTP request for a parsed command (anything but help).
 * @param {ReturnType<typeof parseArgs>} cmd
 * @param {{ url: string, worker: string, token: string }} office
 * @returns {{ method: string, url: string, headers: Record<string, string>, body?: string }}
 */
export function buildRequest(cmd, office) {
  const url = new URL(`${office.url}/office/workers`);
  url.searchParams.set('worker', office.worker);
  const headers = { authorization: `Bearer ${office.token}` };
  if (cmd.cmd === 'list') return { method: 'GET', url: url.href, headers };
  if (cmd.cmd !== 'home') throw new Error(`No request for ${cmd.cmd}`);
  return { method: 'POST', url: url.href, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'home', id: cmd.id, removeWorktree: cmd.removeWorktree }) };
}

/** How long ago `ms` was, briefly: 45s, 12m, 3h, 2d. */
export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 48 * 3600) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What a worker's checkout holds, in a few words. */
function workText(work) {
  if (!work) return '';
  const where = work.path === '.' ? "in the floor's checkout" : 'worktree';
  if (work.error) return `${where}: couldn't check (${work.error})`;
  const parts = [work.dirty ? plural(work.dirty, 'uncommitted change') : 'clean', work.unpushed ? `${plural(work.unpushed, 'commit')} no remote has` : 'nothing unpushed'];
  if (work.commits !== undefined) parts.push(`${plural(work.commits, 'commit')} of its own`);
  return `${where} ${parts.join(', ')}`;
}

/**
 * The floor's workers as the office returns them, two lines each.
 * @param {{ workers?: Array<Record<string, any>> }} view
 * @param {number} [now]
 */
export function formatWorkers(view, now = Date.now()) {
  const workers = view?.workers ?? [];
  if (!workers.length) return 'Nobody is working on this floor.';
  const status = (w) => `${w.status ?? '?'}${w.since ? ` ${ago(w.since, now)}` : ''}`;
  const width = Math.max(...workers.map((w) => status(w).length));
  const lines = [`${plural(workers.length, 'worker')} on this floor`];
  for (const w of workers) {
    const agent = [w.provider, w.model].filter(Boolean).join(' ') || (w.kind === 'shell' ? 'shell' : '');
    lines.push(`${w.id}  ${status(w).padEnd(width)}  ${[w.name, w.desk, agent, w.task ? `“${w.task}”` : ''].filter(Boolean).join(' · ')}`);
    const facts = [
      w.board ? 'board agent' : '',
      w.branch ?? '',
      w.pr ? `PR #${w.pr.number} ${w.pr.state}` : '',
      w.queued ? `queue task ${w.queued.id} ${w.queued.status}` : '',
      workText(w.work),
      w.blocked ? `✗ stays: ${w.blocked}` : '✓ can clock out',
    ];
    lines.push(`    ${facts.filter(Boolean).join(' · ')}`);
  }
  return lines.join('\n');
}

/**
 * Runs the command; resolves to its exit code.
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, fetch?: typeof fetch, out?: (s: string) => void, err?: (s: string) => void, now?: number }} [io]
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
    const res = await send(buildRequest(cmd, office), fetchImpl, TIMEOUT_MS);
    if (res.status < 200 || res.status >= 300) {
      err(`office-workers: ${refusal(res.status, res.body)}`);
      return 1;
    }
    if (cmd.cmd === 'list') {
      out(cmd.json ? JSON.stringify(res.body, null, 2) : formatWorkers(res.body, io.now));
      return 0;
    }
    const b = res.body ?? {};
    const name = b.worker?.name ?? cmd.id;
    out(`Clocked out ${name} (${b.worker?.id ?? cmd.id}).`);
    if (b.kept) out(`Kept its worktree and branch: ${b.kept}.`);
    if (b.note) out(`${b.note}.`);
    if (b.error) err(`office-workers: ${b.error}`);
    if (b.pending) out(b.cleanup === 'all' ? 'Its worktree and branch are still being deleted; the office will say how that went.' : 'The office will say what became of its worktree.');
    return 0;
  } catch (e) {
    err(`office-workers: ${e.message}`);
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
