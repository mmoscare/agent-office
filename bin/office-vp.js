#!/usr/bin/env node
// office-vp: the VP's own command (see src/server/vp.ts). The office puts it on the board agents'
// PATH with the same address and token as office-queue; only the VP may use it. It talks to the
// /office/vp endpoint. Plain Node, no build step, no dependencies.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UsageError, officeEnv, refusal, send } from './office-queue.js';

const USAGE = `Usage:
  office-vp status                      the PRs by group, stuck workers, merges waiting for a restart, duty
  office-vp sweep [--dry-run]           one sweep by the owner's rules (waits up to 8 min; --no-wait)
  office-vp verify <pr> [--repo o/n]    verify one PR's exact merge result
  office-vp merge <pr> [--repo o/n]     merge one PR, once its own verify passed on its current head
  office-vp retry <pr> [--repo o/n]     forget a PR's fix, so the next sweep may start one more
  office-vp workers                     every worker: status, for how long, task, PR, last terminal lines
  office-vp nudge <worker> <<'EOF'      type a message into a worker's session (text on stdin, or --text)
  …the message…
  EOF
  office-vp wake <worker> [--say "…"]   wake an asleep worker and tell it "continue" (or what --say says)
  office-vp duty on|off [--every 10m]   standing duty: the office sweeps by itself on a timer
  --wait <minutes> waits that long for a sweep, verify or merge; --json prints the office's answer.`;

const GROUPS = [
  ['merged', '🎉 Merged'],
  ['ready', '✅ Ready'],
  ['verifying', '🔎 Verifying'],
  ['working', '👷 Being worked on'],
  ['fixing', '🧰 Needs a fix (under way)'],
  ['waiting', '⏳ Waiting'],
  ['owner', '🙋 Needs the owner'],
  ['listed', "📄 Not the VP's to merge"],
];
const DEFAULT_WAIT_MIN = 8;

/**
 * What the command line asks for.
 * @param {string[]} argv the arguments after the command's name
 */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const help = (a) => a === '-h' || a === '--help';
  if (cmd === undefined || cmd === 'help' || help(cmd) || help(rest[0])) return { cmd: 'help' };
  const out = { cmd, json: false };
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const value = () => {
      if (flag !== arg) return arg.slice(eq + 1);
      if (i + 1 < rest.length) return rest[++i];
      throw new UsageError(`${flag} needs a value`);
    };
    if (flag === '--json') out.json = true;
    else if (flag === '--dry-run') out.dryRun = true;
    else if (flag === '--no-wait') out.waitMin = 0;
    else if (flag === '--wait') {
      const n = Number(value());
      if (!Number.isFinite(n) || n < 0) throw new UsageError('--wait takes a number of minutes');
      out.waitMin = n;
    } else if (flag === '--repo') out.repo = value().trim();
    else if (flag === '--text') out.text = value();
    else if (flag === '--say') out.say = value();
    else if (flag === '--every') {
      const m = /^(\d+)\s*(m|min|minutes?)?$/i.exec(value().trim());
      if (!m) throw new UsageError('--every takes minutes, e.g. --every 10m');
      out.everyMin = Number(m[1]);
    } else if (arg.startsWith('--')) throw new UsageError(`Unknown option: ${flag}`);
    else pos.push(arg);
  }
  const one = (what) => {
    if (pos.length !== 1) throw new UsageError(`${cmd} takes ${what}`);
    return pos[0];
  };
  switch (cmd) {
    case 'status':
    case 'workers':
    case 'sweep':
      if (pos.length) throw new UsageError(`${cmd} takes no arguments (got ${pos.join(' ')})`);
      return out;
    case 'verify':
    case 'merge':
    case 'retry': {
      const n = /^#?(\d+)$/.exec(one('a PR number, e.g. office-vp ' + cmd + ' 12'));
      if (!n) throw new UsageError(`${cmd} takes a PR number, e.g. office-vp ${cmd} 12`);
      return { ...out, pr: Number(n[1]) };
    }
    case 'nudge':
    case 'wake':
      return { ...out, worker: one(`a worker's name or id, e.g. office-vp ${cmd} Pixel`) };
    case 'duty': {
      const v = one('on or off');
      if (v !== 'on' && v !== 'off') throw new UsageError('duty takes on or off');
      return { ...out, on: v === 'on' };
    }
    default:
      throw new UsageError(`Unknown command: ${cmd}`);
  }
}

/**
 * The HTTP request for a parsed command.
 * @param {Record<string, any>} cmd
 * @param {{ url: string, worker: string, token: string }} office
 * @param {string} [stdin] what came in on stdin (a nudge's text)
 */
