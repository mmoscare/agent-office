import { AUTHOR_REPO, authorUpdatePrompt, type AuthorUpdates } from '../../shared/author-updates';
import { store } from '../state';
import { h, openModal, timeAgo } from './dom';

export let authorUpdates: AuthorUpdates = { enabled: false };
let loading = false;
let generation = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());
export function onAuthorUpdates(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }

export async function loadAuthorUpdates(refresh = false) {
  if (!store.floor || loading) return;
  const mine = generation;
  loading = true;
  emit();
  try {
    const q = new URLSearchParams({ floor: store.floor });
    const res = await fetch(`/api/git/author-updates${refresh ? '/check' : ''}?${q}`, {
      method: refresh ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Couldn't check for updates (HTTP ${res.status}).`);
    const next = await res.json() as AuthorUpdates;
    if (mine === generation) authorUpdates = next;
  } catch (err) {
    if (mine === generation) authorUpdates = { ...authorUpdates, error: (err as Error).message };
  } finally {
    if (mine === generation) { loading = false; emit(); }
  }
}

store.on('floor', () => {
  generation++;
  loading = false;
  authorUpdates = { enabled: false };
  emit();
  void loadAuthorUpdates();
});
setInterval(() => {
  if (document.visibilityState === 'visible') void loadAuthorUpdates();
}, 60_000);

export function authorUpdateLabel(s: AuthorUpdates): string {
  if (s.error) return 'Check unavailable';
  if (s.merging) return 'Merge needs attention';
  if (s.behind) return `${s.behind} new author update${s.behind === 1 ? '' : 's'}`;
  return s.checkedAt ? 'Up to date with author' : 'Checking author updates';
}

export function openAuthorUpdates(assign: (prompt: string, title: string) => void) {
  if (!authorUpdates.enabled) return;
  const floor = store.floor;
  const body = h('div.body');
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '×');
  const check = h('button.btn', { onclick: () => void loadAuthorUpdates(true) }, 'Check now');
  const merge = h('button.btn.primary', { onclick: () => {
    if (store.floor !== floor || !authorUpdates.enabled || loading) return;
    const snapshot = authorUpdates;
    modal.close();
    assign(authorUpdatePrompt(snapshot), snapshot.merging ? 'Resolve author update conflicts' : 'Merge author updates');
  } }, 'Merge with a worker');
  const el = h('div.modal', { role: 'dialog', 'aria-label': 'Author updates', style: 'width:min(720px,100%)' },
    h('header', {}, h('h2', {}, 'Author updates'), close), body,
    h('footer', {}, check, merge));
  const render = () => {
    if (store.floor !== floor || !authorUpdates.enabled) { modal.close(); return; }
    const s = authorUpdates;
    check.disabled = loading;
    merge.disabled = loading || (!s.merging && (!!s.error || !s.behind));
    merge.textContent = s.merging ? 'Resolve / continue with a worker' : 'Merge with a worker';
    body.replaceChildren(
      h('p', {}, h('a', { href: `https://github.com/${AUTHOR_REPO}/commits/main/`, target: '_blank', rel: 'noopener' }, `${AUTHOR_REPO} · main ↗`)),
      h('h3', { 'aria-live': 'polite' }, loading ? 'Checking…' : authorUpdateLabel(s)),
      h('p', {}, 'Checks every 5 minutes while this floor is open. Updates are commits on the author’s main branch, compared with your local personal branch.'),
      h('p', {}, s.checkedAt ? `Last successful check: ${timeAgo(s.checkedAt)}.` : 'No successful check yet.'),
      ...(s.error ? [h('p', { role: 'alert' }, s.error)] : []),
      ...(s.merging ? [h('p', {}, 'An unfinished merge exists in personal. Continue with its worker, or assign a worker to inspect and resolve it.'),
        h('ul', {}, ...(s.conflicts ?? []).map(file => h('li', {}, h('code', {}, file))))] : []),
      h('ul', {}, ...(s.changes ?? []).map(c => h('li', {}, h('a', {
        href: `https://github.com/${AUTHOR_REPO}/commit/${c.sha}`, target: '_blank', rel: 'noopener',
      }, c.sha.slice(0, 7)), ` ${c.subject}`))),
      ...(s.behind && s.behind > (s.changes?.length ?? 0) ? [h('p', {}, `Showing the latest ${s.changes?.length ?? 0} commits.`)] : []),
      h('p', {}, 'Merge opens a task you can review and send to a new or existing worker. The worker follows upstream/main → main → personal, resolves conflicts while preserving your customizations, tests and builds, then pushes to your fork.'),
      h('p.note', {}, 'Use the same worker while an update is in progress. A merged update runs after the office restarts; wait until active workers finish.'),
    );
  };
  const unsub = onAuthorUpdates(render);
  const modal = openModal(el, { onClose: () => { unsub(); } });
  close.addEventListener('click', () => modal.close());
  render();
  void loadAuthorUpdates();
}
