// The pay-as-you-go balances in the sidebar's "API balances" panel (ui/balances.ts), read from
// each provider's own billing API:
//
// - xAI's management API reports the team's remaining prepaid credit outright.
// - Anthropic and OpenAI have no balance endpoint. Their admin APIs report spend per day, so the
//   office shows this month's spend, and, once you type the balance the console shows, an estimate:
//   that balance minus what the provider has reported since.
//
// Keys live in the environment or in <dataDir>/api-balances.json (mode 0600) and never reach the
// browser. Reads are cached: at most one round of provider calls every REFRESH_MS, a click no more
// often than MIN_GAP_MS.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BALANCE_PROVIDERS, type ApiBalancesState, type BalanceProvider, type BalanceUpdate, type ConsoleCredits, type ProviderBalance } from '../shared/api-balances.js';

export const REFRESH_MS = 5 * 60_000;
export const MIN_GAP_MS = 60_000;
const TIMEOUT_MS = 20_000;
/** The furthest back a spend read goes when the console balance was typed long ago. */
const MAX_LOOKBACK_DAYS = 366;
const DAY_MS = 86_400_000;
const USER_AGENT = 'agent-office/0.1 (https://github.com/mmoscare/agent-office)';

export const ENV_KEYS: Record<BalanceProvider, string> = {
  anthropic: 'AGENT_OFFICE_ANTHROPIC_ADMIN_KEY',
  openai: 'AGENT_OFFICE_OPENAI_ADMIN_KEY',
  xai: 'AGENT_OFFICE_XAI_MANAGEMENT_KEY',
};
export const ENV_XAI_TEAM = 'AGENT_OFFICE_XAI_TEAM_ID';

/** One day's reported spend: the bucket's start (UTC midnight, ms) and its USD. */
export interface DailySpend {
  day: number;
  usd: number;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface ProviderSettings {
  key?: string;
  teamId?: string;
  credits?: ConsoleCredits;
}

interface Saved {
  version: 1;
  providers: Partial<Record<BalanceProvider, ProviderSettings>>;
}

const utcDayStart = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
const utcMonthStart = (ms: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
const money = (v: number) => Math.round(v * 1_000_000) / 1_000_000;

// ---- Reading the providers ---------------------------------------------------------------------

async function call(fetchFn: FetchLike, url: string, init: RequestInit, who: string): Promise<any> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`${who}: ${(err as Error).name === 'TimeoutError' ? 'no answer in time' : 'could not connect'}`);
  }
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const detail = body?.error?.message ?? body?.message ?? (typeof body?.error === 'string' ? body.error : '') ?? '';
    const hint = res.status === 401 ? 'key rejected' : res.status === 403 ? 'key not allowed to read billing' : res.status === 404 ? 'not found' : `HTTP ${res.status}`;
    throw new Error(`${who}: ${hint}${detail ? ` (${String(detail).slice(0, 120)})` : ''}`);
  }
  if (body === null || typeof body !== 'object') throw new Error(`${who}: unexpected answer`);
  return body;
}

/**
 * Anthropic's cost report: USD per day since `sinceMs`, as decimal strings of cents. Daily buckets
 * only, at most 31 per request, so the range is walked a month at a time and paginated within.
 * Needs an Admin API key (sk-ant-admin…); ordinary keys are refused.
 */
export async function anthropicDailySpend(key: string, sinceMs: number, fetchFn: FetchLike = fetch, now = Date.now()): Promise<DailySpend[]> {
  const days = new Map<number, number>();
  const end = utcDayStart(now) + DAY_MS;
  for (let from = utcDayStart(sinceMs); from < end; from += 31 * DAY_MS) {
    const to = Math.min(end, from + 31 * DAY_MS);
    let page: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const q = new URLSearchParams({ starting_at: new Date(from).toISOString(), ending_at: new Date(to).toISOString(), bucket_width: '1d', limit: '31' });
      if (page) q.set('page', page);
      const body = await call(fetchFn, `https://api.anthropic.com/v1/organizations/cost_report?${q}`, {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'user-agent': USER_AGENT },
      }, 'Anthropic');
      for (const bucket of Array.isArray(body.data) ? body.data : []) {
        const day = utcDayStart(Date.parse(bucket?.starting_at));
        if (!Number.isFinite(day)) continue;
        let usd = 0;
        for (const r of Array.isArray(bucket.results) ? bucket.results : []) {
          const cents = Number(r?.amount);
          if (Number.isFinite(cents) && (r?.currency ?? 'USD') === 'USD') usd += cents / 100;
        }
        days.set(day, (days.get(day) ?? 0) + usd);
      }
      if (!body.has_more || typeof body.next_page !== 'string') break;
      page = body.next_page;
    }
  }
  return [...days].map(([day, usd]) => ({ day, usd: money(usd) })).sort((a, b) => a.day - b.day);
}

