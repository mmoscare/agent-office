# Office calendar and first-of-month chores

## Request and outcome

Put a calendar in the office. On every first of the month, notify for three chores, and show those chores on the calendar:

1. Delete and clean up branches and worktrees
2. Combine MFT and Personal Portfolio so they have the same capabilities
3. Backup

Implemented on `office/gizmo-3ea6`. A wall calendar hangs in the boss office; the three chores sit on the 1st of every month; the office shows an in-office card and a desktop notification (when the tab is in the background and notifications are on) until the month is marked done.

## Changes and why

- `src/shared/calendar.ts` — office-clock date (same UTC offset as the sky/holiday calendar), month grid, the three recurring chores, pending/notify-once helpers, notification title and body.
- `src/client/world/calendar.ts` — wooden wall calendar on the loft south wall, west of the bookshelf (`CALENDAR` in `src/shared/layout.ts`). Paints the current month with dots on the 1st.
- `src/client/ui/calendar.ts` — month modal (☰ **📅 Calendar**, or click / E at the wall), chore list, **Done for this month**. Nag card + desktop `Notification` (tag `calendar-chores`). Dismissal/notified/snooze keys live in this browser’s localStorage, not the server.
- `src/client/world/office.ts` — `InteractKind` `'calendar'` and a picture-hanger fixture so hung pictures skip that wall rect.
- `src/client/main.ts` — interact, hint, reach, HUD action (count 3 and a “Monthly chores” chip while pending), wall refresh, nag mount.
- `src/client/style.css` — calendar modal grid and nag card.
- `README.md` — boss-office bullet.

Decisions: personal-fork adapter (small modules, existing notify permission and `openModal`). Catch-up: if you miss the 1st, the chores stay pending until marked done that month, so the reminder is not lost. Notify at most once per month per browser. No server JSON; these are personal monthly chores.

## Checks actually run

- `npx tsc -p tsconfig.server.json --noEmit` and `npx tsc -p tsconfig.client.json --noEmit` — passed (worktree had no `node_modules`; `npm ci --ignore-scripts` first).
- `node --import tsx --test tests/calendar.test.ts` — 5 passed.
- Full `npm test` not run (unrelated suite; this change is client calendar + shared helpers).
- No browser walk-up of the loft wall. No office restart. No authenticated model request.

## Branch, commits, GitHub

- Branch: `office/gizmo-3ea6` (worktree `C:\Users\Owner\agent-office\mmoscare\agent-office\.agent-office\worktrees\gizmo-3ea6`)
- Base for the PR: `personal`
- Repository: `mmoscare/agent-office`
- PR and commit SHA: fill in after push

## Remaining work

None for the requested calendar + reminders. After merge: rebuild/restart the personalized app to see the loft calendar. On the 1st (or until **Done for this month**), allow desktop notifications under ⚙️ if you want the background-tab ping. The chores are reminders only; they do not run cleanup, MFT/portfolio sync, or backup.
