# Worker handoffs

Every AI worker must leave a detailed, durable handoff before declaring a task complete. The next worker must be able to understand the result and continue without access to the original terminal or chat. Read the relevant issue, PR, comments and existing handoff notes before picking up earlier work.

## Where to record the work

- For code changes, include the handoff in the PR description. When completing another task on an existing PR, also add a completion comment so the earlier history remains visible. Link the PR from its issue when needed for discovery.
- For issue work without a PR, add an issue comment. Record reviews and other GitHub actions on the relevant issue or PR, including actions that made no code changes.
- Without an appropriate GitHub thread, save a uniquely named `docs/handoffs/<task>.md` in the working branch when repository edits are allowed. Include the note in the task's commit. Do not create unrelated issues or empty PRs just for logging.
- Respect requests not to publish or edit files. If GitHub or repository writes are unavailable, return the full handoff in the final response, explain where saving failed or was disallowed, and identify the durable handoff as pending. Do not claim it was posted.

Finish with a short user-facing summary and a link to the saved record. Terminal scrollback and task cards help find work, but do not replace a durable handoff.

## Required contents

Use enough detail for another worker to continue. Describe meaningful actions and decisions, rather than dumping a raw tool transcript. Never include credentials or secrets.

```markdown
## Outcome
What was requested, what was achieved, and whether anything remains incomplete.

## Changes and decisions
What changed and why, with key files/components and important decisions.
Say explicitly if there were no code changes.

## Verification
Commands/checks actually run and their results.
List failing or skipped checks and explain why.

## Actions and references
Repository, branch, commit(s), issue and PR links.
Other GitHub or external actions taken (reviews, labels, merges, deployments, etc.).
For queue work, include task IDs and their issue/PR links.

## Remaining work
Known risks, blockers and concrete next steps, or explicitly "None".
Include the location and reason if the durable handoff is still pending.
```

## How the rule reaches workers

Agent Office appends the shared instructions from `src/server/handoff.ts` to agent launch prompts and prompts sent through the office. This covers desk workers, queued work and board agents using Claude Code, OpenCode, Codex or a custom wrapper. Custom wrappers must accept the task text as a positional argument after `--` and forward it to their agent, in addition to any configured arguments.

A fresh agent hired without a task receives the standing rule and is told to wait. A resumed session keeps its existing instructions; a resume without a new prompt does not submit an extra turn. Office follow-up prompts include the rule again, including for sessions started before this feature. Native slash commands and shell workers are left alone. Already-running terminals receive the rule with their next office-submitted task; updating the app does not inject text into an active terminal.

This is an instruction to the worker, not an automatic publication or completion check. The office's **done** status still reflects the provider's lifecycle event; it does not prove that GitHub contains a handoff. Check the linked record when reviewing the work.
