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

const WAIT_FOR_TASK = 'No task has been assigned yet. Keep these standing instructions for future tasks and wait for the user\'s request.';

/** Preserve native slash commands and avoid submitting a new turn on a bare resume. */
export function withWorkerHandoff(prompt: string | undefined, resumeSessionId?: string): string | undefined {
  if (!prompt && resumeSessionId) return undefined;
  if (prompt && /^\/[\w:-]+(?:\s|$)/.test(prompt)) return prompt;
  return `${prompt || WAIT_FOR_TASK}${HANDOFF_NOTE}`;
}

/** Hooks echo the submitted prompt; task cards and naming should see only the actual request. */
export function withoutWorkerHandoff(prompt: string): string {
  if (!prompt.endsWith(HANDOFF_NOTE)) return prompt;
  const request = prompt.slice(0, -HANDOFF_NOTE.length);
  return request === WAIT_FOR_TASK ? '' : request;
}
