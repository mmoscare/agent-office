import { isValidOpenCodeModel } from './agents.js';
import type { OpenCodeModelCatalogue } from './models.js';

/**
 * Personal default: an OpenCode worker whose task or hire leaves the model blank runs xAI's most
 * capable Grok model (see AGENT-SETUP.md, "Add Grok once").
 *
 * The pick follows the live `opencode models` catalogue, so a new Grok release needs no code change:
 *   1. the plain `xai/grok-<version>` id with the highest version. xAI numbers releases as decimals
 *      (4.20 came out before 4.3), and a plain id rules out the fast, mini, reasoning/non-reasoning,
 *      multi-agent, build, imagine, `-latest` and dated snapshot variants;
 *   2. GROK_FLAGSHIP, when the catalogue can't be read or lists no such model.
 */
export const GROK_FLAGSHIP = 'xai/grok-4.7';

/** How long a pick is trusted before the next launch re-reads the catalogue in the background. */
export const GROK_REFRESH_MS = 60 * 60 * 1000;

const PLAIN_GROK = /^xai\/grok-(\d+(?:\.\d+)?)$/;

export function pickGrokFlagship(models: readonly string[]): string | undefined {
  let best: { id: string; version: number } | undefined;
  for (const id of models) {
    const match = PLAIN_GROK.exec(id);
    if (!match) continue;
    const version = Number(match[1]);
    if (!best || version > best.version) best = { id, version };
  }
  return best?.id;
}

export interface GrokDefault {
  /** The model a blank OpenCode worker launches with now; never waits on the catalogue. */
  current(): string;
  /** Re-reads the catalogue, keeping the last pick when it can't be read. */
  refresh(): Promise<string>;
}

export function createGrokDefault(catalogue?: Pick<OpenCodeModelCatalogue, 'get'>, now: () => number = Date.now): GrokDefault {
  let model = GROK_FLAGSHIP;
  let checkedAt = -Infinity;
  let pending: Promise<string> | undefined;
  const refresh = (): Promise<string> => {
    if (!catalogue) return Promise.resolve(model);
    if (pending) return pending;
    checkedAt = now();
    pending = catalogue.get()
      .then((models) => (model = pickGrokFlagship(models) ?? model))
      .catch(() => model)
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  return {
    current() {
      if (now() - checkedAt >= GROK_REFRESH_MS) void refresh();
      return model;
    },
    refresh,
  };
}

let office = createGrokDefault();

/** Points the office-wide default at the server's shared OpenCode catalogue (or back to the fixed id) and reads it once. */
export function useGrokCatalogue(catalogue?: Pick<OpenCodeModelCatalogue, 'get'>): GrokDefault {
  office = createGrokDefault(catalogue);
  void office.refresh();
  return office;
}

/**
 * The model a fresh OpenCode worker launches with: the one its task or hire picked, else a valid
 * `--model` in the office-wide --agent-args, else the Grok flagship.
 */
export function openCodeLaunchModel(chosen: string | undefined, officeArgs: readonly string[]): string {
  return chosen ?? modelFlag(officeArgs) ?? office.current();
}

/** The last `--model`/`-m` value in argv, read the way workers.ts `withoutOpenCodeModel` strips it. */
export function modelFlag(args: readonly string[]): string | undefined {
  let model: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--model' || arg === '-m') {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        model = next;
        i++;
      }
    } else if (arg.startsWith('--model=')) model = arg.slice('--model='.length);
    else if (arg.startsWith('-m') && arg.length > 2) model = arg.slice(2);
  }
  return isValidOpenCodeModel(model) ? model : undefined;
}
