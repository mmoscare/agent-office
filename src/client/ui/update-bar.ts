import type { OfficeStatus } from '../../shared/git-board';
import { store } from '../state';
import { codeBox } from './copy-code';
import { h, toast } from './dom';
import { openManual } from './manual';

// The update bar across the top of the screen: after a pull request for Agent Office itself is
// merged (in the office or on GitHub), the steps to get the office running it, ticked off as each
// gets done: pull the floor, pull the app, build, restart, reload this page. "Hide" puts it away
// until the next merge. It reads the same status as the Git board's 🏢 bar (/api/git/office).
// The steps done by hand in PowerShell (pull the app, build, restart) each end in "Done, next step",
// which checks at once and says what's still to do if it isn't done; the step chips open any step.

const HIDE_KEY = 'agent-office.updateBarHidden';
const POLL_MS = 60_000;
/** Back on this tab (from PowerShell, say): check this long after, once the switch has settled. */
const BACK_MS = 500;
/** The steps done by hand in PowerShell: pull the app, build, restart. */
const BY_HAND = new Set([1, 2, 3]);
/** When this page loaded: an office started after it is running code this page doesn't have. */
const pageLoadedAt = Date.now();

let status: OfficeStatus | null = null;
/** The check under way: another caller shares it rather than starting a second. */
let inflight: Promise<void> | null = null;
/** The last check couldn't reach the office (it's restarting, say). */
let unreachable = false;
let bar: HTMLElement | null = null;
/** The step the owner chose to read (a chip, "next step anyway"); null follows the current step. */
let viewing: number | null = null;
/** The step whose "Done, next step" is being checked. */
let checking: number | null = null;
/** The step whose "Done, next step" found it not done yet: say why beside its button. */
let notYet: number | null = null;

function hiddenKey(): string {
  try {
    return localStorage.getItem(HIDE_KEY) ?? '';
  } catch {
    return '';
  }
}

interface Step {
  title: string;
  done: boolean;
  body: () => (Node | string)[];
}

function steps(s: OfficeStatus): Step[] {
  const floors = s.floors ?? [];
  const behindFloors = floors.filter((f) => f.behind > 0);
  const app = `cd "${s.dir}"`;
  const pullFloor = (f: { dir: string }) => {
    const b = h('button.btn.primary', { type: 'button' }, '⬇️ Pull it');
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'Pulling…';
      const error = await post('office/pull-floor', { dir: f.dir });
      if (error) toast(error, 'error');
      else toast('⬇️ Pulled the floor');
      void check(true);
    });
    return b;
  };
  return [
    {
      title: 'Pull the floor',
      done: behindFloors.length === 0,
      body: () =>
        behindFloors.flatMap((f) => [
          h('p', {}, `The ${f.name} floor is ${f.behind} commit${f.behind === 1 ? '' : 's'} behind GitHub. `, pullFloor(f), ' or in PowerShell:'),
          codeBox(`git -C "${f.dir}" pull --ff-only`).el,
        ]),
    },
    {
      title: 'Pull the app',
      done: !s.needs.pull,
      body: () => [
        h('p', {}, 'In PowerShell, go to the folder the office runs from and pull:'),
        ...(s.dirty ? [h('p.update-warn', {}, `⚠️ ${s.dirty} file${s.dirty === 1 ? ' has' : 's have'} uncommitted changes there (someone’s work in progress). Commit or finish them first.`)] : []),
        codeBox(`${app}\ngit pull`).el,
        h('p.update-note', {}, 'If it says CONFLICT: run ', h('code', {}, 'git merge --abort'), ' and ask Claude to “update the app folder”.'),
      ],
    },
    {
      title: 'Build',
      done: !s.needs.pull && !s.needs.build,
      body: () => [h('p', {}, 'Still in that folder:'), codeBox(s.needs.pull ? 'npm run build' : `${app}\nnpm run build`).el],
    },
    {
      title: 'Restart',
      done: !s.needs.pull && !s.needs.build && !s.needs.restart,
      body: () => {
        const cmd = h('button.btn', { type: 'button' }, '📘 The start command');
        cmd.addEventListener('click', () => openManual('merge-steps'));
        return [h('p', {}, 'When your workers are idle: press ', h('b', {}, 'Ctrl+C'), ' in the office’s window, then start it again. Tell busy workers “continue” afterwards.'), cmd];
      },
    },
    {
      title: 'Reload this page',
      done: s.startedAt <= pageLoadedAt,
      body: () => {
        const b = h('button.btn.primary', { type: 'button' }, '🔄 Reload now');
        b.addEventListener('click', () => location.reload());
        const early = s.needs.pull || s.needs.build || s.needs.restart;
        return [h('p', {}, early ? 'Once the office has restarted, reload this page to see the new code. ' : 'The office restarted with the new code. Reload to see it. '), b];
      },
    },
  ];
}

