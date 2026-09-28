# Personal fork guidance

This is mmoscare's personal fork of AgentSystemLabs/agent-office. The author will keep adding features, and those updates need to merge into this fork regularly.

## Branch workflow

- The user's confirmed workflow is: `personal` is the running, personalized app and the destination for requested app changes.
- Work in `C:\Users\Owner\Documents\Development\Agent-Office\agent-office` and verify that it is on `personal` before editing app code. Preserve existing uncommitted work.
- Keep `main` as a clean mirror of the author's code. Receive author updates from `upstream/main` into `main`, then merge `main` into `personal` while retaining customizations.
- Push `main` and `personal` to the user's fork (`origin`) when the task calls for uploading. The original author's repository is `upstream`.
- Do not default to editing the other `main` checkout or introduce a required `dev` branch. A chat opened in the other folder must target this personal app folder for customization work.
- Test and rebuild requested changes so they can run in the personalized app. Account for active workers when a restart is needed.

## Implementation guidance

- Keep personal changes focused and easy to merge. Prefer small adapter modules and existing extension points over broad rewrites.
- Reuse the existing agent providers and hooks. For Grok, use the existing OpenCode provider with xAI rather than adding a separate provider throughout the protocol.
- Preserve upstream defaults unless the requested customization needs a change. Avoid unrelated formatting, dependency upgrades, and generated-file changes.
- Keep platform-specific fixes in a small, tested helper where practical. Preserve the normal non-Windows behavior.
- Read PERSONAL-WORKFLOW.md before updating from upstream. Preserve local customizations and commit checkpoints; never replace the personal branch wholesale with upstream.
- Keep credentials out of this repository and logs. Provider authentication belongs in the provider's own local login flow.
- Verify the affected launch path and relevant tests after changing agent startup. Distinguish a successful launch check from a completed authenticated model request.
- Local folders are the preferred way to add floors. Keep both local-folder and GitHub-clone options.
- Multi-repository desks use the separate `workspaces.ts` and `workspace-changes.ts` helpers. Preserve repository selection, separate worktrees/PRs, restart metadata, and checks across every repo before cleanup; keep the author's ordinary single-repo flow working too.
- Esc belongs to the worker terminal; leave that view through its clickable close control.
- Keep usage estimates labelled and unknown costs unavailable. The separate model-usage history must not silently change the upstream Claude budget behavior.
- The Windows launcher lives in personal/windows and must run this personal checkout with the existing Personal-Portfolio building settings.
