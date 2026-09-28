/** Personal fork's update board; deliberately separate from the upstream self-updater. */
export const AUTHOR_REPO = 'AgentSystemLabs/agent-office';
export const PERSONAL_REPO = 'mmoscare/agent-office';
export interface AuthorUpdates {
  enabled: boolean;
  dir?: string;
  checkedAt?: number;
  latest?: string;
  behind?: number;
  changes?: { sha: string; subject: string }[];
  conflicts?: string[];
  merging?: boolean;
  personalDir?: string;
  error?: string;
}

/** This is reviewed in the ordinary worker picker before being sent. */
export function authorUpdatePrompt(s: AuthorUpdates): string {
  return `Bring the author's newest updates into my personalized Agent Office and resolve any merge conflicts, preserving my custom behavior.

Repository floor: ${JSON.stringify(s.dir)}. The personal checkout currently reported by Git is ${JSON.stringify(s.personalDir ?? 'not checked out; locate it with git worktree list')}.
Source: https://github.com/${AUTHOR_REPO}, main. Fork: ${PERSONAL_REPO}. Last observed author commit: ${s.latest ?? 'check again'}.
${s.merging ? `An unfinished merge was detected in personal. Inspect it before doing anything else. Reported unresolved files: ${JSON.stringify(s.conflicts ?? [])}.` : ''}

Read AGENTS.md, PERSONAL-WORKFLOW.md, related GitHub PRs/comments and handoffs first. Use git worktree list and the repository floor above to find the actual personal checkout; documentation may name an older location. Verify origin and upstream. Work on this fork only.
Check for existing update workers, update PRs and unfinished Git operations before starting. Continue the existing update when appropriate; never run a second merge concurrently. Preserve all uncommitted work and checkpoint existing customizations before merging. Do not overwrite, auto-stash, hard-reset or force-push anything.
Follow upstream/main -> main (fast-forward only, keeping main an author mirror) -> personal. Fetch the author's latest main again. If main cannot fast-forward, investigate and stop for a decision. Respect branches checked out in other worktrees. If isolation is needed, prepare the merge on a dedicated update branch from personal, then integrate the tested result into personal without losing newer work.
For an unfinished merge, verify MERGE_HEAD and its source before resuming. Compare both sides of each conflict, keep personal customizations and the author's improvements, and ask me only for decisions you cannot safely infer. Never blindly choose ours or theirs for every file. Stage the resolved files and commit the completed merge.
Run npm ci when dependencies changed, npm test, npm run typecheck and npm run build on the combined version; investigate failures before publishing. Push main and personal to origin only after the checks succeed. Verify the actual personal checkout contains the tested result. Do not restart or stop this office while workers are active (including this worker); leave the exact restart steps for after they finish.
Leave a durable handoff in the relevant PR, or docs/handoffs when no PR exists, with commits, conflicts/decisions, checks and results, branch links, and any remaining build/restart work. Report clearly whether the updates are merged, tested, pushed and running; those are separate steps.`;
}
