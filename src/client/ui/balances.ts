import type { BalancesState, ProviderBalance } from '../../shared/balances';
import { $, h, openModal } from './dom';
import { panelHide } from './menu';

/** The panel polls this often while the tab is open; the server caches for as long. */
const POLL_MS = 5 * 60_000;

const usd = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`;
const SOURCE: Record<string, string> = { saved: 'signed in here', file: 'from .env', env: 'from the environment' };

let state: BalancesState | undefined;
let loading = false;

/** Money on the Grok, OpenAI and Anthropic API accounts, in the right-hand sidebar. Admins only. */
export function initBalances() {
  void load(false);
  setInterval(() => { if (!document.hidden) void load(false); }, POLL_MS);
}

async function load(refresh: boolean) {
  if (loading) return;
  loading = true;
  render();
  try {
    const res = await fetch(`/api/balances${refresh ? '?refresh=1' : ''}`, { credentials: 'same-origin', cache: 'no-store' });
    // Not an admin: the panel stays away.
    if (res.status === 403 || res.status === 401) { state = undefined; return; }
    if (res.ok) state = (await res.json()) as BalancesState;
  } catch {
    // offline: keep what was shown
  } finally {
    loading = false;
    render();
  }
}

/** What a row says on the right, and under the name. */
function figure(p: ProviderBalance): [string, string, string] {
  if (p.status === 'ok' && p.remainingUsd !== undefined) return [usd(p.remainingUsd), 'credit left', p.remainingUsd < 5 ? 'low' : ''];
  if (p.status === 'ok' && p.spentMonthUsd !== undefined) return [usd(p.spentMonthUsd), 'spent this month · balance ↗', ''];
  if (p.status === 'needs-admin') return ['Log in', 'needs an admin key', 'muted'];
  if (p.status === 'error') return ['!', p.error ?? 'Couldn’t read it', 'bad'];
  return ['Log in', 'not connected', 'muted'];
}

function render() {
  const el = $('balances');
  el.classList.toggle('hidden', !state);
  if (!state) return;
  const refresh = h('button.bal-refresh', { type: 'button', title: 'Read again now', 'aria-label': 'Refresh balances', disabled: loading }, loading ? '…' : '↻');
  refresh.addEventListener('click', () => void load(true));
  const rows = state.providers.map((p) => {
    const [amount, sub, cls] = figure(p);
    const row = h('button.bal-row', { type: 'button', title: `${p.label}: ${sub}${p.source ? ` (${SOURCE[p.source]})` : ''} · click to manage` },
      h('span.bal-name', {}, p.label, h('small', {}, sub)),
      h('b', { class: cls }, amount),
    );
    row.addEventListener('click', () => openProvider(p));
    return row;
  });
  el.replaceChildren(h('h3', {}, 'Plan balances', refresh, panelHide('balances')), ...rows);
  if (Date.now() - state.at > 2 * POLL_MS) el.append(h('p.bal-note', {}, `As of ${new Date(state.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`));
}

/** One provider's window: how it's connected, and a place to paste a key. */
function openProvider(p: ProviderBalance) {
  const key = h('input', { type: 'password', id: 'bal-key', autocomplete: 'off', spellcheck: 'false', maxlength: 512, placeholder: p.provider === 'openai' ? 'sk-admin-…' : p.provider === 'anthropic' ? 'sk-ant-admin…' : 'Management key' }) as HTMLInputElement;
  const team = h('input', { type: 'text', id: 'bal-team', autocomplete: 'off', spellcheck: 'false', maxlength: 128, placeholder: 'Optional when XAI_API_KEY is set' }) as HTMLInputElement;
  const error = h('p.err', { role: 'alert' });
  const save = h('button.btn.primary', { type: 'button' }, 'Check & save');
  const forget = h('button.btn', { type: 'button' }, 'Forget saved key');
  const [amount, sub] = figure(p);
  const status = p.status === 'ok'
    ? `Connected ${SOURCE[p.source ?? 'env']}: ${amount} ${sub.replace(' · balance ↗', '')}.`
    : p.status === 'error' ? `Connected ${SOURCE[p.source ?? 'env']}, but: ${p.error}` : p.status === 'needs-admin' ? 'Only an ordinary API key was found. Those can’t read billing.' : 'Not connected.';
  const why = p.provider === 'xai'
    ? 'xAI’s Management API reports the prepaid credit left. It’s the posted ledger, which xAI settles when a billing cycle closes, so it can read a little high mid-cycle.'
    : `${p.label} has no API for the balance left. An Admin key shows what you spent this month; the balance itself is on the billing page.`;
  const modal = openModal(h('div.modal.balances-login', { role: 'dialog', 'aria-label': `${p.label} balance` },
    h('header', {}, h('h2', {}, `${p.label} balance`)),
    h('div.body', {},
      h('p.bal-status', {}, status),
      h('p.bal-note', {}, why),
      h('label', { for: key.id }, p.keyHint),
      key,
      p.provider === 'xai' ? h('label', { for: team.id }, 'Team id') : null,
      p.provider === 'xai' ? team : null,
      error,
      h('p.bal-note', {}, 'A key pasted here is checked with the provider, then kept only on this computer in the office’s data folder — never in git. Or put it in ', h('code', {}, state?.envFile ?? '.env'), ' (see .env.example); that file is read on every refresh.'),
      h('p.bal-links', {}, h('a', { href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Make a key ↗'), h('a', { href: p.billingUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Billing page ↗')),
    ),
    h('footer', {}, p.source === 'saved' ? forget : null, h('span.grow'), save),
  ));
  const post = async (path: string, body: object) => {
    save.disabled = forget.disabled = true;
    error.textContent = '';
    try {
      const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = (await res.json()) as BalancesState & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? 'That didn’t work');
      state = data;
      render();
      modal.close();
    } catch (err) {
      error.textContent = (err as Error).message;
    } finally {
      save.disabled = forget.disabled = false;
    }
  };
  save.addEventListener('click', () => { if (key.value.trim()) void post('/api/balances/login', { provider: p.provider, key: key.value, team: team.value }); else key.focus(); });
  key.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
  forget.addEventListener('click', () => void post('/api/balances/logout', { provider: p.provider }));
  key.focus();
}