export function buildRequest(cmd, office, stdin) {
  const url = new URL(`${office.url}/office/vp`);
  url.searchParams.set('worker', office.worker);
  const headers = { authorization: `Bearer ${office.token}` };
  if (cmd.cmd === 'status' || cmd.cmd === 'workers') {
    url.searchParams.set('view', cmd.cmd);
    return { method: 'GET', url: url.href, headers };
  }
  let body;
  if (cmd.cmd === 'sweep') body = { action: 'sweep', dryRun: !!cmd.dryRun };
  else if (cmd.cmd === 'verify' || cmd.cmd === 'merge' || cmd.cmd === 'retry') body = { action: cmd.cmd, pr: cmd.pr, ...(cmd.repo ? { repo: cmd.repo } : {}) };
  else if (cmd.cmd === 'nudge') {
    const text = (cmd.text ?? stdin ?? '').replace(/\r\n?/g, '\n').trim();
    if (!text) throw new UsageError(`Give the message on stdin (office-vp nudge ${cmd.worker} <<'EOF' … EOF) or with --text "…"`);
    body = { action: 'nudge', worker: cmd.worker, text };
  } else if (cmd.cmd === 'wake') body = { action: 'wake', worker: cmd.worker, ...(cmd.say ? { say: cmd.say } : {}) };
  else if (cmd.cmd === 'duty') body = { action: 'duty', on: cmd.on, ...(cmd.everyMin !== undefined ? { everyMin: cmd.everyMin } : {}) };
  else throw new Error(`No request for ${cmd.cmd}`);
  return { method: 'POST', url: url.href, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function jobRequest(office, id) {
  const url = new URL(`${office.url}/office/vp`);
  url.searchParams.set('worker', office.worker);
  url.searchParams.set('view', 'job');
  url.searchParams.set('id', id);
  return { method: 'GET', url: url.href, headers: { authorization: `Bearer ${office.token}` } };
}

const ago = (at) => {
  const m = Math.round((Date.now() - at) / 60_000);
  return m < 1 ? 'just now' : m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/** PR lines, grouped the way the owner reads them. */
export function formatPrs(prs) {
  if (!prs?.length) return 'No open pull requests (as of the last sweep).';
  const out = [];
  for (const [group, title] of GROUPS) {
    const mine = prs.filter((p) => p.group === group);
    if (!mine.length) continue;
    out.push(`${title} (${mine.length})`);
    for (const p of mine) out.push(`  #${p.number} ${p.title}${p.repo ? ` [${p.repo}]` : ''} — ${p.why}${p.worker && !p.why.includes(p.worker) ? ` · ${p.worker}` : ''}\n    ${p.url}`);
  }
  return out.join('\n');
}

/** A sweep's (or a verify's, or a merge's) result. */
export function formatResult(r) {
  if (!r) return '';
  const out = [formatPrs(r.prs)];
  if (r.fixes?.length) out.push(`Fixes started: ${r.fixes.map((f) => `#${f.pr} ${f.taskId ? `task ${f.taskId}` : `by ${f.worker}`} (${f.reason})`).join('; ')}`);
  if (r.escalations?.length) out.push(`Handed to the owner (To Do Next):\n${r.escalations.map((e) => `  - ${e}`).join('\n')}`);
  if (r.pulled?.length) out.push(r.pulled.join('\n'));
  if (r.errors?.length) out.push(`Errors:\n${r.errors.map((e) => `  - ${e}`).join('\n')}`);
  return out.join('\n\n');
}

export function formatStatus(s) {
  const out = [];
  const d = s.duty;
  out.push(d?.on ? `👔 On duty since ${new Date(d.at).toLocaleString()} (turned on by ${d.by}), sweeping every ${Math.round(d.everyMs / 60_000)} min.` : `👔 Not on duty${d?.by ? ` (turned off by ${d.by})` : ''}. office-vp duty on turns it on, when the owner asks.`);
  if (s.job) out.push(`Now: ${s.job.what} (since ${ago(s.job.startedAt)})${s.job.last ? ` — ${s.job.last}` : ''}`);
  if (s.verifying) out.push(`The building's verify slot: ${s.verifying}`);
  if (s.lastSweep) out.push(`Last sweep ${ago(s.lastSweep.at)}: ${s.lastSweep.summary}`);
  if (typeof s.waitingRestart === 'number') out.push(s.waitingRestart ? `🔁 ${s.waitingRestart} merge${s.waitingRestart === 1 ? '' : 's'} waiting for a restart (the VP never restarts the office).` : 'The running office has every merge.');
  out.push('', formatPrs(s.prs));
  if (s.stuck?.length) out.push('', `Stuck workers (${s.stuck.length}):`, ...s.stuck.map((w) => `  ${w.worker}: ${w.detail} → ${w.action === 'escalate' ? 'the owner' : w.action === 'report' ? 'your judgment' : w.action}`));
  else out.push('', 'No stuck workers.');
  if (s.jobLog?.length) out.push('', 'Latest log:', ...s.jobLog.map((l) => `  ${l}`));
  return out.join('\n');
}

export function formatWorkers(view) {
  const ws = view?.workers ?? [];
  if (!ws.length) return 'No workers at desks on this floor.';
  const out = [];
  for (const w of ws) {
    out.push(`${w.seat} — ${w.status} for ${w.for}${w.task ? ` · ${w.task}` : ''}${w.pr ? ` · PR #${w.pr.number} ${w.pr.url}` : ''}${w.queueTask ? ` · task ${w.queueTask.id} (${w.queueTask.status}${w.queueTask.error ? `: ${w.queueTask.error}` : ''})` : ''}`);
    if (w.stuck) out.push(`  ⚠ stuck: ${w.stuck.detail} → ${w.stuck.action === 'escalate' ? 'escalate to the owner (never approve it)' : w.stuck.action === 'report' ? 'your judgment' : `${w.stuck.action}${w.stuck.say === 'continue' ? ' with "continue"' : ''}`}`);
    const tail = String(w.tail ?? '').split('\n').filter((l) => l.trim()).slice(-8);
    for (const l of tail) out.push(`  │ ${l}`);
  }
  return out.join('\n');
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
 * @param {{ env?: Record<string, string | undefined>, stdin?: any, fetch?: typeof fetch, out?: (s: string) => void, err?: (s: string) => void, sleep?: (ms: number) => Promise<void>, pollMs?: number }} [io]
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const stdin = io.stdin ?? process.stdin;
  const fetchImpl = io.fetch ?? fetch;
  const out = io.out ?? ((s) => process.stdout.write(s + '\n'));
  const err = io.err ?? ((s) => process.stderr.write(s + '\n'));
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  try {
    const cmd = parseArgs(argv);
    if (cmd.cmd === 'help') {
      out(USAGE);
      return 0;
    }
    const office = officeEnv(env);
    let text;
    if (cmd.cmd === 'nudge' && cmd.text === undefined) {
      if (stdin.isTTY) throw new UsageError(`Give the message on stdin (office-vp nudge ${cmd.worker} <<'EOF' … EOF) or with --text "…"`);
      text = await readStdin(stdin);
    }
    const res = await send(buildRequest(cmd, office, text), fetchImpl);
    if (res.status < 200 || res.status >= 300) {
      err(`office-vp: ${refusal(res.status, res.body).replace('the queue', 'office-vp')}`);
      return 1;
    }
    if (cmd.json && !res.body?.job) {
      out(JSON.stringify(res.body, null, 2));
      return 0;
    }
    if (cmd.cmd === 'status') out(formatStatus(res.body));
    else if (cmd.cmd === 'workers') out(formatWorkers(res.body));
    else if (cmd.cmd === 'nudge') out(`Typed it into ${cmd.worker}'s session.`);
    else if (cmd.cmd === 'wake') out(`Woke ${cmd.worker}${cmd.say ? '' : ' and told it "continue"'}.`);
    else if (cmd.cmd === 'retry') out(res.body?.note ?? 'Done.');
    else if (cmd.cmd === 'duty') out(cmd.on ? `On duty: the office sweeps every ${Math.round((res.body?.duty?.everyMs ?? 600_000) / 60_000)} minutes and wakes you when there's something to judge or report.` : 'Off duty.');
    else {
      // A job: the office runs it; wait for it (and print its log) up to --wait minutes.
      const id = res.body?.job;
      if (res.body?.already) err(`office-vp: a job is already running on this floor (${id}): following it instead.`);
      const waitMin = cmd.waitMin ?? DEFAULT_WAIT_MIN;
      const until = Date.now() + waitMin * 60_000;
      let seen = 0;
      for (;;) {
        const j = await send(jobRequest(office, id), fetchImpl);
        if (j.status !== 200) {
          err(`office-vp: ${refusal(j.status, j.body)}`);
          return 1;
        }
        const log = j.body.log ?? [];
        for (const l of log.slice(seen)) err(l);
        seen = log.length;
        if (j.body.finishedAt) {
          if (cmd.json) out(JSON.stringify(j.body, null, 2));
          else out(j.body.error ? `⚠️ ${j.body.error}` : formatResult(j.body.result));
          return j.body.error ? 1 : 0;
        }
        if (Date.now() >= until) {
          out(`Still running (job ${id}). office-vp status shows how it's going.`);
          return 0;
        }
        await sleep(io.pollMs ?? 3000);
      }
    }
    return 0;
  } catch (e) {
    err(`office-vp: ${e.message}`);
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
