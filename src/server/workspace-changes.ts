import path from 'node:path';
import type { WorkerInfo } from '../shared/protocol.js';
import { Changes, type ChangesEvents } from './changes.js';
import { Workspaces } from './workspaces.js';
import { isBusy } from '../shared/status.js';

/** Reuse the normal Changes window, but keep watches and actions separate for every repository. */
export class WorkspaceChanges {
  private readers = new Map<string, { workerId: string; changes: Changes }>();
  constructor(private dir: string, private worker: (id: string) => WorkerInfo | undefined, private events: ChangesEvents) {}

  get(workerId: string, repository: string): Changes | undefined {
    const worker = this.worker(workerId);
    const ref = worker?.workspace?.repositories.find(r => r.repository === repository);
    if (!worker?.workspace || !ref) return undefined;
    const key = JSON.stringify([workerId, repository]);
    let reader = this.readers.get(key);
    if (!reader) {
      const changes = new Changes(this.dir, ref.from, id => {
        const w = this.worker(id);
        const r = w?.workspace?.repositories.find(r => r.repository === repository);
        if (!w?.workspace || !r) return undefined;
        let error: string | undefined;
        try { new Workspaces(this.dir).check(w.workspace, r); } catch (err) { error = (err as Error).message; }
        return { name: `${w.name} / ${r.name}`, cwd: path.join(this.dir, r.path), rel: r.path, worktreeBase: r.base, error, busy: isBusy(w.status) || w.prOpening ? 'Wait until the worker finishes its current operation' : undefined };
      }, () => this.worker(workerId)?.workspace?.repositories.find(r => r.repository === repository)?.pr, {
        ...this.events,
        state: (state, clients) => this.events.state({ ...state, repository }, clients),
      });
      reader = { workerId, changes };
      this.readers.set(key, reader);
    }
    return reader.changes;
  }

  unwatchAll(clientId: string) { for (const r of this.readers.values()) r.changes.unwatchAll(clientId); }
  unwatch(workerId: string, clientId: string, repository?: string) {
    if (repository) this.readers.get(JSON.stringify([workerId, repository]))?.changes.unwatch(workerId, clientId);
  }
  forget(workerId: string) {
    for (const [key, r] of this.readers) if (r.workerId === workerId) { r.changes.stop(); this.readers.delete(key); }
  }
  stop() { for (const r of this.readers.values()) r.changes.stop(); this.readers.clear(); }
}
