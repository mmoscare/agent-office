import './office-update.css';
import './sync-all.css';
import { newsLines, suggestMessage, type NextStep, type SyncChoice, type SyncFile, type SyncPlan, type SyncRepo, type SyncRepoResult, type SyncResult } from '../../shared/sync-all';
import { UPDATE_STEPS } from '../../shared/office-update';
import { store } from '../state';
import { codeBox, copyText } from './copy-code';
import { h, openModal, STATUS_LABEL, toast, type Modal } from './dom';
import { START_COMMAND } from './manual-content';
import { checkOfficeUpdate, currentStep, officeUpdateState, openOfficeUpdate } from './office-update';

// 🔄 Sync everything (server/sync-all.ts): the window the push-button by the gong opens. One review
// of what's unsaved in each repository of the floor and in the office's app folder (secret-looking
// files unticked, the office's own folders left out), one Go that saves, pulls and uploads, then what
// happened per repository and a short numbered checklist of what the new code needs, with a copy
// button on every command and #84's step-by-step update for the steps it can do itself.

type View =
  | { kind: 'loading' }
  | { kind: 'review'; plan: SyncPlan }
  | { kind: 'running'; plan: SyncPlan; since: number }
  | { kind: 'done'; result: SyncResult }
  | { kind: 'error'; message: string };

let modal: Modal | null = null;
let view: View = { kind: 'loading' };
let render: (() => void) | null = null;
let onBusy: ((on: boolean) => void) | undefined;
/** A sync finished while the window was closed: show its result when it's opened again. */
let unseen = false;
/** Per repository: the ticked files and the message, as the owner left them. */
const picks = new Map<string, { files: Set<string>; message: string; edited: boolean }>();

