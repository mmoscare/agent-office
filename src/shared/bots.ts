// Deployable bots: agents with a preloaded brief that the owner puts on a floor from the floor menu
// (or by walking up to their kiosk). Each is a board agent with a kiosk of its own (STATIONS in
// layout.ts), hired and briefed the same way (server/stations.ts), launched without the file-editing
// tools, and working only through its office-* commands. One per floor.
//
// Adding a bot: an entry here (name, colour, kiosk, card text, the first request it gets when it's
// deployed), its brief (see vp-brief.ts, and 'station.<kind>' in prompts.ts so it can be rewritten in
// ⚙️ Settings), and any command of its own (bin/office-<kind>.js, written onto the board agents' PATH
// by workers.ts). Nothing here imports layout.ts, which builds its stations from this list. The floor
// menu deploys any bot with { t: 'bot.deploy', kind } (the VP also has his own vp.deploy).

export type BotKind = 'vp' | 'cleanbot';

export interface BotDef {
  kind: BotKind;
  /** Its name over its head, the same whenever it's hired. */
  name: string;
  color: string;
  icon: string;
  /** On the front of its kiosk. */
  sign: string;
  /** Its card while it waits at the kiosk, and what it does. */
  offer: string;
  does: string;
  /** An example request, for the kiosk's prompt box. */
  example: string;
  /** The first request it's given when the floor menu deploys it. */
  deployPrompt: string;
  /** Its kiosk (a DeskDef in layout.ts): where it stands, the way it faces and what the hint calls it. */
  spot: { x: number; z: number; rotY: number; label: string; freestanding: boolean };
}

export const BOTS: Record<BotKind, BotDef> = {
  vp: {
    kind: 'vp',
    name: 'VP',
    color: '#6a4c93',
    icon: '👔',
    sign: '👔 VP',
    offer: 'Deploy me, or ask me',
    does: 'I sweep the PRs, merge what passes, and unstick workers',
    example: 'Sweep the PRs and tell me what needs me',
    deployPrompt: "You've just been deployed on this floor. Run office-vp status and office-vp workers, then tell me in a few lines where the pull requests and the workers stand, and what (if anything) needs me.",
    // Out in the lounge, against the meeting room's glass under the boss office, facing into the room.
    spot: { x: 14.8, z: 7.0, rotY: 0, label: 'VP', freestanding: true },
  },
  cleanbot: {
    kind: 'cleanbot',
    name: 'CleanBot',
    color: '#2a9d8f',
    icon: '🧹',
    sign: '🧹 CleanBot',
    offer: 'Deploy me to tidy up',
    does: 'I find the leftover branches and worktrees, suggest what to delete, and delete only what you say',
    example: 'Clean up this floor',
    deployPrompt: "You've just been deployed on this floor. Run office-cleanbot list, then show me what you found and what you suggest deleting, and ask me which to delete and which to keep. Don't delete anything until I say so.",
    // In the lounge too, against the meeting room's glass just west of its door (the VP is east of it),
    // facing into the room. Further east the way out runs into the lounge's furniture (tests/nav.test.ts).
    spot: { x: 9.6, z: 7.0, rotY: 0, label: 'CleanBot', freestanding: true },
  },
};

export const BOT_KINDS = Object.keys(BOTS) as BotKind[];

export function isBotKind(value: unknown): value is BotKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BOTS, value);
}

/** The kiosk a bot stands at (a desk id in layout.ts). */
export function botDesk(kind: BotKind): string {
  return `station-${kind}`;
}