/** OpenAI's costs endpoint: USD per day since `sinceMs`. Needs an Admin key (sk-admin-…). */
export async function openaiDailySpend(key: string, sinceMs: number, fetchFn: FetchLike = fetch): Promise<DailySpend[]> {
  const days = new Map<number, number>();
  let page: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const q = new URLSearchParams({ start_time: String(Math.floor(utcDayStart(sinceMs) / 1000)), bucket_width: '1d', limit: '31' });
    if (page) q.set('page', page);
    const body = await call(fetchFn, `https://api.openai.com/v1/organization/costs?${q}`, {
      headers: { authorization: `Bearer ${key}`, 'user-agent': USER_AGENT },
    }, 'OpenAI');
    for (const bucket of Array.isArray(body.data) ? body.data : []) {
      const day = utcDayStart(Number(bucket?.start_time) * 1000);
      if (!Number.isFinite(day)) continue;
      let usd = 0;
      for (const r of Array.isArray(bucket.results) ? bucket.results : []) {
        const v = Number(r?.amount?.value);
        if (Number.isFinite(v) && (r?.amount?.currency ?? 'usd').toLowerCase() === 'usd') usd += v;
      }
      days.set(day, (days.get(day) ?? 0) + usd);
    }
    if (!body.has_more || typeof body.next_page !== 'string') break;
    page = body.next_page;
  }
  return [...days].map(([day, usd]) => ({ day, usd: money(usd) })).sort((a, b) => a.day - b.day);
}

/**
 * xAI's prepaid balance: the team's ledger total in string cents, sign inverted (a $10 top-up is
 * "-1000"), so the remaining credit is the negated value. Needs a management key and the team id.
 */
export async function xaiPrepaidBalance(key: string, teamId: string, fetchFn: FetchLike = fetch): Promise<number> {
  const body = await call(fetchFn, `https://management-api.x.ai/v1/billing/teams/${encodeURIComponent(teamId)}/prepaid/balance`, {
    headers: { authorization: `Bearer ${key}`, 'user-agent': USER_AGENT },
  }, 'xAI');
  const cents = Number(body?.total?.val);
  if (!Number.isFinite(cents)) throw new Error('xAI: no balance in the answer');
  return money(-cents / 100);
}

// ---- Adding it up ------------------------------------------------------------------------------

/** This month's spend, and the spend since the console balance was typed. */
export function summarize(days: DailySpend[], credits: ConsoleCredits | undefined, now = Date.now()): { spentMonth: number; spentSinceCredits?: number } {
  const monthStart = utcMonthStart(now);
  let spentMonth = 0;
  for (const d of days) if (d.day >= monthStart) spentMonth += d.usd;
  if (!credits) return { spentMonth: money(spentMonth) };
  const typedDay = utcDayStart(credits.at);
  let since = 0;
  for (const d of days) {
    if (d.day > typedDay) since += d.usd;
    else if (d.day === typedDay) since += Math.max(0, d.usd - credits.baseline);
  }
  return { spentMonth: money(spentMonth), spentSinceCredits: money(since) };
}

/** How far back to read: the month, or the day the console balance was typed if that's earlier. */
export function lookback(credits: ConsoleCredits | undefined, now = Date.now()): number {
  const earliest = now - MAX_LOOKBACK_DAYS * DAY_MS;
  const since = Math.min(utcMonthStart(now), credits ? utcDayStart(credits.at) : Infinity);
  return Math.max(earliest, since);
}

// ---- The office's copy -------------------------------------------------------------------------

export class ApiBalances {
  private file: string;
  private saved: Saved = { version: 1, providers: {} };
  private cache = new Map<BalanceProvider, ProviderBalance>();
  private lastRead = 0;
  private reading: Promise<void> | undefined;
  saveError?: string;

