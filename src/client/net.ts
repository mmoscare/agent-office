import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { ANSWER_WITHIN_MS, Heartbeat, PING_EVERY_MS } from './heartbeat';
import { lastFloor, store, type Profile } from './state';

type Handler = (msg: ServerMsg) => void;

export class Net {
  private ws: WebSocket | null = null;
  private handlers: Handler[] = [];
  private statusHandlers: ((up: boolean) => void)[] = [];
  private retry = 0;
  private closedByUs = false;
  /** The server is restarting on purpose: retry every second instead of backing off. */
  private restartExpected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pinger: ReturnType<typeof setInterval> | undefined;
  up = false;
  /** When the connection to the office was lost (Date.now()), or 0 while it's up. */
  downSince = 0;
  /** Tries since it was lost. */
  attempts = 0;

  constructor(private profile: () => Profile) {}

  onMessage(h: Handler) {
    this.handlers.push(h);
  }

  onStatus(h: (up: boolean) => void) {
    this.statusHandlers.push(h);
  }

  connect() {
    const { name, color, look } = this.profile();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ name, color, skin: String(look.skin), hair: String(look.hair), style: String(look.style) });
    // Back to the floor you were on (after a reload or a restart).
    const floor = store.floor ?? lastFloor();
    if (floor) q.set('floor', floor);
    const ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
    this.ws = ws;
    const heartbeat = new Heartbeat();
    let gone = false;
    // A server that takes the connection but never answers it is no better than one that's gone.
    const opening = setTimeout(() => ws.readyState === WebSocket.CONNECTING && ws.close(), ANSWER_WITHIN_MS);
    ws.onopen = () => {
      clearTimeout(opening);
      this.retry = 0;
      this.attempts = 0;
      this.downSince = 0;
      this.up = true;
      this.statusHandlers.forEach((h) => h(true));
      clearInterval(this.pinger);
      this.pinger = setInterval(() => {
        const next = heartbeat.tick();
        if (next === 'ping') this.send({ t: 'ping', at: performance.now() });
        else if (next === 'dead') {
          // Stopped answering without hanging up: hang up for it, and start trying again.
          lost();
          ws.close();
        }
      }, PING_EVERY_MS);
    };
    ws.onmessage = (ev) => {
      heartbeat.heard();
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      for (const h of this.handlers) h(msg);
    };
    const lost = async () => {
      if (gone || this.ws !== ws) return;
      gone = true;
      clearTimeout(opening);
      clearInterval(this.pinger);
      if (!this.downSince) this.downSince = Date.now();
      this.up = false;
      this.statusHandlers.forEach((h) => h(false));
      if (this.closedByUs) return;
      // Session expired? Go back to the door.
      try {
        const res = await fetch('/api/whoami', { cache: 'no-store', signal: AbortSignal.timeout(ANSWER_WITHIN_MS) });
        if (res.status === 401) {
          location.href = '/login';
          return;
        }
      } catch {
        // offline; keep retrying
      }
      // Retry now was pressed meanwhile: that try is already on its way.
      if (this.ws !== ws) return;
      const delay = this.restartExpected ? 1000 : Math.min(8000, 500 * 2 ** this.retry++);
      this.reconnectTimer = setTimeout(() => this.reconnect(), delay);
    };
    ws.onclose = lost;
  }

  private reconnect() {
    clearTimeout(this.reconnectTimer);
    this.attempts++;
    this.connect();
  }

  /** Try again straight away instead of waiting out the backoff. */
  retryNow() {
    if (this.up || this.closedByUs) return;
    this.retry = 0;
    const ws = this.ws;
    // Still waiting on a try that went out: that one gets to finish.
    if (ws && ws.readyState === WebSocket.CONNECTING) return;
    this.reconnect();
  }

  get restarting() {
    return this.restartExpected;
  }

  expectRestart() {
    this.restartExpected = true;
  }

  send(msg: ClientMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
