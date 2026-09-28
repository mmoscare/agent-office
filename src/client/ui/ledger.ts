// The Office Ledger: the book on the boss's desk. Every cost of running the office, estimated on a
// usage basis and a recurring basis, from what the office has measured plus a few assumptions you
// can change (kept in this browser). The sums live in shared/ledger.ts.

import {
  CHATGPT_PLANS,
  CLAUDE_PLANS,
  CODEX_RATES,
  DEFAULT_ASSUMPTIONS,
  HOSTING,
  estimate,
  weekPace,
  type LedgerAssumptions,
  type LedgerFacts,
  type LedgerLine,
} from '../../shared/ledger';
import { store } from '../state';
import { h, openModal } from './dom';
import { fmtCost } from './usage';

const KEY = 'agent-office.ledger';

/** Your saved assumptions, or guesses from what the office knows: its Claude plan, and whether it's on AWS. */
function loadAssumptions(): LedgerAssumptions {
  const guess: LedgerAssumptions = { ...DEFAULT_ASSUMPTIONS };
  const plan = store.limits.plan?.toLowerCase();
  if (plan === 'pro') guess.claudePlan = 'pro';
  if (store.invites) guess.hosting = 'aws';
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (saved && typeof saved === 'object') {
      for (const k of Object.keys(guess) as (keyof LedgerAssumptions)[]) {
        if (typeof saved[k] === typeof guess[k]) (guess as any)[k] = saved[k];
      }
    }
  } catch {}
  return guess;
}

function saveAssumptions(a: LedgerAssumptions) {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {}
}

/** A line's cost: n/a when unknown, free when the whole line costs nothing. */
function cell(l: LedgerLine, n: number | null): string {
  if (n === null) return 'n/a';
  return l.usage || l.recurring ? fmtCost(n) : 'free';
}

/** A total, marked as a floor when some lines in it are unavailable. */
const total = (n: number, unknown: number) => (unknown ? `≥ ${fmtCost(n)}` : fmtCost(n));

const GROUPS: Record<LedgerLine['group'], string> = { AI: '🤖 The workers', Hosting: '🏢 The building', Free: '🎁 On the house' };