/** Why step `i` isn't done yet, in plain words ('' when it is). Each step needs the ones before it. */
function stillToDo(s: OfficeStatus, i: number): string {
  if (i >= 1 && s.needs.pull) return `The app folder is still ${s.behind} commit${s.behind === 1 ? '' : 's'} behind ${s.upstream ?? 'GitHub'}. Did git pull finish? Look for an error in PowerShell.`;
  if (i >= 2 && s.needs.build) return 'There’s no new build yet. Is npm run build still running, or did it stop with an error? Look in PowerShell, then check again once it has finished.';
  if (i >= 3 && s.needs.restart) return 'The office hasn’t restarted since the build. Press Ctrl+C in its window, start it again, then check again.';
  return '';
}

async function post(path: string, body: unknown): Promise<string | undefined> {
  try {
    const q = new URLSearchParams({ floor: store.floor ?? '' });
    const res = await fetch(`/api/git/${path}?${q}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const r = (await res.json().catch(() => ({}))) as { error?: string };
    return r.error ?? (res.ok ? undefined : `HTTP ${res.status}`);
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Asks the office how its own code stands. `fresh`: a PR was just merged, so look at GitHub now.
 * While a check is under way, this returns that one instead of starting another.
 */
export function check(fresh = false): Promise<void> {
  if (!store.floor) return Promise.resolve();
  inflight ??= load(store.floor, fresh).finally(() => {
    inflight = null;
    render();
  });
  return inflight;
}

async function load(floor: string, fresh: boolean): Promise<void> {
  try {
    const q = new URLSearchParams({ floor, ...(fresh ? { fresh: '1' } : {}) });
    const res = await fetch(`/api/git/office?${q}`, { credentials: 'same-origin', cache: 'no-store' });
    unreachable = !res.ok;
    if (res.ok) status = ((await res.json()) as { office: OfficeStatus | null }).office;
  } catch {
    // Offline for a moment (a restart): keep what we had.
    unreachable = true;
  }
}

/**
 * "Done, next step" on step `i`: check now, then show the next step to do, or say what's still left.
 * A check already under way may have started before the command finished, so this one comes after it.
 */
async function done(i: number): Promise<void> {
  checking = i;
  notYet = null;
  render();
  await inflight;
  await check();
  checking = null;
  const list = status ? steps(status) : [];
  if (!unreachable && list[i]?.done) {
    const next = list.findIndex((st, j) => j > i && !st.done);
    viewing = next < 0 ? null : next;
  } else notYet = i;
  render();
}

/** The "Done, next step" button under a step done by hand, and why it isn't done when the check says so. */
function nextRow(s: OfficeStatus, i: number): HTMLElement {
  const waiting = checking === i;
  const b = h(
    'button.btn.primary.update-done',
    { type: 'button', 'data-focus': 'done', 'aria-disabled': waiting ? 'true' : undefined },
    waiting ? 'Checking…' : notYet === i ? '↻ Check again' : '✓ Done, next step',
  );
  b.addEventListener('click', () => {
    if (checking === null) void done(i);
  });
  const row = h('div.update-next', {}, b);
  if (notYet === i && !waiting) {
    const anyway = h('button.update-link', { type: 'button', 'data-focus': 'anyway' }, 'Show me the next step anyway →');
    anyway.addEventListener('click', () => {
      viewing = i + 1;
      notYet = null;
      render();
    });
    const why = unreachable ? 'Couldn’t reach the office just now. If it’s restarting, wait a moment and check again.' : stillToDo(s, i);
    row.append(h('p.update-why', { role: 'status' }, why), anyway);
  }
  return row;
}

/** A pull request was merged here: its steps are wanted now, not at the next poll. */
export function mergedJustNow(): void {
  // GitHub takes a moment to show the merge on the branch.
  setTimeout(() => void check(true), 1500);
  setTimeout(() => void check(true), 20_000);
}

function render() {
  const s = status;
  bar ??= (document.getElementById('app') ?? document.body).appendChild(h('div.update-bar', { role: 'region', 'aria-label': 'Update the office' }));
  const list = s ? steps(s) : [];
  const current = list.findIndex((st) => !st.done);
  // Everything's done up to the reload, or the reload itself: which update this is, for "Hide".
  const key = s ? `${s.target ?? ''}|${current === 4 ? s.startedAt : ''}` : '';
  if (!s || current < 0 || s.error || hiddenKey() === key) {
    bar.hidden = true;
    bar.replaceChildren();
    viewing = notYet = null;
    return;
  }
  // The step on show: the current one, unless the owner opened another. Checks don't move that.
  if (viewing === current || (viewing !== null && !list[viewing])) viewing = null;
  const shown = viewing ?? current;
  if (notYet !== null && (notYet !== shown || list[notYet].done)) notYet = null;
  const hide = h('button.btn.update-hide', { type: 'button', title: 'Put this away until the next merge' }, 'Hide');
  hide.addEventListener('click', () => {
    try {
      localStorage.setItem(HIDE_KEY, key);
    } catch {
      // Private windows: it only hides for now.
    }
    bar!.hidden = true;
  });
  const chips = h(
    'ol.update-steps',
    {},
    // Everything before the current step is done; everything after it is still to come.
    ...list.map((st, i) => {
      const chip = h(
        'button',
        { type: 'button', 'data-focus': `chip${i}`, 'aria-current': i === shown ? 'step' : undefined, title: i === shown ? undefined : `Show step ${i + 1}` },
        h('span.update-num', {}, i < current ? '✓' : String(i + 1)),
        st.title,
      );
      chip.addEventListener('click', () => {
        viewing = i;
        render();
      });
      return h('li', { class: `${i < current ? 'done' : i === current ? 'now' : 'later'}${i === shown && i !== current ? ' shown' : ''}` }, chip);
    }),
  );
  const st = list[shown];
  // A step the owner went back (or ahead) to that's already done: say so, and no "Done" to press.
  const doneAlready = shown < current || (BY_HAND.has(shown) && st.done);
  const title = h('div.update-now-head', {}, h('b.update-now-title', {}, `Step ${shown + 1}: ${st.title}`));
  if (shown !== current) {
    const back = h('button.update-link', { type: 'button', 'data-focus': 'back' }, `← Back to the current step (${current + 1})`);
    back.addEventListener('click', () => {
      viewing = null;
      render();
    });
    title.append(back);
  }
  // The bar is rebuilt on every check: keep the keyboard on the same control (or the step on show).
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && bar.contains(active) ? active.dataset.focus : undefined;
  bar.hidden = false;
  bar.replaceChildren(
    h('div.update-head', {}, h('b', {}, current === 4 ? '✨ The office was updated' : s.needs.pull || current === 0 ? '🔀 New Agent Office code on GitHub' : '🛠 The office’s code changed'), h('span.update-sub', {}, current === 4 ? '' : 'To run it:'), chips, hide),
    h(
      'div.update-now',
      {},
      title,
      ...(doneAlready ? [h('p.update-ok', {}, '✓ This step is done.')] : []),
      ...st.body(),
      ...(BY_HAND.has(shown) && !doneAlready ? [nextRow(s, shown)] : []),
    ),
  );
  if (focused) (bar.querySelector<HTMLElement>(`[data-focus="${focused}"]`) ?? bar.querySelector<HTMLElement>('[aria-current="step"]'))?.focus();
}

/** Starts watching; call once when the page is up. */
export function mountUpdateBar(): void {
  void check();
  setInterval(() => {
    if (document.visibilityState === 'visible') void check();
  }, POLL_MS);
  store.on('floor', () => void check());
  // Back from PowerShell (this tab shown again, or the window focused): check straight away, so the
  // bar has usually moved on to the next step by the time you look.
  let backTimer: ReturnType<typeof setTimeout> | undefined;
  const back = () => {
    if (document.visibilityState !== 'visible' || !bar || bar.hidden) return;
    clearTimeout(backTimer);
    backTimer = setTimeout(() => void check(), BACK_MS);
  };
  document.addEventListener('visibilitychange', back);
  window.addEventListener('focus', back);
  // A PR the boards now show as merged (on GitHub, by a worker, by anyone here): check at once.
  let merged: Set<string> | null = null;
  store.on('pulls', () => {
    const now = new Set(store.pulls.items.filter((p) => p.state === 'MERGED').map((p) => `${p.repo ?? ''}#${p.number}`));
    const fresh = merged !== null && [...now].some((k) => !merged!.has(k));
    merged = now;
    if (fresh) mergedJustNow();
  });
}
