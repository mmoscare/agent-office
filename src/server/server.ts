import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { workspaceRepositories } from './workspaces.js';
import { routeGitBoard } from './git-board-routes.js';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { Config } from './config.js';
import { Auth, type Session } from './auth.js';
import { Accounts } from './accounts.js';
import { childEnv, resolveCommand } from './workers.js';
import { configuredProvider, OPEN_CODE_MODEL_MAX } from './agents.js';
import { createOpenCodeModelCatalogue } from './models.js';
import { Team } from './team.js';
import { Upgrader } from './upgrade.js';
import { Services } from './services.js';
import { ImageProxy } from './decor.js';
import { Ledger } from './usage.js';
import { ledgerFacts } from './ledger-facts.js';
import { ModelUsageLedger } from './model-usage.js';
import { ApiBalances } from './api-balances.js';
import type { BalanceUpdate } from '../shared/api-balances.js';
import { PlanLimitsReader } from './limits.js';
import { Webhook } from './webhook.js';
import { MAX_WORKER_LIMIT, Machine, parseWorkerLimit } from './machine.js';
import { PhoneLine } from './phone.js';
import { Building, type FloorDef } from './building.js';
import { listLocalFolders } from './local-folders.js';
import { Floor, type FloorContext } from './floor.js';
import { PlansError } from './plans.js';
import { INBOX_SERVE_MAX, InTrayDoor, InboxError, fileType, plainName, readBytes } from './inbox.js';
import { Sky } from './sky.js';
import { Themes } from './theme.js';
import { RELAY_LOGIN, relayRequest, relayUpgrade, signInPage, stoppedPage, tunneledPort } from './relay.js';
import { ChatLog } from './history.js';
import { Arcade, HighScores } from './cabinet.js';
import type { ChatLine, ClientMsg, FloorInfo, FloorView, Me, MeetingRequest, PeerInfo, SearchResults, ServerMsg, ServicesState } from '../shared/protocol.js';
import { GH_COMMENT_MAX, ghRef, isAgentEffort, isAgentProvider } from '../shared/protocol.js';
import { normalizeRepo } from '../shared/floors.js';
import { PLAN_COLUMNS, PLAN_TEXT_MAX, planTitle, type PlanStatus } from '../shared/plans.js';
import { INBOX_FILE_MAX, INBOX_NOTE_MAX, inboxPlanText, inboxPrompt } from '../shared/inbox.js';
import { DESK_BY_ID, elevatorSpot, seatHere, streetBelow } from '../shared/layout.js';
import { JUKEBOX_TUNES, STREAM } from '../shared/jukebox.js';
import { checkFrame, scoreText, type CabinetFrame, type CabinetState } from '../shared/cabinet.js';
import { SEARCH_MAX, SEARCH_MIN, searchKey } from '../shared/search.js';
import { WB_MAX_FILE_BYTES } from '../shared/whiteboard.js';
import { MAX_FLOORS } from '../shared/floors.js';
import { lookFromSeed, sanitizeLook } from '../shared/avatar.js';
import { EMOTE_EVERY, EmoteBucket, isEmote } from '../shared/emotes.js';
import { isThemePick } from '../shared/theme.js';
import { ROOF, isDrink } from '../shared/rooftop.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

const CLEANUPS = new Set(['keep', 'worktree', 'all']);

type ToastLevel = Extract<ServerMsg, { t: 'toast' }>['level'];

interface Client {
  id: string;
  ws: WebSocket;
  peer: PeerInfo;
  /** Signed in with this account; none means the shared office password. */
  accountId?: string;
  /** Whether this person was last told they're an admin (see `me`). */
  admin: boolean;
  /** Signed out while connected; whatever it still sends is dropped until the socket closes. */
  out?: boolean;
  attached: Set<string>;
  /** Terminals whose output was skipped because this client fell behind; re-snapshotted later. */
  stale: Set<string>;
  lastMoveAt: number;
  lastActAt: number;
  lastGongAt: number;
  /** When they last blew the DJ's air horn on the roof. */
  lastHornAt: number;
  emotes: EmoteBucket;
  /** Has the floor's whiteboard open. */
  whiteboard: boolean;
  lastWbPointerAt: number;
  /** At the arcade cabinet on their floor, playing `game` (see Arcade); `frame` is it as it looks now. */
  playing: boolean;
  game?: string;
  frame?: CabinetFrame;
  lastFrameAt: number;
  /** When this client last said it was typing, per terminal (see 'term.typing'). */
  typingAt: Map<string, number>;
  /** Cleared at each heartbeat ping and set again by the pong; still clear at the next one means gone. */
  isAlive: boolean;
}

const SLOW_CLIENT_BYTES = 8 * 1024 * 1024;
/** The least time between two 'term.typing' notes from one person in one terminal. */
const TYPING_GAP_MS = 500;

function findPublicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../../public'), path.resolve(here, '../../dist/public')];
  for (const c of candidates) if (existsSync(path.join(c, 'index.html'))) return c;
  throw new Error(`Client bundle not found (looked in ${candidates.join(', ')}). Run \`npm run build\`.`);
}

function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    // The rightmost hop is the one our proxy appended; anything left of it is client-controlled.
    if (typeof fwd === 'string' && fwd) return fwd.split(',').pop()!.trim();
  }
  return req.socket.remoteAddress ?? '?';
}

function isSecure(req: http.IncomingMessage, cfg: Config): boolean {
  if (cfg.tls) return true;
  return cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https';
}

function readBody(req: http.IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Whether the page asking is the office itself, so another site can't open a socket with a visitor's cookie. */
function sameOrigin(req: http.IncomingMessage, cfg: Config): boolean {
  const origin = req.headers.origin;
  const host = (cfg.trustProxy && (req.headers['x-forwarded-host'] as string)) || req.headers.host;
  try {
    return !!origin && new URL(origin).host === host;
  } catch {
    return false;
  }
}

function refuseUpgrade(socket: Duplex) {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(json);
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** Where someone going to another floor says they arrive (see `floor.go`): on the grounds, or nowhere (the elevator). */
function arrivalSpot(at: unknown): { x: number; y: number; z: number; rotY: number } | undefined {
  if (!at || typeof at !== 'object') return undefined;
  const a = at as Record<string, unknown>;
  const clamp = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, num(v)));
  // Down on the street from a floor high up, the street is a long way down.
  return { x: clamp(a.x, -60, 60), y: clamp(a.y, streetBelow(MAX_FLOORS - 1), 10), z: clamp(a.z, -60, 60), rotY: num(a.rotY) };
}
const issueNumber = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : undefined);
/** A worker's side shell, in a client's `attached` and `stale` sets (its own terminal goes by its id). */
const sideKey = (workerId: string) => `side:${workerId}`;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const TOO_MANY_ATTEMPTS = 'Too many attempts. Try again in a few minutes.';
/** WebSocket close code for a session that stopped counting: the account was revoked, or the shared password switched off. */
const SIGNED_OUT = 4001;
/** The most chat lines, and lines per worker's terminal, a search answers with. */
const SEARCH_CHAT_HITS = 50;
const SEARCH_TERMINAL_HITS = 25;

