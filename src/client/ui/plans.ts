import { PLAN_COLUMNS, PLAN_TEXT_MAX, type PlanAction, type PlansState, type PlanStatus } from '../../shared/plans';
import { store } from '../state';
import { h, openModal, toast } from './dom';

let opened = false;
export function openPlans() {
  if (opened) return;
  const floor = store.floor;
  const info = store.currentFloor();
  if (!floor || !info) return toast('Take the elevator to a floor first', 'warn');
  opened = true;
  let state: PlansState | undefined;
  let busy = false;
  let closed = false;
  let editing: { id: string; text: string } | undefined;
  const url = `/api/plans?floor=${encodeURIComponent(floor)}`;
  const status = h('p.plans-status', { role: 'status', 'aria-live': 'polite' }, 'Loading plans…');
  const error = h('p.err', { role: 'alert' });
  const board = h('div.plans-board');
  const input = h('textarea', { rows: 2, maxlength: PLAN_TEXT_MAX, placeholder: 'What do you want to achieve here?', 'aria-label': 'New plan' });
  const add = h('button.btn.primary', { type: 'submit' }, 'Add plan');
  const refresh = h('button.btn', { type: 'button', onclick: () => void request() }, 'Refresh');
  const form = h('form.plans-add', {}, input, add);
  const controls = h('fieldset.plans-controls', {}, form, board);
  const el = h('div.modal.plans-modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'To Do Next' },
    h('header', {}, h('h2', {}, 'To Do Next'), refresh),
    h('div.body', {}, h('p.plans-floor', {}, info.name),
      h('p.note', {}, 'Your plans for this folder or repo. Add a plan, then move it as you make progress.'),
      status, error, controls));

  function render() {
    if (!state) return;
    board.replaceChildren(...Object.entries(PLAN_COLUMNS).map(([value, label]) => {
      const items = state!.items.filter(p => p.status === value);
      const column = h('section.plans-column', { 'aria-label': label, 'data-status': value }, h('h3', {}, label, h('span', {}, items.length)));
      if (!items.length) column.append(h('p.plans-empty', {}, value === 'todo' ? 'Your next ideas go here.' : value === 'progress' ? 'Plans you’re working on.' : 'Keep your achievements here.'));
      for (const plan of items) {
        const card = h('article.plan-card');
        if (editing?.id === plan.id) {
          const text = h('textarea', { rows: 5, maxlength: PLAN_TEXT_MAX, 'aria-label': 'Edit plan' });
          text.value = editing.text;
          text.oninput = () => { if (editing) editing.text = text.value; };
          card.append(text, h('div.plan-actions', {},
            h('button.btn.primary', { type: 'button', onclick: () => void request({ action: 'edit', id: plan.id, text: text.value }, () => { editing = undefined; }) }, 'Save'),
            h('button.btn', { type: 'button', onclick: () => { editing = undefined; render(); } }, 'Cancel')));
        } else {
          const select = h('select', { 'aria-label': 'Move plan' }, ...Object.entries(PLAN_COLUMNS).map(([value, label]) => h('option', { value }, label)));
          select.value = plan.status;
          select.onchange = () => { const next = select.value as PlanStatus; select.value = plan.status; void request({ action: 'edit', id: plan.id, status: next }); };
          const remove = h('button.btn', { type: 'button', onclick: () => {
            card.replaceChildren(h('p', {}, 'Remove this plan?'), h('p.plan-text', {}, plan.text), h('div.plan-actions', {},
              h('button.btn.danger', { type: 'button', onclick: () => void request({ action: 'remove', id: plan.id }) }, 'Remove plan'),
              h('button.btn', { type: 'button', onclick: render }, 'Keep plan')));
          } }, 'Remove');
          card.append(h('p.plan-text', {}, plan.text), h('div.plan-actions', {}, select,
            h('button.btn', { type: 'button', onclick: () => { editing = { id: plan.id, text: plan.text }; render(); board.querySelector<HTMLTextAreaElement>('textarea')?.focus(); } }, 'Edit'), remove));
        }
        column.append(card);
      }
      return column;
    }));
  }
  async function request(action?: PlanAction, saved?: () => void) {
    if (busy || closed || (action && !state)) return;
    busy = true;
    controls.disabled = refresh.disabled = true;
    status.textContent = action ? 'Saving…' : 'Loading plans…';
    error.textContent = '';
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store',
        ...(action ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...action, revision: state!.revision }) } : {}) });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error ?? 'Could not open the binder. The office server may need a restart.');
      if (closed) return;
      state = data as PlansState;
      saved?.();
      render();
      status.textContent = action ? 'Saved' : 'All plans saved';
    } catch (err) {
      if (!closed) { error.textContent = (err as Error).message; status.textContent = action ? 'Change not saved' : 'Could not load plans'; }
    } finally {
      busy = false;
      controls.disabled = !state;
      refresh.disabled = false;
    }
  }
  form.onsubmit = event => { event.preventDefault(); if (input.value.trim()) void request({ action: 'add', text: input.value }, () => { input.value = ''; input.focus(); }); };
  const off = store.on('floor', () => { if (store.floor !== floor) modal.close(); });
  const modal = openModal(el, { backdropCloses: false, doing: 'planning what to do next', onClose: () => { closed = true; opened = false; off(); } });
  void request();
}
