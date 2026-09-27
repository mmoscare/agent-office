import { hasModelCost, modelTokens, modelUsageTotals, type ModelUsageState } from '../../shared/model-usage';
import { h, openModal } from './dom';
import { PROVIDER_LABEL } from './provider';

const money = (v: number) => v > 0 && v < .01 ? '<$0.01' : `$${v.toFixed(2)}`;
const number = (v: number) => v.toLocaleString('en-US');
let opened = false;

/** All floors, including sessions whose workers have left. Refresh only while the window is open. */
export function openModelUsage() {
  if (opened) return;
  opened = true;
  let state: ModelUsageState = { records: [], waiting: [] };
  let controller: AbortController | undefined;
  let closed = false;
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close usage' }, '✕');
  const filter = h('select', { 'aria-label': 'Filter usage by provider' },
    h('option', { value: '' }, 'All providers'),
    ...Object.entries(PROVIDER_LABEL).map(([value, label]) => h('option', { value }, label)),
  ) as HTMLSelectElement;
  const summary = h('div.usage-summary', { 'aria-live': 'polite' });
  const history = h('div.usage-history');
  const error = h('p.err', { role: 'alert' });
  const download = h('button.btn', { type: 'button' }, 'Download CSV');
  const render = () => {
    const records = state.records.filter(r => !filter.value || r.provider === filter.value);
    const total = modelUsageTotals(records);
    const cost = records.length && total.unknown === records.length ? 'Cost unavailable' : `${money(total.cost)} API-value estimate`;
    summary.replaceChildren(h('strong', {}, `${number(total.tokens)} tokens · ${cost}`),
      h('p.note', {}, `${records.length} saved worker/session records across all floors.${total.unknown ? ` Cost unavailable for ${total.unknown}.` : ''}${total.partial ? ` ${total.partial} have partial metrics.` : ''}`));
    const openKeys = new Set([...history.querySelectorAll<HTMLDetailsElement>('details[open]')].map(d => d.dataset.usageKey));
    const rows = records.map(r => {
      const u = r.usage;
      const details = h('details.usage-record', { 'data-usage-key': r.key },
        h('summary', {},
          h('span.usage-expander', { 'aria-hidden': 'true' }, '▸'),
          h('span', {}, h('b', {}, r.worker), h('small', {}, `${PROVIDER_LABEL[r.provider]} · ${r.floor}`)),
          h('span', {}, `${number(modelTokens(u))} tokens`, h('small', {}, hasModelCost(r) ? `${money(u.cost)} API estimate` : 'Cost unavailable')),
        ),
        h('p', {}, `Input ${number(u.input)} · Output ${number(u.output)} · Reasoning ${number(u.reasoning ?? 0)}`),
        h('p', {}, `Cache read ${number(u.cacheRead)} · Cache write ${number(u.cacheWrite)} · ${u.callsKnown === false || r.provider === 'codex' ? 'Call count unavailable' : `${number(u.calls)} calls`}`),
        h('p.note', {}, r.initialModel ? `Model selected at hire: ${r.initialModel}. Session totals include later model changes.` : 'Model chosen inside the terminal. These totals cover the worker/session, including model changes.'),
        h('p.note', {}, `Last report: ${new Date(r.updatedAt).toLocaleString()}${u.incomplete ? ' · Partial history' : ''}`),
      );
      (details as HTMLDetailsElement).open = openKeys.has(r.key);
      return details;
    });
    history.replaceChildren(...rows);
    if (!rows.length) history.append(h('p.empty', {}, 'Usage appears after an agent reports its first tokens.'));
    for (const w of state.waiting.filter(w => !filter.value || w.provider === filter.value)) {
      history.append(h('p.note', {}, `${w.worker} · ${PROVIDER_LABEL[w.provider]} · ${w.floor}: waiting for a usage report`));
    }
    error.textContent = state.saveError ?? '';
    download.disabled = !records.length;
  };
  const refresh = async () => {
    if (controller || closed) return;
    controller = new AbortController();
    try {
      const response = await fetch('/api/model-usage', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Usage could not be loaded. Sign in again if needed.');
      const next = await response.json() as ModelUsageState;
      if (!closed) {
        if (JSON.stringify(next) !== JSON.stringify(state)) { state = next; render(); }
        error.textContent = next.saveError ?? '';
      }
    } catch (err) { if (!closed) error.textContent = (err as Error).message; }
    finally { controller = undefined; }
  };
  const el = h('div.modal.model-usage', { role: 'dialog', 'aria-label': 'Usage and cost' },
    h('header', {}, h('h2', {}, 'Usage & cost'), close),
    h('div.body', {},
      h('p.note', {}, 'Dollar figures estimate what your tokens would cost at API prices. They do not show subscription charges or remaining plan allowance. Codex supplies main-session tokens only; Grok appears under OpenCode.'),
      filter, summary, error, history,
      h('p.note', {}, 'Saved records stay after workers leave. Costs are estimates, not your subscription bill. Model changes stay in the same session total.'),
    ),
    h('footer', {}, h('span.grow', {}, 'Updates every 3 seconds'), download),
  );
  const timer = setInterval(() => void refresh(), 3000);
  const modal = openModal(el, { onClose: () => { closed = true; opened = false; clearInterval(timer); controller?.abort(); } });
  close.addEventListener('click', () => modal.close());
  filter.addEventListener('change', render);
  download.addEventListener('click', () => {
    // Neutralize formula prefixes in user-chosen names before opening this CSV in a spreadsheet.
    const cell = (v: string | number) => `"${String(v).replace(/^\s*[=+@-]/, "'$&").replace(/"/g, '""')}"`;
    const rows = [['Worker', 'Floor', 'Provider', 'Initial model', 'Tokens', 'Input', 'Output', 'Reasoning', 'Cache read', 'Cache write', 'Estimated API value USD (not a bill)', 'Partial', 'Last report'],
      ...state.records.filter(r => !filter.value || r.provider === filter.value).map(r => [r.worker, r.floor, r.provider, r.initialModel ?? '', modelTokens(r.usage), r.usage.input, r.usage.output, r.usage.reasoning ?? 0, r.usage.cacheRead, r.usage.cacheWrite, hasModelCost(r) ? r.usage.cost : '', String(!!r.usage.incomplete), new Date(r.updatedAt).toISOString()])];
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const link = h('a', { href: url, download: 'Agent Office usage.csv' });
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  render(); void refresh();
}
