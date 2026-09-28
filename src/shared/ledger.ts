// The Office Ledger: every cost of running the office, estimated two ways (see ui/ledger.ts).
//
//  - Usage basis: everything metered, the way an API key and a pay-per-hour machine would bill it.
//    Tokens at API rates, the machine only for the hours it runs.
//  - Recurring basis: the flat monthly bills. The Claude and ChatGPT plans (their tokens cost
//    nothing extra until you hit a limit) and a machine that stays on.
//
// All figures are USD per month. Prices were checked 2026-09-27 and are estimates, not billing.

export type ClaudePlan = 'pro' | 'max5' | 'max20' | 'api';
export type ChatGptPlan = 'none' | 'plus' | 'pro100' | 'pro200' | 'business';
export type CodexRate = 'sol' | 'terra' | 'codex';
export type Hosting = 'aws' | 'aws-paused' | 'vps' | 'own';

export const CLAUDE_PLANS: Record<ClaudePlan, { label: string; monthly: number }> = {
  pro: { label: 'Claude Pro', monthly: 20 },
  max5: { label: 'Claude Max 5x', monthly: 100 },
  max20: { label: 'Claude Max 20x', monthly: 200 },
  api: { label: 'API key (no plan)', monthly: 0 },
};

/** Codex comes with a ChatGPT plan. Business is per seat, billed monthly. */
export const CHATGPT_PLANS: Record<ChatGptPlan, { label: string; monthly: number }> = {
  none: { label: 'No ChatGPT plan', monthly: 0 },
  plus: { label: 'ChatGPT Plus', monthly: 20 },
  pro100: { label: 'ChatGPT Pro ($100)', monthly: 100 },
  pro200: { label: 'ChatGPT Pro ($200)', monthly: 200 },
  business: { label: 'ChatGPT Business (1 seat)', monthly: 25 },
};

/** OpenAI API rates, USD per million tokens: [input, cached input, output]. */
export const CODEX_RATES: Record<CodexRate, { label: string; rates: [number, number, number] }> = {
  sol: { label: 'gpt-5.6-sol', rates: [5, 0.5, 30] },
  terra: { label: 'gpt-5.6-terra', rates: [2, 0.2, 12] },
  codex: { label: 'gpt-5.3-codex', rates: [1.75, 0.175, 14] },
};

export const HOSTING: Record<Hosting, string> = {
  aws: 'AWS EC2 (deploy/aws.sh)',
  'aws-paused': 'AWS, paused (aws.sh pause)',
  vps: 'A VPS',
  own: 'My own computer',
};

/** AWS us-east-1 on-demand prices. */
export const AWS = {
  /** An Elastic IP's public IPv4 address, per hour, running or not. */
  ipv4Hourly: 0.005,
  /** gp3 disk, per GiB-month. */
  gp3: 0.08,
  /** Internet data out per GB after the first 100 GB a month. */
  egressGb: 0.09,
  freeEgressGb: 100,
};

/** What `deploy/aws.sh up` launches by default: a t3.xlarge. */
export const T3_XLARGE_HOURLY = 0.1664;

/** Claude Haiku 4.5 naming one task card: ~1.5k tokens in at $1/M, ~60 out at $5/M. */
export const TASK_CARD_USD = 0.0018;
/** Roughly one card for every few API calls a Claude worker makes (debounced prompts and tools). */
export const CALLS_PER_CARD = 5;

const HOURS_PER_MONTH = 730;
const DAYS_PER_MONTH = HOURS_PER_MONTH / 24;

export interface LedgerAssumptions {
  claudePlan: ClaudePlan;
  chatgptPlan: ChatGptPlan;
  codexRate: CodexRate;
  hosting: Hosting;
  /** Hours a day the office's machine is up (usage basis only; recurring assumes always on). */
  hoursPerDay: number;
  /** EC2 on-demand price per hour for the instance type. */
  awsHourly: number;
  diskGb: number;
  /** Data leaving AWS each month (tunnels, voice, clones), GB. */
  egressGb: number;
  vpsMonthly: number;
  /** Average draw of your own computer while the office runs. */
  watts: number;
  /** Electricity, USD per kWh. */
  kwh: number;
  /** A domain for Caddy/nginx instead of an SSH tunnel. */
  domain: boolean;
  /** A small TURN relay for voice across strict NATs (--turn). */
  turn: boolean;
}

export const DEFAULT_ASSUMPTIONS: LedgerAssumptions = {
  claudePlan: 'max20',
  chatgptPlan: 'plus',
  codexRate: 'terra',
  hosting: 'own',
  hoursPerDay: 10,
  awsHourly: T3_XLARGE_HOURLY,
  diskGb: 50,
  egressGb: 20,
  vpsMonthly: 20,
  watts: 60,
  kwh: 0.17,
  domain: false,
  turn: false,
};

/** Tokens without a price, as Codex reports them. */
export interface TokenCounts {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Output, reasoning included. */
  output: number;
}

