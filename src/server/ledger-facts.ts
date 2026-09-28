import type { LedgerFacts } from '../shared/ledger.js';
import type { AgentProvider, UsageState, WorkerInfo } from '../shared/protocol.js';

const DAY_MS = 86_400_000;

/**
 * Read live desks across the building, independent of the viewer's current floor. A session's
 * tokens and cost are its running total since the worker was hired (kept across restarts and
 * resumes), so each is spread over the days since then, a day at least, to give a daily rate.
 */
export function ledgerFacts(usage: UsageState, floors: Iterable<{
  project: { defaultProvider?: AgentProvider };
  workers: { list(): WorkerInfo[] };
}>, now = Date.now()): LedgerFacts {
  const facts: LedgerFacts = {
    claude: { today: usage.today.cost, month: usage.month, total: usage.total.cost, calls: usage.total.calls },
    codex: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, sessions: 0, unknown: 0 },
    opencode: { cost: 0, sessions: 0, unknown: 0 },
  };
  for (const floor of floors) {
    for (const worker of floor.workers.list()) {
      if (worker.kind !== 'agent') continue;
      const provider = worker.provider ?? floor.project.defaultProvider ?? 'claude';
      const u = worker.usage;
      const days = Math.max(1, (now - worker.createdAt) / DAY_MS);
      if (provider === 'codex') {
        if (!u) {
          facts.codex.unknown!++;
          continue;
        }
        facts.codex.sessions++;
        facts.codex.input += u.input / days;
        facts.codex.cacheRead += u.cacheRead / days;
        facts.codex.cacheWrite += u.cacheWrite / days;
        facts.codex.output += (u.output + (u.reasoning ?? 0)) / days;
      } else if (provider === 'opencode') {
        if (!u || u.costKnown === false || !Number.isFinite(u.cost) || u.cost < 0 || u.incomplete) {
          facts.opencode.unknown!++;
        } else {
          facts.opencode.sessions++;
          facts.opencode.cost += u.cost / days;
        }
      }
    }
  }
  return facts;
}
