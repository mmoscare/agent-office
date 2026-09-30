// Noticing a server that has gone quiet without closing the connection: a frozen process, a laptop
// that slept, or a dropped network. Those can leave the socket looking open for minutes.

/** How often the page asks the office whether it's still there. */
export const PING_EVERY_MS = 5_000;
/** How long an unanswered ping waits before the office counts as gone. */
export const ANSWER_WITHIN_MS = 12_000;

export class Heartbeat {
  /** When the ping still waiting on an answer went out; 0 when nothing is waiting. */
  private askedAt = 0;

  constructor(private now: () => number = Date.now) {}

  /** Anything from the office answers the ping. */
  heard() {
    this.askedAt = 0;
  }

  /**
   * Called every PING_EVERY_MS: 'ping' to ask again, 'dead' when the last one went unanswered.
   * Only an unanswered ping counts, so a background tab whose timers the browser slows to once a
   * minute doesn't look like a dead office.
   */
  tick(): 'ping' | 'dead' | 'wait' {
    const now = this.now();
    if (!this.askedAt) {
      this.askedAt = now;
      return 'ping';
    }
    return now - this.askedAt > ANSWER_WITHIN_MS ? 'dead' : 'wait';
  }
}
