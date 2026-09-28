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
import { resolvedProvider } from './provider';
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

function facts(): LedgerFacts {
  const u = store.usage;
  const f: LedgerFacts = {
    claude: { today: u.today.cost, month: u.month, total: u.total.cost, calls: u.total.calls },
    codex: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, sessions: 0 },
    opencode: { cost: 0, sessions: 0 },
  };
  for (const w of store.workers.values()) {
    if (w.kind !== 'agent' || !w.usage) continue;
    const provider = resolvedProvider(w.provider, store.project);
    if (provider === 'codex') {
      f.codex.sessions++;
      f.codex.input += w.usage.input;
      f.codex.cacheRead += w.usage.cacheRead;
      f.codex.cacheWrite += w.usage.cacheWrite;
      f.codex.output += w.usage.output + (w.usage.reasoning ?? 0);
    } else if (provider === 'opencode' && w.usage.costKnown !== false) {
      f.opencode.sessions++;
      f.opencode.cost += w.usage.cost;
    }
  }
  return f;
}

const GROUPS: Record<LedgerLine['group'], string> = { AI: '🤖 The workers', Hosting: '🏢 The building', Free: '🎁 On the house' };

export function openLedger() {
  let a = loadAssumptions();
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
    const e = estimate(a, facts());
    const verdict =
      e.usage > e.recurring
        ? `Flat bills win: paying as you go would cost ${fmtCost(e.usage - e.recurring)} more a month.`
        : e.usage < e.recurring
          ? `Paying as you go would save ${fmtCost(e.recurring - e.usage)} a month at this pace.`
          : 'Both ways cost the same at this pace.';
    const week = store.limits.windows.find((w) => w.label === 'Week');
    const pace = week?.resetsAt ? weekPace(week.pct, week.resetsAt, Date.now()) : null;
    const plan = CLAUDE_PLANS[a.claudePlan];
    const notes: (HTMLElement | null)[] = [
      h('div.total', { title: 'Every token at API rates, the machine billed only for the hours it is up' }, h('span', {}, 'Usage basis'), h('b', {}, `${fmtCost(e.usage)}/mo`), h('small', {}, `${fmtCost(e.usage * 12)} a year`)),
      h('div.total', { title: 'The flat monthly bills: plans, and a machine that stays on' }, h('span', {}, 'Recurring basis'), h('b', {}, `${fmtCost(e.recurring)}/mo`), h('small', {}, `${fmtCost(e.recurring * 12)} a year`)),
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
            h('span.num', {}, l.usage || l.recurring ? fmtCost(l.usage) : 'free'),
            h('span.num', {}, l.usage || l.recurring ? fmtCost(l.recurring) : 'free'),
          ),
        );
      }
    }
    rows.push(h('div.row.foot', {}, h('span', {}, 'A month'), h('span.num', {}, fmtCost(e.usage)), h('span.num', {}, fmtCost(e.recurring))));
    table.replaceChildren(...rows);
  }

  renderKnobs();
  render();
  const offs = (['usage', 'workers', 'limits'] as const).map((t) => store.on(t, render));
  const modal = openModal(el, { onClose: () => offs.forEach((off) => off()) });
  close.addEventListener('click', () => modal.close());
}
