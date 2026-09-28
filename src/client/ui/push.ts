import './push.css';
import { pushAdvice, type PushPreview, type PushTargets } from '../../shared/push';
import { store } from '../state';
import { h, openModal, toast } from './dom';
import type { HudAction } from './menu';

let list: PushTargets | undefined;
let generation = 0;
let opened = false;
let notify = () => {};
const pending = () => list?.targets.reduce((n, t) => n + (!t.error ? t.ahead : 0), 0) ?? 0;
async function api<T>(floor: string, endpoint: string, params: Record<string, string> = {}, body?: unknown): Promise<T> {
  const q = new URLSearchParams({ floor, ...params });
  const r = await fetch(`/api/git/${endpoint}?${q}`, { credentials: 'same-origin', cache: 'no-store',
    ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error ?? 'Could not check Push. The office server may need a restart.');
  return data as T;
}
async function refreshTargets() {
  const floor = store.floor;
  const seq = ++generation;
  if (!floor) { list = undefined; notify(); return; }
  try {
    const next = await api<PushTargets>(floor, 'push-targets');
    if (generation === seq && store.floor === floor) { list = next; notify(); }
  } catch { if (generation === seq) { list = undefined; notify(); } }
}
export const pushAction: HudAction = {
  id: 'push', icon: '⬆️', label: 'Push', section: 'Open', run: openPush,
  status: () => pending() > 0, count: pending, chip: () => 'Push',
  title: () => pending() ? 'Saved commits may need uploading. Check the repository and remote before pushing.' : 'Check what is ready to upload on this floor or in the Agent Office app',
};
export function mountPush(changed: () => void) {
  notify = changed;
  store.on('floor', () => { list = undefined; notify(); void refreshTargets(); });
  setInterval(() => { if (document.visibilityState === 'visible') void refreshTargets(); }, 60_000);
  window.addEventListener('focus', () => void refreshTargets());
  void refreshTargets();
}

export function openPush() {
  if (opened) return;
  const floor = store.floor;
  if (!floor || !store.currentFloor()) return toast('Take the elevator to a floor first', 'warn');
  opened = true;
  let closed = false;
  let busy = false;
  let preview: PushPreview | undefined;
  const choose = h('select', { 'aria-label': 'Repository to push' });
  const check = h('button.btn', { type: 'button' }, 'Check again');
  const push = h('button.btn.primary', { type: 'button', disabled: true }, 'Push');
  const info = h('div.push-info');
  const status = h('p', { role: 'status', 'aria-live': 'polite' }, 'Finding repositories…');
  const error = h('p.err', { role: 'alert' });
  const el = h('div.modal.push-modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Push' },
    h('header', {}, h('h2', {}, 'Push saved commits')),
    h('div.body', {}, h('p', {}, 'Upload commits to the selected repository’s remote. Choose the checkout you worked in.'),
      h('label', {}, 'Repository and branch', choose), status, error, info),
    h('footer', {}, check, push));
  function enabled() {
    choose.disabled = check.disabled = busy;
    push.disabled = busy || !preview?.token || !pushAdvice(preview.target).ready;
  }
  function render() {
    if (!preview) { info.replaceChildren(); return; }
    const s = preview.target;
    const advice = pushAdvice(s);
    info.replaceChildren(h('div.push-advice', { class: advice.ready ? 'ready' : '' }, h('h3', {}, advice.title), h('p', {}, advice.detail)),
      h('dl.push-details', {}, h('dt', {}, 'Checkout'), h('dd', {}, s.dir), h('dt', {}, 'Branch'), h('dd', {}, s.branch ?? 'Detached HEAD'), h('dt', {}, 'Destination'), h('dd', {}, s.destination ?? 'No origin remote')),
      h('p.push-note', {}, s.dirty ? `${s.dirty} uncommitted file entries stay on this computer. This push only uploads the commits listed below.` : 'This uploads existing commits. It does not create a commit or a pull request.'),
      preview.commits.length ? h('div', {}, h('h3', {}, 'Commits to upload'), h('ul.push-commits', {}, ...preview.commits.map(c => h('li', {}, h('code', {}, c.hash), ' ', c.subject))),
        s.ahead > preview.commits.length ? h('p.push-note', {}, `Showing the newest ${preview.commits.length} of ${s.ahead} commits.`) : null) : null);
  }
  async function inspect() {
    if (busy || closed || !choose.value) return;
    busy = true; preview = undefined; error.textContent = ''; status.textContent = 'Checking the remote…'; render(); enabled();
    try {
      const next = await api<PushPreview>(floor!, 'push-preview', { target: choose.value });
      if (closed) return;
      preview = next; status.textContent = 'Remote checked just now'; render();
    } catch (err) { if (!closed) { status.textContent = 'Could not check'; error.textContent = (err as Error).message; } }
    finally { busy = false; enabled(); }
  }
  choose.onchange = () => void inspect();
  check.onclick = () => void load();
  push.onclick = async () => {
    if (busy || !preview?.token) return;
    busy = true; error.textContent = ''; status.textContent = 'Pushing…'; enabled();
    const sending = preview;
    try {
      const result = await api<{ branch: string; count: number }>(floor, 'push-reviewed', {}, { target: sending.target.id, token: sending.token });
      if (closed) return;
      preview = undefined;
      status.textContent = `Pushed ${result.count} commit${result.count === 1 ? '' : 's'} from ${result.branch}.`;
      info.replaceChildren(h('div.push-advice.ready', {}, h('h3', {}, 'Uploaded'), h('p', {}, 'Your saved commits are on the remote. Pushing does not rebuild or restart the app.')));
      void refreshTargets();
    } catch (err) { if (!closed) { preview = undefined; status.textContent = 'Push did not complete'; error.textContent = (err as Error).message; } }
    finally { busy = false; enabled(); }
  };
  async function load() {
    if (busy || closed) return;
    busy = true; preview = undefined; status.textContent = 'Finding repositories…'; error.textContent = ''; enabled();
    try {
      const data = await api<PushTargets>(floor!, 'push-targets');
      if (closed) return;
      const selected = choose.value;
      choose.replaceChildren(...data.targets.map(t => h('option', { value: t.id }, `${t.kind === 'office' ? 'App: ' : 'Floor: '}${t.name} · ${t.branch ?? 'no branch'}${t.ahead ? ` · ${t.ahead} to check` : ''}${t.kind === 'floor' && t.id !== 'floor:.' ? ` (${t.id.slice(6)})` : ''}`)));
      if (data.targets.some(t => t.id === selected)) choose.value = selected;
      else if (data.targets.length > 1) { choose.prepend(h('option', { value: '' }, 'Choose a repository…')); choose.value = ''; }
      status.textContent = data.targets.length ? data.truncated ? 'Choose a repository. The folder search reached its limit; some repositories may be missing.' : 'Choose a repository to check what is ready.' : 'No Git repositories found here.';
      render();
    } catch (err) { if (!closed) { status.textContent = 'Could not load'; error.textContent = (err as Error).message; } }
    finally { busy = false; enabled(); }
    if (!closed && choose.value) void inspect();
  }
  const unsubscribe = store.on('floor', () => { if (store.floor !== floor) modal.close(); });
  const modal = openModal(el, { backdropCloses: false, doing: 'reviewing commits to push', onClose: () => { closed = true; opened = false; unsubscribe(); } });
  void load();
}
