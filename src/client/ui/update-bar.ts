import type { OfficeStatus } from '../../shared/git-board';
import { store } from '../state';
import { codeBox } from './copy-code';
import { h, toast } from './dom';
import { openManual } from './manual';

// The update bar across the top of the screen: after a pull request for Agent Office itself is
// merged (in the office or on GitHub), the steps to get the office running it, ticked off as each
// gets done: pull the floor, pull the app, build, restart, reload this page. "Hide" puts it away
// until the next merge. It reads the same status as the Git board's 🏢 bar (/api/git/office).

const HIDE_KEY = 'agent-office.updateBarHidden';
const POLL_MS = 60_000;
/** When this page loaded: an office started after it is running code this page doesn't have. */
const pageLoadedAt = Date.now();

let status: OfficeStatus | null = null;
let busy = false;
let bar: HTMLElement | null = null;

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
        return [h('p', {}, 'The office restarted with the new code. Reload to see it. '), b];
      },
    },
  ];
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

/** Asks the office how its own code stands. `fresh`: a PR was just merged, so look at GitHub now. */
export async function check(fresh = false): Promise<void> {
  if (busy || !store.floor) return;
  busy = true;
  try {
    const q = new URLSearchParams({ floor: store.floor, ...(fresh ? { fresh: '1' } : {}) });
    const res = await fetch(`/api/git/office?${q}`, { credentials: 'same-origin', cache: 'no-store' });
    if (res.ok) status = ((await res.json()) as { office: OfficeStatus | null }).office;
  } catch {
    // Offline for a moment (a restart): keep what we had.
  } finally {
    busy = false;
  }
  render();
}

/** A pull request was merged here: its steps are wanted now, not at the next poll. */
export function mergedJustNow(): void {
  // GitHub takes a moment to show the merge on the branch.
  setTimeout(() => void check(true), 1500);
  setTimeout(() => void check(true), 20_000);
}

function render() {
  const s = status;
  bar ??= document.body.appendChild(h('div.update-bar', { role: 'region', 'aria-label': 'Update the office' }));
  const list = s ? steps(s) : [];
  const current = list.findIndex((st) => !st.done);
  // Everything's done up to the reload, or the reload itself: which update this is, for "Hide".
  const key = s ? `${s.target ?? ''}|${current === 4 ? s.startedAt : ''}` : '';
  if (!s || current < 0 || s.error || hiddenKey() === key) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
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
    ...list.map((st, i) => h('li', { class: i < current ? 'done' : i === current ? 'now' : 'later' }, h('span.update-num', {}, i < current ? '✓' : String(i + 1)), st.title)),
  );
  bar.hidden = false;
  bar.replaceChildren(
    h('div.update-head', {}, h('b', {}, current === 4 ? '✨ The office was updated' : s.needs.pull || current === 0 ? '🔀 New Agent Office code on GitHub' : '🛠 The office’s code changed'), h('span.update-sub', {}, current === 4 ? '' : 'To run it:'), chips, hide),
    h('div.update-now', {}, h('b.update-now-title', {}, `Step ${current + 1}: ${list[current].title}`), ...list[current].body()),
  );
}

/** Starts watching; call once when the page is up. */
export function mountUpdateBar(): void {
  void check();
  setInterval(() => {
    if (document.visibilityState === 'visible') void check();
  }, POLL_MS);
  store.on('floor', () => void check());
  // A PR the boards now show as merged (on GitHub, by a worker, by anyone here): check at once.
  let merged: Set<string> | null = null;
  store.on('pulls', () => {
    const now = new Set(store.pulls.items.filter((p) => p.state === 'MERGED').map((p) => `${p.repo ?? ''}#${p.number}`));
    const fresh = merged !== null && [...now].some((k) => !merged!.has(k));
    merged = now;
    if (fresh) mergedJustNow();
  });
}
