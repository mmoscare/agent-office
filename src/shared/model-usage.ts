import type { AgentProvider, Usage } from './protocol.js';

export interface ModelUsageRecord {
  key: string;
  provider: AgentProvider;
  floor: string;
  worker: string;
  /** The launch choice, not a claim that a session never switched models. */
  initialModel?: string;
  startedAt: number;
  updatedAt: number;
  usage: Usage;
}

export interface ModelUsageState {
  records: ModelUsageRecord[];
  waiting: { provider: AgentProvider; floor: string; worker: string }[];
  saveError?: string;
}

export const modelTokens = (u: Usage) => u.totalTokens ?? (u.input + u.output + (u.reasoning ?? 0) + u.cacheRead + u.cacheWrite);
export const hasModelCost = (r: ModelUsageRecord) => r.provider === 'codex' ? r.usage.costKnown === true : r.usage.costKnown !== false;

export function modelUsageTotals(records: ModelUsageRecord[]) {
  return records.reduce((sum, r) => ({
    tokens: sum.tokens + modelTokens(r.usage),
    cost: sum.cost + (hasModelCost(r) ? r.usage.cost : 0),
    unknown: sum.unknown + (hasModelCost(r) ? 0 : 1),
    partial: sum.partial + (r.usage.incomplete ? 1 : 0),
  }), { tokens: 0, cost: 0, unknown: 0, partial: 0 });
}
