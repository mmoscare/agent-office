import './office-update.css';
import { UPDATE_STEPS, type OfficeUpdateState, type UpdateOutcome, type UpdatePr, type UpdateStepId, type UpdateWorker } from '../../shared/office-update';
import type { Net } from '../net';
import { store } from '../state';
import { codeBox } from './copy-code';
import { h, openModal, STATUS_LABEL, timeAgo, toast, type Modal } from './dom';
import { openManual } from './manual';
import { START_COMMAND } from './manual-content';

// The guided office update (server/office-update.ts): after a pull request for Agent Office itself is
// merged, a window that walks through it one step at a time: which pull requests this brings, "Step 2
// of 5", one big button for the step at hand, what happened in plain English (the technical part behind
// "Show details"), and ✅ for each step done. Opened from the update bar and the Git board's 🏢 bar.

const REOPEN_KEY = 'agent-office.officeUpdateReopen';
const POLL_BUSY_MS = 1500;
const POLL_MS = 15_000;

type Reply = { state?: OfficeUpdateState | null; outcome?: UpdateOutcome; error?: string; confirm?: UpdateWorker[]; restarting?: boolean };

let net: Net | null = null;
let state: OfficeUpdateState | null = null;
let loadedOnce = false;
const listeners = new Set<() => void>();
let modal: Modal | null = null;
let render: (() => void) | null = null;
let working: string | null = null;
let confirmBusy: UpdateWorker[] | null = null;
/** When this page asked for a restart, the running office's start time then: a later one is the new office. */
let restartFrom: number | null = null;
/** The office said it's restarting (it answers that at once, before it goes). */
let restartAsked = false;
const said = new Set<string>();

export function officeUpdateState(): OfficeUpdateState | null {
  return state;
}

export function onOfficeUpdate(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  listeners.forEach((fn) => fn());
  render?.();
}

