// The "API balances" panel in the sidebar: what each pay-as-you-go account has left, read by the
// server from the provider's billing API (server/api-balances.ts). xAI reports a real balance;
// Anthropic and OpenAI only report spend, so their balance is an estimate from the console figure
// you type in ⚙, minus what they've reported since. Nothing here is a subscription plan.

import { BALANCE_LABEL, BALANCE_PROVIDERS, estimatedBalance, type ApiBalancesState, type BalanceProvider, type BalanceUpdate, type ProviderBalance } from '../../shared/api-balances';
import { fmtCost } from '../../shared/protocol';
import { $, h, openModal } from './dom';
import { panelHide } from './menu';

/** The browser asks this often; the server only calls the providers every 5 minutes. */
const POLL_MS = 60_000;
const ENV_NAME: Record<BalanceProvider, string> = { anthropic: 'AGENT_OFFICE_ANTHROPIC_ADMIN_KEY', openai: 'AGENT_OFFICE_OPENAI_ADMIN_KEY', xai: 'AGENT_OFFICE_XAI_MANAGEMENT_KEY' };

let state: ApiBalancesState = { providers: [], at: 0 };
let loadError = '';
let inflight: AbortController | undefined;

const dollars = (v: number) => (v < 0 ? `-${fmtCost(-v)}` : fmtCost(v));
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const anyConfigured = () => state.providers.some((p) => p.configured);

function providerRows(p: ProviderBalance): HTMLElement[] {
  const label = BALANCE_LABEL[p.provider];
  if (!p.configured) {
    return [h('div.row.unset', { title: `No ${label} key yet. ⚙ explains what to paste.` }, h('span.what', {}, label), h('span.muted', {}, 'not set up'))];
  }
  const rows: HTMLElement[] = [];
  const when = p.at ? `\nRead ${clock(p.at)}` : '';
  if (p.provider === 'xai') {
    const has = p.reportedBalance !== undefined;
    rows.push(h('div.row', { class: p.error ? 'err' : '', title: `Remaining prepaid credit xAI reports for the team.${when}${p.error ? `\n${p.error}` : ''}` },
      h('span.what', {}, label), h('b', {}, has ? dollars(p.reportedBalance!) : p.error ? '?' : '…'), h('span.muted', {}, has ? 'balance' : p.error ? 'unavailable' : 'reading')));
  } else {
    const est = estimatedBalance(p);
    const spentMonth = p.spentMonth;
    const title = [
      est !== undefined
        ? `Estimate: the ${dollars(p.credits!.amount)} you typed on ${new Date(p.credits!.at).toLocaleDateString()} minus ${dollars(p.spentSinceCredits!)} reported since. Reports lag about 5 minutes; the console is the truth.`
        : spentMonth !== undefined
          ? `${label} reports spend, not a balance. Type the balance from its console in ⚙ to see an estimate.`
          : p.error ? 'Could not read spend.' : 'Reading spend…',
      spentMonth !== undefined ? `This month (UTC): ${dollars(spentMonth)}` : '',
      when.trim(),
      p.error ?? '',
    ].filter(Boolean).join('\n');
    rows.push(h('div.row', { class: p.error ? 'err' : '', title },
      h('span.what', {}, label),
      h('b', {}, est !== undefined ? `≈ ${dollars(est)}` : spentMonth !== undefined ? dollars(spentMonth) : p.error ? '?' : '…'),
      h('span.muted', {}, est !== undefined ? 'balance est.' : spentMonth !== undefined ? 'spent this month' : p.error ? 'unavailable' : 'reading'),
    ));
    if (est !== undefined && spentMonth !== undefined) rows.push(h('div.row.sub.muted', { title }, `spent ${dollars(spentMonth)} this month`));
  }
  if (p.error) rows.push(h('div.row.sub.err', { title: p.error }, p.error));
  return rows;
}

/** Draws the panel from what was last read. */
export function renderBalances() {
  const el = $('balances');
  const gear = h('button.panel-gear', { type: 'button', 'aria-label': 'Set up API balances', title: 'Keys and console balances', onclick: (e: Event) => { e.stopPropagation(); openBalancesSetup(); } }, '⚙');
  const rows = state.providers.flatMap(providerRows);
  const foot = loadError
    ? h('div.row.sub.err', {}, loadError)
    : anyConfigured()
      ? h('div.row.sub.muted', { title: 'Providers are asked every 5 minutes; click the panel to ask again now (once a minute).' }, `Pay-as-you-go API accounts · ${state.at ? `as of ${clock(state.at)}` : 'reading…'}`)
      : h('div.row.sub.muted', {}, 'Pay-as-you-go API accounts, not plans. Set up in ⚙.');
  el.replaceChildren(h('h3', {}, 'API balances', gear, panelHide('balances')), ...rows, foot);
}

async function load(refresh = false) {
  if (inflight) return;
  inflight = new AbortController();
  try {
    const res = await fetch(`/api/balances${refresh ? '?refresh=1' : ''}`, { credentials: 'same-origin', cache: 'no-store', signal: inflight.signal });
    if (!res.ok) throw new Error(res.status === 401 ? 'Sign in again to read balances.' : 'Balances could not be read.');
    state = (await res.json()) as ApiBalancesState;
    loadError = '';
  } catch (err) {
    loadError = (err as Error).message;
  } finally {
    inflight = undefined;
    renderBalances();
  }
}

