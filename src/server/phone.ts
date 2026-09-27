import type { WorkerInfo } from '../shared/protocol.js';

/**
 * The office phone: rings on every other floor when an agent worker finishes. It hears every
 * worker's updates and picks out the moment one goes from anything else to done. A worker it's
 * never seen before doesn't count, so the workers waking up at their desks after a restart,
 * already done, don't set every phone in the building off.
 */
export class PhoneLine {
  private last = new Map<string, WorkerInfo['status']>();

  /** True when this update is `w` finishing a turn: time to ring. */
  onWorker(w: WorkerInfo): boolean {
    const before = this.last.get(w.id);
    this.last.set(w.id, w.status);
    return w.kind === 'agent' && before !== undefined && before !== 'done' && w.status === 'done';
  }

  onWorkerGone(id: string) {
    this.last.delete(id);
  }
}