/** What the office has measured. */
export interface LedgerFacts {
  /** Claude Code at API rates: today, the last 30 days (over `days` of them) and all time. */
  claude: { today: number; month?: { cost: number; days: number }; total: number; calls: number };
  /** Tokens of the Codex sessions at desks now; `sessions` of them. */
  codex: TokenCounts & { sessions: number; unknown?: number };
  /** OpenCode's own reported cost for the sessions at desks now; `unknown` more report no cost. */
  opencode: { cost: number; sessions: number; unknown?: number };
}

export interface LedgerLine {
  group: 'AI' | 'Hosting' | 'Free';
  item: string;
  /** USD a month on a usage basis; null when the office can't tell (shown as unavailable, never guessed). */
  usage: number | null;
  /** USD a month on a recurring basis; null when the office can't tell. */
  recurring: number | null;
  note: string;
}

export interface LedgerEstimate {
  lines: LedgerLine[];
  /** Sums of the known lines only. */
  usage: number;
  recurring: number;
  /** Lines left out of each sum because their cost is unavailable. */
  unknown: { usage: number; recurring: number };
  /** Claude Code at API rates, per month, and the plan it's measured against. */
  claudeMonthly: number;
}

const money = (n: number) => `$${n.toFixed(2)}`;

export function codexCost(t: TokenCounts, rate: CodexRate): number {
  const [pin, pcached, pout] = CODEX_RATES[rate].rates;
  return ((t.input + t.cacheWrite) * pin + t.cacheRead * pcached + t.output * pout) / 1e6;
}

/** Claude Code's API-rate spend, per month, from the last 30 days when there are any. */
export function claudeMonthly(c: LedgerFacts['claude']): number {
  if (c.month && c.month.cost > 0) return (c.month.cost / Math.max(1, c.month.days)) * DAYS_PER_MONTH;
  return c.today * DAYS_PER_MONTH;
}

