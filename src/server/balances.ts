// The Plan balances panel: money on the xAI, OpenAI and Anthropic API accounts.
//
// Only xAI has an API for credit left (its Management API's prepaid ledger). OpenAI and Anthropic
// show a balance in their consoles but no API returns it, so for them this reads what was spent
// this month with an Admin key, and links to the billing page for the rest. Ordinary API keys can
// read none of this; the panel says so instead of guessing.
//
// Keys come from, in order: one pasted into the panel (saved in the office's data folder), this
// checkout's gitignored .env, then the office's environment. The .env is parsed here only and never
// merged into process.env, which workers inherit: an ANTHROPIC_API_KEY there would move Claude Code
// off the subscription and onto API billing.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BALANCE_PROVIDERS, type BalanceKeySource, type BalanceProvider, type BalancesState, type ProviderBalance } from '../shared/balances.js';

/** This checkout's .env, next to its package.json: src/server and dist/server/server sit at different depths. */
export const CODE_ENV_FILE = path.join(checkoutRoot(path.dirname(fileURLToPath(import.meta.url))), '.env');

function checkoutRoot(from: string): string {
  for (let dir = from, i = 0; i < 6; i++, dir = path.dirname(dir)) if (existsSync(path.join(dir, 'package.json'))) return dir;
  return path.resolve(from, '..', '..');
}

/** Answers are kept this long; the panel polls, and Anthropic asks for at most one read a minute. */
const CACHE_MS = 5 * 60_000;
/** A refresh click reads again once the last read is at least this old. */
const MIN_GAP_MS = 30_000;
const TIMEOUT_MS = 15_000;
const MAX_PAGES = 6;
const KEY_MAX = 512;

type Fetch = typeof fetch;

const INFO: Record<BalanceProvider, Pick<ProviderBalance, 'label' | 'billingUrl' | 'keyUrl' | 'keyHint'>> = {
  xai: { label: 'Grok (xAI)', billingUrl: 'https://console.x.ai', keyUrl: 'https://console.x.ai', keyHint: 'A Management key (console.x.ai → Settings → Management Keys)' },
  openai: { label: 'OpenAI', billingUrl: 'https://platform.openai.com/settings/organization/billing/overview', keyUrl: 'https://platform.openai.com/settings/organization/admin-keys', keyHint: 'An Admin key (sk-admin-…)' },
  anthropic: { label: 'Anthropic API', billingUrl: 'https://console.anthropic.com/settings/billing', keyUrl: 'https://console.anthropic.com/settings/admin-keys', keyHint: 'An Admin key (sk-ant-admin…)' },
};

/** KEY=value lines; `export`, quotes, comments and CRLF are fine. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    let v = m[2];
    const q = v[0];
    if ((q === '"' || q === "'") && v.length > 1 && v.endsWith(q)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (v) out[m[1]] = v;
  }
  return out;
}

interface Saved {
  xai?: { key: string; team?: string };
  openai?: { key: string };
  anthropic?: { key: string };
}

interface Found {
  key?: string;
  source?: BalanceKeySource;
  /** An ordinary API key was there, which can't read billing. */
  plainKey?: boolean;
}

export interface BalancesOptions {
  fetch?: Fetch;
  env?: Record<string, string | undefined>;
  envFile?: string;
  now?: () => number;
}

export class Balances {
  private file: string;
  private saved: Saved = {};
  private cached: BalancesState | undefined;
  private reading: Promise<BalancesState> | undefined;
  /** xAI team ids looked up from an API key, by that key. */
  private teams = new Map<string, string>();
  private fetch: Fetch;
  private env: Record<string, string | undefined>;
  private envFile: string;
  private now: () => number;

