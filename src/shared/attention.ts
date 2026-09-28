import type { FloorInfo, WorkerAttention, WorkerInfo } from './protocol.js';
import { DESK_BY_ID } from './layout.js';
import { alertDetail } from './status.js';

/** One notification per agent. Questions stay pending until the agent moves on. */
export function workerAttention(w: WorkerInfo): WorkerAttention | undefined {
  if (w.kind !== 'agent') return;
  const reason = w.status === 'needs_input' ? 'needs_input'
    : w.status === 'done' && !w.acked ? 'done'
    : w.status === 'exited' && w.exitCode !== undefined && w.exitCode !== 0 && !w.acked ? 'error'
    : undefined;
  if (!reason) return;
  const detail = reason === 'error'
    ? `Exited with code ${w.exitCode}. Open the terminal to retry.`
    : alertDetail(w);
  return { id: w.id, name: w.name, color: w.color, reason, detail: detail?.slice(0, 200) };
}

/** The same counts and notification entries for the floor broadcast and the current floor's HUD. */
export function summarizeWorkers(workers: Iterable<WorkerInfo>): Pick<FloorInfo, 'workers' | 'busy' | 'waiting' | 'attention'> {
  const list = [...workers].sort((a, b) => a.createdAt - b.createdAt);
  const attention = list.flatMap((w) => {
    const entry = workerAttention(w);
    return entry ? [entry] : [];
  });
  return {
    workers: list.filter((w) => !DESK_BY_ID.get(w.deskId)?.station).length,
    busy: list.filter((w) => w.status === 'working').length,
    waiting: attention.length,
    attention,
  };
}

/** Local worker updates arrive before the throttled building broadcast; never count both copies. */
export function attentionFloors(floors: readonly FloorInfo[], currentFloor: string | null, workers: Iterable<WorkerInfo>): FloorInfo[] {
  return floors.map((floor) => floor.id === currentFloor ? { ...floor, ...summarizeWorkers(workers) } : floor);
}