export function estimate(a: LedgerAssumptions, f: LedgerFacts): LedgerEstimate {
  const lines: LedgerLine[] = [];
  const clean = (n: number | null) => (n === null || !Number.isFinite(n) ? null : Math.max(0, n));
  const add = (group: LedgerLine['group'], item: string, usage: number | null, recurring: number | null, note: string) =>
    lines.push({ group, item, usage: clean(usage), recurring: clean(recurring), note });
  const hours = Math.min(24, Math.max(0, a.hoursPerDay)) * DAYS_PER_MONTH;

  // ---- AI
  const claude = claudeMonthly(f.claude);
  const plan = CLAUDE_PLANS[a.claudePlan];
  const basis = f.claude.month && f.claude.month.cost > 0
    ? `${money(f.claude.month.cost)} over the last ${f.claude.month.days} day${f.claude.month.days === 1 ? '' : 's'}`
    : `${money(f.claude.today)} today`;
  add(
    'AI',
    'Claude Code workers and board agents',
    claude,
    plan.monthly || claude,
    a.claudePlan === 'api'
      ? `Billed per token on an API key: ${basis} at API rates, run out to a month.`
      : `${plan.label} covers these tokens. At API rates they'd be ${basis}, run out to a month.`,
  );
  // The office's own calls-per-dollar turns the month's spend into calls, and calls into cards.
  const cards = f.claude.total > 0 ? (claude * (f.claude.calls / f.claude.total)) / CALLS_PER_CARD : 0;
  add(
    'AI',
    'Task cards over heads (Claude Haiku)',
    cards * TASK_CARD_USD,
    a.claudePlan === 'api' ? cards * TASK_CARD_USD : 0,
    `About ${Math.round(cards).toLocaleString('en-US')} short Haiku calls a month, one per ~${CALLS_PER_CARD} worker API calls. ${a.claudePlan === 'api' ? 'Billed to the API key.' : 'Comes out of the Claude plan.'}`,
  );
  // With no Codex session at a desk there are no tokens to price: that's unknown, not free.
  const codex = f.codex.sessions && !f.codex.unknown ? codexCost(f.codex, a.codexRate) * DAYS_PER_MONTH : null;
  const chat = CHATGPT_PLANS[a.chatgptPlan];
  add(
    'AI',
    'Codex workers',
    codex,
    chat.monthly || codex,
    f.codex.unknown
      ? `${f.codex.unknown} Codex session${f.codex.unknown === 1 ? '' : 's'} awaiting token reports: usage unavailable. ${a.chatgptPlan === 'none' ? '' : `${chat.label} is the flat bill.`}`
      : f.codex.sessions
      ? `${f.codex.sessions} session${f.codex.sessions === 1 ? '' : 's'} at desks now, priced at ${CODEX_RATES[a.codexRate].label} API rates, as if every day were like today. ${a.chatgptPlan === 'none' ? 'Without a plan Codex bills an API key.' : `${chat.label} covers them.`}`
      : `No Codex worker at a desk right now, so no tokens to price: usage unavailable. ${a.chatgptPlan === 'none' ? '' : `${chat.label} is the flat bill.`}`,
  );
  const ocUnknown = f.opencode.unknown ?? 0;
  if (ocUnknown) {
    const n = f.opencode.sessions + ocUnknown;
    add('AI', 'OpenCode workers', null, null, `${ocUnknown} of the ${n} OpenCode session${n === 1 ? '' : 's'} at desks now report no cost, so this is unavailable rather than guessed.`);
  } else if (f.opencode.sessions) {
    const oc = f.opencode.cost * DAYS_PER_MONTH;
    add('AI', 'OpenCode workers', oc, oc, `What OpenCode reports for the ${f.opencode.sessions} session${f.opencode.sessions === 1 ? '' : 's'} at desks now, as if every day were like today. Billed by its provider.`);
  }
  add('AI', 'Plan-limit meter (Claude /usage)', 0, 0, 'Reading the limits starts no conversation and costs nothing.');

  // ---- Hosting
  if (a.hosting === 'aws' || a.hosting === 'aws-paused') {
    const running = a.hosting === 'aws';
    add(
      'Hosting',
      'EC2 instance',
      running ? a.awsHourly * hours : 0,
      running ? a.awsHourly * HOURS_PER_MONTH : 0,
      running ? `${money(a.awsHourly)}/hour: ${Math.round(hours)} hours a month when up ${a.hoursPerDay} h a day, or all ${HOURS_PER_MONTH} left running.` : 'Paused machines bill no compute; only the disk and the address.',
    );
    add('Hosting', 'EBS disk (gp3)', a.diskGb * AWS.gp3, a.diskGb * AWS.gp3, `${a.diskGb} GiB at ${money(AWS.gp3)} per GiB-month, running or paused.`);
    add('Hosting', 'Elastic IP (public IPv4)', AWS.ipv4Hourly * HOURS_PER_MONTH, AWS.ipv4Hourly * HOURS_PER_MONTH, `${money(AWS.ipv4Hourly)}/hour for the fixed address, running or paused.`);
    const out = running ? Math.max(0, a.egressGb - AWS.freeEgressGb) * AWS.egressGb : 0;
    add('Hosting', 'Data transfer out', out, 0, `${a.egressGb} GB a month through tunnels and voice; the first ${AWS.freeEgressGb} GB are free, then ${money(AWS.egressGb)}/GB.`);
  } else if (a.hosting === 'vps') {
    add('Hosting', 'VPS', Math.min(a.vpsMonthly, (a.vpsMonthly / HOURS_PER_MONTH) * hours), a.vpsMonthly, 'Most VPS hosts bill by the hour up to a monthly cap.');
  }
  if (a.hosting === 'own') {
    const kwhMonth = (a.watts / 1000);
    add('Hosting', 'Electricity for your computer', kwhMonth * hours * a.kwh, kwhMonth * HOURS_PER_MONTH * a.kwh, `${a.watts} W at ${money(a.kwh)}/kWh: ${a.hoursPerDay} h a day, or left on around the clock.`);
  }
  if (a.domain) add('Hosting', 'Domain name', 12 / 12, 12 / 12, 'About $12 a year. Caddy gets the HTTPS certificate for free.');
  if (a.turn) add('Hosting', 'TURN relay for voice', 5, 5, 'The smallest VPS runs coturn. Public STUN is free.');

  // ---- Free
  add('Free', 'GitHub (gh: clones, boards, PRs, the gong)', 0, 0, 'Free for public and private repos. The office runs no Actions.');
  add('Free', 'Weather and sunrise (Open-Meteo)', 0, 0, 'Free, no key.');
  add('Free', 'Voice and screen sharing (WebRTC, public STUN)', 0, 0, 'Browser to browser, so no media server.');
  add('Free', 'Whiteboard, jukebox, pictures, the dog', 0, 0, 'Excalidraw, tunes and picture fetches all run in the office itself.');
  add('Free', 'Agent Office, Node.js, npm packages', 0, 0, 'Open source.');

  const sum = (k: 'usage' | 'recurring') => lines.reduce((s, l) => s + (l[k] ?? 0), 0);
  const missing = (k: 'usage' | 'recurring') => lines.filter((l) => l[k] === null).length;
  return { lines, usage: sum('usage'), recurring: sum('recurring'), unknown: { usage: missing('usage'), recurring: missing('recurring') }, claudeMonthly: claude };
}

/**
 * Where the week's Claude limit is heading: the percent used so far, run out to the reset.
 * Null when there is no weekly window or too little of it has passed to tell.
 */
export function weekPace(pct: number, resetsAt: number, now: number): number | null {
  const week = 7 * 24 * 3600_000;
  const elapsed = 1 - (resetsAt - now) / week;
  if (!(elapsed > 0.05) || elapsed > 1) return null;
  return pct / elapsed;
}