  constructor(
    dataDir: string,
    private env: Record<string, string | undefined> = process.env,
    private fetchFn: FetchLike = fetch,
    private now: () => number = Date.now,
  ) {
    this.file = path.join(dataDir, 'api-balances.json');
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (raw?.version !== 1 || typeof raw.providers !== 'object') throw new Error('Unsupported');
      for (const p of BALANCE_PROVIDERS) {
        const s = raw.providers[p];
        if (!s || typeof s !== 'object') continue;
        const out: ProviderSettings = {};
        if (typeof s.key === 'string' && s.key) out.key = s.key;
        if (typeof s.teamId === 'string' && s.teamId) out.teamId = s.teamId;
        const c = s.credits;
        if (c && Number.isFinite(c.amount) && Number.isFinite(c.at)) out.credits = { amount: c.amount, at: c.at, baseline: Number.isFinite(c.baseline) ? c.baseline : 0 };
        this.saved.providers[p] = out;
      }
    } catch {
      this.saveError = 'Saved API balance settings could not be read; the file was left alone.';
    }
  }

  private keyOf(p: BalanceProvider): { key: string; source: 'env' | 'file' } | undefined {
    const env = this.env[ENV_KEYS[p]];
    if (env) return { key: env, source: 'env' };
    const file = this.saved.providers[p]?.key;
    return file ? { key: file, source: 'file' } : undefined;
  }

  private teamIdOf(): string | undefined {
    return this.env[ENV_XAI_TEAM] || this.saved.providers.xai?.teamId || undefined;
  }

  /** What the browser is told: never the keys themselves. */
  state(editable = false): ApiBalancesState {
    const providers = BALANCE_PROVIDERS.map((p): ProviderBalance => {
      const k = this.keyOf(p);
      const cached = this.cache.get(p);
      return {
        provider: p,
        configured: !!k,
        ...(k ? { source: k.source } : {}),
        ...(p === 'xai' ? { teamIdSet: !!this.teamIdOf() } : {}),
        ...(this.saved.providers[p]?.credits ? { credits: this.saved.providers[p]!.credits } : {}),
        ...(cached && k ? { reportedBalance: cached.reportedBalance, spentSinceCredits: cached.spentSinceCredits, spentMonth: cached.spentMonth, at: cached.at, error: cached.error } : {}),
      };
    });
    return { providers, at: this.lastRead, editable };
  }

  /** The cached numbers, read again when they're older than REFRESH_MS (or MIN_GAP_MS when asked). */
  async read(refresh = false, editable = false): Promise<ApiBalancesState> {
    const age = this.now() - this.lastRead;
    if (age >= (refresh ? MIN_GAP_MS : REFRESH_MS)) await this.readAll();
    return this.state(editable);
  }

  private readAll(): Promise<void> {
    if (!this.reading) {
      this.reading = Promise.all(BALANCE_PROVIDERS.map((p) => this.readOne(p))).then(() => { this.lastRead = this.now(); this.reading = undefined; });
    }
    return this.reading;
  }

  private async readOne(p: BalanceProvider) {
    const k = this.keyOf(p);
    if (!k) { this.cache.delete(p); return; }
    const at = this.now();
    try {
      if (p === 'xai') {
        const teamId = this.teamIdOf();
        if (!teamId) throw new Error('xAI: team id missing');
        this.cache.set(p, { provider: p, configured: true, reportedBalance: await xaiPrepaidBalance(k.key, teamId, this.fetchFn), at });
        return;
      }
      const credits = this.saved.providers[p]?.credits;
      const days = p === 'anthropic'
        ? await anthropicDailySpend(k.key, lookback(credits, at), this.fetchFn, at)
        : await openaiDailySpend(k.key, lookback(credits, at), this.fetchFn);
      this.cache.set(p, { provider: p, configured: true, at, ...summarize(days, credits, at) });
    } catch (err) {
      // Keep the last good numbers alongside the reason; the panel shows both.
      const last = this.cache.get(p);
      this.cache.set(p, { ...(last ?? { provider: p, configured: true }), error: (err as Error).message, at: last?.at ?? at });
    }
  }

  /** Saves a key, team id or console balance, then reads that provider again. Throws on bad input. */
  async update(u: BalanceUpdate, editable = true): Promise<ApiBalancesState> {
    if (!BALANCE_PROVIDERS.includes(u.provider)) throw new Error('Unknown provider');
    if (u.teamId !== undefined && u.provider !== 'xai') throw new Error('Only xAI has a team id');
    if (u.credits !== undefined && u.provider === 'xai') throw new Error('xAI reports its own balance');
    if (u.key !== undefined && this.env[ENV_KEYS[u.provider]]) throw new Error(`The ${u.provider} key comes from ${ENV_KEYS[u.provider]}; change it there`);
    const s = this.saved.providers[u.provider] ?? {};
    if (u.key !== undefined) {
      if (u.key === null) delete s.key;
      else if (typeof u.key === 'string' && u.key.trim()) {
        if (u.key.trim().length > 512 || /\s/.test(u.key.trim())) throw new Error('That does not look like an API key');
        s.key = u.key.trim();
      }
    }
    if (u.teamId !== undefined) {
      if (u.teamId === null) delete s.teamId;
      else if (typeof u.teamId === 'string' && u.teamId.trim()) {
        if (!/^[\w.-]{1,128}$/.test(u.teamId.trim())) throw new Error('That does not look like a team id');
        s.teamId = u.teamId.trim();
      }
    }
    this.saved.providers[u.provider] = s;
    if (u.credits !== undefined) {
      if (u.credits === null) delete s.credits;
      else {
        const amount = Number(u.credits);
        if (!Number.isFinite(amount) || amount < -1_000_000 || amount > 1_000_000) throw new Error('Enter the balance in dollars');
        const at = this.now();
        // What today already cost before this moment is in the console figure; don't count it again.
        let baseline = 0;
        const k = this.keyOf(u.provider);
        if (k) {
          try {
            const days = u.provider === 'anthropic' ? await anthropicDailySpend(k.key, utcDayStart(at), this.fetchFn, at) : await openaiDailySpend(k.key, utcDayStart(at), this.fetchFn);
            baseline = days.find((d) => d.day === utcDayStart(at))?.usd ?? 0;
          } catch { /* the read below reports the problem; the estimate then counts the whole day */ }
        }
        s.credits = { amount: money(amount), at, baseline };
      }
    }
    this.save();
    await this.readOne(u.provider);
    return this.state(editable);
  }

  private save() {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
      this.saveError = undefined;
    } catch (err) {
      this.saveError = `API balance settings could not be saved: ${(err as Error).message}`;
      throw new Error(this.saveError);
    }
  }
}