export async function startServer(cfg: Config) {
  const publicDir = findPublicDir();
  const accounts = new Accounts(cfg.dataDir);
  const auth = new Auth(cfg.verifier, cfg.salt, cfg.secret, accounts);
  const clients = new Map<string, Client>();
  // Kept on disk, so a restart doesn't wipe it.
  const chat = new ChatLog(cfg.dataDir);
  // The arcade's high scores: one table for the whole building, on every floor's cabinet. The office
  // follows every game and puts the scores up itself (see Arcade).
  const highScores = new HighScores(cfg.dataDir);
  const arcade = new Arcade(highScores, (first) => {
    for (const f of floors.values()) cabinetChanged(f);
    if (first) toastFloor(floors.get(first.floor), `🏆 ${first.score.name} set a new arcade high score: ${scoreText(first.score.score)}`);
  });
  /** What the office is called where it has no project of its own to go by (webhooks, invites). */
  const officeName = cfg.project ? path.basename(cfg.project) : 'the office';
  const modelCommand = configuredProvider(cfg.agentCmd) === 'opencode' ? cfg.agentCmd : 'opencode';
  const openCodeModels = createOpenCodeModelCatalogue(
    modelCommand.includes('/') ? path.resolve(modelCommand) : modelCommand,
    cfg.dir,
  );

  const sendTo = (c: Client, msg: ServerMsg) => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMsg, except?: string, droppable = false) => {
    const json = JSON.stringify(msg);
    for (const c of clients.values()) {
      if (c.id === except || c.ws.readyState !== WebSocket.OPEN) continue;
      if (droppable && c.ws.bufferedAmount > 4 * 1024 * 1024) continue;
      c.ws.send(json);
    }
  };
  const toastAll = (text: string, level: ToastLevel = 'info') => broadcast({ t: 'toast', text, level });

  // --- The building: a floor per project, each with its own workers, boards and queue -----------
  const building = new Building(cfg.dataDir, cfg.projectsDir);
  if (cfg.projects) {
    const err = building.setProjectsDir(cfg.projects, 'the command line');
    if (err) console.error(`agent-office: --projects: ${err}`);
  }
  const floors = new Map<string, Floor>();
  const floorOf = (c: Client): Floor | undefined => (c.peer.floor ? floors.get(c.peer.floor) : undefined);
  /** The floor a worker sits on. Worker ids are unique across the building. */
  const workerFloor = (workerId: string): Floor | undefined => {
    for (const f of floors.values()) if (f.workers.get(workerId)) return f;
    return undefined;
  };
  /** The in-tray door (POST /api/inbox from outside), one for the whole building (see inbox.ts). */
  const door = new InTrayDoor(cfg.dataDir);
  /** To everyone on one floor. */
  const toFloor = (floor: Floor, msg: ServerMsg, droppable = false) => {
    const json = JSON.stringify(msg);
    for (const c of clients.values()) {
      if (c.peer.floor !== floor.id || c.ws.readyState !== WebSocket.OPEN) continue;
      if (droppable && c.ws.bufferedAmount > 4 * 1024 * 1024) continue;
      c.ws.send(json);
    }
  };
  const toastFloor = (floor: Floor | undefined, text: string, level: ToastLevel = 'info') => {
    if (floor) toFloor(floor, { t: 'toast', text, level });
  };
  const floorInfos = (): FloorInfo[] => [
    ...[...floors.values()].map((f) => f.info()),
    ...building.pending().map((d) => ({ id: d.id, name: d.name, repo: d.repo, dir: d.dir, palette: d.palette, addedBy: d.addedBy, addedAt: d.addedAt, cloning: true, workers: 0, busy: 0, waiting: 0, attention: [], people: 0 })),
  ];
  // The elevator's counts change with every worker update; tell everyone at most a few times a second.
  let floorsSent = '';
  let floorsTimer: NodeJS.Timeout | undefined;
  const floorsChanged = () => {
    floorsTimer ??= setTimeout(() => {
      floorsTimer = undefined;
      const list = floorInfos();
      const json = JSON.stringify(list);
      if (json === floorsSent) return;
      floorsSent = json;
      broadcast({ t: 'floors', floors: list });
    }, 250);
  };
  /** Tells just this person why their request didn't happen; nothing when there's no error. */
  const warn = (c: Client, error: string | undefined) => {
    if (error) sendTo(c, { t: 'toast', text: error, level: 'warn' });
  };

  // --- Loopback-only endpoint for authenticated agent events -------------------------------
  let webhook!: Webhook;
  const hookServer = http.createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return send(res, 400, {});
    }
    if (url.pathname === '/office/queue') return officeQueue(req, res, url);
    if (url.pathname === '/office/plans') return officePlans(req, res, url);
    if (url.pathname === '/office/inbox') return officeInbox(req, res, url);
    if (req.method !== 'POST' || !['/hooks/claude', '/hooks/opencode', '/hooks/codex'].includes(url.pathname)) return send(res, 404, { ok: false });
    let payload: unknown = {};
    try {
      const body = await readBody(req);
      payload = body ? JSON.parse(body) : {};
    } catch {
      if (url.pathname !== '/hooks/claude') return send(res, 400, { ok: false });
      // permissive: a bad payload still counts as the event
    }
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const workerId = url.searchParams.get('worker') ?? '';
    const workers = workerFloor(workerId)?.workers;
    if (!workers) return send(res, 401, {});
    const ok = url.pathname === '/hooks/opencode'
      ? workers.handleOpenCodeHook(workerId, token, payload)
      : url.pathname === '/hooks/codex'
        ? workers.handleCodexHook(workerId, token, url.searchParams.get('event') ?? '', payload)
        : workers.handleHook(workerId, token, url.searchParams.get('event') ?? '', payload);
    send(res, ok ? 200 : 401, {});
  });
  /**
   * The task queue, for the board agents (see stations.ts, which tells them how): GET lists it, POST
   * adds a task, DELETE with ?task= takes a waiting one off. The agent's own hook token says who's asking.
   */
  const officeQueue = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    const workerId = url.searchParams.get('worker') ?? '';
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const floor = workerFloor(workerId);
    const agent = floor?.workers.authenticate(workerId, token);
    if (!floor || !agent) return send(res, 401, { error: 'Send your own AGENT_OFFICE_WORKER_ID as ?worker= and AGENT_OFFICE_HOOK_TOKEN as the bearer token' });
    if (!DESK_BY_ID.get(agent.deskId)?.station) return send(res, 403, { error: 'Only the agents standing by the boards can use the queue' });
    const view = () => {
      const q = floor.queue.state();
      return {
        maxWorkers: q.maxWorkers,
        tasks: q.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, outcome: t.outcome, issue: t.issue, repo: t.repo, plan: t.plan, addedBy: t.addedBy, worker: t.workerName, branch: t.branch, pr: t.pr, error: t.error })),
      };
    };
    if (req.method === 'GET') return send(res, 200, view());
    if (req.method === 'DELETE') {
      const err = floor.queue.remove(url.searchParams.get('task') ?? '');
      return err ? send(res, 400, { error: err }) : send(res, 200, view());
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'GET, POST or DELETE' });
    let body: { prompt?: unknown; title?: unknown; issue?: unknown; repo?: unknown; plan?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'Send JSON: {"title": "…", "prompt": "…", "issue": 12}' });
    }
    const issue = Number.isInteger(body?.issue) && (body.issue as number) > 0 ? (body.issue as number) : undefined;
    const repo = normalizeRepo(body?.repo);
    if (issue !== undefined && !repo && floor.github.checkouts.length > 1) return send(res, 400, { error: `This floor holds several repositories: send "repo" (owner/name) with "issue", one of ${floor.github.checkouts.map((c) => c.repo).join(', ')}` });
    const plan = str(body?.plan, 64) || undefined;
    if (plan && !floor.plans.state().items.some((p) => p.id === plan)) return send(res, 400, { error: `There is no To Do Next item ${plan} (see office-plans list)` });
    const err = floor.queue.add(str(body?.prompt, 20000), agent.name, str(body?.title, 200) || undefined, issue, undefined, undefined, undefined, repo, plan);
    if (err) return send(res, 400, { error: err });
    const task = floor.queue.state().tasks.at(-1)!;
    toastFloor(floor, `📋 The ${agent.name} queued ${issue !== undefined ? `issue ${ghRef({ number: issue, repo })}` : `“${task.title}”`}${plan ? ' from To Do Next' : ''}`);
    send(res, 200, { ok: true, task: { id: task.id, title: task.title, status: task.status } });
  };
  /** The agent standing by a board that's asking, for the /office/* endpoints; the refusal is already sent when there isn't one. */
  const boardAgent = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, what: string): { floor: Floor; agent: { id: string; name: string } } | undefined => {
    const workerId = url.searchParams.get('worker') ?? '';
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const floor = workerFloor(workerId);
    const agent = floor?.workers.authenticate(workerId, token);
    if (!floor || !agent) {
      send(res, 401, { error: 'Send your own AGENT_OFFICE_WORKER_ID as ?worker= and AGENT_OFFICE_HOOK_TOKEN as the bearer token' });
      return undefined;
    }
    if (!DESK_BY_ID.get(agent.deskId)?.station) {
      send(res, 403, { error: `Only the agents standing by the boards can use ${what}` });
      return undefined;
    }
    return { floor, agent };
  };
  /**
   * The 📒 To Do Next board, for the board agents (office-plans): GET lists it; POST adds, moves or
   * removes an item ({"action": "add", "text"}, {"action": "edit", "id", "status"} or {"action": "remove", "id"}).
   */
  const officePlans = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    const who = boardAgent(req, res, url, 'the To Do Next board');
    if (!who) return;
    const { floor, agent } = who;
    try {
      if (req.method === 'GET') return send(res, 200, floor.plans.read());
      if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST' });
      let body: { action?: unknown; id?: unknown; text?: unknown; status?: unknown };
      try {
        body = JSON.parse(await readBody(req, 128 * 1024));
      } catch {
        return send(res, 400, { error: 'Send JSON: {"action": "add", "text": "…"}, {"action": "edit", "id": "…", "status": "progress"} or {"action": "remove", "id": "…"}' });
      }
      const action = body?.action;
      if (action !== 'add' && action !== 'edit' && action !== 'remove') return send(res, 400, { error: 'The action is add, edit or remove' });
      const id = str(body?.id, 64);
      const state = floor.plans.apply(
        action === 'add'
          ? { action, text: str(body?.text, PLAN_TEXT_MAX + 1) }
          : action === 'remove'
            ? { action, id }
            : { action, id, ...(body?.text !== undefined ? { text: str(body.text, PLAN_TEXT_MAX + 1) } : {}), ...(body?.status !== undefined ? { status: body.status as PlanStatus } : {}) },
      );
      const item = action === 'add' ? state.items.at(-1) : state.items.find((p) => p.id === id);
      const what = item ? `“${planTitle(item.text)}”` : 'an item';
      toastFloor(floor, action === 'add' ? `📒 The ${agent.name} added ${what} to To Do Next` : action === 'remove' ? `📒 The ${agent.name} took an item off To Do Next` : body?.status !== undefined && item ? `📒 The ${agent.name} moved ${what} to ${PLAN_COLUMNS[item.status]}` : `📒 The ${agent.name} edited ${what} on To Do Next`);
      return send(res, 200, { ok: true, item, state });
    } catch (error) {
      if (error instanceof PlansError) return send(res, error.status, { error: error.message });
      throw error;
    }
  };
  /**
   * The 📥 in-tray, for the board agents (office-inbox): GET lists it, or with ?read=<name> gives one
   * item (a note's text, or a file's path); POST {"action": "archive", "name"} puts an item away.
   */
  const officeInbox = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    const who = boardAgent(req, res, url, 'the in-tray');
    if (!who) return;
    const { floor, agent } = who;
    try {
      if (req.method === 'GET') {
        const name = url.searchParams.get('read');
        if (name === null) return send(res, 200, { dir: floor.inbox.dir, items: floor.inbox.list() });
        return send(res, 200, await floor.inbox.read(name));
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST' });
      let body: { action?: unknown; name?: unknown };
      try {
        body = JSON.parse(await readBody(req, 16 * 1024));
      } catch {
        return send(res, 400, { error: 'Send JSON: {"action": "archive", "name": "…"}' });
      }
      if (body?.action !== 'archive') return send(res, 400, { error: 'The action is archive' });
      const name = str(body?.name, 256);
      const where = floor.inbox.archive(name);
      toastFloor(floor, `📥 The ${agent.name} put ${name} away`);
      return send(res, 200, { ok: true, path: where });
    } catch (error) {
      if (error instanceof InboxError) return send(res, error.status, { error: error.message });
      throw error;
    }
  };
  /**
   * The in-tray door: POST /api/inbox from outside the office, with the token an admin made as the
   * bearer token (or ?token=). A JSON body {"title", "text", "from"} or a text body becomes a note;
   * anything else is saved as a file named by its X-Filename header (or ?name=). ?floor= says which
   * floor's tray; it can be left out while the building has one floor.
   */
  const inboxDoor = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    const ip = clientIp(req, cfg.trustProxy);
    if (!door.allow(ip)) return send(res, 429, { error: 'Too many requests. Try again in a minute.' });
    if (!door.open) return send(res, 403, { error: 'The in-tray door is closed: an admin can open it from the In-tray window in the office.' });
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
    if (!door.check(token)) return send(res, door.allowBadToken(ip) ? 401 : 429, { error: 'That token does not open the in-tray door.' });
    const wanted = url.searchParams.get('floor');
    const floor = wanted ? floors.get(wanted) : floors.size === 1 ? floors.values().next().value : undefined;
    if (!floor) return send(res, 400, { error: wanted ? `No floor called ${wanted}` : `Say which floor's tray with ?floor=<id>: one of ${[...floors.keys()].join(', ')}` });
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const title = str(url.searchParams.get('title'), 200);
    const from = str(url.searchParams.get('from'), 200);
    try {
      let name: string;
      if (type === 'application/json') {
        const body = JSON.parse((await readBytes(req, INBOX_NOTE_MAX + 4096)).toString('utf8') || '{}') as Record<string, unknown> | null;
        name = floor.inbox.note(str(body?.title, 200) || title, str(body?.text ?? body?.body ?? body?.note, INBOX_NOTE_MAX + 1), str(body?.from, 200) || from || undefined);
      } else if (!type || type.startsWith('text/')) {
        name = floor.inbox.note(title, (await readBytes(req, INBOX_NOTE_MAX + 4096)).toString('utf8'), from || undefined);
      } else {
        const given = str(req.headers['x-filename'], 300) || str(url.searchParams.get('name'), 300);
        if (!given) return send(res, 400, { error: 'Name the file: an X-Filename header, or ?name=' });
        name = floor.inbox.file(given, await readBytes(req, INBOX_FILE_MAX));
      }
      toastFloor(floor, `📥 Something came in through the in-tray door: ${name}`);
      return send(res, 201, { ok: true, floor: floor.id, name });
    } catch (error) {
      if (error instanceof InboxError) return send(res, error.status, { error: error.message });
      if (error instanceof SyntaxError) return send(res, 400, { error: 'That JSON could not be read' });
      throw error;
    }
  };
  // Workers' terminals outlive a restart of the office (see ptys.ts) with this address in their
  // environment, so listen where the last office did when that port is free.
  const hookPortPath = path.join(cfg.dataDir, 'hook-port');
  const listenHooks = (port: number) =>
    new Promise<void>((resolve, reject) => {
      hookServer.once('error', reject);
      hookServer.listen(port, '127.0.0.1', () => {
        hookServer.off('error', reject);
        resolve();
      });
    });
  let lastHookPort = 0;
  try {
    lastHookPort = Number(readFileSync(hookPortPath, 'utf8')) || 0;
  } catch {
    // first start
  }
  await listenHooks(lastHookPort).catch(() => listenHooks(0));
  const hookPort = (hookServer.address() as { port: number }).port;
  writeFileSync(hookPortPath, String(hookPort), { mode: 0o600 });

  // Day, night and the weather outside the windows, the same for everyone.
  const sky = new Sky({ city: cfg.city, weather: cfg.weather }, (state) => broadcast({ t: 'sky', state }));
  sky.start();
  // Halloween or Christmas all over the building, the same for everyone (⚙️ Settings). On 'auto' it
  // goes by the calendar at the office, the sky's clock.
  const themes = new Themes(cfg.dataDir, () => sky.state.utcOffset, (state) => broadcast({ t: 'theme', state }));
  themes.start();

  // What the workers spend, all time and today, with the optional daily budget.
  const ledger = new Ledger(
    cfg.dataDir,
    { budget: cfg.budget, pauseHiring: cfg.budgetPause },
    (state) => broadcast({ t: 'usage', state }),
    toastAll,
  );
  const modelUsage = new ModelUsageLedger(cfg.dataDir);
  // Pay-as-you-go balances for the sidebar's API balances panel; keys stay on this side.
  const apiBalances = new ApiBalances(cfg.dataDir);

  // The Claude plan's 5-hour and weekly limits, for the meter under the workers: one account for
  // every floor.
  const limits = new PlanLimitsReader(
    configuredProvider(cfg.agentCmd) === 'claude' ? resolveCommand(cfg.agentCmd) : resolveCommand('claude'),
    childEnv(),
    () => clients.size > 0,
    (state) => broadcast({ t: 'limits', state }),
  );

  // The office phone: an agent finishing on one floor rings it on all the others.
  const phone = new PhoneLine();

  // Slack / Discord pings for workers that need input or finish (set from ⚙️ Settings or --webhook).
  webhook = new Webhook(cfg.dataDir, (workerId) => (workerId && workerFloor(workerId)?.def.name) || officeName, (state) => broadcast({ t: 'notify', state }));
  if (cfg.webhook !== undefined) {
    const err = webhook.set(cfg.webhook, 'the command line');
    if (err) console.error(`agent-office: --webhook: ${err}`);
  }

  // The machine's CPU and memory, for the monitor on the wall and a warning before hiring, and the
  // most workers the office runs at once, across every floor (--max-workers, or ⚙️ Settings).
  const machine = new Machine(
    cfg.dataDir,
    cfg.maxWorkers,
    () => {
      let n = 0;
      for (const f of floors.values()) n += f.workers.list().length;
      return n;
    },
    (state) => broadcast({ t: 'machine', state }),
  );
  machine.start();
  /** Queues everywhere may be waiting for room under the worker limit: let them look again. */
  const pumpQueues = (except?: Floor) => {
    if (machine.limit === undefined) return;
    // Not right now: whoever freed the seat (a queue making room for its next task) takes it first.
    setImmediate(() => {
      for (const f of floors.values()) if (f !== except) f.queue.pump();
    });
  };

  const floorContext: FloorContext = {
    agentCmd: cfg.agentCmd,
    agentArgs: cfg.agentArgs,
    hook: { url: `http://127.0.0.1:${hookPort}`, token: '' },
    ledger,
    capacity: machine,
    emit: toFloor,
    toast: toastFloor,
    termData: (workerId, data, viewers, side) => {
      const json = JSON.stringify({ t: side ? 'side.data' : 'term.data', workerId, data } satisfies ServerMsg);
      const key = side ? sideKey(workerId) : workerId;
      for (const id of viewers) {
        const c = clients.get(id);
        if (!c || c.ws.readyState !== WebSocket.OPEN) continue;
        // A viewer on a slow link skips output and gets a fresh snapshot once it catches up,
        // instead of queueing unbounded data in server memory.
        if (c.stale.has(key) || c.ws.bufferedAmount > SLOW_CLIENT_BYTES) c.stale.add(key);
        else c.ws.send(json);
      }
    },
    changes: (state, ids) => {
      for (const id of ids) {
        const c = clients.get(id);
        if (c) sendTo(c, { t: 'changes', state });
      }
    },
    workerChanged: (floor, w) => {
      if (typeof w === 'string') {
        webhook.onWorkerGone(w);
        phone.onWorkerGone(w);
        pumpQueues(floor);
      } else {
        modelUsage.record(floor.def.name, w, floor.project.defaultProvider);
        webhook.onWorker(w);
        if (phone.onWorker(w)) {
          const msg: ServerMsg = { t: 'phone', floor: floor.id, name: floor.def.name, worker: w.name, task: w.task?.name };
          for (const c of clients.values()) if (c.peer.floor !== floor.id) sendTo(c, msg);
        }
      }
      machine.workersChanged();
      floorsChanged();
    },
    people: (floor) => {
      let n = 0;
      for (const c of clients.values()) if (c.peer.floor === floor.id) n++;
      return n;
    },
    peers: (floor) => [...clients.values()].filter((c) => c.peer.floor === floor.id).map((c) => c.peer),
    inboxDoor: () => door.open,
  };
  const openFloor = (def: FloorDef): Floor | undefined => {
    if (!existsSync(def.dir)) {
      console.error(`agent-office: the ${def.name} floor's checkout is gone (${def.dir}) — it stays closed until it's back`);
      return undefined;
    }
    try {
      const floor = new Floor(def, floorContext);
      floors.set(def.id, floor);
      return floor;
    } catch (err) {
      console.error(`agent-office: couldn't open the ${def.name} floor: ${(err as Error).message}`);
      return undefined;
    }
  };
  // Started in a project: it's a floor too (the one it has always been).
  if (cfg.project) building.ensureLocal(cfg.project, 'the office');
  for (const def of building.list()) openFloor(def);
  // Workers still running from the last office are back at their desks before anyone walks in.
  await Promise.all([...floors.values()].map((f) => f.ready));

  const team = new Team(cfg.publicHost, cfg.port);

  // Web servers the workers start, for the Services board and service tunnels (see relay.ts).
  // One scan covers every floor; each floor's board lists its own workers' servers.
  const servicesState = (floor: Floor | undefined, items = services.list()): ServicesState => ({
    items: floor ? items.filter((s) => floor.workers.get(s.workerId)) : [],
    port: cfg.port,
    ssh: team.ssh,
  });
  const services = new Services(
    () => [...floors.values()].flatMap((f) => f.workers.owners()),
    (items) => {
      for (const c of clients.values()) sendTo(c, { t: 'services', state: servicesState(floorOf(c), items) });
    },
  );

  /** Who has a floor's whiteboard open. */
  const drawing = (floor: Floor): string[] => [...clients.values()].filter((c) => c.whiteboard && c.peer.floor === floor.id).map((c) => c.id);
  const drawingChanged = (floor: Floor | undefined) => {
    if (floor) toFloor(floor, { t: 'wb.people', people: drawing(floor) });
  };

  /** Who's playing the arcade cabinet on a floor. */
  const cabinetPlayer = (floor: Floor): Client | undefined => [...clients.values()].find((c) => c.playing && c.peer.floor === floor.id);
  const cabinetState = (floor: Floor | undefined): CabinetState => {
    const p = floor && cabinetPlayer(floor);
    return { player: p ? { id: p.id, name: p.peer.name, game: p.game ?? '' } : null, scores: highScores.top() };
  };
  const cabinetChanged = (floor: Floor | undefined) => {
    if (floor) toFloor(floor, { t: 'cabinet', state: cabinetState(floor) });
  };
  /** `c` stepped away from the cabinet (or left the floor, or the office): their game waits, with its score so far on the table. */
  const stopPlaying = (c: Client, floor = floorOf(c)) => {
    if (!c.playing) return;
    if (floor) arcade.leave(c.game, floor.id);
    c.playing = false;
    c.game = undefined;
    c.frame = undefined;
    cabinetChanged(floor);
  };

  /** Everything on a floor, for whoever just arrived there. */
  const floorView = (floor: Floor | undefined): FloorView => ({
    floor: floor?.id ?? null,
    project: floor?.project ?? null,
    workers: floor?.workers.list() ?? [],
    issues: floor?.github.issues ?? { items: [], fetchedAt: 0, loading: false },
    pulls: floor?.github.pulls ?? { items: [], fetchedAt: 0, loading: false },
    queue: floor?.queue.state() ?? { tasks: [], maxWorkers: 0 },
    decor: floor?.decor.list() ?? [],
    services: servicesState(floor),
    dog: floor?.dog.view() ?? null,
    jukebox: floor?.jukebox.state() ?? { on: false, track: JUKEBOX_TUNES[0].id, startedAt: Date.now(), elapsed: 0 },
    whiteboard: { elements: floor?.whiteboard.scene() ?? [], people: floor ? drawing(floor) : [] },
    meeting: floor?.meetings.state() ?? { current: null, past: [] },
    cabinet: { ...cabinetState(floor), frame: (floor && cabinetPlayer(floor)?.frame) ?? null },
    plans: floor?.plans.state() ?? { revision: 0, items: [] },
    inbox: floor?.inbox.state() ?? { revision: 0, items: [], dir: '', door: door.open },
  });
  /** The rooftop bar: nobody works up there, so it has none of a floor's things. */
  const roofView = (): FloorView => ({ ...floorView(undefined), floor: ROOF });
  const screensOf = (c: Client, floor: Floor | undefined) => {
    for (const { workerId, frame } of floor?.workers.fullScreens() ?? []) sendTo(c, { t: 'screen', workerId, ...frame, full: true });
  };
  /** Where someone arriving goes: the floor they asked for, else the first one there is. */
  const arrivalFloor = (wanted: string | null): Floor | undefined => (wanted && floors.get(wanted)) || floors.values().next().value;

  const images = new ImageProxy();

  const upgrader = new Upgrader(
    (state) => broadcast({ t: 'upgrade', state }),
    () => {
      // cli.ts shuts down gracefully; systemd (Restart=always) then starts the new version, which
      // wakes every worker.
      process.kill(process.pid, 'SIGTERM');
    },
  );

  // --- HTTP ------------------------------------------------------------------------------------
  const serveFile = (res: http.ServerResponse, file: string, cache: boolean) => {
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': cache ? 'public, max-age=31536000, immutable' : 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });
    createReadStream(file).pipe(res);
  };

  /** A file of the client bundle, or undefined when it's missing, a folder, or outside the bundle. */
  const publicFile = (p: string): string | undefined => {
    const file = path.join(publicDir, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    return file.startsWith(publicDir + path.sep) && existsSync(file) && statSync(file).isFile() ? file : undefined;
  };

  /**
   * A password, claim-token or invite guess: counts it against the IP, then reads the small JSON
   * body. Undefined once it has already answered (rate limited, or a bad body).
   */
  const readGuess = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<{ ip: string; body: Record<string, unknown> } | undefined> => {
    const ip = clientIp(req, cfg.trustProxy);
    // Counted before the body is read, so parallel guesses can't all slip under the limit.
    if (!auth.allowAttempt(ip)) return void send(res, 429, { error: TOO_MANY_ATTEMPTS });
    try {
      const body = JSON.parse(await readBody(req, 4096));
      if (body && typeof body === 'object') return { ip, body };
    } catch {
      // answered below
    }
    send(res, 400, { error: 'Bad request' });
  };
  const signedIn = (req: http.IncomingMessage, accountId?: string) => ({ 'set-cookie': auth.cookie(req, auth.issue(accountId), isSecure(req, cfg)) });

  /** With a name, that person's own account; without one, the shared office password (while it's on). */
  const login = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const guess = await readGuess(req, res);
    if (!guess) return;
    const name = str(guess.body.name, 64).trim();
    const password = str(guess.body.password, 512);
    if (name) {
      const account = await accounts.check(name, password);
      if (!account) return send(res, 401, { error: 'Wrong name or password' });
      auth.recordSuccess(guess.ip);
      return send(res, 200, { ok: true }, signedIn(req, account.id));
    }
    if (!accounts.sharedPassword) return send(res, 401, { error: 'Sign in with your name and your own password' });
    if (!(await auth.checkPassword(password))) {
      return send(res, 401, { error: accounts.any ? 'Wrong password. With an account of your own, type your name too.' : 'Wrong password' });
    }
    auth.recordSuccess(guess.ip);
    return send(res, 200, { ok: true }, signedIn(req));
  };
  /** Which fields the sign-in forms ask for. */
  const loginOptions = () => ({ accounts: accounts.any, shared: accounts.sharedPassword });

  /**
   * An invite link: `peek` says who it's for; otherwise it makes the account and signs it in.
   * Counted like a password guess, since the token is one.
   */
  const join = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const guess = await readGuess(req, res);
    if (!guess) return;
    const token = str(guess.body.token, 128);
    const invite = accounts.findInvite(token);
    if (!invite) return send(res, 410, { error: 'This invite link has expired or was already used. Ask whoever sent it for a new one.' });
    auth.recordSuccess(guess.ip);
    if (guess.body.peek === true) return send(res, 200, { name: invite.name, role: invite.role, by: invite.createdBy, project: officeName });
    const r = await accounts.join(token, str(guess.body.name, 64), str(guess.body.password, 1024));
    if (typeof r === 'string') return send(res, 400, { error: r });
    console.log(`  ${r.name} joined the office with an invite from ${r.createdBy}`);
    accountsChanged();
    return send(res, 200, { ok: true, name: r.name }, signedIn(req, r.id));
  };

  /** The 🔎 search: chat lines, and lines of the terminals of every worker on that floor, with the words in them. */
  const search = (q: string, floor: Floor | undefined): SearchResults => {
    q = q.slice(0, SEARCH_MAX);
    const needle = searchKey(q);
    if (needle.length < SEARCH_MIN) return { q, chat: [], terminals: [], more: false };
    const said = chat.search(needle, SEARCH_CHAT_HITS);
    const shown = floor?.workers.search(needle, SEARCH_TERMINAL_HITS) ?? { hits: [], more: false };
    return { q, chat: said.hits, terminals: shown.hits, more: said.more || shown.more };
  };

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      // A service tunnel (localhost:5173 -> the office): relay to that worker's server.
      const tunneled = tunneledPort(req, cfg.port);
      const svc = tunneled ? services.lookup(tunneled) : undefined;
      if (tunneled && svc) {
        if (req.method === 'POST' && req.url === RELAY_LOGIN) return await login(req, res);
        if (!auth.fromAnyCookie(req)) return signInPage(res, tunneled, loginOptions());
        if (svc === 'gone') return stoppedPage(res, tunneled);
        return relayRequest(req, res, svc);
      }
      let url: URL;
      let p: string;
      try {
        url = new URL(req.url ?? '/', 'http://x');
        p = decodeURIComponent(url.pathname);
      } catch {
        return send(res, 400, { error: 'Bad request' });
      }
      if (p === '/api/login' && req.method === 'POST') return await login(req, res);
      if (p === '/api/login' && req.method === 'GET') return send(res, 200, loginOptions());
      if (p === '/api/join' && req.method === 'POST') return await join(req, res);
      // One-time reveal of the generated password. After this the plaintext is gone for good.
      const claimable = !!cfg.claimToken && !cfg.claimed && !!cfg.password;
      if (p === '/api/claim' && req.method === 'GET') return send(res, 200, { claimable });
      if (p === '/api/claim' && req.method === 'POST') {
        const guess = await readGuess(req, res);
        if (!guess) return;
        if (!claimable) return send(res, 410, { error: 'This office has already been claimed. Sign in with the password you saved.' });
        if (!auth.checkToken(str(guess.body.token, 256), cfg.claimToken!)) return send(res, 403, { error: 'That claim link is not valid.' });
        const password = cfg.password!;
        cfg.markClaimed();
        auth.recordSuccess(guess.ip);
        console.log('  the office password was claimed — it will not be shown again');
        return send(res, 200, { password }, signedIn(req));
      }
      if (p === '/api/logout' && req.method === 'POST') {
        return send(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie(req) });
      }
      if (p === '/api/health') return send(res, 200, { ok: true });

      if (p.startsWith('/assets/')) {
        const file = publicFile(p);
        if (file) return serveFile(res, file, true);
        res.writeHead(404).end();
        return;
      }
      if (p === '/login' || p === '/login.html') return serveFile(res, path.join(publicDir, 'login.html'), false);
      if (p === '/claim' || p === '/claim.html') return serveFile(res, path.join(publicDir, 'claim.html'), false);
      if (p === '/join' || p === '/join.html') return serveFile(res, path.join(publicDir, 'join.html'), false);
      if (p === '/favicon.svg') return serveFile(res, path.join(publicDir, 'favicon.svg'), false);
      // The in-tray door lets things in from outside with its own token, not a signed-in session.
      if (p === '/api/inbox' && req.method === 'POST') return await inboxDoor(req, res, url);

      const session = auth.fromRequest(req);
      if (!session) {
        if (p.startsWith('/api/')) return send(res, 401, { error: 'Not logged in' });
        res.writeHead(302, { location: '/login' }).end();
        return;
      }
      if (p === '/api/whoami') return send(res, 200, { ok: true, me: meOf(session.account?.id) });
      const logoMatch = /^\/api\/floors\/([^/]+)\/logo$/.exec(p);
      if (logoMatch && req.method === 'GET') {
        const logo = floors.get(logoMatch[1])?.logo;
        if (!logo) return send(res, 404, { error: 'No project logo' });
        res.writeHead(200, {
          'content-type': logo.type,
          'content-length': logo.bytes.length,
          'cache-control': 'private, max-age=3600',
          'x-content-type-options': 'nosniff',
          // An SVG is an image here, never an executable page if opened directly.
          'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
        });
        res.end(logo.bytes);
        return;
      }
      if (p === '/api/ledger' && req.method === 'GET') {
        return send(res, 200, ledgerFacts(ledger.state(), floors.values()));
      }
      if (p === '/api/model-usage' && req.method === 'GET') {
        const waiting = [];
        for (const floor of floors.values()) {
          for (const w of floor.workers.list()) {
            if (w.kind !== 'agent') continue;
            modelUsage.record(floor.def.name, w, floor.project.defaultProvider);
            if (!w.usage) waiting.push({ provider: w.provider ?? floor.project.defaultProvider, floor: floor.def.name, worker: w.name });
          }
        }
        return send(res, 200, { records: modelUsage.list(), waiting, saveError: modelUsage.saveError });
      }
      if (p === '/api/balances') {
        const admin = meOf(session.account?.id).admin;
        if (req.method === 'GET') return send(res, 200, await apiBalances.read(url.searchParams.get('refresh') === '1', admin));
        if (req.method === 'POST') {
          if (!sameOrigin(req, cfg)) return send(res, 403, { error: 'Forbidden' });
          if (!admin) return send(res, 403, { error: 'Only an admin can change API balance settings' });
          let input: BalanceUpdate;
          try {
            const parsed: unknown = JSON.parse((await readBody(req, 16 * 1024)) || '{}');
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
            input = parsed as BalanceUpdate;
          } catch {
            return send(res, 400, { error: 'Bad request' });
          }
          try { return send(res, 200, await apiBalances.update(input, true)); }
          catch (err) { return send(res, 400, { error: (err as Error).message }); }
        }
        return send(res, 405, { error: 'Method not allowed' });
      }
      if (p === '/api/folders' && req.method === 'GET') {
        try {
          const dir = url.searchParams.get('dir') || (cfg.project ? path.dirname(cfg.project) : cfg.dir);
          return send(res, 200, await listLocalFolders(dir));
        } catch (err) {
          return send(res, 400, { error: (err as Error).message });
        }
      }
      if (p === '/api/plans') {
        const floor = floors.get(url.searchParams.get('floor') ?? '');
        if (!floor) return send(res, 404, { error: 'No such floor' });
        res.setHeader('cache-control', 'no-store');
        try {
          if (req.method === 'GET') return send(res, 200, floor.plans.read());
          if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST' });
          if (!sameOrigin(req, cfg)) return send(res, 403, { error: 'Forbidden' });
          let body: unknown;
          try { body = JSON.parse(await readBody(req, 128 * 1024)); }
          catch { return send(res, 400, { error: 'The plan could not be read. Keep it under 10,000 characters.' }); }
          return send(res, 200, floor.plans.change(body));
        } catch (error) {
          if (error instanceof PlansError) return send(res, error.status, { error: error.message });
          throw error;
        }
      }
      if (p === '/api/inbox/door') {
        // The in-tray door's state; admins open it (a new token, shown once) and close it.
        const admin = meOf(session.account?.id).admin;
        if (req.method === 'GET') return send(res, 200, { ...door.info(), admin, floors: [...floors.values()].map((f) => ({ id: f.id, name: f.project.name })) });
        if (req.method !== 'POST' && req.method !== 'DELETE') return send(res, 405, { error: 'GET, POST or DELETE' });
        if (!sameOrigin(req, cfg)) return send(res, 403, { error: 'Forbidden' });
        if (!admin) return send(res, 403, { error: 'Only an admin can open or close the in-tray door' });
        const who = session.account?.name ?? 'an admin';
        const token = req.method === 'POST' ? door.generate(who) : undefined;
        if (!token) door.close();
        for (const f of floors.values()) toFloor(f, { t: 'inbox', state: f.inbox.state() });
        console.log(`  ${who} ${token ? 'opened' : 'closed'} the in-tray door`);
        return send(res, 200, { ...door.info(), ...(token ? { token } : {}) });
      }
      if (p === '/api/inbox/file' && req.method === 'GET') {
        // A tray item in the browser: a note to read, a picture, a PDF, a voice memo to play.
        const floor = floors.get(url.searchParams.get('floor') ?? '');
        if (!floor) return send(res, 404, { error: 'No such floor' });
        const name = url.searchParams.get('name') ?? '';
        if (!plainName(name)) return send(res, 400, { error: 'Bad request' });
        const file = floor.inbox.pathOf(name, url.searchParams.get('archived') === '1');
        let size: number;
        try {
          size = statSync(file).size;
        } catch {
          return send(res, 404, { error: 'That is not in the tray (any more)' });
        }
        if (size > INBOX_SERVE_MAX) return send(res, 413, { error: 'Too big to open here: open it from the tray folder' });
        const { type, inline } = fileType(name);
        res.writeHead(200, {
          'content-type': type,
          'content-length': String(size),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          'cross-origin-resource-policy': 'same-origin',
          'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
        });
        createReadStream(file).pipe(res);
        return;
      }
      if (p === '/api/workspace/repositories'  && req.method === 'GET') {
        const floor = floors.get(url.searchParams.get('floor') ?? '');
        if (!floor) return send(res, 404, { error: 'No such floor' });
        try { return send(res, 200, await workspaceRepositories(floor.dir)); }
        catch (err) { return send(res, 400, { error: (err as Error).message }); }
      }
      if (p.startsWith('/api/git/')) {
        // The Git board, the PR board's other side (git-board.ts).
        const floor = floors.get(url.searchParams.get('floor') ?? '');
        if (!floor) return send(res, 404, { error: 'No such floor' });
        let input: Record<string, unknown> = {};
        if (req.method === 'POST') {
          if (!sameOrigin(req, cfg)) return send(res, 403, { error: 'Forbidden' });
          try {
            const raw = await readBody(req, 128 * 1024);
            const parsed: unknown = raw ? JSON.parse(raw) : {};
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
          } catch {
            return send(res, 400, { error: 'Bad request' });
          }
        }
        const [status, body] = await routeGitBoard(p, req.method ?? 'GET', url.searchParams, floor.dir, input, [...floors.values()].map((f) => ({ name: f.def.name, dir: f.dir })));
        return send(res, status, body);
      }
      if (p === '/api/floors/local' && req.method === 'POST') {
        if (!sameOrigin(req, cfg)) return send(res, 403, { error: 'Forbidden' });
        let body: { dir?: unknown } | null;
        try { body = JSON.parse(await readBody(req, 16 * 1024)); }
        catch { return send(res, 400, { error: 'Enter a full folder path' }); }
        const who = session.account?.name ?? 'the office';
        const def = building.addLocal(body?.dir, who);
        if (typeof def === 'string') return send(res, 400, { error: def });
        const existing = floors.get(def.id);
        const floor = existing ?? openFloor(def);
        if (!floor) return send(res, 500, { error: 'The floor could not be opened. Check that the folder is writable and see the office log.' });
        await floor.ready;
        floorsChanged();
        if (!existing) toastAll(`🛗 New floor: ${def.name}, added by ${who}`);
        return send(res, 200, { floor: floor.id });
      }
      if (p === '/api/agents/opencode/models' && req.method === 'GET') {
        try {
          return send(res, 200, { models: await openCodeModels.get() });
        } catch {
          return send(res, 502, { error: 'Could not load OpenCode models' });
        }
      }
      if (p === '/api/image' && req.method === 'GET') {
        // A picture on the wall, fetched by the office so the 3D view can draw it (see decor.ts).
        const r = await images.get(url.searchParams.get('url') ?? '');
        if ('error' in r) return send(res, r.status, { error: r.error });
        res.writeHead(200, {
          'content-type': r.type,
          'content-length': String(r.body.length),
          'cache-control': 'private, max-age=3600',
          'x-content-type-options': 'nosniff',
          // Opened on its own (an SVG, say), it still can't run anything on the office's origin.
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          'cross-origin-resource-policy': 'same-origin',
        });
        res.end(r.body);
        return;
      }
      // Which floor a request is about: its boards and its workers.
      const floor = floors.get(url.searchParams.get('floor') ?? '');
      if (p === '/api/whiteboard/file') {
        // Pictures on the whiteboard. Their ids are hashes of what's in them, so they never change.
        if (!floor) return send(res, 404, { error: 'No such floor' });
        if (req.method === 'GET') {
          const f = floor.whiteboard.file(url.searchParams.get('id') ?? '');
          if (!f) return send(res, 404, { error: 'No such picture' });
          return send(res, 200, f, { 'cache-control': 'private, max-age=31536000, immutable' });
        }
        if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
        if (!sameOrigin(req, cfg)) return send(res, 403, { error: 'Forbidden' });
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req, WB_MAX_FILE_BYTES + 4096));
        } catch (err) {
          if ((err as Error).message === 'too large') return send(res, 413, { error: 'That picture is too big for the whiteboard' });
          return send(res, 400, { error: 'Bad request' });
        }
        const error = floor.whiteboard.addFile(body);
        return error ? send(res, 400, { error }) : send(res, 200, { ok: true });
      }
      if (p === '/api/changes/file') {
        // A changed picture in the Changes window at a desk: before (old) or after (new) the worker's edits.
        if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
        const workerId = str(url.searchParams.get('worker'), 32);
        const file = str(url.searchParams.get('path'), 4096);
        const side = url.searchParams.get('side');
        if (!workerId || !file || (side !== 'old' && side !== 'new')) return send(res, 400, { error: 'Bad request' });
        if (!floor) return send(res, 404, { error: 'No such floor' });
        if (!floor.workers.get(workerId)) return send(res, 404, { error: 'No such worker' });
        const r = await floor.changes.file(workerId, file, side);
        if ('error' in r) return send(res, r.status, { error: r.error });
        res.writeHead(200, {
          'content-type': r.type,
          'content-length': String(r.body.length),
          // The worker may change it again any moment.
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          'cross-origin-resource-policy': 'same-origin',
        });
        res.end(r.body);
        return;
      }
      if (p === '/api/search' && req.method === 'GET') return send(res, 200, search(url.searchParams.get('q') ?? '', floor));
      if (p.startsWith('/api/gh/') && req.method === 'GET') {
        // What the issue and PR windows show beyond the board cards (see github.ts).
        const n = Number(url.searchParams.get('number'));
        if (!Number.isSafeInteger(n) || n <= 0) return send(res, 400, { error: 'Bad number' });
        if (!floor) return send(res, 404, { error: 'No such floor' });
        // On a floor that's a folder of checkouts, which repository it's in.
        const repo = normalizeRepo(url.searchParams.get('repo') ?? undefined);
        const github = floor.github;
        try {
          if (p === '/api/gh/pull') return send(res, 200, await github.pullDetail(n, repo));
          if (p === '/api/gh/issue') return send(res, 200, await github.issueDetail(n, repo));
          if (p === '/api/gh/pull/diff') {
            const diff = await github.pullDiff(n, repo);
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
            res.end(diff);
            return;
          }
        } catch (err) {
          return send(res, 502, { error: (err as Error).message });
        }
        return send(res, 404, { error: 'Not found' });
      }
      if (p === '/' || p === '/index.html') return serveFile(res, path.join(publicDir, 'index.html'), false);
      const file = publicFile(p);
      if (file) return serveFile(res, file, false);
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    }
  };

  const server = cfg.tls ? https.createServer({ cert: cfg.tls.cert, key: cfg.tls.key }, handler) : http.createServer(handler);

  // --- WebSocket -------------------------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const tunneled = tunneledPort(req, cfg.port);
    const svc = tunneled ? services.lookup(tunneled) : undefined;
    if (tunneled && svc) {
      if (svc !== 'gone' && auth.fromAnyCookie(req)) return relayUpgrade(req, socket, head, svc);
      return refuseUpgrade(socket);
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://x');
    } catch {
      socket.destroy();
      return;
    }
    const session = url.pathname === '/ws' && sameOrigin(req, cfg) ? auth.fromRequest(req) : undefined;
    if (!session) return refuseUpgrade(socket);
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, url, session));
  });

  /** Who a connection is: its account's current name and role, or an admin guest on the shared password. */
  const meOf = (accountId: string | undefined): Me => {
    const a = accounts.get(accountId);
    return a ? { account: { name: a.name, role: a.role }, admin: a.role === 'admin' } : { admin: !accountId };
  };
  /** Still signed in: the account wasn't revoked, and the shared password wasn't switched off. */
  const stillIn = (c: Client) => (c.accountId ? !!accounts.get(c.accountId) : accounts.sharedPassword);
  const signOut = (c: Client) => {
    c.out = true;
    c.ws.close(SIGNED_OUT, 'Signed out');
  };
  const onlineAccounts = () => new Set([...clients.values()].map((c) => c.accountId).filter((id): id is string => !!id));
  /** Tells each admin what the accounts are now, and everyone whether they're (still) an admin. */
  const accountsChanged = () => {
    let state: ReturnType<Accounts['state']> | undefined;
    for (const c of clients.values()) {
      if (c.out) continue;
      if (!stillIn(c)) {
        signOut(c);
        continue;
      }
      const me = meOf(c.accountId);
      if (me.admin !== c.admin) {
        c.admin = me.admin;
        sendTo(c, { t: 'me', me });
      }
      if (me.admin) sendTo(c, { t: 'accounts', state: (state ??= accounts.state(onlineAccounts())) });
    }
  };

  const onConnection = (ws: WebSocket, url: URL, session: Session) => {
    const id = randomBytes(5).toString('hex');
    // Back where they were before a reload or a restart, else the first floor. Everyone arrives by elevator.
    const wanted = url.searchParams.get('floor');
    // Up on the roof, as long as there's a building under it.
    const onRoof = wanted === ROOF && floors.size > 0;
    const floor = onRoof ? undefined : arrivalFloor(wanted);
    const spot = elevatorSpot();
    const account = session.account;
    // An account's name is its own; on the shared password people pick one.
    const name = account?.name ?? (str(url.searchParams.get('name'), 24).trim() || `Guest ${id.slice(0, 3)}`);
    const colorParam = url.searchParams.get('color') ?? '';
    const intParam = (k: string) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : undefined);
    const me = meOf(account?.id);
    const client: Client = {
      id,
      ws,
      accountId: account?.id,
      admin: me.admin,
      attached: new Set(),
      stale: new Set(),
      lastMoveAt: 0,
      lastActAt: 0,
      lastGongAt: 0,
      lastHornAt: 0,
      // A little more lenient than the page's own, so emotes it let through aren't dropped for arriving bunched up.
      emotes: new EmoteBucket(EMOTE_EVERY * 0.8),
      whiteboard: false,
      lastWbPointerAt: 0,
      playing: false,
      lastFrameAt: 0,
      typingAt: new Map(),
      isAlive: true,
      peer: {
        id,
        name,
        color: COLOR_RE.test(colorParam) ? colorParam : '#4f86f7',
        look: sanitizeLook({ skin: intParam('skin'), hair: intParam('hair'), style: intParam('style') }, lookFromSeed(id)),
        x: spot.x,
        y: 0,
        z: spot.z,
        // Facing out through the doors.
        rotY: 0,
        moving: false,
        voice: false,
        muted: true,
        sharing: false,
        ...(account ? { account: true } : {}),
        ...(onRoof ? { floor: ROOF } : floor ? { floor: floor.id } : {}),
      },
    };
    clients.set(id, client);
    if (account) accounts.seen(account.id);
    ws.on('pong', () => (client.isAlive = true));

    sendTo(client, {
      t: 'welcome',
      you: id,
      peers: [...clients.values()].map((c) => c.peer),
      floors: floorInfos(),
      projectsDir: building.projectsDirState(),
      ice: cfg.iceServers,
      chat: chat.recent(50),
      invites: team.available,
      version: upgrader.version,
      upgrade: upgrader.state,
      usage: ledger.state(),
      limits: limits.state,
      me,
      notify: webhook.state(),
      machine: machine.state(),
      sky: sky.state,
      theme: themes.state(),
      ...(onRoof ? roofView() : floorView(floor)),
    });
    screensOf(client, floor);
    broadcast({ t: 'peer.join', peer: client.peer }, id);
    if (account) accountsChanged(); // now online
    floorsChanged();
    if (floor) {
      floor.arrived();
      // Anyone whose process ended since (exited, or failed to resume) gets up as you walk in.
      floor.workers.wakeAll();
    }
    limits.refresh();

    ws.on('message', (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || client.out) return;
      handleMessage(client, msg);
    });
    ws.on('close', () => {
      clients.delete(id);
      if (client.whiteboard) drawingChanged(floorOf(client));
      stopPlaying(client);
      for (const f of floors.values()) {
        f.workers.detachAll(id);
        f.changes.unwatchAll(id);
        f.workspaceChanges.unwatchAll(id);
      }
      broadcast({ t: 'peer.leave', id });
      if (account) accountsChanged();
      floorsChanged();
    });
    ws.on('error', () => ws.terminate());
  };

  const decorChanged = (floor: Floor) => toFloor(floor, { t: 'decor', items: floor.decor.list() });
  const jukeboxChanged = (floor: Floor) => toFloor(floor, { t: 'jukebox', state: floor.jukebox.state() });
  const teamChanged = async () => broadcast({ t: 'team', state: await team.state() });

  /** To everyone else on the same floor as `c`: nobody on another floor can see them. */
  const toNeighbors = (c: Client, msg: ServerMsg, droppable = false) => {
    if (!c.peer.floor) return;
    const json = JSON.stringify(msg);
    for (const o of clients.values()) {
      if (o.id === c.id || o.peer.floor !== c.peer.floor || o.ws.readyState !== WebSocket.OPEN) continue;
      if (droppable && o.ws.bufferedAmount > 4 * 1024 * 1024) continue;
      o.ws.send(json);
    }
  };

  /**
   * Takes `c` to another floor: everyone sees them leave and arrive, and they get the new floor's
   * everything. They arrive in the elevator, or `at` the spot they came by.
   */
  const goToFloor = (c: Client, floor: Floor, at?: { x: number; y: number; z: number; rotY: number }) => {
    if (c.peer.floor === floor.id) return;
    const left = leave(c, at);
    Object.assign(c.peer, { floor: floor.id });
    sendTo(c, { t: 'floor.enter', peers: [...clients.values()].map((o) => o.peer), ...floorView(floor) });
    screensOf(c, floor);
    arrived(c, left);
    floor.arrived();
    floor.workers.wakeAll();
    floorsChanged();
  };

  /** Up to the rooftop bar, by elevator. */
  const goToRoof = (c: Client) => {
    if (c.peer.floor === ROOF) return;
    const left = leave(c);
    c.peer.floor = ROOF;
    sendTo(c, { t: 'floor.enter', peers: [...clients.values()].map((o) => o.peer), ...roofView() });
    arrived(c, left);
    floorsChanged();
  };

  /** Off the floor (or the roof) `c` was on, to `at` on the next one, or into its elevator car. */
  const leave = (c: Client, at?: { x: number; y: number; z: number; rotY: number }) => {
    const was = floorOf(c);
    if (was) {
      was.workers.detachAll(c.id);
      was.changes.unwatchAll(c.id);
      was.workspaceChanges.unwatchAll(c.id);
    }
    c.attached.clear();
    c.typingAt.clear();
    c.stale.clear();
    // The whiteboard downstairs stays downstairs, and so does the arcade.
    const wasDrawing = c.whiteboard;
    c.whiteboard = false;
    stopPlaying(c, was);
    const spot = at ?? { ...elevatorSpot(), y: 0, rotY: 0 };
    Object.assign(c.peer, { x: spot.x, y: spot.y, z: spot.z, rotY: spot.rotY, moving: false });
    delete c.peer.seat;
    // An issue card belongs to the board it came off, which is on the floor they left; a drink stays at the bar.
    delete c.peer.carrying;
    delete c.peer.drink;
    return { was, wasDrawing };
  };

  const arrived = (c: Client, left: ReturnType<typeof leave>) => {
    broadcast({ t: 'peer.update', peer: c.peer }, c.id);
    if (left.wasDrawing) drawingChanged(left.was);
  };

  /**
   * A worker took on GitHub issue `n` (an issue card dropped on its desk): assign it on GitHub, which
   * moves it to In progress on the board, and take it off the queue so nobody else is seated for it.
   */
  const takeIssue = (c: Client, floor: Floor, n: number) => {
    floor.queue.dropIssue(n);
    void floor.github.claim(n).then((err) => warn(c, err && `Couldn't assign issue #${n} on GitHub: ${err}`));
  };
  /** A worker was handed a 📒 To Do Next item at a desk: it's in progress, by that worker. */
  const takePlan = (floor: Floor, plan: string, w: { id: string; name: string }) => {
    if (floor.plans.start(plan, { id: w.id, name: w.name })) toastFloor(floor, `📒 ${w.name} took a To Do Next item`);
  };

  const handleMessage = (c: Client, msg: ClientMsg) => {
    const who = c.peer.name;
    /** The floor `c` is on, or a note to them that they have to be on one. */
    const here = (): Floor | undefined => {
      const f = floorOf(c);
      if (!f) warn(c, 'Take the elevator to a floor first');
      return f;
    };
    /** A worker by id, with the floor it sits on. */
    const worker = (id: unknown) => {
      const wid = str(id, 32);
      const floor = workerFloor(wid);
      return floor ? { wid, floor, info: floor.workers.get(wid)! } : undefined;
    };
    switch (msg.t) {
      case 'move': {
        const p = c.peer;
        p.x = num(msg.x);
        p.y = num(msg.y);
        p.z = num(msg.z);
        p.rotY = num(msg.rotY);
        p.moving = !!msg.moving;
        toNeighbors(c, { t: 'peer.move', id: c.id, x: p.x, y: p.y, z: p.z, rotY: p.rotY, moving: p.moving }, true);
        break;
      }
      case 'act': {
        if (msg.drink !== undefined) {
          // A drink from the rooftop bar, which stays up there.
          const drink = isDrink(msg.drink) && c.peer.floor === ROOF ? msg.drink : undefined;
          if (drink === c.peer.drink) break;
          if (drink) c.peer.drink = drink;
          else delete c.peer.drink;
          broadcast({ t: 'peer.act', id: c.id, drink: drink ?? null }, c.id, true);
          break;
        }
        if (typeof msg.smoke === 'boolean') {
          if (msg.smoke === !!c.peer.smoking) break;
          c.peer.smoking = msg.smoke;
          broadcast({ t: 'peer.act', id: c.id, smoke: msg.smoke }, c.id, true);
          break;
        }
        const now = Date.now();
        if (now - c.lastActAt < 100) break;
        c.lastActAt = now;
        toNeighbors(c, { t: 'peer.act', id: c.id }, true);
        break;
      }
      case 'emote':
        if (isEmote(msg.emote) && c.emotes.take(Date.now())) toNeighbors(c, { t: 'peer.emote', id: c.id, emote: msg.emote }, true);
        break;
      case 'sit': {
        // Everyone sees them sit down (or get up), and anyone who comes in later finds them sitting.
        // Only on a seat where they are: the roof's up on the roof, the office's on a floor.
        const key = str(msg.seat, 40);
        const seat = seatHere(key, c.peer.floor === ROOF) ? key : undefined;
        if (seat === c.peer.seat) break;
        if (seat) c.peer.seat = seat;
        else delete c.peer.seat;
        broadcast({ t: 'peer.update', peer: c.peer }, c.id);
        break;
      }
      case 'carry': {
        // Everyone on the floor sees the issue card in their hands, and whoever comes in later too.
        const issue = issueNumber(msg.issue);
        if (issue === c.peer.carrying?.issue) break;
        if (issue !== undefined) c.peer.carrying = { issue, title: str(msg.title, 200) };
        else delete c.peer.carrying;
        broadcast({ t: 'peer.update', peer: c.peer }, c.id);
        break;
      }
      case 'profile': {
        const name = str(msg.name, 24).trim();
        if (name && !c.accountId) c.peer.name = name;
        if (COLOR_RE.test(msg.color)) c.peer.color = msg.color;
        c.peer.look = sanitizeLook(msg.look, c.peer.look);
        broadcast({ t: 'peer.update', peer: c.peer });
        break;
      }
      case 'voice':
        c.peer.voice = !!msg.voice;
        c.peer.muted = !!msg.muted;
        c.peer.sharing = !!msg.sharing;
        broadcast({ t: 'peer.update', peer: c.peer });
        break;
      case 'rtc': {
        const target = clients.get(str(msg.to, 32));
        if (target) sendTo(target, { t: 'rtc', from: c.id, data: msg.data });
        break;
      }
      case 'chat': {
        const text = str(msg.text, 500).trim();
        if (!text) break;
        const line: ChatLine = { from: c.id, name: who, color: c.peer.color, text, at: Date.now(), ...(c.accountId ? { account: true } : {}) };
        chat.add(line);
        broadcast({ t: 'chat', ...line });
        break;
      }
      case 'floor.go': {
        if (msg.floor === ROOF) {
          if (floors.size) goToRoof(c);
          else warn(c, 'There is no building to go up on yet');
          break;
        }
        const floor = floors.get(str(msg.floor, 64));
        if (!floor) warn(c, building.pending().some((d) => d.id === msg.floor) ? "That floor is still being cloned — it'll be ready in a moment" : 'No such floor');
        else goToFloor(c, floor, arrivalSpot(msg.at));
        break;
      }
      case 'floor.repos':
        void building.repos(msg.refresh === true).then(
          (repos) => sendTo(c, { t: 'floor.repos', repos }),
          (err: Error) => sendTo(c, { t: 'floor.repos', repos: [], error: `Couldn't list your repositories with gh: ${err.message}` }),
        );
        break;
      case 'floor.add': {
        const repo = str(msg.repo, 200);
        void building
          .add(repo, who, (def) => {
            floorsChanged();
            toastAll(`🛗 ${who} is adding a floor for ${def.repo ?? def.name}…`);
          })
          .then((r) => {
            floorsChanged();
            if (typeof r === 'string') return sendTo(c, { t: 'floor.added', repo, error: r });
            const floor = openFloor(r);
            if (!floor) return sendTo(c, { t: 'floor.added', repo, error: `Cloned ${r.repo}, but couldn't open its floor — see the office's log` });
            console.log(`  ${who} added a floor for ${r.repo} (${r.dir})`);
            toastAll(`🛗 New floor: ${r.name}, added by ${who}`);
            sendTo(c, { t: 'floor.added', repo, floor: floor.id });
          });
        break;
      }
      case 'floor.projectsDir': {
        // It's a folder on the office's machine that `gh` writes into: admins pick it.
        const err = meOf(c.accountId).admin ? building.setProjectsDir(str(msg.dir, 1024), who) : 'Only admins can move the workspace folder';
        warn(c, err);
        if (err) break;
        const state = building.projectsDirState();
        broadcast({ t: 'projectsDir', state });
        toastAll(state.custom ? `📁 ${who} moved the workspace folder to ${state.dir}` : `📁 ${who} put the workspace folder back to ${state.dir}`);
        break;
      }
      case 'dog.pet':
        floorOf(c)?.dog.pet(c.peer);
        break;
      case 'dog.name': {
        const floor = here();
        if (!floor) break;
        const name = floor.dog.rename(str(msg.name, 200));
        toastFloor(floor, `🐶 ${who} named the dog ${name}`);
        break;
      }
      case 'worker.spawn': {
        const floor = here();
        if (!floor) break;
        const kind = msg.kind === 'shell' ? 'shell' : 'agent';
        if (kind === 'agent' && msg.provider !== undefined && (!isAgentProvider(msg.provider) || !floor.project.agentProviders.includes(msg.provider))) {
          warn(c, 'Unknown agent provider');
          break;
        }
        const model = msg.model === undefined ? undefined : str(msg.model, OPEN_CODE_MODEL_MAX + 1);
        const effort = isAgentEffort(msg.effort) ? msg.effort : undefined;
        const r = floor.workers.spawn(str(msg.deskId, 32), who, str(msg.prompt, 20000) || undefined, msg.worktree === true, kind, msg.provider, model, effort, undefined, msg.workspace);
        const issue = kind === 'agent' ? issueNumber(msg.issue) : undefined;
        const plan = kind === 'agent' ? str(msg.plan, 64) || undefined : undefined;
        if (typeof r === 'string') warn(c, r);
        else toastFloor(floor, kind === 'shell' ? `${who} opened a shell at a desk` : `${who} hired ${r.name}${issue ? ` for issue #${issue}` : r.prompt ? ' with a task' : ''}`);
        if (typeof r !== 'string' && issue) takeIssue(c, floor, issue);
        if (typeof r !== 'string' && plan) takePlan(floor, plan, r);
        break;
      }
      case 'worker.workspace.add': {
        const w = worker(msg.workerId);
        if (!w) break;
        const err = w.floor.workers.addRepositories(w.wid, msg.workspace, who);
        if (err) warn(c, err);
        else toastFloor(w.floor, `Added repositories to ${w.info.name}'s workspace`);
        break;
      }
      case 'worker.resume': {
        const w = worker(msg.workerId);
        warn(c, w ? w.floor.workers.resume(w.wid) : 'No such worker');
        break;
      }
      case 'worker.kill': {
        const w = worker(msg.workerId);
        if (!w) break;
        const { floor, info } = w;
        if (info.prOpening) { warn(c, 'Wait for the pull request operation to finish before sending this worker home'); break; }
        // The worker leaves right away; its worktree is dealt with after that, and the outcome follows.
        const done = floor.workers.kill(info.id, CLEANUPS.has(String(msg.cleanup)) ? msg.cleanup : undefined);
        toastFloor(floor, `${who} sent ${info.name} home`);
        void done.then(({ note, error }) => {
          if (note) toastFloor(floor, note);
          if (error) toastFloor(floor, error, 'warn');
        });
        break;
      }
      case 'worker.worktree': {
        const w = worker(msg.workerId);
        if (!w) break;
        void w.floor.workers.inspectWorktree(w.wid).then((state) => {
          if (state) sendTo(c, { t: 'worker.worktree', workerId: w.wid, state });
        });
        break;
      }
      case 'worker.attach': {
        const w = worker(msg.workerId);
        const snap = w?.floor.workers.attach(w.wid, c.id, who);
        if (w && snap) {
          c.attached.add(w.wid);
          sendTo(c, { t: 'term.snapshot', workerId: w.wid, ...snap });
        }
        break;
      }
      case 'worker.detach': {
        const wid = str(msg.workerId, 32);
        c.attached.delete(wid);
        c.typingAt.delete(wid);
        workerFloor(wid)?.workers.detach(wid, c.id);
        break;
      }
      case 'worker.prompt': {
        const w = worker(msg.workerId);
        const err = w ? w.floor.workers.prompt(w.wid, str(msg.prompt, 20000), who) : 'No such worker';
        warn(c, err);
        const issue = w?.info.kind === 'agent' ? issueNumber(msg.issue) : undefined;
        if (w && !err && issue) {
          toastFloor(w.floor, `${who} handed issue #${issue} to ${w.info.name}`);
          takeIssue(c, w.floor, issue);
        }
        const plan = w?.info.kind === 'agent' ? str(msg.plan, 64) || undefined : undefined;
        if (w && !err && plan) takePlan(w.floor, plan, w.info);
        break;
      }
      case 'station.prompt': {
        const floor = here();
        if (!floor) break;
        const r = floor.workers.station(str(msg.deskId, 32), who, str(msg.prompt, 20000));
        if (typeof r === 'string') warn(c, r);
        else if (r.hired) toastFloor(floor, `${who} asked the ${r.info.name} something`);
        break;
      }
      case 'worker.pr': {
        const w = worker(msg.workerId);
        if (!w) break;
        const { floor, wid } = w;
        void floor.workers.openPr(wid, who, typeof msg.repository === 'string' ? msg.repository : undefined).then((r) => {
          if (typeof r === 'string') return warn(c, r);
          const name = floor.workers.get(wid)?.name ?? 'the worker';
          toastFloor(floor, r.existed ? `${name}'s branch already has PR #${r.number}` : `${who} opened PR #${r.number} for ${name}`);
          if (r.dirty) warn(c, `${name} still has uncommitted changes in its worktree — they are not in the PR`);
          if (floor.workers.get(wid)?.workspace) return;
          // Put it on the board now rather than at the next poll. A refresh already in flight
          // returns at once and can miss it, so look again shortly after.
          void floor.github.refresh().then(() => {
            if (!floor.github.pulls.items.some((p) => p.number === r.number)) setTimeout(() => void floor.github.refresh(), 3000);
          });
        });
        break;
      }
      case 'term.input':
        if (c.attached.has(msg.workerId)) workerFloor(msg.workerId)?.workers.write(msg.workerId, str(msg.data, 64 * 1024), who);
        break;
      case 'term.typing': {
        // Everyone else in that terminal sees who's typing. A typist says so about once a second.
        const w = worker(msg.workerId);
        const now = Date.now();
        if (!w || !c.attached.has(w.wid) || now - (c.typingAt.get(w.wid) ?? 0) < TYPING_GAP_MS) break;
        c.typingAt.set(w.wid, now);
        for (const id of w.info.viewerIds) {
          const o = clients.get(id);
          if (o && o.id !== c.id) sendTo(o, { t: 'term.typing', workerId: w.wid, id: c.id });
        }
        break;
      }
      case 'doing': {
        const what = str(msg.what, 60).trim() || undefined;
        if (what === c.peer.doing) break;
        if (what) c.peer.doing = what;
        else delete c.peer.doing;
        broadcast({ t: 'peer.update', peer: c.peer });
        break;
      }
      case 'term.resize':
        if (c.attached.has(msg.workerId)) workerFloor(msg.workerId)?.workers.resize(msg.workerId, num(msg.cols), num(msg.rows));
        break;
      case 'side.attach': {
        const w = worker(msg.workerId);
        if (!w) break;
        const snap = w.floor.workers.attachSide(w.wid, c.id, num(msg.cols), num(msg.rows));
        if (typeof snap === 'string') {
          sendTo(c, { t: 'side.error', workerId: w.wid, error: snap });
          break;
        }
        c.attached.add(sideKey(w.wid));
        sendTo(c, { t: 'side.snapshot', workerId: w.wid, ...snap });
        break;
      }
      case 'side.detach': {
        const wid = str(msg.workerId, 32);
        c.attached.delete(sideKey(wid));
        workerFloor(wid)?.workers.detachSide(wid, c.id);
        break;
      }
      case 'side.input':
        if (c.attached.has(sideKey(msg.workerId))) workerFloor(msg.workerId)?.workers.writeSide(msg.workerId, str(msg.data, 64 * 1024));
        break;
      case 'side.resize':
        if (c.attached.has(sideKey(msg.workerId))) workerFloor(msg.workerId)?.workers.resizeSide(msg.workerId, num(msg.cols), num(msg.rows));
        break;
      case 'gh.refresh':
        void floorOf(c)?.github.refresh();
        break;
      case 'gh.merge': {
        const floor = here();
        const n = num(msg.number);
        const method = (['squash', 'merge', 'rebase'] as const).find((m) => m === msg.method);
        const repo = normalizeRepo(msg.repo);
        if (!floor || !Number.isSafeInteger(n) || n <= 0 || !method) break;
        const ref = ghRef({ number: n, repo });
        void floor.github.merge(n, method, msg.deleteBranch === true, msg.auto === true, repo).then((error) => {
          sendTo(c, { t: 'gh.merged', number: n, repo: msg.repo, error });
          if (error) return;
          toastFloor(floor, msg.auto ? `${who} set PR ${ref} to merge once its checks pass` : `🎉 ${who} merged PR ${ref}`);
          // An auto-merge rings once GitHub gets round to it and the boards see it merged.
          if (!msg.auto) floor.merged(n, who, repo);
        });
        break;
      }
      case 'gh.comment': {
        const floor = here();
        const n = num(msg.number);
        const kind = msg.kind === 'pull' ? 'pull' : 'issue';
        const repo = normalizeRepo(msg.repo);
        if (!floor || !Number.isSafeInteger(n) || n <= 0) break;
        const body = typeof msg.body === 'string' ? msg.body : '';
        // Refused rather than cut short: a comment that silently lost its end would read as finished.
        const invalid = !body.trim() ? 'The comment is empty' : body.length > GH_COMMENT_MAX ? `GitHub takes comments of up to ${GH_COMMENT_MAX} characters` : '';
        if (invalid) {
          sendTo(c, { t: 'gh.commented', kind, number: n, repo: msg.repo, error: invalid });
          break;
        }
        void floor.github.comment(kind, n, body, repo).then((r) => {
          sendTo(c, { t: 'gh.commented', kind, number: n, repo: msg.repo, ...r });
          if (r.comment) toastFloor(floor, `💬 ${who} commented on ${kind === 'pull' ? 'PR' : 'issue'} ${ghRef({ number: n, repo })}`);
        });
        break;
      }
      case 'gong': {
        const floor = floorOf(c);
        const now = Date.now();
        if (!floor || now - c.lastGongAt < 500) break;
        c.lastGongAt = now;
        toFloor(floor, { t: 'gong', why: 'hit', by: who });
        break;
      }
      case 'horn': {
        const now = Date.now();
        if (c.peer.floor !== ROOF || now - c.lastHornAt < 1500) break;
        c.lastHornAt = now;
        for (const o of clients.values()) if (o.peer.floor === ROOF) sendTo(o, { t: 'horn', by: who });
        break;
      }
      case 'gh.close': {
        const floor = here();
        const n = num(msg.number);
        const kind = msg.kind === 'issue' || msg.kind === 'pull' ? msg.kind : undefined;
        const repo = normalizeRepo(msg.repo);
        if (!floor || !Number.isSafeInteger(n) || n <= 0 || !kind) break;
        const reason = msg.reason === 'not planned' ? 'not planned' : 'completed';
        const ref = ghRef({ number: n, repo });
        void floor.github.close(kind, n, { comment: str(msg.comment, 20000).trim() || undefined, reason, deleteBranch: msg.deleteBranch === true }, repo).then((error) => {
          sendTo(c, { t: 'gh.closed', kind, number: n, repo: msg.repo, error });
          if (error) return;
          if (kind === 'pull') return toastFloor(floor, `${who} closed PR ${ref} without merging`);
          // Nobody should be seated for an issue that's closed.
          const dropped = floor.queue.dropIssue(n, repo);
          toastFloor(floor, `${who} closed issue ${ref}${reason === 'not planned' ? ' as not planned' : ''}${dropped ? ' and took it off the queue' : ''}`);
        });
        break;
      }
      case 'queue.add': {
        const floor = here();
        if (!floor) break;
        if (msg.provider !== undefined && (!isAgentProvider(msg.provider) || !floor.project.agentProviders.includes(msg.provider))) {
          warn(c, 'Unknown agent provider');
          break;
        }
        const issue = Number.isInteger(msg.issue) && (msg.issue as number) > 0 ? (msg.issue as number) : undefined;
        const repo = normalizeRepo(msg.repo);
        const model = msg.model === undefined ? undefined : str(msg.model, OPEN_CODE_MODEL_MAX + 1);
        const effort = isAgentEffort(msg.effort) ? msg.effort : undefined;
        const plan = str(msg.plan, 64) || undefined;
        const err = floor.queue.add(str(msg.prompt, 20000), who, str(msg.title, 200), issue, msg.provider, model, effort, repo, plan);
        if (err) warn(c, err);
        else toastFloor(floor, `📋 ${who} queued ${issue !== undefined ? `issue ${ghRef({ number: issue, repo })}` : plan ? 'a To Do Next item' : 'a task'}`);
        break;
      }
      case 'inbox.note': {
        const floor = here();
        if (!floor) break;
        try {
          floor.inbox.note(str(msg.title, 200), str(msg.text, INBOX_NOTE_MAX + 1), `${who} in the office`);
          toastFloor(floor, `📥 ${who} dropped a note in the in-tray`);
        } catch (error) {
          warn(c, error instanceof InboxError ? error.message : 'The note could not be saved');
        }
        break;
      }
      case 'inbox.archive': {
        const floor = here();
        if (!floor) break;
        const name = str(msg.name, 256);
        try {
          floor.inbox.archive(name);
          toastFloor(floor, `📥 ${who} put ${name} away`);
        } catch (error) {
          warn(c, error instanceof InboxError ? error.message : 'That item could not be put away');
        }
        break;
      }
      case 'inbox.plan': {
        const floor = here();
        if (!floor) break;
        void floor.inbox.read(str(msg.name, 256)).then((r) => {
          // A file's place is known once it's archived; a note carries its text, and is put away once filed.
          const where = r.item.kind === 'note' ? r.path : floor.inbox.archive(r.item.name);
          floor.plans.apply({ action: 'add', text: inboxPlanText(r.item, r.body, where).slice(0, PLAN_TEXT_MAX) });
          if (r.item.kind === 'note') floor.inbox.archive(r.item.name);
          toastFloor(floor, `📒 ${who} filed “${planTitle(r.item.title)}” from the in-tray on To Do Next`);
        }).catch((error) => warn(c, error instanceof InboxError || error instanceof PlansError ? error.message : 'That item could not be filed'));
        break;
      }
      case 'inbox.queue': {
        const floor = here();
        if (!floor) break;
        if (msg.provider !== undefined && (!isAgentProvider(msg.provider) || !floor.project.agentProviders.includes(msg.provider))) {
          warn(c, 'Unknown agent provider');
          break;
        }
        const model = msg.model === undefined ? undefined : str(msg.model, OPEN_CODE_MODEL_MAX + 1);
        const effort = isAgentEffort(msg.effort) ? msg.effort : undefined;
        void floor.inbox.read(str(msg.name, 256)).then((r) => {
          const where = r.item.kind === 'note' ? r.path : floor.inbox.archive(r.item.name);
          const err = floor.queue.add(inboxPrompt(r.item, r.body, where), who, `📥 ${r.item.title}`, undefined, msg.provider, model, effort);
          if (err) return warn(c, err);
          if (r.item.kind === 'note') floor.inbox.archive(r.item.name);
          toastFloor(floor, `📋 ${who} queued “${planTitle(r.item.title)}” from the in-tray`);
        }).catch((error) => warn(c, error instanceof InboxError ? error.message : 'That item could not be queued'));
        break;
      }
      case 'queue.remove': {
        const floor = here();
        if (floor) warn(c, floor.queue.remove(str(msg.taskId, 32)));
        break;
      }
      case 'queue.move':
        floorOf(c)?.queue.move(str(msg.taskId, 32), num(msg.delta) < 0 ? -1 : 1);
        break;
      case 'queue.retry': {
        const floor = here();
        if (floor) warn(c, floor.queue.retry(str(msg.taskId, 32)));
        break;
      }
      case 'queue.clear':
        floorOf(c)?.queue.clear();
        break;
      case 'queue.limit':
        floorOf(c)?.queue.setLimit(num(msg.maxWorkers));
        break;
      case 'meeting.start': {
        const floor = here();
        if (!floor) break;
        if (msg.provider !== undefined && (!isAgentProvider(msg.provider) || !floor.project.agentProviders.includes(msg.provider))) {
          warn(c, 'Unknown agent provider');
          break;
        }
        const count = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : undefined);
        const request: MeetingRequest = {
          pattern: msg.pattern,
          prompt: str(msg.prompt, 20000),
          title: str(msg.title, 200) || undefined,
          output: str(msg.output, 300) || undefined,
          roles: Array.isArray(msg.roles) ? msg.roles.slice(0, 8).map((r) => str(r, 80)) : [],
          parts: Array.isArray(msg.parts) ? msg.parts.slice(0, 200).map((p) => str(p, 500)) : undefined,
          pr: count(msg.pr),
          issue: count(msg.issue),
          rounds: count(msg.rounds),
          budget: count(msg.budget),
          provider: msg.provider,
          model: msg.model === undefined ? undefined : str(msg.model, OPEN_CODE_MODEL_MAX + 1),
          effort: isAgentEffort(msg.effort) ? msg.effort : undefined,
        };
        warn(c, floor.meetings.start(request, who));
        break;
      }
      case 'meeting.stop': {
        const floor = here();
        if (floor) warn(c, floor.meetings.stop(who));
        break;
      }
      case 'meeting.clear': {
        const floor = here();
        if (floor) warn(c, floor.meetings.clear(who));
        break;
      }
      case 'notify.webhook': {
        const url = str(msg.url, 4096).trim();
        const err = webhook.set(url, who);
        warn(c, err);
        if (!err) toastAll(url ? `📣 ${who} set up team notifications` : `${who} turned off team notifications`);
        break;
      }
      case 'notify.test':
        void webhook.test(who).then((err) => sendTo(c, { t: 'toast', text: err ?? '📣 Sent a test message', level: err ? 'warn' : 'info' }));
        break;
      case 'theme.set': {
        if (!isThemePick(msg.pick)) return;
        if (msg.pick === themes.state().pick) break;
        themes.set(msg.pick, who);
        const now = themes.state().active;
        toastAll(
          msg.pick === 'halloween'
            ? `🎃 ${who} dressed the office up for Halloween`
            : msg.pick === 'christmas'
              ? `🎄 ${who} dressed the office up for Christmas`
              : msg.pick === 'off'
                ? `${who} took the holiday decorations down`
                : `📅 ${who} set the decorations to follow the calendar${now ? ` (it's ${now === 'halloween' ? 'Halloween 🎃' : 'Christmas 🎄'} season)` : ''}`,
        );
        break;
      }
      case 'machine.limit': {
        if (!meOf(c.accountId).admin) return warn(c, 'Only admins can change the worker limit');
        const limit = msg.limit === null ? undefined : parseWorkerLimit(msg.limit);
        if (msg.limit !== null && limit === undefined) return warn(c, `The worker limit is a whole number from 1 to ${MAX_WORKER_LIMIT}`);
        const err = machine.setLimit(limit, who);
        if (err) return warn(c, err);
        const now = machine.limit;
        toastAll(limit !== undefined ? `⚙️ ${who} set the worker limit to ${now}` : now === undefined ? `⚙️ ${who} took the worker limit off` : `⚙️ ${who} put the worker limit back to ${now} (--max-workers)`);
        pumpQueues();
        break;
      }
      case 'changes.watch': {
        const w = worker(msg.workerId);
        if (w) {
          const changes = w.floor.changesFor(w.wid, msg.repository);
          if (changes) changes.watch(w.wid, c.id);
          else warn(c, 'Choose a repository from this worker’s workspace');
        }
        break;
      }
      case 'changes.unwatch': {
        const wid = str(msg.workerId, 32);
        // Its worker may have gone home already; stop watching wherever it was.
        for (const f of floors.values()) {
          f.changes.unwatch(wid, c.id);
          f.workspaceChanges.unwatch(wid, c.id, msg.repository);
        }
        break;
      }
      case 'changes.diff': {
        const workerId = str(msg.workerId, 32);
        const file = str(msg.path, 4096);
        const floor = workerFloor(workerId);
        const repository = typeof msg.repository === 'string' ? msg.repository : undefined;
        const changes = floor?.changesFor(workerId, repository);
        if (!changes) {
          sendTo(c, { t: 'changes.diff', workerId, repository, path: file, diff: '', truncated: false, error: 'No such worker or repository' });
          break;
        }
        void changes.diff(workerId, file).then((r) => {
          if (typeof r === 'string') sendTo(c, { t: 'changes.diff', workerId, repository, path: file, diff: '', truncated: false, error: r });
          else sendTo(c, { t: 'changes.diff', workerId, repository, path: file, ...r });
        });
        break;
      }
      case 'changes.commit': {
        const w = worker(msg.workerId);
        if (w) void w.floor.changesFor(w.wid, msg.repository)?.commit(w.wid, str(msg.message, 5000), who).then((err) => warn(c, err));
        break;
      }
      case 'changes.discard': {
        const w = worker(msg.workerId);
        if (w) void w.floor.changesFor(w.wid, msg.repository)?.discard(w.wid, typeof msg.path === 'string' ? str(msg.path, 4096) : undefined, who).then((err) => warn(c, err));
        break;
      }
      case 'changes.pr': {
        const w = worker(msg.workerId);
        if (w?.info.workspace) {
          void w.floor.workers.openPr(w.wid, who, msg.repository, { title: str(msg.title, 300), body: str(msg.body, 20000) }).then(r => {
            if (typeof r === 'string') warn(c, r);
            else toastFloor(w.floor, `Pull request for ${msg.repository}: ${r.url}`);
          });
        } else if (w) void w.floor.changesFor(w.wid, msg.repository)?.pullRequest(w.wid, str(msg.title, 300), str(msg.body, 20000), who).then((err) => warn(c, err));
        break;
      }
      case 'upgrade.check':
        void upgrader.check();
        break;
      case 'upgrade.start':
        void upgrader.start(who).then((err) => {
          if (err) warn(c, err);
          else toastAll(`${who} is upgrading the office — it restarts when the new version is built`);
        });
        break;
      case 'limits.refresh':
        limits.refresh();
        break;
      case 'team.get':
        void team.state().then((state) => sendTo(c, { t: 'team', state }));
        break;
      case 'team.invite': {
        const user = str(msg.github, 64);
        void team.invite(user).then(async (r) => {
          sendTo(c, { t: 'team.invited', github: user, ...r });
          if ('error' in r) return;
          toastAll(`${who} invited ${r.name} to the office`);
          await teamChanged();
        });
        break;
      }
      case 'team.remove': {
        const name = str(msg.name, 64);
        void team.remove(name).then(async (err) => {
          if (err) return warn(c, err);
          toastAll(`${who} removed ${name}'s access`);
          await teamChanged();
        });
        break;
      }
      case 'accounts.get':
      case 'accounts.invite':
      case 'accounts.cancel':
      case 'accounts.revoke':
      case 'accounts.role':
      case 'accounts.shared':
        handleAccounts(c, msg);
        break;
      case 'decor.add': {
        const floor = here();
        if (!floor) break;
        const d = floor.decor.add(msg.decor, who);
        if (typeof d === 'string') return warn(c, d);
        decorChanged(floor);
        toastFloor(floor, `🖼️ ${who} hung ${d.title ? `“${d.title}”` : 'a picture'}`);
        break;
      }
      case 'decor.update': {
        const floor = here();
        if (!floor) break;
        const d = floor.decor.update(str(msg.id, 32), msg.decor);
        if (typeof d === 'string') return warn(c, d);
        decorChanged(floor);
        break;
      }
      case 'decor.remove': {
        const floor = here();
        if (!floor) break;
        const d = floor.decor.remove(str(msg.id, 32));
        if (!d) break;
        decorChanged(floor);
        toastFloor(floor, `${who} took down ${d.title ? `“${d.title}”` : 'a picture'}`);
        break;
      }
      case 'wb.open':
      case 'wb.close': {
        const floor = floorOf(c);
        const open = msg.t === 'wb.open' && !!floor;
        if (open === c.whiteboard) break;
        c.whiteboard = open;
        drawingChanged(floor);
        break;
      }
      case 'wb.update': {
        const floor = here();
        if (!floor) break;
        const { accepted, error } = floor.whiteboard.apply(msg.elements);
        if (accepted.length) toNeighbors(c, { t: 'wb.update', elements: accepted });
        warn(c, error);
        break;
      }
      case 'wb.pointer': {
        const now = Date.now();
        if (!c.whiteboard || now - c.lastWbPointerAt < 25) break;
        c.lastWbPointerAt = now;
        const selected = Array.isArray(msg.selected) ? msg.selected.filter((s): s is string => typeof s === 'string').slice(0, 200).map((s) => s.slice(0, 100)) : undefined;
        const pointer: ServerMsg = { t: 'wb.pointer', id: c.id, x: num(msg.x), y: num(msg.y), tool: msg.tool === 'laser' ? 'laser' : 'pointer', button: msg.button === 'down' ? 'down' : 'up', selected };
        const json = JSON.stringify(pointer);
        for (const o of clients.values()) {
          if (o.id === c.id || !o.whiteboard || o.peer.floor !== c.peer.floor || o.ws.readyState !== WebSocket.OPEN || o.ws.bufferedAmount > 1024 * 1024) continue;
          o.ws.send(json);
        }
        break;
      }
      case 'jukebox.play': {
        const floor = here();
        if (!floor) break;
        const r = floor.jukebox.play({ track: msg.track, url: msg.url }, who);
        if ('error' in r) return warn(c, r.error);
        if (!r.changed) break;
        jukeboxChanged(floor);
        toastFloor(floor, floor.jukebox.state().track === STREAM ? `📻 ${who} tuned the jukebox to ${floor.jukebox.title()}` : `🎵 ${who} put on “${floor.jukebox.title()}”`);
        break;
      }
      case 'jukebox.skip': {
        const floor = here();
        if (!floor) break;
        floor.jukebox.skip(who);
        jukeboxChanged(floor);
        toastFloor(floor, `⏭️ ${who} skipped to “${floor.jukebox.title()}”`);
        break;
      }
      case 'cabinet.play': {
        const floor = here();
        if (!floor || (c.playing && msg.game === c.game)) break;
        const at = cabinetPlayer(floor);
        if (at && at !== c) {
          warn(c, `${at.peer.name} is on the arcade — press E there to watch`);
          sendTo(c, { t: 'cabinet', state: cabinetState(floor) });
          break;
        }
        // Already at it: that game's over, and this is the next one.
        if (c.playing) arcade.leave(c.game, floor.id);
        c.game = arcade.start({ owner: c.accountId ? `account:${c.accountId}` : `name:${who}`, name: who, color: c.peer.color, connection: c.id }, msg.game);
        if (c.game !== msg.game && !arcade.counts(c.game)) warn(c, "🕹️ That's a lot of new games in a row, so this one won't go on the high-score table");
        c.playing = true;
        c.frame = undefined;
        cabinetChanged(floor);
        break;
      }
      case 'cabinet.leave':
        stopPlaying(c);
        break;
      case 'cabinet.frame': {
        const floor = floorOf(c);
        const frame = checkFrame(msg.frame);
        if (!c.playing || !floor || !frame) break;
        // Every frame counts towards the score, even one that comes too soon after the last to pass on.
        if (arcade.frame(c.game, frame, floor.id) === 'void') warn(c, "🕹️ The office couldn't follow this game, so its score won't go on the high-score table");
        c.frame = frame;
        const now = Date.now();
        if (now - c.lastFrameAt < 40) break;
        c.lastFrameAt = now;
        toNeighbors(c, { t: 'cabinet.frame', frame }, true);
        break;
      }
      case 'jukebox.stop': {
        const floor = here();
        if (!floor || !floor.jukebox.stop(who)) break;
        jukeboxChanged(floor);
        toastFloor(floor, `🔇 ${who} turned the jukebox off`);
        break;
      }
      case 'ping':
        sendTo(c, { t: 'pong', at: num(msg.at), now: Date.now() });
        break;
    }
  };

  /** Inviting, listing and revoking people. Admins only: an admin account, or the shared password. */
  const handleAccounts = (c: Client, msg: Extract<ClientMsg, { t: `accounts.${string}` }>) => {
    const who = c.peer.name;
    if (!meOf(c.accountId).admin) return warn(c, 'Only admins can manage accounts');
    switch (msg.t) {
      case 'accounts.get':
        sendTo(c, { t: 'accounts', state: accounts.state(onlineAccounts()) });
        break;
      case 'accounts.invite': {
        const r = accounts.invite(who, msg.role === 'admin' ? 'admin' : 'member', typeof msg.name === 'string' ? msg.name : undefined);
        if (typeof r === 'string') return sendTo(c, { t: 'accounts.invited', error: r });
        sendTo(c, { t: 'accounts.invited', invite: r });
        accountsChanged();
        break;
      }
      case 'accounts.cancel':
        if (accounts.cancel(str(msg.inviteId, 32))) accountsChanged();
        break;
      case 'accounts.revoke': {
        const id = str(msg.accountId, 32);
        if (id === c.accountId) return warn(c, "You can't revoke your own account");
        const a = accounts.revoke(id);
        if (!a) break;
        console.log(`  ${who} revoked ${a.name}'s account`);
        toastAll(`${who} revoked ${a.name}'s account`);
        accountsChanged(); // signs them out everywhere
        break;
      }
      case 'accounts.role': {
        const id = str(msg.accountId, 32);
        if (id === c.accountId) return warn(c, "You can't change your own role");
        const a = accounts.setRole(id, msg.role === 'admin' ? 'admin' : 'member');
        if (!a) break;
        toastAll(a.role === 'admin' ? `${who} made ${a.name} an admin` : `${a.name} is no longer an admin`);
        accountsChanged();
        break;
      }
      case 'accounts.shared': {
        if (msg.on === accounts.sharedPassword) break;
        // Only someone who can still get in without it may switch it off.
        if (!msg.on && !c.accountId) return warn(c, 'Sign in with an admin account of your own first, or nobody could get back in');
        accounts.setSharedPassword(!!msg.on);
        console.log(`  ${who} switched the shared office password ${msg.on ? 'on' : 'off'}`);
        toastAll(msg.on ? `${who} switched the shared office password back on` : `🔑 ${who} switched off the shared office password — everyone signs in with their own account now`);
        accountsChanged(); // signs out whoever came in with it
        break;
      }
    }
  };

  const resync = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.stale.size || c.ws.bufferedAmount > SLOW_CLIENT_BYTES / 8) continue;
      for (const key of c.stale) {
        if (!c.attached.has(key)) continue;
        if (key.startsWith('side:')) {
          const wid = key.slice(5);
          const w = workerFloor(wid)?.workers.get(wid);
          const snap = w?.side && workerFloor(wid)!.workers.attachSide(wid, c.id, w.side.cols, w.side.rows);
          if (snap && typeof snap !== 'string') sendTo(c, { t: 'side.snapshot', workerId: wid, ...snap });
          continue;
        }
        const snap = workerFloor(key)?.workers.attach(key, c.id, c.peer.name);
        if (snap) sendTo(c, { t: 'term.snapshot', workerId: key, ...snap });
      }
      c.stale.clear();
    }
  }, 1000);

  // Drop dead connections so ghosts don't linger in the office.
  // Also signs out anyone `agent-office accounts` revoked, and passes on role changes made there.
  const heartbeat = setInterval(() => {
    let accountsMoved = false;
    for (const c of clients.values()) {
      if (!c.isAlive) {
        c.ws.terminate();
        continue;
      }
      if (!c.out && (!stillIn(c) || c.admin !== meOf(c.accountId).admin)) accountsMoved = true;
      c.isAlive = false;
      c.ws.ping();
    }
    if (accountsMoved) accountsChanged();
  }, 20_000);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => resolve());
  });
  services.start();

  /** With `keep` (a restart), workers' terminals keep running for the next office to pick up. */
  const shutdown = (keep = false) => {
    clearInterval(heartbeat);
    clearInterval(resync);
    clearTimeout(floorsTimer);
    arcade.flush();
    upgrader.stop();
    services.stop();
    webhook.stop();
    machine.stop();
    sky.stop();
    themes.stop();
    for (const f of floors.values()) f.shutdown(keep);
    ledger.flush();
    modelUsage.flush();
    limits.close();
    for (const c of clients.values()) c.ws.close();
    server.close();
    hookServer.close();
  };

  return { server, shutdown, accounts, publicDir, hookPort, floors: () => [...floors.values()], projectsDir: () => building.projectsDir, resolvedAgent: resolveCommand(cfg.agentCmd) };
}