  constructor(dataDir: string, opts: BalancesOptions = {}) {
    this.file = path.join(dataDir, 'balances.json');
    this.fetch = opts.fetch ?? fetch;
    this.env = opts.env ?? process.env;
    this.envFile = opts.envFile ?? CODE_ENV_FILE;
    this.now = opts.now ?? Date.now;
    try {
      if (existsSync(this.file)) this.saved = cleanSaved(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      // unreadable: the panel shows signed out, and a new sign-in writes it again
    }
  }

  /** The cached answer, or a fresh one when it's old (or `refresh` and it isn't brand new). */
  state(refresh = false): Promise<BalancesState> {
    const age = this.cached ? this.now() - this.cached.at : Infinity;
    if (this.cached && age < (refresh ? MIN_GAP_MS : CACHE_MS)) return Promise.resolve(this.cached);
    this.reading ??= this.read().finally(() => (this.reading = undefined));
    return this.reading;
  }

  /** Checks a pasted key against the provider, and keeps it only if the provider takes it. */
  async login(provider: BalanceProvider, key: string, team = ''): Promise<string | undefined> {
    key = key.trim();
    team = team.trim();
    if (!key || key.length > KEY_MAX || /\s/.test(key)) return 'Paste the whole key';
    if (team.length > 128 || /[^A-Za-z0-9-]/.test(team)) return 'That team id doesn’t look right';
    const wrong = wrongKind(provider, key);
    if (wrong) return wrong;
    const found: Found = { key, source: 'saved' };
    let balance: ProviderBalance;
    if (provider === 'xai') {
      if (!team) {
        const plain = this.lookup(['XAI_API_KEY']);
        if (plain.key) team = (await this.xaiTeam(plain.key).catch(() => undefined)) ?? '';
      }
      if (!team) return 'Add your team id too (it’s in the console’s address bar)';
      balance = await this.readXai(found, team);
    } else {
      balance = await this.readOne(provider, found);
    }
    if (balance.status !== 'ok') return balance.error ?? 'The provider didn’t take that key';
    this.saved[provider] = provider === 'xai' ? { key, team } : { key };
    this.write();
    this.cached = undefined;
    return undefined;
  }

  /** Forgets a key pasted into the panel (a .env or environment key still applies). */
  logout(provider: BalanceProvider) {
    delete this.saved[provider];
    this.write();
    this.cached = undefined;
  }

  private async read(): Promise<BalancesState> {
    const providers = await Promise.all(BALANCE_PROVIDERS.map((p) => this.readProvider(p)));
    this.cached = { providers, envFile: this.envFile, at: this.now() };
    return this.cached;
  }

  private async readProvider(provider: BalanceProvider): Promise<ProviderBalance> {
    if (provider === 'xai') {
      const found = this.saved.xai ? { key: this.saved.xai.key, source: 'saved' as const } : this.lookup(['XAI_MANAGEMENT_KEY']);
      if (!found.key) return { ...base('xai'), status: 'signed-out' };
      let team = (this.saved.xai ? this.saved.xai.team : undefined) ?? this.lookup(['XAI_TEAM_ID']).key;
      if (!team) {
        const plain = this.lookup(['XAI_API_KEY']);
        if (!plain.key) return { ...base('xai'), status: 'error', source: found.source, error: 'Needs XAI_TEAM_ID (or XAI_API_KEY to look it up)' };
        try {
          team = await this.xaiTeam(plain.key);
        } catch (err) {
          return { ...base('xai'), status: 'error', source: found.source, error: `Team lookup: ${(err as Error).message}` };
        }
      }
      return this.readXai(found, team);
    }
    const found = provider === 'openai'
      ? this.lookup(['OPENAI_ADMIN_KEY', 'OPENAI_API_KEY'], (k) => k.startsWith('sk-admin-'))
      : this.lookup(['ANTHROPIC_ADMIN_KEY', 'ANTHROPIC_API_KEY'], (k) => k.startsWith('sk-ant-admin'));
    const saved = this.saved[provider];
    return this.readOne(provider, saved ? { key: saved.key, source: 'saved' } : found);
  }

  private async readOne(provider: 'openai' | 'anthropic', found: Found): Promise<ProviderBalance> {
    if (!found.key) return { ...base(provider), status: found.plainKey ? 'needs-admin' : 'signed-out' };
    try {
      const spent = provider === 'openai' ? await this.openaiSpend(found.key) : await this.anthropicSpend(found.key);
      return { ...base(provider), status: 'ok', source: found.source, spentMonthUsd: spent };
    } catch (err) {
      return { ...base(provider), status: 'error', source: found.source, error: (err as Error).message };
    }
  }

  private async readXai(found: Found, team: string): Promise<ProviderBalance> {
    try {
      const body = await this.get(`https://management-api.x.ai/v1/billing/teams/${encodeURIComponent(team)}/prepaid/balance`, { authorization: `Bearer ${found.key}` });
      // An inverted ledger in cents: a $10 top-up is "-1000". It's the posted ledger, which xAI
      // settles at the billing cycle's close, so mid-cycle it can read above the console.
      // A missing total is an error, never a $0.00 balance.
      const val = body?.total?.val;
      const cents = (typeof val === 'string' && val.trim()) || typeof val === 'number' ? Number(val) : NaN;
      if (!Number.isFinite(cents)) throw new Error('xAI sent no balance');
      return { ...base('xai'), status: 'ok', source: found.source, remainingUsd: -cents / 100 };
    } catch (err) {
      return { ...base('xai'), status: 'error', source: found.source, error: (err as Error).message };
    }
  }

  private async xaiTeam(apiKey: string): Promise<string> {
    const known = this.teams.get(apiKey);
    if (known) return known;
    const body = await this.get('https://api.x.ai/v1/api-key', { authorization: `Bearer ${apiKey}` });
    const team = typeof body?.team_id === 'string' ? body.team_id : '';
    if (!team) throw new Error('xAI didn’t say which team the key is on');
    this.teams.set(apiKey, team);
    return team;
  }

  private async openaiSpend(key: string): Promise<number> {
    const start = Math.floor(monthStart(this.now()) / 1000);
    let total = 0;
    let page = '';
    for (let i = 0; i < MAX_PAGES; i++) {
      const body = await this.get(`https://api.openai.com/v1/organization/costs?start_time=${start}&bucket_width=1d&limit=31${page ? `&page=${encodeURIComponent(page)}` : ''}`, { authorization: `Bearer ${key}` });
      for (const bucket of list(body?.data)) for (const r of list(bucket?.results)) total += money(r?.amount?.value);
      if (!body?.has_more || typeof body.next_page !== 'string') break;
      page = body.next_page;
    }
    return total;
  }

  private async anthropicSpend(key: string): Promise<number> {
    const start = new Date(monthStart(this.now())).toISOString().replace('.000Z', 'Z');
    let cents = 0;
    let page = '';
    for (let i = 0; i < MAX_PAGES; i++) {
      const body = await this.get(`https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(start)}&bucket_width=1d&limit=31${page ? `&page=${encodeURIComponent(page)}` : ''}`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
      // Decimal strings in cents.
      for (const bucket of list(body?.data)) for (const r of list(bucket?.results)) cents += money(r?.amount);
      if (!body?.has_more || typeof body.next_page !== 'string') break;
      page = body.next_page;
    }
    return cents / 100;
  }

  private async get(url: string, headers: Record<string, string>): Promise<any> {
    const host = new URL(url).host;
    let res: Response;
    try {
      res = await this.fetch(url, { headers: { accept: 'application/json', 'user-agent': 'agent-office', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new Error(`Couldn’t reach ${host}`);
    }
    if (res.status === 401 || res.status === 403) throw new Error('The key was turned down — sign in again');
    if (res.status === 404) throw new Error('Not found — check the team id');
    if (res.status === 429) throw new Error('Rate limited — try again in a minute');
    if (!res.ok) throw new Error(`${host} answered ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new Error(`${host} sent something unreadable`);
    }
  }

  /** The first variable set, in this checkout's .env and then the environment. */
  private lookup(names: string[], usable: (key: string) => boolean = () => true): Found {
    let file: Record<string, string> = {};
    try {
      file = existsSync(this.envFile) ? parseEnv(readFileSync(this.envFile, 'utf8')) : {};
    } catch {
      // unreadable .env: the environment still counts
    }
    let plainKey = false;
    for (const [source, vars] of [['file', file], ['env', this.env]] as const) {
      for (const name of names) {
        const v = vars[name]?.trim();
        if (!v) continue;
        if (usable(v)) return { key: v, source };
        plainKey = true;
      }
    }
    return { plainKey };
  }

  private write() {
    try {
      writeFileSync(this.file, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}

const base = (provider: BalanceProvider) => ({ provider, ...INFO[provider] });
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
function money(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** Midnight UTC on the 1st of this month: both providers bill in UTC. */
export function monthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Why a pasted key can't be the kind this provider needs, when it can't. */
function wrongKind(provider: BalanceProvider, key: string): string | undefined {
  if (provider === 'openai' && !key.startsWith('sk-admin-')) return 'That’s not an OpenAI Admin key (they start with sk-admin-). Ordinary API keys can’t read billing.';
  if (provider === 'anthropic' && !key.startsWith('sk-ant-admin')) return 'That’s not an Anthropic Admin key (they start with sk-ant-admin). Ordinary API keys can’t read billing.';
  return undefined;
}

function cleanSaved(v: any): Saved {
  const out: Saved = {};
  const key = (k: unknown) => (typeof k === 'string' && k && k.length <= KEY_MAX ? k : undefined);
  if (key(v?.xai?.key)) out.xai = { key: v.xai.key, ...(typeof v.xai.team === 'string' && v.xai.team ? { team: v.xai.team } : {}) };
  if (key(v?.openai?.key)) out.openai = { key: v.openai.key };
  if (key(v?.anthropic?.key)) out.anthropic = { key: v.anthropic.key };
  return out;
}
