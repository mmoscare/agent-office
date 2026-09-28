import { PLAN_COLUMNS, PLAN_TEXT_MAX, type Plan, type PlanAction, type PlansState, type PlanStatus } from '../../shared/plans';
import { store } from '../state';
import { h, openModal, timeAgo, toast } from './dom';

/** What the binder can do with a plan besides keeping it: hand it to the workers (main.ts). */
export interface PlansActions {
  /** Put it on the 📋 task queue, for a fresh worker. */
  queue(plan: Plan): void;
  /** Hand it to a worker at a desk now (or to one already working). */
  assign(plan: Plan): void;
  openTerminal(workerId: string): void;
}

let opened = false;
export function openPlans(actions: PlansActions) {
  if (opened) return;
  const floor = store.floor;
  const info = store.currentFloor();
  if (!floor || !info) return toast('Take the elevator to a floor first', 'warn');
  opened = true;
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
    h('p.plans-floor', {}, info.name),
    h('p.note', {}, 'Your plans for this folder or repo. Add a plan, then move it as you make progress, or hand it over: 📋 queues it for a fresh worker, 🤖 gives it to one at a desk. The office moves it to Progress when the worker starts and to Finished when it finishes. The board agents read this board too (office-plans).'),
    status, error, controls);

  /** The queue task a plan is on, if it's on one now. */
  const taskFor = (plan: Plan) => store.queue.tasks.find((t) => t.plan === plan.id && t.status !== 'done');

  function render() {
    const state: PlansState = store.plans;
    board.replaceChildren(...Object.entries(PLAN_COLUMNS).map(([value, label]) => {
      const items = state.items.filter(p => p.status === value);
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
          // Who's on it: its queue task, or the worker it was handed to.
          const task = taskFor(plan);
          const worker = plan.worker ? store.workers.get(plan.worker.id) : undefined;
          const links: HTMLElement[] = [];
          if (task) links.push(h('span.plan-link', { title: task.title }, task.status === 'running' ? `📋 ${task.workerName ?? 'A worker'} is on it` : '📋 On the queue'));
          else if (plan.worker) {
            const said = `🤖 ${plan.worker.name}${plan.status === 'finished' ? ' finished it' : ' is on it'}`;
            links.push(worker
              ? h('button.btn.plan-link', { type: 'button', title: `${plan.worker.name}’s terminal`, onclick: () => actions.openTerminal(plan.worker!.id) }, said)
              : h('span.plan-link', {}, said));
          } else if (plan.status === 'finished' && plan.finishedAt) links.push(h('span.plan-link', {}, `✅ Finished ${timeAgo(plan.finishedAt)}`));
          const hand = plan.status !== 'finished' && !task
            ? [
                h('button.btn', { type: 'button', title: 'Put it on the task queue: the next free worker picks it up', onclick: () => actions.queue(plan) }, '📋 Queue'),
                h('button.btn', { type: 'button', title: 'Hand it to a worker at a desk now', onclick: () => actions.assign(plan) }, '🤖 Hand to a worker'),
              ]
            : [];
          card.append(h('p.plan-text', {}, plan.text));
          if (links.length) card.append(h('p.plan-links', {}, ...links));
          card.append(h('div.plan-actions', {}, select, ...hand,
            h('button.btn', { type: 'button', onclick: () => { editing = { id: plan.id, text: plan.text }; render(); board.querySelector<HTMLTextAreaElement>('textarea')?.focus(); } }, 'Edit'), remove));
        }
        column.append(card);
      }
      return column;
    }));
  }
  /** A change of your own goes to the office with the board's revision; the office sends everyone the new board. */
  async function request(action?: PlanAction, saved?: () => void) {
    if (busy || closed) return;
    busy = true;
    controls.disabled = refresh.disabled = true;
    status.textContent = action ? 'Saving…' : 'Loading plans…';
    error.textContent = '';
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store',
        ...(action ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...action, revision: store.plans.revision }) } : {}) });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error ?? 'Could not open the binder. The office server may need a restart.');
      if (closed) return;
      if (data && typeof data.revision === 'number' && Array.isArray(data.items)) store.plans = data as PlansState;
      saved?.();
      render();
      status.textContent = action ? 'Saved' : 'All plans saved';
    } catch (err) {
      if (!closed) { error.textContent = (err as Error).message; status.textContent = action ? 'Change not saved' : 'Could not load plans'; }
    } finally {
      busy = false;
      controls.disabled = false;
      refresh.disabled = false;
    }
  }
  form.onsubmit = event => { event.preventDefault(); if (input.value.trim()) void request({ action: 'add', text: input.value }, () => { input.value = ''; input.focus(); }); };
  const unsubs = [
    store.on('floor', () => { if (store.floor !== floor) modal.close(); }),
    // The board agents, the queue and the workers move items along too.
    store.on('plans', () => { if (!busy) render(); }),
    store.on('queue', render),
    store.on('workers', render),
  ];
  const modal = openModal(el, { backdropCloses: false, doing: 'planning what to do next', onClose: () => { closed = true; opened = false; unsubs.forEach((u) => u()); } });
  render();
  void request();
}
