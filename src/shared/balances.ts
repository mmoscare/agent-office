/** Money on the AI provider accounts, for the Plan balances panel (server/balances.ts). */

export const BALANCE_PROVIDERS = ['xai', 'openai', 'anthropic'] as const;
export type BalanceProvider = (typeof BALANCE_PROVIDERS)[number];

export const isBalanceProvider = (v: unknown): v is BalanceProvider => (BALANCE_PROVIDERS as readonly unknown[]).includes(v);

/** Where the key came from: pasted into the widget, this checkout's .env, or the office's environment. */
export type BalanceKeySource = 'saved' | 'file' | 'env';

export interface ProviderBalance {
  provider: BalanceProvider;
  label: string;
  /** `needs-admin`: only an ordinary API key was found, and it can't read billing. */
  status: 'ok' | 'signed-out' | 'needs-admin' | 'error';
  source?: BalanceKeySource;
  /** Prepaid credit left, in USD (xAI only: no other provider has an API for it). */
  remainingUsd?: number;
  /** Spent since the 1st of this month (UTC), in USD. */
  spentMonthUsd?: number;
  error?: string;
  /** Where the provider's own billing page is, for the balance an API can't give. */
  billingUrl: string;
  /** Where to make the key this needs. */
  keyUrl: string;
  /** What to paste, said for a person. */
  keyHint: string;
}

export interface BalancesState {
  providers: ProviderBalance[];
  /** The .env file the widget reads (shown in the sign-in window). */
  envFile: string;
  at: number;
}
