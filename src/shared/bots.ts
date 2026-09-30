// Deployable bots: agents with a preloaded brief that the owner puts on a floor from the floor menu
// (or by walking up to their kiosk). Each is a board agent with a kiosk of its own (STATIONS in
// layout.ts), hired and briefed the same way (server/stations.ts), launched without the file-editing
// tools, and working only through its office-* commands. One per floor.
//
// Adding a bot: an entry here (name, colour, kiosk, card text, the first request it gets when it's
// deployed), its brief (see vp-brief.ts, and 'station.<kind>' in prompts.ts so it can be rewritten in
// ⚙️ Settings), and any command of its own (bin/office-<kind>.js, written onto the board agents' PATH
// by workers.ts). Nothing here imports layout.ts, which builds its stations from this list.

export type BotKind = 'vp';

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
};

export const BOT_KINDS = Object.keys(BOTS) as BotKind[];

export function isBotKind(value: unknown): value is BotKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BOTS, value);
}

/** The kiosk a bot stands at (a desk id in layout.ts). */
export function botDesk(kind: BotKind): string {
  return `station-${kind}`;
}
