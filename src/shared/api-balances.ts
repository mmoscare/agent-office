// The API balances widget in the sidebar: what the office knows about each pay-as-you-go account.
// Keys never travel here; the browser only learns whether one is set and what it reported.

export type BalanceProvider = 'anthropic' | 'openai' | 'xai';
export const BALANCE_PROVIDERS: BalanceProvider[] = ['anthropic', 'openai', 'xai'];
export const BALANCE_LABEL: Record<BalanceProvider, string> = { anthropic: 'Anthropic API', openai: 'OpenAI API', xai: 'xAI (Grok) API' };

/** The balance you copied from the provider's console, and when. */
export interface ConsoleCredits {
  amount: number;
  at: number;
  /** Spend the provider had already reported for the day of `at` when it was typed; not counted again. */
  baseline: number;
}

export interface ProviderBalance {
  provider: BalanceProvider;
  /** A key is saved for it (in the settings file or the environment). */
  configured: boolean;
  /** Where the key came from; an environment key can't be changed from the office. */
  source?: 'env' | 'file';
  /** xAI needs a team id as well as a key. */
  teamIdSet?: boolean;
  /** Remaining prepaid credit the provider reported (xAI), USD. */
  reportedBalance?: number;
  credits?: ConsoleCredits;
  /** Spend the provider reported since `credits.at`, USD. */
  spentSinceCredits?: number;
  /** Spend this calendar month (UTC), USD. */
  spentMonth?: number;
  /** When it was last read. */
  at?: number;
  /** Why the last read failed, when it did. */
  error?: string;
}

export interface ApiBalancesState {
  providers: ProviderBalance[];
  at: number;
  /** Someone with the admin role may save keys. */
  editable?: boolean;
}

/** The console balance minus what the provider has reported since: an estimate, reports lag a few minutes. */
export function estimatedBalance(p: ProviderBalance): number | undefined {
  if (!p.credits || p.spentSinceCredits === undefined) return undefined;
  return p.credits.amount - p.spentSinceCredits;
}

/** What a POST /api/balances may change. Empty strings leave keys alone; null removes. */
export interface BalanceUpdate {
  provider: BalanceProvider;
  key?: string | null;
  teamId?: string | null;
  /** The console balance now, or null to stop estimating. */
  credits?: number | null;
}
