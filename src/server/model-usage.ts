import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isAgentProvider, type AgentProvider, type WorkerInfo } from '../shared/protocol.js';
import type { ModelUsageRecord } from '../shared/model-usage.js';
import { reportedUsage } from './reported-usage.js';

/** Independent snapshot history: does not change upstream's Claude daily budget or accounting. */
export class ModelUsageLedger {
  private records = new Map<string, ModelUsageRecord>();
  private file: string;
  private timer?: NodeJS.Timeout;
  private dirty = false;
  private loadFailed = false;
  saveError?: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'model-usage.json');
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.records)) throw new Error('Unsupported history');
      for (const row of saved.records) {
        const usage = reportedUsage(row?.usage);
        if (!usage || !isAgentProvider(row.provider) || typeof row.key !== 'string' || typeof row.floor !== 'string' || typeof row.worker !== 'string' || !Number.isFinite(row.startedAt) || !Number.isFinite(row.updatedAt)) throw new Error('Invalid history');
        this.records.set(row.key, { key: row.key, provider: row.provider, floor: row.floor, worker: row.worker,
          startedAt: row.startedAt, updatedAt: row.updatedAt, usage,
          ...(typeof row.initialModel === 'string' ? { initialModel: row.initialModel } : {}),
        });
      }
    } catch {
      // Preserve an unreadable file; never replace it with an empty history.
      this.records.clear();
      this.loadFailed = true;
      this.saveError = 'Saved usage history could not be read. The original file has been preserved.';
    }
  }

  record(floor: string, w: WorkerInfo, fallback: AgentProvider = 'claude') {
    if (w.kind !== 'agent') return;
    const usage = reportedUsage(w.usage);
    if (!usage) return;
    const provider = w.provider ?? fallback;
    // Claude's upstream tracker spans /clear sessions for a worker. OpenCode and Codex reset
    // their counters per session, and resuming that same session must replace its snapshot.
    const scope = provider === 'claude' || provider === 'custom' ? w.id : w.sessionId;
    if (!scope) return;
    const key = `${provider}:${scope}`;
    const previous = this.records.get(key);
    if (previous && previous.floor === floor && previous.worker === w.name && previous.initialModel === w.model && JSON.stringify(previous.usage) === JSON.stringify(usage)) return;
    this.records.set(key, { key, provider, floor, worker: w.name, initialModel: w.model,
      startedAt: previous?.startedAt ?? w.createdAt, updatedAt: Date.now(), usage });
    this.dirty = true;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.write(); }, 600);
  }

  list(): ModelUsageRecord[] {
    return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(r => ({ ...r, usage: { ...r.usage } }));
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.write();
  }

  private write() {
    if (!this.dirty || this.loadFailed) return;
    try {
      const temp = this.file + '.tmp';
      writeFileSync(temp, JSON.stringify({ version: 1, records: this.list() }, null, 2), { mode: 0o600 });
      renameSync(temp, this.file);
      this.dirty = false;
      this.saveError = undefined;
    } catch {
      this.saveError = 'Usage is visible now, but its history could not be saved to disk.';
    }
  }
}
