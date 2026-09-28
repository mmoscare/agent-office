import { previewPush, pushReviewed, pushTargets } from './push.js';
import type { GitDiffMode } from '../shared/git-board.js';
import { authorUpdates } from './author-updates.js';
import { gitBranchPr, gitCommit, gitFetch, gitFileDiff, gitOpenPr, gitPull, gitPush, gitRepositories, gitRepository, gitStage, gitUnstage, officeFloorPull, officeStatus, type OfficeFloor } from './git-board.js';

/** A result that's a string is a failure, said for a person. */
function reply<T>(r: T | string): [number, unknown] {
  if (typeof r === 'string') return [200, { error: r }];
  return [200, r === undefined ? { ok: true } : r];
}

function paths(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.length || v.length > 500 || v.some((p) => typeof p !== 'string' || !p || p.length > 4096)) throw new Error('Bad file list');
  return v as string[];
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * The Git board's HTTP API: `[status, JSON body]` for a request under /api/git/. POSTs change the
 * checkout (the server checks the request came from the office's own page first).
 */
export async function routeGitBoard(p: string, method: string, q: URLSearchParams, floorDir: string, body: Record<string, unknown> = {}, floors: OfficeFloor[] = []): Promise<[number, unknown]> {
  const repo = (q.get('repo') ?? '').slice(0, 2048);
  const branch = (q.get('branch') ?? '').slice(0, 255) || undefined;
  try {
    if (p === '/api/git/author-updates' && method === 'GET') return [200, await authorUpdates.read(floorDir)];
    if (p === '/api/git/author-updates/check' && method === 'POST') return [200, await authorUpdates.read(floorDir, true)];
    if (p === '/api/git/push-targets' && method === 'GET') return [200, await pushTargets(floorDir)];
    if (p === '/api/git/push-preview' && method === 'GET') return [200, await previewPush(floorDir, text(q.get('target'), 2048))];
    if (p === '/api/git/push-reviewed' && method === 'POST') return reply(await pushReviewed(floorDir, text(body.target, 2048), text(body.token, 100)));
    if (p === '/api/git/repos' && method === 'GET') return [200, await gitRepositories(floorDir)];
    // The office's own code folder, whichever floor asks (see OfficeStatus).
    if (p === '/api/git/office' && method === 'GET') return [200, { office: (await officeStatus(floors, q.get('fresh') === '1')) ?? null }];
    if (p === '/api/git/office/pull-floor' && method === 'POST') return reply(await officeFloorPull(floors, text(body.dir, 4096)));
    if (!repo) return [400, { error: 'Choose a repository' }];
    if (method === 'GET') {
      if (p === '/api/git/repo') return [200, await gitRepository(floorDir, repo, branch)];
      if (p === '/api/git/diff') {
        const file = (q.get('path') ?? '').slice(0, 4096);
        const mode = q.get('mode');
        if (!file || (mode !== 'github' && mode !== 'uncommitted')) return [400, { error: 'Bad request' }];
        return reply(await gitFileDiff(floorDir, repo, branch, file, mode as GitDiffMode));
      }
      if (p === '/api/git/pr') return reply(await gitBranchPr(floorDir, repo));
    }
    if (method === 'POST') {
      if (p === '/api/git/fetch') return reply(await gitFetch(floorDir, repo));
      if (p === '/api/git/stage') return reply(await gitStage(floorDir, repo, paths(body.paths)));
      if (p === '/api/git/unstage') return reply(await gitUnstage(floorDir, repo, paths(body.paths)));
      if (p === '/api/git/commit') return reply(await gitCommit(floorDir, repo, text(body.message, 20_000)));
      if (p === '/api/git/push') return reply(await gitPush(floorDir, repo));
      if (p === '/api/git/pull') return reply(await gitPull(floorDir, repo));
      if (p === '/api/git/pr') return reply(await gitOpenPr(floorDir, repo, text(body.title, 300), text(body.body, 60_000)));
    }
    return [404, { error: 'Not found' }];
  } catch (err) {
    return [400, { error: (err as Error).message }];
  }
}
