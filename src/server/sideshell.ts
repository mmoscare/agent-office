import { existsSync } from 'node:fs';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import * as pty from '@lydell/node-pty';

type HeadlessTerminal = InstanceType<typeof headless.Terminal>;

/** Kept shorter than a worker's own: a side shell is for a quick look, not a record of the work. */
const SIDE_SCROLLBACK = 2000;

/**
 * A worker's side shell: a plain login shell in the worker's checkout, opened from the Shell tab of
 * its terminal window, to look around beside the agent (which branch, git status, run the tests)
 * without typing into the agent's session. One per worker, shared by everyone who opens that tab.
 * It runs in the office itself, so it goes when the office restarts or the worker is sent home;
 * opening the tab again starts a fresh one.
 */
interface Side {
  proc: pty.IPty;
  term: HeadlessTerminal;
  ser: InstanceType<typeof serialize.SerializeAddon>;
  viewers: Set<string>;
  cols: number;
  rows: number;
}

export interface SideEvents {
  /** Observe PTY output even while no browser is attached. */
  output?(workerId: string, data: string): void;
  /** Output, for whoever has that worker's Shell tab open. */
  data(workerId: string, data: string, viewers: string[]): void;
  /** The shell started, was resized (its size), or ended (undefined). */
  size(workerId: string, size: { cols: number; rows: number } | undefined): void;
}

export class SideShells {
  private shells = new Map<string, Side>();

  constructor(private events: SideEvents, private launch = () => sideShellLaunch(process.platform, process.env)) {}

  /**
   * Opens `workerId`'s side shell for `clientId`, starting it in `cwd` when none runs. Returns what
   * it shows so far, or why it couldn't start.
   */
  attach(workerId: string, clientId: string, cwd: string, env: Record<string, string>, cols: number, rows: number): { data: string; cols: number; rows: number } | string {
    let s = this.shells.get(workerId);
    if (!s) {
      const started = this.start(workerId, cwd, env, clamp(cols, 20, 400), clamp(rows, 5, 200));
      if (typeof started === 'string') return started;
      s = started;
    }
    s.viewers.add(clientId);
    return { data: s.ser.serialize({ scrollback: SIDE_SCROLLBACK }), cols: s.cols, rows: s.rows };
  }

  detach(workerId: string, clientId: string) {
    this.shells.get(workerId)?.viewers.delete(clientId);
  }

  detachAll(clientId: string) {
    for (const s of this.shells.values()) s.viewers.delete(clientId);
  }

  write(workerId: string, data: string) {
    this.shells.get(workerId)?.proc.write(data);
  }

  /** The shell's process id while it runs (console-shell.ts reads where it is now from it). */
  pid(workerId: string): number | undefined {
    return this.shells.get(workerId)?.proc.pid;
  }

  resize(workerId: string, cols: number, rows: number) {
    const s = this.shells.get(workerId);
    if (!s) return;
    cols = clamp(Math.floor(cols), 20, 400);
    rows = clamp(Math.floor(rows), 5, 200);
    if (cols === s.cols && rows === s.rows) return;
    s.cols = cols;
    s.rows = rows;
    try {
      s.proc.resize(cols, rows);
      s.term.resize(cols, rows);
    } catch {
      // it may have exited between checks
    }
    this.events.size(workerId, { cols, rows });
  }

  /** The worker went home: its side shell goes with it. */
  kill(workerId: string) {
    const s = this.shells.get(workerId);
    if (!s) return;
    this.shells.delete(workerId);
    s.viewers.clear();
    try {
      s.proc.kill();
    } catch {
      // already gone
    }
    s.term.dispose();
  }

  killAll() {
    for (const id of [...this.shells.keys()]) this.kill(id);
  }

  private start(workerId: string, cwd: string, env: Record<string, string>, cols: number, rows: number): Side | string {
    const { file, args } = this.launch();
    let proc: pty.IPty;
    try {
      proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
    } catch (err) {
      return `Couldn't start a shell in ${cwd}: ${(err as Error).message}`;
    }
    const term = new headless.Terminal({ cols, rows, scrollback: SIDE_SCROLLBACK, allowProposedApi: true });
    const ser = new serialize.SerializeAddon();
    term.loadAddon(ser as any);
    const s: Side = { proc, term, ser, viewers: new Set(), cols, rows };
    this.shells.set(workerId, s);
    proc.onData((data) => {
      if (this.shells.get(workerId) !== s) return;
      term.write(data);
      this.events.output?.(workerId, data);
      if (s.viewers.size) this.events.data(workerId, data, [...s.viewers]);
    });
    proc.onExit(({ exitCode }) => {
      if (this.shells.get(workerId) !== s) return;
      this.shells.delete(workerId);
      const msg = `\r\n\x1b[2m[shell exited with code ${exitCode} — press Enter for a new one]\x1b[0m\r\n`;
      if (s.viewers.size) this.events.data(workerId, msg, [...s.viewers]);
      term.dispose();
      this.events.size(workerId, undefined);
    });
    this.events.size(workerId, { cols, rows });
    return s;
  }
}

/**
 * The program a side shell runs: a login `$SHELL` (else bash) off Windows. On Windows it matches the
 * office's shell workers: `$SHELL` when it names a shell that exists (Git Bash, say), otherwise the
 * console's own (`%COMSPEC%`, cmd.exe) with no arguments, since cmd.exe has no `-l`.
 */
export function sideShellLaunch(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (file: string) => boolean = existsSync): { file: string; args: string[] } {
  if (platform !== 'win32') return { file: env.SHELL || '/bin/bash', args: ['-l'] };
  if (env.SHELL && exists(env.SHELL)) return { file: env.SHELL, args: ['-l'] };
  return { file: env.COMSPEC || env.ComSpec || 'cmd.exe', args: [] };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
