import { UPDATE_STEPS, type OfficeUpdateState } from '../../shared/office-update';
import { store } from '../state';
import { h } from './dom';
import { checkOfficeUpdate, currentStep, officeUpdateState, onOfficeUpdate, openOfficeUpdate } from './office-update';

// The update bar across the top of the screen: after a pull request for Agent Office itself is
// merged (in the office or on GitHub), which pull requests are waiting and how far the update has
// got, with a button that opens the step-by-step walkthrough (ui/office-update.ts). After the
// restart it says the update is live and who to tell "continue". "Hide" puts it away until the next
// merge. It reads the walkthrough's state (/api/git/office/update).

const HIDE_KEY = 'agent-office.updateBarHidden';
const POLL_MS = 60_000;

let bar: HTMLElement | null = null;

function hiddenKey(): string {
  try {
    return localStorage.getItem(HIDE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Which update this is: a newer merge brings the bar back after "Hide". */
function keyOf(s: OfficeUpdateState): string {
  return `${s.target ?? s.app.head ?? ''}|${s.last && !s.last.acknowledged ? s.last.at : ''}`;
}

function prLabel(s: OfficeUpdateState): string {
  const prs = s.prs;
  if (prs.length === 1) return `PR #${prs[0].number}: ${prs[0].title}`;
  if (prs.length > 1) return `${prs.length} pull requests (${prs.slice(0, 3).map((p) => `#${p.number}`).join(', ')}${prs.length > 3 ? '…' : ''})`;
  return '';
}

/** A PR was merged here: look at GitHub now, not at the next poll. */
export function mergedJustNow(): void {
  // GitHub takes a moment to show the merge on the branch.
  setTimeout(() => void checkOfficeUpdate(true), 1500);
  setTimeout(() => void checkOfficeUpdate(true), 20_000);
}

function render() {
  const s = officeUpdateState();
  bar ??= (document.getElementById('app') ?? document.body).appendChild(h('div.update-bar', { role: 'region', 'aria-label': 'Update the office' }));
  const step = s ? currentStep(s) : null;
  const last = s?.last && !s.last.acknowledged && s.last.verdict !== 'pending' ? s.last : undefined;
  const key = s ? keyOf(s) : '';
  if (!s || s.error || (!step && !last) || hiddenKey() === key) {
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
  const open = (label: string) => {
    const b = h('button.btn.primary', { type: 'button' }, label);
    b.addEventListener('click', openOfficeUpdate);
    return b;
  };
  bar.hidden = false;
  if (!step && last) {
    // After the restart: how it went.
    const live = last.verdict === 'live';
    const prs = last.prs;
    const what = prs.length === 1 ? `PR #${prs[0].number} is live` : prs.length ? `${prs.length} pull requests are live` : 'The office runs the new code';
    const waiting = last.now.filter((w) => !w.gone && w.status !== 'working' && w.status !== 'starting').length;
    bar.replaceChildren(
      h('div.update-head', { class: live ? 'ok' : 'bad' },
        h('b', {}, live ? `✅ Done: ${what}.` : '❌ The office update didn’t finish.'),
        h('span.update-sub', {}, live ? (waiting ? `Tell ${waiting} worker${waiting === 1 ? '' : 's'} “continue”.` : '') : 'It’s still on the old version.'),
        h('span.update-grow', {}),
        open(live ? (waiting ? '💬 Who to tell' : 'Details') : 'See what happened'),
        hide,
      ),
    );
    return;
  }
  const index = UPDATE_STEPS.findIndex((st) => st.id === step);
  const chips = h(
    'ol.update-steps',
    { 'aria-label': `Step ${index + 1} of ${UPDATE_STEPS.length}` },
    ...UPDATE_STEPS.map((st, i) => h('li', { class: i < index ? 'done' : i === index ? 'now' : 'later' }, h('span.update-num', {}, i < index ? '✓' : String(i + 1)), st.title)),
  );
  const title = s.app.behind > 0 || s.floors.some((f) => f.behind > 0) ? '🔀 New Agent Office code' : '🛠 The office’s code changed';
  const label = prLabel(s);
  bar.replaceChildren(
    h('div.update-head', {}, h('b', {}, title), label ? h('span.update-pr', { title: label }, label) : null, h('span.update-grow', {}), open('👉 Walk me through it'), hide),
    h('div.update-now', {}, h('span.update-sub', {}, `Step ${index + 1} of ${UPDATE_STEPS.length}: ${UPDATE_STEPS[index].title}`), chips),
  );
}

/** Starts watching; call once when the page is up. */
export function mountUpdateBar(): void {
  onOfficeUpdate(render);
  void checkOfficeUpdate();
  setInterval(() => {
    if (document.visibilityState === 'visible') void checkOfficeUpdate();
  }, POLL_MS);
  store.on('floor', () => void checkOfficeUpdate());
  // A PR the boards now show as merged (on GitHub, by a worker, by anyone here): check at once.
  let merged: Set<string> | null = null;
  store.on('pulls', () => {
    const now = new Set(store.pulls.items.filter((p) => p.state === 'MERGED').map((p) => `${p.repo ?? ''}#${p.number}`));
    const fresh = merged !== null && [...now].some((k) => !merged!.has(k));
    merged = now;
    if (fresh) mergedJustNow();
  });
}
