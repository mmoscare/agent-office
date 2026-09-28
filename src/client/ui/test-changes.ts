import type { Net } from '../net';
import { store } from '../state';
import { workerTestPrompt, workerTestUnavailable } from '../../shared/worker-test';
import { h, toast } from './dom';

/** Sends a scoped task to the existing agent; results belong in that agent's terminal. */
export function testChangesButton(net: Net, workerId: string, onSent?: () => void) {
  let sending = false;
  const element = h('button.btn', { type: 'button' }, 'Test changes');
  const refresh = () => {
    const reason = workerTestUnavailable(store.workers.get(workerId));
    element.disabled = sending || !!reason;
    element.title = reason ?? 'Ask this agent to test the whole task across all of its repositories and worktrees';
  };
  element.addEventListener('click', () => {
    const worker = store.workers.get(workerId);
    const reason = workerTestUnavailable(worker);
    if (sending || reason || !worker) { if (reason) toast(reason, 'warn'); return; }
    if (!net.up) { toast('Reconnect to the office before requesting tests', 'warn'); return; }
    // Re-read worker metadata at click time: another repository may have been added since opening.
    sending = true;
    refresh();
    net.send({ t: 'worker.prompt', workerId, prompt: workerTestPrompt(worker, store.project?.dir) });
    toast(`Asked ${worker.name} to test its changes. Results will appear in its terminal.`);
    onSent?.();
    setTimeout(() => { sending = false; refresh(); }, 1500);
  });
  refresh();
  return { element, refresh };
}