async function call(path: string, body?: unknown): Promise<Reply> {
  const floor = store.floor;
  if (!floor) return { error: 'Take the elevator to a floor first' };
  try {
    const q = new URLSearchParams({ floor });
    const res = await fetch(`/api/git/office/update${path}?${q}`, body === undefined
      ? { credentials: 'same-origin', cache: 'no-store' }
      : { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as Reply;
    if (!res.ok && !data.error) data.error = `The office answered ${res.status}`;
    return data;
  } catch {
    return { error: 'The office didn’t answer (it may be restarting).' };
  }
}

/** Asks the office how its update stands. `fresh`: a PR was just merged, so look at GitHub now. */
async function load(fresh = false) {
  const floor = store.floor;
  if (!floor) return;
  try {
    const q = new URLSearchParams({ floor, ...(fresh ? { fresh: '1' } : {}) });
    const res = await fetch(`/api/git/office/update?${q}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return;
    const next = ((await res.json()) as Reply).state ?? null;
    accept(next);
  } catch {
    // Offline for a moment (a restart): keep what we had.
  }
}

function accept(next: OfficeUpdateState | null | undefined) {
  if (next === undefined) return;
  state = next;
  loadedOnce = true;
  // The new office is up: load its page (the window comes back, see reopenAfterRestart).
  if (restartFrom !== null && next && next.running.startedAt > restartFrom) {
    restartFrom = null;
    location.reload();
    return;
  }
  changed();
}

/** Whether this tab should bring the window back after the page reloads onto the new office. */
function reopenAfterRestart(on: boolean) {
  try {
    if (on) sessionStorage.setItem(REOPEN_KEY, '1');
    else sessionStorage.removeItem(REOPEN_KEY);
  } catch {
    // Private windows: the update bar still says how it went.
  }
}

/** The check under way: another caller shares it rather than starting a second. */
let inflight: Promise<void> | null = null;

/** Asks the office how its update stands; while a check is under way, this returns that one. */
export function checkOfficeUpdate(fresh = false): Promise<void> {
  inflight ??= load(fresh).finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Checks again once any check under way is back. That one may have asked before a step done
 * elsewhere finished (a restart from the tray icon, say), and would leave things as they were.
 */
export async function checkOfficeUpdateAfter(): Promise<void> {
  await inflight;
  await checkOfficeUpdate();
}

/** The first step still to do, or null when everything is. */
export function currentStep(s: OfficeUpdateState): UpdateStepId | null {
  return UPDATE_STEPS.find((st) => s.steps[st.id] === 'todo')?.id ?? null;
}

// ---- Small pieces ------------------------------------------------------------------------------

function details(text: string | undefined, label = 'Show details'): HTMLElement | null {
  if (!text) return null;
  return h('details.ou-details', {}, h('summary', {}, label), h('pre', {}, text));
}

function outcomeBox(o: UpdateOutcome, kind?: 'ok' | 'bad' | 'warn'): HTMLElement {
  const k = kind ?? (o.ok ? 'ok' : 'bad');
  const icon = k === 'ok' ? '✅' : k === 'warn' ? '✋' : '❌';
  return h(
    'div.ou-outcome',
    { class: k, role: k === 'ok' ? 'status' : 'alert' },
    h('p.ou-message', {}, `${icon} ${o.message}`),
    ...(o.notes ?? []).map((n) => h('p.ou-note', {}, `ℹ️ ${n}`)),
    details(o.details),
  );
}

function prLink(s: OfficeUpdateState, pr: UpdatePr): Node {
  const label = `PR #${pr.number}`;
  return s.github ? h('a', { href: `https://github.com/${s.github}/pull/${pr.number}`, target: '_blank', rel: 'noopener noreferrer' }, label) : document.createTextNode(label);
}

function prsText(prs: UpdatePr[]): string {
  if (!prs.length) return 'the new code';
  if (prs.length > 4) return `${prs.length} pull requests`;
  const nums = prs.map((p) => `#${p.number}`);
  return `${prs.length === 1 ? 'PR' : 'PRs'} ${nums.length === 1 ? nums[0] : `${nums.slice(0, -1).join(', ')} and ${nums[nums.length - 1]}`}`;
}

function bringing(s: OfficeUpdateState, prs: UpdatePr[], verb = 'Bringing in'): HTMLElement {
  if (prs.length === 1) return h('p.ou-bringing', {}, `${verb} `, prLink(s, prs[0]), `: ${prs[0].title}`);
  if (prs.length > 1) return h('div.ou-bringing', {}, h('p', {}, `${verb} ${prs.length} pull requests:`), h('ul', {}, ...prs.map((pr) => h('li', {}, prLink(s, pr), `: ${pr.title}`))));
  return h('p.ou-bringing', {}, `${verb} the latest Agent Office code${s.otherCommits ? ` (${s.otherCommits} change${s.otherCommits === 1 ? '' : 's'})` : ''}`);
}

function elapsed(from: number | undefined): string {
  if (!from) return '';
  const s = Math.max(0, Math.round((Date.now() - from) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function running(text: string, since?: number, tail?: string): HTMLElement {
  return h(
    'div.ou-running',
    { role: 'status', 'aria-live': 'polite' },
    h('div.ou-running-line', {}, h('span.spinner'), h('b', {}, text), since ? h('span.ou-elapsed', {}, elapsed(since)) : null),
    h('div.ou-bar', {}),
    details(tail, 'Show what it’s doing'),
  );
}

function workerLine(w: UpdateWorker): HTMLElement {
  const status = w.status === 'needs_input' ? 'waiting for your answer' : STATUS_LABEL[w.status] ?? w.status;
  return h('li', {}, h('b', {}, w.name), ` · ${status} · ${w.floor}`);
}

function names(ws: { name: string }[]): string {
  const n = ws.map((w) => w.name);
  return n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

// ---- Doing a step ------------------------------------------------------------------------------

async function act(label: string, path: string, body: unknown) {
  if (working) return;
  working = label;
  render?.();
  const r = await call(path, body);
  working = null;
  if (r.error) toast(r.error, 'warn');
  if (r.confirm) confirmBusy = r.confirm;
  accept(r.state);
  if (!r.state) render?.();
}

function button(label: string, onClick: () => void, opts: { primary?: boolean; big?: boolean } = {}): HTMLButtonElement {
  const b = h(`button.btn${opts.primary ? '.primary' : ''}${opts.big ? '.ou-go' : ''}` as 'button.btn', { type: 'button' }, label);
  b.disabled = !!working || !state?.admin;
  b.addEventListener('click', onClick);
  return b;
}

// ---- The steps ---------------------------------------------------------------------------------

function floorCard(s: OfficeUpdateState): HTMLElement[] {
  const behind = s.floors.filter((f) => f.behind > 0);
  const o = s.outcomes.floor;
  const out: HTMLElement[] = [
    h('p', {}, `${behind.map((f) => `The ${f.name} floor is ${f.behind} change${f.behind === 1 ? '' : 's'} behind GitHub.`).join(' ')} Pulling it means new workers start from the latest code.`),
  ];
  if (o && !o.ok) out.push(outcomeBox(o));
  if (working) out.push(running(working));
  else {
    const row = h('div.ou-actions', {}, button(o && !o.ok ? '⬇️ Try again' : '⬇️ Pull the floor', () => void act('Pulling the floor…', '/pull-floors', {}), { primary: true, big: true }));
    if (o && !o.ok) row.append(button('Skip this step', () => void act('Skipping…', '/skip', { step: 'floor' })));
    out.push(row);
  }
  return out;
}

function appCard(s: OfficeUpdateState, prs: UpdatePr[]): HTMLElement[] {
  const o = s.outcomes.app;
  const out: HTMLElement[] = [
    h('p', {}, `The office runs from its own copy of the code, the app folder. This brings ${prsText(prs)} into it.`),
    h('p.ou-muted', {}, 'Folder: ', h('code', {}, s.appDir)),
  ];
  if (o && !o.ok) out.push(outcomeBox(o, /^Stopped:/.test(o.message) ? 'warn' : 'bad'));
  else if (s.app.dirty.length) {
    out.push(outcomeBox({ ok: false, at: 0, message: `Someone’s unfinished work is in the app folder (${s.app.dirty.length} file${s.app.dirty.length === 1 ? '' : 's'}). The pull stops rather than touch it. Ask Claude to “finish or commit the work in the app folder” first.`, details: s.app.dirty.join('\n') }, 'warn'));
  }
  if (working) out.push(running(working));
  else out.push(h('div.ou-actions', {}, button(o && !o.ok ? '⬇️ Try again' : '⬇️ Pull the app folder', () => void act('Pulling the app folder…', '/pull-app', {}), { primary: true, big: true })));
  return out;
}

function packagesCard(s: OfficeUpdateState): HTMLElement[] {
  const o = s.outcomes.packages;
  const n = s.packages.changes.length;
  const out: HTMLElement[] = [
    h('p', {}, `This update needs new packages (${n} changed). They’re installed into a separate copy, so the running office isn’t touched. They switch in when the office restarts.`),
    details([...(s.packages.runtime ? ['Includes packages the office itself runs with.', ''] : ['Only build tools changed.', '']), ...s.packages.changes].join('\n'), 'Show the packages'),
  ].filter((x): x is HTMLElement => !!x);
  if (s.build.state === 'packages') out.push(running(s.build.phase ?? 'Installing the packages…', s.build.startedAt, s.build.tail));
  else {
    if (o && !o.ok) out.push(outcomeBox(o));
    if (working) out.push(running(working));
    else out.push(h('div.ou-actions', {}, button(o && !o.ok ? '📦 Try again' : '📦 Get the new packages', () => void act('Starting…', '/packages', {}), { primary: true, big: true })));
  }
  return out;
}

function buildCard(s: OfficeUpdateState): HTMLElement[] {
  const o = s.outcomes.build;
  const out: HTMLElement[] = [];
  if (s.steps.packages === 'skipped') out.push(h('p.ou-done-line', {}, '✅ No new packages needed.'));
  out.push(h('p', {}, 'Building turns the new code into the version the office runs. It’s built in a separate folder, so the office keeps working and nothing changes until the restart.'));
  if (s.build.state === 'building') out.push(running(s.build.phase ?? 'Building…', s.build.startedAt, s.build.tail));
  else {
    if (o && !o.ok) out.push(outcomeBox(o));
    if (working) out.push(running(working));
    else out.push(h('div.ou-actions', {}, button(o && !o.ok ? '🛠 Try again' : '🛠 Build it', () => void act('Starting…', '/build', {}), { primary: true, big: true })));
  }
  return out;
}

function restartByHand(s: OfficeUpdateState): HTMLElement[] {
  const r = s.restart;
  const why =
    r.reason === 'old-launcher' ? 'This office can’t restart itself yet: its launcher is from before this feature.'
    : r.reason === 'powershell' ? 'This office was started from a PowerShell window, so it can’t restart itself.'
    : 'This office can’t restart itself.';
  const out: HTMLElement[] = [h('div.ou-outcome.warn', {}, h('p.ou-message', {}, `✋ ${why} Restart it by hand:`))];
  if (r.needsPackagesByHand) {
    out.push(
      h('ol.ou-steps-list', {},
        h('li', {}, 'Stop the office: right-click the Agent Office icon near the clock → ', h('b', {}, 'Stop Agent Office and exit'), '. Or press ', h('b', {}, 'Ctrl+C'), ' in its PowerShell window.'),
        h('li', {}, 'In PowerShell, install the new packages (safe now the office is stopped):', codeBox(`cd "${s.appDir}"\nnpm ci`).el),
        h('li', {}, 'Start it again: double-click ', h('b', {}, 'Agent Office'), ' on your Desktop, or run the start command:', codeBox(START_COMMAND).el),
      ),
    );
  } else {
    out.push(
      h('ul.ou-steps-list', {},
        h('li', {}, 'Launcher: right-click the Agent Office icon near the clock → ', h('b', {}, 'Restart Agent Office'), '.'),
        h('li', {}, 'PowerShell: press ', h('b', {}, 'Ctrl+C'), ' in the office’s window, then start it again:', codeBox(START_COMMAND).el),
      ),
      h('p.ou-muted', {}, 'The new build switches in as the office stops. This page reconnects by itself and checks it worked.'),
    );
  }
  if (r.reason === 'old-launcher' || r.reason === 'powershell') {
    out.push(
      h('div.ou-onetime', {},
        h('p', {}, h('b', {}, 'One-time setup'), ' so this window can restart the office itself next time:'),
        h('ol.ou-steps-list', {},
          h('li', {}, 'Stop the office (tray icon → ', h('b', {}, 'Stop Agent Office and exit'), ', or Ctrl+C in PowerShell).'),
          h('li', {}, 'In PowerShell, run:', codeBox(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${s.appDir}\\personal\\windows\\Install-Launcher.ps1"`).el),
          h('li', {}, 'Double-click ', h('b', {}, 'Agent Office'), ' on your Desktop. That also starts the new version.'),
        ),
      ),
    );
  }
  return out;
}

function restartCard(s: OfficeUpdateState): HTMLElement[] {
  const out: HTMLElement[] = [];
  out.push(h('p', {}, 'Restarting switches the office to the new version. It takes about half a minute, and this page reconnects by itself.'));
  const r = s.restart;
  if (r.pending || restartAsked) return [...out, running('Restarting… this page reconnects by itself.')];
  if (s.busy.length) {
    out.push(
      h('div.ou-outcome.warn', {},
        h('p.ou-message', {}, `⚠️ ${s.busy.length === 1 ? 'This worker is' : 'These workers are'} busy right now. Restarting interrupts ${s.busy.length === 1 ? 'it' : 'them'}. The office starts ${s.busy.length === 1 ? 'it' : 'them'} again and says “continue”; this window lists ${s.busy.length === 1 ? 'it' : 'them'} afterwards in case one needs telling again:`),
        h('ul.ou-workers', {}, ...s.busy.map(workerLine)),
        h('p.ou-note', {}, 'Anything they started in a terminal (a dev server, a test run) has to be started again.'),
      ),
    );
  } else out.push(h('p.ou-done-line', {}, '👍 No workers are busy right now, so this is a good time.'));
  if (!r.available) return [...out, ...restartByHand(s)];
  if (r.waiting) {
    const blocking = s.busy.filter((w) => w.status === 'working' || w.status === 'starting');
    out.push(
      running(blocking.length ? `Waiting for ${names(blocking)} to finish. The office restarts by itself when ${blocking.length === 1 ? 'it’s' : 'they’re'} idle.` : 'Restarting as soon as it can…', r.waiting),
      h('p.ou-muted', {}, 'You can close this window meanwhile.'),
      h('div.ou-actions', {}, button('Cancel waiting', () => void restart('cancel', false))),
    );
    return out;
  }
  if (working) return [...out, running(working)];
  if (confirmBusy?.length) {
    out.push(
      h('div.ou-confirm', { role: 'alertdialog', 'aria-label': 'Restart now?' },
        h('p', {}, h('b', {}, `Restart now and stop ${names(confirmBusy)}?`)),
        h('div.ou-actions', {},
          button('Yes, restart now', () => { confirmBusy = null; void restart('now', true); }, { primary: true }),
          button('Cancel', () => { confirmBusy = null; render?.(); }),
        ),
      ),
    );
    return out;
  }
  const row = h('div.ou-actions', {}, button('🔄 Restart now', () => void restart('now', false), { primary: true, big: true }));
  if (s.busy.length) row.append(button('⏳ Restart as soon as everyone is idle', () => void restart('idle', false)));
  out.push(row);
  return out;
}

async function restart(mode: 'now' | 'idle' | 'cancel', confirm: boolean) {
  if (working) return;
  const before = state?.running.startedAt ?? Date.now();
  working = mode === 'now' ? 'Asking the office to restart…' : mode === 'idle' ? 'Setting that up…' : 'Cancelling…';
  render?.();
  const r = await call('/restart', { mode, confirm });
  working = null;
  // No answer at all just after asking for a restart: it's most likely on its way down already.
  const silent = mode !== 'cancel' && !r.state && !r.restarting && !r.confirm && /didn’t answer/.test(r.error ?? '');
  if (r.error && !silent) toast(r.error, 'warn');
  if (r.confirm) confirmBusy = r.confirm;
  restartAsked = !!(r.restarting || silent);
  accept(r.state);
  render?.();
  // Other pages reload onto the new version by themselves; this one also brings the window back.
  const coming = !!(restartAsked || state?.restart.pending || state?.restart.waiting);
  restartFrom = coming ? before : null;
  reopenAfterRestart(coming);
  if (coming) net?.expectRestart();
  schedule();
}

// ---- After the restart -------------------------------------------------------------------------

function doneCard(s: OfficeUpdateState): HTMLElement[] {
  const last = s.last;
  if (!last || last.verdict !== 'live') {
    return [h('h3', {}, '✅ The office is up to date'), h('p', {}, `It runs the latest code${s.running.commit ? ` (${s.running.commit.slice(0, 7)})` : ''}. When you merge a pull request for Agent Office, the steps to update it appear here.`)];
  }
  const prs = last.prs;
  const title = prs.length === 0 ? '✅ Done: the office runs the new code' : prs.length === 1 ? `✅ Done: PR #${prs[0].number} is live` : prs.length <= 4 ? `✅ Done: ${prsText(prs)} are live` : `✅ Done: ${prs.length} pull requests are live`;
  const out: HTMLElement[] = [
    h('h3', {}, title),
    h('p', {}, `The office restarted ${timeAgo(s.running.startedAt)} and runs the new version${s.running.commit ? ` (${s.running.commit.slice(0, 7)})` : ''}.`),
  ];
  if (prs.length > 1) out.push(h('ul', {}, ...prs.map((pr) => h('li', {}, prLink(s, pr), `: ${pr.title}`))));
  else if (prs.length === 1) out.push(h('p', {}, prLink(s, prs[0]), `: ${prs[0].title}`));
  if (last.now.length) {
    const sayable = last.now.filter((w) => !w.gone && w.status !== 'working' && w.status !== 'starting');
    const say = (w: UpdateWorker) => {
      net?.send({ t: 'worker.prompt', workerId: w.id, prompt: 'continue' });
      said.add(w.id);
      render?.();
    };
    out.push(
      h('h4', {}, sayable.length ? `Tell ${sayable.length === 1 ? 'this worker' : 'these workers'} “continue”:` : `${last.now.length === 1 ? 'The worker' : 'The workers'} that ${last.now.length === 1 ? 'was' : 'were'} busy:`),
      h('p.ou-muted', {}, `${last.now.length === 1 ? 'It was' : 'They were'} busy when the office restarted. The office told ${last.now.length === 1 ? 'it' : 'them'} to carry on; one that’s idle now needs a “continue”.`),
      h('ul.ou-workers.ou-continue', {},
        ...last.now.map((w) => {
          const li = h('li', {}, h('b', {}, w.name), ` · ${w.floor}`, ' ');
          if (w.gone) li.append(h('span.ou-muted', {}, '(no longer at a desk)'));
          else if (said.has(w.id)) li.append(h('span.ou-said', {}, '✓ Said “continue”'));
          else if (w.status === 'working' || w.status === 'starting') li.append(h('span.ou-said', {}, '✅ Carrying on'));
          else li.append(button('💬 Say “continue”', () => say(w)));
          return li;
        }),
      ),
    );
    const left = sayable.filter((w) => !said.has(w.id));
    if (left.length > 1) out.push(h('div.ou-actions', {}, button('💬 Say it to all of them', () => left.forEach(say))));
  }
  out.push(h('div.ou-actions', {}, button('Close', () => { void act('Closing…', '/done', {}); modal?.close(); }, { primary: true })));
  return out;
}

// ---- The window --------------------------------------------------------------------------------

let pollTimer: ReturnType<typeof setTimeout> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;

function busyNow(s: OfficeUpdateState | null): boolean {
  return restartAsked || (!!s && (s.build.state === 'packages' || s.build.state === 'building' || !!s.restart.pending || !!s.restart.waiting || (s.last?.verdict === 'pending')));
}

function schedule() {
  clearTimeout(pollTimer);
  if (!modal && restartFrom === null) return;
  pollTimer = setTimeout(async () => {
    await load();
    schedule();
  }, busyNow(state) || restartFrom !== null ? POLL_BUSY_MS : POLL_MS);
}

export function openOfficeUpdate() {
  if (modal) return;
  if (!store.floor) return toast('Take the elevator to a floor first', 'warn');
  const body = h('div.body.ou-body');
  const note = h('span.grow');
  const byHand = h('button.btn', { type: 'button', title: 'The same steps as PowerShell commands, in the Office Manual' }, '📘 By hand');
  byHand.addEventListener('click', () => openManual('merge-steps'));
  const el = h('div.modal.ou-modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Update the office' },
    h('header', {}, h('h2', {}, '🔄 Update the office')),
    body,
    h('footer', {}, note, byHand),
  );
  render = () => {
    const s = state;
    body.replaceChildren();
    if (!loadedOnce) return void body.append(running('Checking the office’s code…'));
    if (!s) return void body.append(h('p', {}, 'This office doesn’t run from a Git checkout of its code, so there’s nothing to update here.'));
    note.textContent = s.admin ? 'Nothing happens until you press a button.' : 'Only an admin can press these buttons.';
    const step = currentStep(s);
    const last = s.last && !s.last.acknowledged ? s.last : undefined;
    const prs = s.prs.length || !last ? s.prs : last.prs;
    if (step || !last || last.verdict !== 'live') body.append(bringing(s, prs));
    const index = step ? UPDATE_STEPS.findIndex((st) => st.id === step) : UPDATE_STEPS.length;
    body.append(
      h('div.ou-progress', {},
        h('span.ou-stepof', {}, step ? `Step ${index + 1} of ${UPDATE_STEPS.length}` : 'All done'),
        h('ol.ou-chips', {},
          ...UPDATE_STEPS.map((st, i) => {
            const failed = st.id === step && s.outcomes[st.id]?.ok === false;
            const done = s.steps[st.id] !== 'todo' && i < index;
            const cls = done ? 'done' : st.id === step ? (failed ? 'now failed' : 'now') : 'later';
            const tip = s.steps[st.id] === 'skipped' ? (st.id === 'packages' ? 'No new packages needed' : 'Skipped') : st.title;
            return h('li', { class: cls, title: tip, 'aria-current': st.id === step ? 'step' : undefined }, h('span.ou-num', {}, done ? '✓' : failed ? '✕' : String(i + 1)), st.title);
          }),
        ),
      ),
    );
    if (last && last.verdict !== 'live' && last.verdict !== 'pending') {
      body.append(outcomeBox({ ok: false, at: 0, message: last.message ?? 'The last restart didn’t bring the new version in.', details: last.details }));
    }
    // The step just done, so its "✅ Pulled" (and any note) is still there on the next one.
    const prev = UPDATE_STEPS.filter((st) => st.id !== step && s.steps[st.id] !== 'todo' && s.outcomes[st.id]?.ok).map((st) => s.outcomes[st.id]!).sort((a, b) => b.at - a.at)[0];
    if (prev && step) body.append(h('div.ou-prev', {}, outcomeBox(prev)));
    const card = h('section.ou-card', { 'aria-label': step ? UPDATE_STEPS[index].title : 'Done' });
    if (step) card.append(h('h3', {}, UPDATE_STEPS[index].title));
    const parts =
      step === 'floor' ? floorCard(s)
      : step === 'app' ? appCard(s, prs)
      : step === 'packages' ? packagesCard(s)
      : step === 'build' ? buildCard(s)
      : step === 'restart' ? restartCard(s)
      : last?.verdict === 'pending' ? [running('Restarting… this page reconnects by itself.')]
      : doneCard(s);
    card.append(...parts);
    body.append(card);
  };
  modal = openModal(el, {
    doing: 'updating the office',
    onClose: () => {
      modal = null;
      render = null;
      confirmBusy = null;
      clearTimeout(pollTimer);
      clearInterval(tickTimer);
      if (restartFrom !== null) schedule();
    },
  });
  render();
  void load(true).then(schedule);
  // The clocks on running steps.
  tickTimer = setInterval(() => {
    if (busyNow(state)) el.querySelectorAll('.ou-elapsed').forEach((e) => {
      const s = state;
      const since = s?.restart.waiting ?? s?.build.startedAt;
      e.textContent = elapsed(since);
    });
  }, 1000);
}

/** Starts watching; call once when the page is up. Reopens the window after the restart this page asked for. */
export function mountOfficeUpdate(n: Net) {
  net = n;
  let reopen = false;
  try {
    reopen = sessionStorage.getItem(REOPEN_KEY) === '1';
    sessionStorage.removeItem(REOPEN_KEY);
  } catch {
    reopen = false;
  }
  if (!reopen) return;
  const tryOpen = () => {
    if (!store.floor) return setTimeout(tryOpen, 500);
    openOfficeUpdate();
  };
  setTimeout(tryOpen, 800);
}
