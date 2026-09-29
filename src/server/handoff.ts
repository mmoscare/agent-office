/** Standing instructions shared by desk, queue and board workers, regardless of provider. */
const HANDOFF_NOTE = `

<agent-office-handoff>
Worker handoff rule (applies to every task in this session):
Before continuing someone else's work, read the relevant GitHub issue/PR description, comments and previous handoff, plus any repository handoff notes.
Before declaring a task complete, leave a detailed, durable handoff so another worker can continue without this terminal or conversation. For code changes, put it in the PR description; when updating an existing PR, also add a completion comment for this task without erasing earlier history. For work with an issue but no PR, post it as an issue comment. Link the PR from the related issue when needed to make the handoff discoverable. For reviews or other GitHub actions, record the outcome on the relevant issue or PR.
Include: the request and outcome; changes made and why, with key files/components; important decisions; checks actually run with commands and results (and checks skipped or failing); commits, branch and issue/PR links; other actions taken on GitHub or external systems; remaining work, blockers, risks and concrete next steps. Say explicitly when there are no code changes or no remaining work. Keep it factual and never include credentials or secrets.
If there is no appropriate GitHub thread, save the same handoff in a uniquely named docs/handoffs/<task>.md file in your working branch when repository edits are allowed, and include it in the task's commit. Do not create an unrelated issue or empty PR just to log work. Respect requests not to publish or edit files. If publishing or saving is unavailable, include the full handoff in your final response, explain where it could not be saved and why, and mark the durable handoff as pending; never claim it was posted.
Finish with a concise user-facing summary linking to the durable handoff. A terminal-only summary is not a substitute when a durable record can be saved.
</agent-office-handoff>`;

/**
 * For queued workers in their own worktree: an office restart kills a running task, so whatever
 * isn't committed and pushed by then is stranded. Never given to board agents (they share the main checkout).
 */
export const CHECKPOINT_NOTE = `

<agent-office-checkpoint>
Checkpoint rule: the office can restart at any time and end this session, so make your work durable early and often.
- After your first meaningful change (or within a few minutes), run git add -A && git commit -m "WIP: <task title>" and git push -u origin HEAD so the branch exists on the fork.
- Commit and push again at each milestone (a passing test, a working piece). WIP commits are fine; tidy or squash them later if you like.
- Before ending, leave no uncommitted changes: commit and push everything, or say in the handoff what was left out and why.
- If you can't push (no origin or no access), keep committing locally and say so in the handoff.
- If you're woken after a restart, first run git status and git log @{u}..HEAD (or git log origin/<your branch>..HEAD) to see what was already saved, and continue from there.
</agent-office-checkpoint>`;

/** A queued task without the checkpoint rule: the rule is for the worker, not for its pull request. */
export function withoutCheckpoint(task: string): string {
  return task.endsWith(CHECKPOINT_NOTE) ? task.slice(0, -CHECKPOINT_NOTE.length) : task;
}

const WAIT_FOR_TASK = 'No task has been assigned yet. Keep these standing instructions for future tasks and wait for the user\'s request.';

const RETOLD_NOTE = `

(Agent Office restarted you in a fresh session because the earlier one could not be continued. This is your original task again: check the working tree, branch and any pull request for work already done before starting over: run git status and git log @{u}..HEAD first, and continue from what was saved.)`;

/** A worker's original task, for a fresh session that replaces one it can't continue. */
export function retoldTask(task: string | undefined): string | undefined {
  return task ? `${task}${RETOLD_NOTE}` : undefined;
}

const SAVED_PREFIX = 'The office saved your uncommitted work as WIP commit ';

/** Tells a worker that the office committed what it left uncommitted when it went down. */
export function checkpointNotice(checkpoints: { hash: string; branch: string; repository?: string }[] | undefined): string | undefined {
  if (!checkpoints?.length) return undefined;
  return checkpoints
    .map((c) => `${SAVED_PREFIX}${c.hash.slice(0, 12)} on ${c.branch}${c.repository ? ` (in ${c.repository})` : ''} when it restarted; run \`git log -1 --stat\` and continue from it. Squash or reword it before opening the PR if you like.`)
    .join('\n');
}

/** A woken worker's prompt with the checkpoint notice after it, or the notice alone when there's no task to repeat. */
export function withCheckpointNotice(prompt: string | undefined, notice: string | undefined): string | undefined {
  if (!notice) return prompt;
  return prompt ? `${prompt}\n\n${notice}` : notice;
}

/** A native slash command (/compact, /model …), which the agent runs as typed. */
export function isSlashCommand(prompt: string): boolean {
  return /^\/[\w:-]+(?:\s|$)/.test(prompt);
}

/** Preserve native slash commands and avoid submitting a new turn on a bare resume. */
export function withWorkerHandoff(prompt: string | undefined, resumeSessionId?: string): string | undefined {
  if (!prompt && resumeSessionId) return undefined;
  if (prompt && isSlashCommand(prompt)) return prompt;
  return `${prompt || WAIT_FOR_TASK}${HANDOFF_NOTE}`;
}

/** Hooks echo the submitted prompt; task cards and naming should see only the actual request. */
export function withoutWorkerHandoff(prompt: string): string {
  if (!prompt.endsWith(HANDOFF_NOTE)) return prompt;
  const request = prompt.slice(0, -HANDOFF_NOTE.length);
  if (request === WAIT_FOR_TASK) return '';
  const told = withoutNotice(request);
  return told.endsWith(RETOLD_NOTE) ? told.slice(0, -RETOLD_NOTE.length) : told;
}

/** Drops the checkpoint notice the office put after a woken worker's prompt (see withCheckpointNotice). */
function withoutNotice(request: string): string {
  // The notice is the last paragraph: one line per saved commit, each starting with the same words.
  const split = request.lastIndexOf('\n\n');
  const notice = request.slice(split < 0 ? 0 : split + 2);
  if (!notice.split('\n').every((line) => line.startsWith(SAVED_PREFIX))) return request;
  return split < 0 ? '' : request.slice(0, split);
}