/** Fills the panel and keeps it fresh while it's on screen. */
export function mountBalances() {
  const el = $('balances');
  renderBalances();
  void load();
  const visible = () => document.visibilityState === 'visible' && !el.classList.contains('hud-off');
  setInterval(() => { if (visible()) void load(); }, POLL_MS);
  el.addEventListener('click', () => void load(true));
}

// ---- ⚙ Setup -----------------------------------------------------------------------------------

const HELP: Record<BalanceProvider, { key: string; where: string; note: string }> = {
  anthropic: {
    key: 'Admin API key (sk-ant-admin…)',
    where: 'Claude Console → Settings → Admin keys. An ordinary sk-ant-api… key is refused; the Admin API needs an organization, not an individual account.',
    note: 'Anthropic reports spend per day, never a balance. Type the balance the Console shows and the office subtracts what Anthropic reports from then on.',
  },
  openai: {
    key: 'Admin key (sk-admin-…)',
    where: 'OpenAI platform → Organization settings → Admin keys. Project keys can’t read costs.',
    note: 'OpenAI reports spend per day, never a balance. Type the balance from Billing and the office subtracts what OpenAI reports from then on.',
  },
  xai: {
    key: 'Management API key',
    where: 'xAI Console → Settings → Management keys, plus the team id: the UUID in the console URL after /team/.',
    note: 'xAI reports the team’s remaining prepaid credit itself. Its ledger can lag the live figure by the current cycle’s unposted spend.',
  },
};

let setupOpen = false;

export function openBalancesSetup() {
  if (setupOpen) return;
  setupOpen = true;
  const editable = state.editable === true;
  const msg = h('p.err', { role: 'alert' });
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close' }, '✕');

  const post = async (u: BalanceUpdate, after: () => void) => {
    msg.textContent = '';
    try {
      const res = await fetch('/api/balances', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(u) });
      const body = (await res.json()) as ApiBalancesState & { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Could not save.');
      state = body;
      loadError = '';
      renderBalances();
      after();
      render();
    } catch (err) {
      msg.textContent = (err as Error).message;
    }
  };

  const sections = h('div.balances-setup-list');
  const render = () => {
    sections.replaceChildren(...BALANCE_PROVIDERS.map((id) => {
      const p = state.providers.find((x) => x.provider === id) ?? { provider: id, configured: false };
      const help = HELP[id];
      const fromEnv = p.source === 'env';
      const key = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: p.configured ? '•••••••• saved · paste to replace' : help.key, disabled: !editable || fromEnv, 'aria-label': `${BALANCE_LABEL[id]} key` }) as HTMLInputElement;
      const team = id === 'xai' ? h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: p.teamIdSet ? 'team id saved · type to replace' : 'team id (UUID)', disabled: !editable, 'aria-label': 'xAI team id' }) as HTMLInputElement : null;
      const credits = id !== 'xai' ? h('input', { type: 'number', step: '0.01', inputmode: 'decimal', placeholder: p.credits ? `${p.credits.amount.toFixed(2)} typed ${new Date(p.credits.at).toLocaleDateString()}` : 'balance shown in the console, $', disabled: !editable, 'aria-label': `${BALANCE_LABEL[id]} console balance` }) as HTMLInputElement : null;
      const save = h('button.btn.primary', { type: 'button', disabled: !editable }, 'Save');
      const forget = h('button.btn', { type: 'button', disabled: !editable || !p.configured || fromEnv, title: 'Remove the saved key' }, 'Remove key');
      const clearCredits = credits && p.credits ? h('button.btn', { type: 'button', disabled: !editable, title: 'Show spend only, no estimate' }, 'Clear balance') : null;
      save.addEventListener('click', () => {
        const u: BalanceUpdate = { provider: id };
        if (key.value.trim()) u.key = key.value;
        if (team?.value.trim()) u.teamId = team.value;
        if (credits?.value.trim()) u.credits = Number(credits.value);
        if (u.key === undefined && u.teamId === undefined && u.credits === undefined) { msg.textContent = 'Nothing to save.'; return; }
        save.disabled = true;
        void post(u, () => { key.value = ''; if (team) team.value = ''; if (credits) credits.value = ''; }).finally(() => { save.disabled = !editable; });
      });
      forget.addEventListener('click', () => void post({ provider: id, key: null }, () => {}));
      clearCredits?.addEventListener('click', () => void post({ provider: id, credits: null }, () => {}));
      return h('section.balances-setup-provider', {},
        h('h3', {}, BALANCE_LABEL[id], h('span.state', {}, p.configured ? (fromEnv ? `key from ${ENV_NAME[id]}` : 'key saved') : 'no key')),
        h('p.note', {}, help.note),
        h('label', {}, h('span', {}, help.key), key),
        h('p.note', {}, help.where),
        team ? h('label', {}, h('span', {}, 'Team id'), team) : null,
        credits ? h('label', {}, h('span', {}, 'Balance in the console right now ($)'), credits) : null,
        h('div.balances-setup-actions', {}, save, forget, clearCredits),
      );
    }));
  };
  render();

  const el = h('div.modal.balances-setup', { role: 'dialog', 'aria-label': 'API balances setup' },
    h('header', {}, h('h2', {}, 'API balances'), close),
    h('div.body', {},
      h('p.note', {}, 'Pay-as-you-go API accounts only; subscriptions have their own limits panel. Keys are kept on the office server in the building’s .agent-office/api-balances.json and never sent to the browser. Balances are read every 5 minutes.'),
      editable ? null : h('p.note', {}, 'Only an admin can change these settings.'),
      msg, sections,
    ),
  );
  const modal = openModal(el, { onClose: () => { setupOpen = false; } });
  close.addEventListener('click', () => modal.close());
}
