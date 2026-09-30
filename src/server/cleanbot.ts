import { floorPrune, pinRows, renderReport, type FloorPruneOptions, type FloorPruneReport, type OfficeView } from './prune-floor.js';

// CleanBot on one floor (see shared/bots.ts for the agent, shared/cleanbot-brief.ts for his brief): the
// /office/cleanbot endpoint behind his office-cleanbot command. It runs the whole-floor sweep
// (prune-floor.ts) inside the office, with the office's own view of every floor and its open
// terminals, so what the PR agent, the VP and the queue still need is read the moment it's asked.
// Nothing here deletes a row that isn't named, or one that isn't safe unless it's named to discard.

export interface CleanbotRequest {
  method: string;
  query: URLSearchParams;
  body?: Record<string, unknown>;
  /** The floor's folder. */
  floorDir: string;
  /** Who's asking: CleanBot, and the person who last typed to him. */
  by: string;
  /** Every floor of the office and its open terminals, asked afresh before each deletion too. */
  office: () => Promise<OfficeView>;
  /** Tests stand in for GitHub and the clock. */
  prune?: Partial<FloorPruneOptions>;
}

/** One sweep per floor at a time: a second list or delete while one runs is told to wait. */
const running = new Map<string, string>();

const names = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? [v] : [])
    .flatMap((s) => (typeof s === 'string' ? s.split(',') : []))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 500);

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : undefined);

function hours(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const h = Number(v);
  return Number.isFinite(h) && h > 0 ? h * 3_600_000 : NaN;
}

function answer(report: FloorPruneReport, dryRun = false) {
  return { report, text: renderReport(report, dryRun, 'cleanbot') };
}

/** CleanBot's endpoint. Resolves to an HTTP status and a JSON body: the report, and it rendered as text. */
export async function handleCleanbot(req: CleanbotRequest): Promise<{ status: number; body: unknown }> {
  const base: FloorPruneOptions = { floor: req.floorDir, office: async () => req.office().catch(() => undefined), by: req.by, ...req.prune };
  if (req.method === 'GET') {
    const view = req.query.get('view') ?? 'list';
    if (view === 'office') return { status: 200, body: await req.office() };
    if (view !== 'list') return { status: 400, body: { error: 'view is list or office' } };
    const recentMs = hours(req.query.get('recent'));
    if (Number.isNaN(recentMs)) return { status: 400, body: { error: '--recent takes a number of hours' } };
    return exclusive(req.floorDir, 'a list', async () =>
      answer(await floorPrune({ ...base, repo: str(req.query.get('repo')), recentMs, fetch: req.query.get('fetch') !== '0' })),
    );
  }
  if (req.method !== 'POST') return { status: 405, body: { error: 'GET or POST' } };
  const b = req.body ?? {};
  const repo = str(b.repo);
  switch (b.action) {
    case 'delete': {
      const only = names(b.only);
      if (!only.length) return { status: 400, body: { error: 'Say which rows to delete: office-cleanbot delete <names>' } };
      const discard = names(b.discard);
      // --discard is per row, and only for rows also named to delete: never a blanket force.
      const stray = discard.filter((d) => !only.includes(d));
      if (stray.length) return { status: 400, body: { error: `--discard only applies to rows you also name to delete (not ${stray.join(', ')})` } };
      const dryRun = b.dryRun === true;
      return exclusive(req.floorDir, dryRun ? 'a dry run' : 'a delete', async () =>
        answer(await floorPrune({ ...base, repo, only, keep: names(b.keep), discard, remote: b.remote === true, dryRun }), dryRun),
      );
    }
    case 'keep':
    case 'forget': {
      const list = names(b.names);
      if (!list.length) return { status: 400, body: { error: `Say which: office-cleanbot ${b.action} <names>` } };
      try {
        const repos = await pinRows(req.floorDir, list, { repo, forget: b.action === 'forget' });
        return { status: 200, body: { ok: true, repos } };
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } };
      }
    }
    default:
      return { status: 400, body: { error: 'The action is delete, keep or forget' } };
  }
}

async function exclusive(floorDir: string, what: string, fn: () => Promise<unknown>): Promise<{ status: number; body: unknown }> {
  const busy = running.get(floorDir);
  if (busy) return { status: 409, body: { error: `CleanBot is already running ${busy} on this floor: wait for it to finish, then ask again` } };
  running.set(floorDir, what);
  try {
    return { status: 200, body: await fn() };
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  } finally {
    running.delete(floorDir);
  }
}