export function openLedger() {
  let a = loadAssumptions();
  let facts: LedgerFacts | null = null;
  let error = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const summary = h('div.ledger-summary');
  const table = h('div.ledger-lines');
  const knobs = h('div.ledger-knobs');
  const el = h(
    'div.modal.ledger',
    { role: 'dialog', 'aria-label': 'The Office Ledger' },
    h('header', {}, h('h2', {}, '📒 The Office Ledger'), close),
    h('div.body', {}, summary, knobs, table),
    h('footer', {}, h('span.grow', {}, 'Estimates, not bills. Prices checked 27 Sep 2026 (Claude and ChatGPT plans, OpenAI and AWS us-east-1 rates). Claude Code tokens come from the office’s own ledger; Codex and OpenCode from the desks now.')),
  );

  const set = <K extends keyof LedgerAssumptions>(k: K, v: LedgerAssumptions[K]) => {
    a = { ...a, [k]: v };
    saveAssumptions(a);
    // Which boxes show depends on the hosting; rebuilding them otherwise would drop your cursor.
    if (k === 'hosting') renderKnobs();
    render();
  };
  const select = <K extends keyof LedgerAssumptions>(k: K, label: string, options: Record<string, string>) => {
    const s = h('select', { 'aria-label': label }, ...Object.entries(options).map(([v, text]) => h('option', { value: v, selected: a[k] === v }, text))) as HTMLSelectElement;
    s.addEventListener('change', () => set(k, s.value as LedgerAssumptions[K]));
    return h('label', {}, h('span', {}, label), s);
  };
  const number = (k: 'hoursPerDay' | 'awsHourly' | 'diskGb' | 'egressGb' | 'vpsMonthly' | 'watts' | 'kwh', label: string, step: number) => {
    const i = h('input', { type: 'number', min: 0, step, value: a[k], 'aria-label': label }) as HTMLInputElement;
    i.addEventListener('change', () => {
      const v = Number(i.value);
      if (Number.isFinite(v) && v >= 0) set(k, k === 'hoursPerDay' ? Math.min(24, v) : v);
    });
    return h('label', {}, h('span', {}, label), i);
  };
  const toggle = (k: 'domain' | 'turn', label: string) => {
    const i = h('input', { type: 'checkbox', checked: a[k] }) as HTMLInputElement;
    i.addEventListener('change', () => set(k, i.checked));
    return h('label.check', {}, i, h('span', {}, label));
  };
  const labels = <T extends string>(r: Record<T, { label: string; monthly?: number }>) =>
    Object.fromEntries(Object.entries<{ label: string; monthly?: number }>(r).map(([k, v]) => [k, v.monthly ? `${v.label} · $${v.monthly}/mo` : v.label]));

  function renderKnobs() {
    const hostingKnobs =
      a.hosting === 'aws' || a.hosting === 'aws-paused'
        ? [number('awsHourly', 'EC2 $/hour', 0.0001), number('diskGb', 'Disk GiB', 1), number('egressGb', 'Data out GB/mo', 1)]
        : a.hosting === 'vps'
          ? [number('vpsMonthly', 'VPS $/month', 1)]
          : [number('watts', 'Computer watts', 1), number('kwh', 'Electricity $/kWh', 0.01)];
    knobs.replaceChildren(
      h('h3', {}, 'What the office runs on'),
      h(
        'div.grid',
        {},
        select('claudePlan', 'Claude Code plan', labels(CLAUDE_PLANS)),
        select('chatgptPlan', 'Codex (ChatGPT) plan', labels(CHATGPT_PLANS)),
        select('codexRate', 'Price Codex tokens as', Object.fromEntries(Object.entries(CODEX_RATES).map(([k, v]) => [k, `${v.label} ($${v.rates[0]} in / $${v.rates[2]} out)`]))),
        select('hosting', 'The office runs on', HOSTING),
        number('hoursPerDay', 'Hours up a day', 1),
        ...hostingKnobs,
      ),
      h('div.checks', {}, toggle('domain', 'Own domain (Caddy + HTTPS)'), toggle('turn', 'TURN relay for voice')),
    );
  }

  function render() {
    if (!facts) {
      summary.replaceChildren(h('p', {}, error
        ? 'Office usage is unavailable. Retrying...'
        : 'Loading usage from every floor...'));
      table.replaceChildren();
      return;
    }
    const e = estimate(a, facts);
    const verdict =
      e.unknown.usage || e.unknown.recurring
        ? 'Some costs are unavailable (n/a), so the totals leave them out and the two bases can’t be fairly compared.'
        : e.usage > e.recurring
        ? `Flat bills win: paying as you go would cost ${fmtCost(e.usage - e.recurring)} more a month.`
        : e.usage < e.recurring
          ? `Paying as you go would save ${fmtCost(e.recurring - e.usage)} a month at this pace.`
          : 'Both ways cost the same at this pace.';
    const week = store.limits.windows.find((w) => w.label === 'Week');
    const pace = week?.resetsAt ? weekPace(week.pct, week.resetsAt, Date.now()) : null;
    const plan = CLAUDE_PLANS[a.claudePlan];
    const notes: (HTMLElement | null)[] = [
      h('div.total', { title: 'Every token at API rates, the machine billed only for the hours it is up' }, h('span', {}, 'Usage basis (estimate)'), h('b', {}, `${total(e.usage, e.unknown.usage)}/mo`), h('small', {}, `${total(e.usage * 12, e.unknown.usage)} a year`)),
      h('div.total', { title: 'The flat monthly bills: plans, and a machine that stays on' }, h('span', {}, 'Recurring basis (estimate)'), h('b', {}, `${total(e.recurring, e.unknown.recurring)}/mo`), h('small', {}, `${total(e.recurring * 12, e.unknown.recurring)} a year`)),
      h('p.verdict', {}, verdict),
      a.claudePlan !== 'api' && plan.monthly
        ? h('p.muted', {}, `Claude Code would cost ${fmtCost(e.claudeMonthly)} a month at API rates: ${(e.claudeMonthly / plan.monthly).toFixed(1)}× what ${plan.label} costs.`)
        : null,
      pace !== null
        ? h('p', { class: pace > 100 ? 'warn' : 'muted' }, `This week's Claude limit is ${Math.round(week!.pct)}% used and on pace for ${Math.round(pace)}% by the reset${pace > 100 ? ': a bigger plan or extra usage would cost more.' : '.'}`)
        : null,
      store.limits.plan?.toLowerCase() === 'max' ? h('p.muted', {}, 'The office sees a Max plan: pick 5x or 20x below.') : null,
    ];
    summary.replaceChildren(...notes.filter((n): n is HTMLElement => !!n));
    const rows: HTMLElement[] = [h('div.row.head', {}, h('span', {}, 'Cost'), h('span', {}, 'Usage'), h('span', {}, 'Recurring'))];
    for (const group of Object.keys(GROUPS) as LedgerLine['group'][]) {
      const lines = e.lines.filter((l) => l.group === group);
      if (!lines.length) continue;
      rows.push(h('div.group', {}, GROUPS[group]));
      for (const l of lines) {
        rows.push(
          h(
            'div.row',
            {},
            h('span.item', {}, h('b', {}, l.item), h('small', {}, l.note)),
            h('span.num', {}, cell(l, l.usage)),
            h('span.num', {}, cell(l, l.recurring)),
          ),
        );
      }
    }
    rows.push(h('div.row.foot', {}, h('span', {}, 'A month (estimated)'), h('span.num', {}, total(e.usage, e.unknown.usage)), h('span.num', {}, total(e.recurring, e.unknown.recurring))));
    table.replaceChildren(...rows);
  }

  renderKnobs();
  render();
  // The endpoint reads all floors, including ones this browser has never visited.
  async function refresh() {
    try {
      const response = await fetch('/api/ledger', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Usage unavailable');
      facts = await response.json() as LedgerFacts;
      error = false;
    } catch {
      facts = null;
      error = true;
    }
    if (closed) return;
    render();
    timer = setTimeout(refresh, 5000);
  }
  const off = store.on('limits', render);
  const modal = openModal(el, { onClose: () => {
    closed = true;
    controller.abort();
    clearTimeout(timer);
    off();
  } });
  void refresh();
  close.addEventListener('click', () => modal.close());
}
