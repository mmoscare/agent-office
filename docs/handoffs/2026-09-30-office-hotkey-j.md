# Handoff: restore O, move office jump to J

## Request
Previous personal edit bound O to "take me to the boss's office". O was already the desk key (open a worker's PR, open the PR agent's terminal, read an issue note). Restore O. Bind the office jump to J.

## Outcome
Done in the personal checkout (`C:\Users\Owner\Documents\Development\Agent-Office\agent-office`, branch `personal`). Not committed.

## Changes
- `src/client/main.ts`: `officeKey` calls `toOffice()` on KeyJ, not KeyO. Desk key O is no longer skipped. Ladder/golf still let J through. Hints restored: O at a desk opens the PR, O at a board agent opens its terminal, O on an issue note reads it.
- `src/client/ui/hud.ts`: controls list says J for the boss's office and O for the old desk actions.
- `src/shared/layout.ts`: comment on `OFFICE_SPOT` now says J.

## Checks
- `npm run build:client` in the personal checkout (so the running office can serve the new page).
- No server restart. Client-only.

## Next
Hard-refresh the office tab. J stands you in the boss's office. O at the PR agent's kiosk opens its terminal; O at a worker's desk opens its PR.