async function call<T>(path: string, body?: unknown): Promise<T | { error: string }> {
  const floor = store.floor;
  if (!floor) return { error: 'Take the elevator to a floor first' };
  try {
    const res = await fetch(`/api/git/sync-all${path}?${new URLSearchParams({ floor })}`, body === undefined
      ? { credentials: 'same-origin', cache: 'no-store' }
      : { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as T | { error: string };
    if (!res.ok && !(data as { error?: string }).error) return { error: `The office answered ${res.status}` };
    return data;
  } catch {
    return { error: 'The office didn’t answer. Check it’s running, then press Sync again.' };
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function details(text: string | undefined, label = 'Show details'): HTMLElement | null {
  return text ? h('details.ou-details', {}, h('summary', {}, label), h('pre', {}, text)) : null;
}

function spinner(text: string, since?: number): HTMLElement {
  const clock = h('span.ou-elapsed', {});
  if (since) {
    const tick = () => {
      if (!clock.isConnected) return;
      const s = Math.round((Date.now() - since) / 1000);
      clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 0);
  }
  return h('div.ou-running', { role: 'status', 'aria-live': 'polite' }, h('div.ou-running-line', {}, h('span.spinner'), h('b', {}, text), clock), h('div.ou-bar', {}));
}

function tickable(f: SyncFile): boolean {
  return !f.blocked;
}

// ---- The review ----------------------------------------------------------------------------------

function pickFor(repo: SyncRepo) {
  let p = picks.get(repo.id);
  if (!p) {
    p = { files: new Set(repo.files.filter((f) => tickable(f) && !f.risky).map((f) => f.path)), message: repo.suggested, edited: false };
    picks.set(repo.id, p);
  }
  return p;
}

const STATUS_WORD: Record<SyncFile['status'], string> = { M: 'changed', A: 'new', D: 'deleted', R: 'renamed', '?': 'new' };

function fileRow(repo: SyncRepo, f: SyncFile, message: HTMLTextAreaElement): HTMLElement {
  const pick = pickFor(repo);
  const box = h('input', { type: 'checkbox', 'aria-label': `Save ${f.path}` }) as HTMLInputElement;
  box.checked = pick.files.has(f.path);
  box.disabled = !tickable(f);
  box.addEventListener('change', () => {
    if (box.checked) pick.files.add(f.path);
    else pick.files.delete(f.path);
    // The suggestion follows the ticks until the owner writes their own.
    if (!pick.edited) {
      pick.message = suggestMessage(repo.files.filter((x) => pick.files.has(x.path)));
      message.value = pick.message;
    }
    row.classList.toggle('off', !box.checked);
  });
  const why = f.blocked ? h('span.sa-why.blocked', {}, `🚫 never uploaded: ${f.blocked}`) : f.risky ? h('span.sa-why.risky', {}, `⚠️ left unticked: ${f.risky}`) : null;
  const row = h(`label.sa-file${f.blocked ? '.blocked' : f.risky ? '.risky' : ''}` as 'label', { title: f.from ? `${f.from} → ${f.path}` : f.path },
    box,
    h(`span.sa-status.s-${f.status === '?' ? 'new' : f.status}` as 'span', {}, STATUS_WORD[f.status]),
    h('code', {}, f.path),
    why,
  );
  row.classList.toggle('off', !box.checked);
  return row;
}

function repoCard(repo: SyncRepo): HTMLElement {
  const icon = repo.kind === 'office' ? '🏢' : '📁';
  const card = h('section.ou-card.sa-repo', { 'aria-label': repo.name },
    h('div.sa-repo-head', {},
      h('h3', {}, `${icon} ${repo.name}`),
      repo.branch ? h('span.sa-branch', { title: repo.dir }, `🌿 ${repo.branch}${repo.upstream ? ` → ${repo.upstream}` : ''}`) : null,
    ),
    h('p.ou-muted', {}, h('code', {}, repo.dir)),
  );
  if (repo.problem) {
    card.append(h('div.ou-outcome.warn', {}, h('p.ou-message', {}, `✋ Skipped: ${repo.problem}`)));
    return card;
  }
  const pick = pickFor(repo);
  const message = h('textarea.sa-message', { rows: 2, 'aria-label': `Commit message for ${repo.name}`, placeholder: 'What these changes are, in a few words' }) as HTMLTextAreaElement;
  message.value = pick.message;
  message.addEventListener('input', () => {
    pick.message = message.value;
    pick.edited = true;
  });
  if (repo.files.length) {
    const n = repo.files.filter((f) => !f.blocked).length;
    card.append(
      h('p', {}, h('b', {}, n ? `${plural(n, 'file')} with unsaved changes` : 'Nothing that can be saved here'), n ? ' · untick any you don’t want uploaded' : ''),
      h('div.sa-files', {}, ...repo.files.map((f) => fileRow(repo, f, message))),
    );
    if (repo.more) card.append(h('p.ou-muted', {}, `…and ${plural(repo.more, 'more file')} not shown. Look at them on the Git board first.`));
    if (n) card.append(h('label.sa-message-label', {}, 'Commit message', message));
  } else card.append(h('p.ou-done-line', {}, '✅ Nothing unsaved here.'));
  const notes: string[] = [];
  if (repo.ahead) notes.push(`⬆️ Also uploads ${plural(repo.ahead, 'earlier commit')} saved here: ${repo.outgoing.slice(0, 3).map((s) => `“${s}”`).join(', ')}${repo.ahead > 3 ? '…' : ''}`);
  if (repo.behind) notes.push(`⬇️ GitHub has ${plural(repo.behind, 'new change')} to pull in.`);
  if (repo.noPush) notes.push(`ℹ️ ${repo.noPush}`);
  for (const n of notes) card.append(h('p.ou-note', {}, n));
  return card;
}

function choices(plan: SyncPlan): SyncChoice[] {
  return plan.repos.filter((r) => !r.problem).map((r) => {
    const p = pickFor(r);
    return { id: r.id, files: [...p.files], message: p.message.trim() || suggestMessage(r.files.filter((f) => p.files.has(f.path))) };
  });
}

function reviewView(plan: SyncPlan): HTMLElement[] {
  const out: HTMLElement[] = [
    h('p.sa-intro', {}, 'Saves the unsaved work in each folder below as a commit, pulls GitHub’s latest on top, then uploads it. Files that look secret or personal start unticked; the office’s own folders are never uploaded. Nothing happens until you press Go.'),
  ];
  if (plan.truncated) out.push(h('p.ou-note', {}, 'ℹ️ This floor has more repositories than the office looks at: only these are synced.'));
  out.push(...plan.repos.map(repoCard));
  const go = h('button.btn.primary.ou-go', { type: 'button' }, '✅ Go: save, pull and upload');
  go.disabled = !plan.admin || plan.repos.every((r) => r.problem);
  go.addEventListener('click', () => void goNow(plan));
  const cancel = h('button.btn', { type: 'button' }, 'Cancel');
  cancel.addEventListener('click', () => modal?.close());
  out.push(h('div.ou-actions', {}, go, cancel));
  if (!plan.admin) out.push(h('p.ou-muted', {}, 'Only an admin can press Go.'));
  return out;
}

// ---- Go ------------------------------------------------------------------------------------------

async function goNow(plan: SyncPlan) {
  if (view.kind === 'running') return;
  view = { kind: 'running', plan, since: Date.now() };
  onBusy?.(true);
  render?.();
  const r = await call<SyncResult>('/run', { token: plan.token, choices: choices(plan) });
  onBusy?.(false);
  if ('error' in r) {
    view = { kind: 'error', message: r.error };
    render?.();
    return;
  }
  view = { kind: 'done', result: r };
  picks.clear();
  if (!modal) {
    unseen = true;
    toast('🔄 Sync finished. Press the Sync button again to see what to do next.');
  }
  render?.();
  // #84's walkthrough may have steps waiting from before (a pull that was never built): ask it.
  if (r.next.changed || r.repos.some((x) => x.kind === 'office')) void checkOfficeUpdate(true).then(() => render?.());
}

// ---- What happened, and what's next -----------------------------------------------------------------

function resultBox(r: SyncRepoResult): HTMLElement {
  const kind = r.state === 'done' ? 'ok' : r.state === 'skipped' ? 'warn' : 'bad';
  const icon = r.state === 'done' ? '✅' : r.state === 'skipped' ? '✋' : r.state === 'conflict' ? '⚔️' : '❌';
  const box = h('div.ou-outcome', { class: kind, role: kind === 'ok' ? 'status' : 'alert' },
    h('p.ou-message', {}, `${icon} ${r.kind === 'office' ? '🏢' : '📁'} ${r.name}: ${r.message}`),
  );
  if (r.clashes?.length) box.append(h('ul.sa-clashes', {}, ...r.clashes.slice(0, 20).map((c) => h('li', {}, h('code', {}, c)))));
  // A clash or a failure: a request to hand to Claude, ready to paste.
  if (r.state === 'conflict') box.append(h('p.ou-note', {}, 'To hand it to Claude, copy this:'), codeBox(`In ${r.name}, merge GitHub's latest into the current branch and resolve the clashes in ${r.clashes!.join(', ')}. Keep both sides' intent, run the tests, then push.`).el);
  box.append(...[details(r.details)].filter((x): x is HTMLElement => !!x));
  return box;
}

function stepItem(step: NextStep, first: { walkthrough: boolean }, busy: SyncResult['next']['busy']): HTMLElement {
  const li = h('li.sa-step', {}, h('b', {}, step.title));
  if (step.why) li.append(h('span.sa-step-why', {}, ` ${step.why}`));
  if (step.kind === 'restart' && busy.length) li.append(h('ul.ou-workers', {}, ...busy.map((w) => h('li', {}, h('b', {}, w.name), ` · ${w.status === 'needs_input' ? 'waiting for your answer' : STATUS_LABEL[w.status] ?? w.status} · ${w.floor}`))));
  const commands = step.kind === 'start' && !step.commands ? [START_COMMAND] : step.commands;
  for (const c of commands ?? []) li.append(codeBox(c).el);
  if (step.walkthrough) {
    if (first.walkthrough) {
      first.walkthrough = false;
      const b = h('button.btn.primary', { type: 'button' }, '👉 Do it with the step-by-step update');
      b.addEventListener('click', () => {
        modal?.close();
        openOfficeUpdate();
      });
      li.append(h('div.ou-actions', {}, b), h('p.ou-muted', {}, step.kind === 'restart' ? 'It asks before interrupting anyone.' : 'It does this step and the ones after it, one button each, and never restarts without your click.'));
    } else li.append(h('span.ou-muted', {}, ' (the step-by-step update does this too)'));
  }
  if (step.kind === 'reload') {
    const b = h('button.btn', { type: 'button' }, '🔄 Reload this page');
    b.addEventListener('click', () => location.reload());
    li.append(h('div.ou-actions', {}, b));
  }
  return li;
}

/** Plain text of the whole thing, to paste into a chat or a note. */
function summaryText(result: SyncResult): string {
  const lines = ['Sync everything:', ...result.repos.map((r) => `- ${r.name}: ${r.message}`)];
  const news = whatsNew(result);
  if (news.length) lines.push('', 'What’s new:', ...news.map((n) => `- ${n}`));
  if (result.next.steps.length) lines.push('', 'Next:', ...result.next.steps.map((s, i) => `${i + 1}. ${s.title}${s.why ? ` (${s.why})` : ''}${(s.commands ?? []).map((c) => `\n   ${c.replace(/\n/g, '\n   ')}`).join('')}`));
  return lines.join('\n');
}

function whatsNew(result: SyncResult): string[] {
  const out: string[] = [];
  for (const r of result.repos) {
    const lines = r.kind === 'office' ? result.next.news : newsLines(r.prs, r.otherCommits, 4);
    out.push(...lines.map((l) => `${r.kind === 'office' ? 'Agent Office' : r.name}: ${l}`));
  }
  return out;
}

function doneView(result: SyncResult): HTMLElement[] {
  const ok = result.repos.every((r) => r.state === 'done');
  const out: HTMLElement[] = [h('h3.sa-title', {}, ok ? '✅ Everything is saved, uploaded and up to date' : '⚠️ Synced, with something for you to look at')];
  out.push(...result.repos.map(resultBox));

  const news = whatsNew(result);
  if (news.length) out.push(h('section.ou-card.sa-news', { 'aria-label': 'What’s new' }, h('h3', {}, '🆕 What’s new'), h('ul', {}, ...news.map((n) => h('li', {}, n)))));

  const next = result.next;
  const app = result.repos.find((r) => r.kind === 'office');
  const card = h('section.ou-card.sa-next', { 'aria-label': 'What to do next' }, h('h3', {}, '👉 What to do next'));
  if (next.changed) {
    const first = { walkthrough: true };
    card.append(h('ol.sa-steps', {}, ...next.steps.map((s) => stepItem(s, first, next.busy))));
  } else if (app && app.state !== 'done') card.append(h('p', {}, 'The app folder didn’t update, so there’s nothing to install, build or restart yet. Sort out the problem above, then press Sync again.'));
  else card.append(h('p.ou-done-line', {}, app ? '✅ Nothing to do: the app folder had no new code.' : '✅ Nothing to do.'));
  // Nothing new this time, but the step-by-step update still has steps from before (a pull that was never built or restarted).
  const s = officeUpdateState();
  const pending = s ? currentStep(s) : null;
  if (!next.changed && pending && pending !== 'floor' && pending !== 'app') {
    const b = h('button.btn.primary', { type: 'button' }, '👉 Open the step-by-step update');
    b.addEventListener('click', () => {
      modal?.close();
      openOfficeUpdate();
    });
    card.append(h('p.ou-note', {}, `ℹ️ The office still runs older code: the step-by-step update is at “${UPDATE_STEPS.find((x) => x.id === pending)?.title}”.`), h('div.ou-actions', {}, b));
  }
  out.push(card);

  const copy = h('button.btn', { type: 'button', title: 'All of this as plain text, to paste into a chat or a note' }, '📋 Copy a summary');
  copy.addEventListener('click', async () => {
    const done = await copyText(summaryText(result));
    toast(done ? 'Copied' : 'Couldn’t copy here', done ? 'info' : 'warn');
  });
  const again = h('button.btn', { type: 'button' }, '🔄 Sync again');
  again.addEventListener('click', () => void look());
  const close = h('button.btn.primary', { type: 'button' }, 'Close');
  close.addEventListener('click', () => modal?.close());
  out.push(h('div.ou-actions', {}, close, copy, again));
  return out;
}

// ---- The window --------------------------------------------------------------------------------

async function look() {
  view = { kind: 'loading' };
  picks.clear();
  render?.();
  const r = await call<SyncPlan>('');
  if ('error' in r) {
    view = { kind: 'error', message: r.error };
    return render?.();
  }
  view = { kind: 'review', plan: r };
  render?.();
  // Nothing anywhere that could be saved: straight to pulling.
  if (r.admin && r.repos.some((x) => !x.problem) && !r.repos.some((x) => !x.problem && x.files.some(tickable))) void goNow(r);
}

/** Opens the Sync window: looks first, and does nothing until Go. `busy` lights the button by the gong while it runs. */
export function openSyncAll(opts: { busy?: (on: boolean) => void } = {}) {
  onBusy = opts.busy;
  if (modal) return;
  if (!store.floor) return toast('Take the elevator to a floor first', 'warn');
  const body = h('div.body.ou-body.sa-body');
  const el = h('div.modal.ou-modal.sa-modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Sync everything' },
    h('header', {}, h('h2', {}, '🔄 Sync everything')),
    body,
  );
  render = () => {
    body.replaceChildren();
    const v = view;
    if (v.kind === 'loading') body.append(spinner('Looking for unsaved work, and checking GitHub…'));
    else if (v.kind === 'error') {
      const again = h('button.btn.primary', { type: 'button' }, 'Try again');
      again.addEventListener('click', () => void look());
      body.append(h('div.ou-outcome.bad', { role: 'alert' }, h('p.ou-message', {}, `❌ ${v.message}`)), h('div.ou-actions', {}, again));
    } else if (v.kind === 'review') body.append(...reviewView(v.plan));
    else if (v.kind === 'running') {
      const saving = v.plan.repos.filter((r) => !r.problem && pickFor(r).files.size).length;
      body.append(spinner(saving ? 'Saving, pulling and uploading… this can take a minute.' : 'Nothing to save: pulling the latest…', v.since), h('ul.ou-muted', {}, ...v.plan.repos.filter((r) => !r.problem).map((r) => h('li', {}, `${r.kind === 'office' ? '🏢' : '📁'} ${r.name}`))));
    } else body.append(...doneView(v.result));
  };
  modal = openModal(el, {
    doing: 'syncing',
    onClose: () => {
      modal = null;
      render = null;
    },
  });
  if (view.kind === 'running' || (view.kind === 'done' && unseen)) render();
  else void look();
  unseen = false;
}
