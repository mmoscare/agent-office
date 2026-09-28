import type { LedgerFacts } from '../shared/ledger.js';
import type { AgentProvider, UsageState, WorkerInfo } from '../shared/protocol.js';

/** Read live desks across the building, independent of the viewer's current floor. */
export function ledgerFacts(usage: UsageState, floors: Iterable<{
  project: { defaultProvider?: AgentProvider };
  workers: { list(): WorkerInfo[] };
}>): LedgerFacts {
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
      if (provider === 'codex') {
        if (!u) {
          facts.codex.unknown!++;
          continue;
        }
        facts.codex.sessions++;
        facts.codex.input += u.input;
        facts.codex.cacheRead += u.cacheRead;
        facts.codex.cacheWrite += u.cacheWrite;
        facts.codex.output += u.output + (u.reasoning ?? 0);
      } else if (provider === 'opencode') {
        if (!u || u.costKnown === false || !Number.isFinite(u.cost) || u.cost < 0 || u.incomplete) {
          facts.opencode.unknown!++;
        } else {
          facts.opencode.sessions++;
          facts.opencode.cost += u.cost;
        }
      }
    }
  }
  return facts;
}
