import type { WorkerInfo } from './protocol.js';
import { isAsleep, isBusy } from './status.js';

/** Keep this action out of shells, in-progress turns and permission/login questions. */
export function workerTestUnavailable(worker: WorkerInfo | undefined): string | undefined {
  if (!worker || worker.kind !== 'agent') return 'Testing needs an AI worker';
  if (isAsleep(worker.status)) return 'Open the terminal to resume the worker before testing';
  if (worker.status === 'needs_input') return 'Answer the worker’s question in its terminal first';
  if (isBusy(worker.status)) return 'Wait until the worker finishes its current task';
  if (worker.prOpening) return 'Wait until the pull request operation finishes';
  return undefined;
}

/** Test the whole task, even when the button is in a single repository's Changes view. */
export function workerTestPrompt(worker: WorkerInfo, floor?: string): string {
  const location = (relative: string) => JSON.stringify(floor
    ? `${floor.replaceAll('\\', '/').replace(/\/$/, '')}/${relative.replaceAll('\\', '/')}`
    : relative);
  const scope = worker.workspace
    ? ['This desk has the following repository worktrees. Inspect the changes in all of them:',
      ...worker.workspace.repositories.map(repo => `- Repository ${JSON.stringify(repo.repository)}: worktree ${location(repo.path)}, branch ${JSON.stringify(repo.branch)}, starting commit ${repo.base}.`)]
    : worker.worktree
      ? [`This desk's worktree is ${location(worker.worktree.path)}, on branch ${JSON.stringify(worker.worktree.branch)}, starting commit ${worker.worktree.base}.`]
      : [floor ? `This floor's project folder is ${JSON.stringify(floor)}.` : 'Use this session’s project folder and task context.'];
  return [
    'Test the changes for the current task across every repository and worktree involved.',
    '',
    ...scope,
    '',
    'Use our conversation and the Git diffs to identify the current task and its changes, including committed changes on the task branches. Include any additional worktrees you created for this task; do not limit testing to the terminal’s current directory or to one repository.',
    'Read each affected repository’s instructions and use its own documented test commands and tooling. Run relevant automated tests and applicable type checks, lint checks and builds. Choose checks that verify the changed behavior; do not assume every project uses npm or that a successful build alone proves the feature works.',
    'When the task spans repositories, test them together as well. For example, connect the changed frontend to the changed backend from their task worktrees and check the affected user flow or API contract. Use local/test services and data, not live production systems.',
    'Run checks and make any fixes in the task’s worktrees when they exist. Leave original checkouts, unrelated changes and other workers’ work untouched. If working directly in shared folders, preserve existing uncommitted work. Do not switch branches, reset, stash, discard changes, commit, push, merge or delete worktrees as part of this request.',
    'Fix failures caused by this task within its scope and rerun the affected checks. Separate pre-existing failures from new ones. If a required service, dependency or credential is missing, report the blocker and what remains untested; never describe an unrun or failing check as passed.',
    'Finish with a plain-English report: what you tested in each repository, what you tested across repositories, which checks passed or failed, any fixes you made, and anything still blocked or untested. If there are no task changes or no suitable automated tests, say so and explain any manual/smoke checks you could perform.',
  ].join('\n');
}
