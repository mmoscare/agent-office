import type { GhPull, PullRequestRef } from './protocol.js';

/** Prefer current work when a branch was reused; otherwise retain its latest completed PR. */
export function pullForBranch(pulls: Pick<GhPull, 'number' | 'url' | 'state' | 'headRefName'>[], branch: string): PullRequestRef | undefined {
  let found: (typeof pulls)[number] | undefined;
  for (const p of pulls) {
    if (p.headRefName !== branch) continue;
    if (!found || (p.state === 'OPEN' && found.state !== 'OPEN') || ((p.state === 'OPEN') === (found.state === 'OPEN') && p.number > found.number)) found = p;
  }
  return found ? { number: found.number, url: found.url, state: found.state } : undefined;
}

export function pullRequestLabel(pr: PullRequestRef): string {
  const prefix = pr.state === 'MERGED' ? 'Merged ' : pr.state === 'CLOSED' ? 'Closed ' : '';
  return `${prefix}PR #${pr.number}`;
}

/**
 * The agent a branch was made for, from the office's `office/<worker>-<id>` naming (server/worktrees.ts),
 * so a PR still names its agent after the worker has gone home. Undefined for other branches and meetings.
 */
export function agentForBranch(branch: string): string | undefined {
  const m = /^office\/([a-z][a-z0-9]*)-[0-9a-f]{4,}$/.exec(branch);
  if (!m || m[1] === 'meeting') return undefined;
  return m[1][0].toUpperCase() + m[1].slice(1);
}
