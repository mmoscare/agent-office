import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PHONE_KEEP, type PhoneCall, type WorkerInfo } from '../shared/protocol.js';

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

function isCall(v: unknown): v is PhoneCall {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<PhoneCall>;
  return typeof c.at === 'number' && typeof c.floor === 'string' && typeof c.name === 'string' && typeof c.workerId === 'string' && typeof c.worker === 'string' && typeof c.deskId === 'string' && typeof c.color === 'string' && (c.task === undefined || typeof c.task === 'string');
}

export { PHONE_KEEP };

/** Who rang the office phone, kept in .agent-office/phone.jsonl so a restart doesn't wipe the list. */
export class PhoneLog {
  private calls: PhoneCall[] = [];
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'phone.jsonl');
    this.load();
  }

  recent(): PhoneCall[] {
    return this.calls;
  }

  add(call: PhoneCall): PhoneCall {
    this.calls.push(call);
    if (this.calls.length > PHONE_KEEP) this.calls.splice(0, this.calls.length - PHONE_KEEP);
    try {
      if (this.calls.length === PHONE_KEEP) this.rewrite();
      else appendFileSync(this.file, `${JSON.stringify(call)}\n`, { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
    return call;
  }

  private load() {
    if (!existsSync(this.file)) return;
    let raw: string[];
    try {
      raw = readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    } catch {
      return;
    }
    for (const s of raw) {
      try {
        const c = JSON.parse(s) as unknown;
        if (isCall(c)) this.calls.push(c);
      } catch {
        // a torn last line is skipped
      }
    }
    if (this.calls.length > PHONE_KEEP) {
      this.calls = this.calls.slice(-PHONE_KEEP);
      this.rewrite();
    }
  }

  private rewrite() {
    try {
      writeFileSync(this.file, this.calls.map((c) => `${JSON.stringify(c)}\n`).join(''), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}
