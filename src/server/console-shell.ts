import { execFile } from 'node:child_process';
import { existsSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ClientMsg, ServerMsg } from '../shared/protocol.js';
import { SideShells, sideShellLaunch } from './sideshell.js';
import { childEnv } from './workers.js';

/**
 * Makes PowerShell say where it is at every prompt, as OSC 7 (the sequence terminals use for the shell's
 * current directory), so the office knows which folder a terminal is in after a `cd` and CleanBot keeps
 * that worktree. It wraps the prompt the profile left, so a custom prompt still shows. Windows has no
 * other way to read a process's current directory (there's no /proc), and ConPTY passes the sequence
 * through; the browser's terminal ignores it. Single quotes only: it travels on PowerShell's command line.
 */
export const POWERSHELL_CWD_PROMPT =
  "$global:__agentOfficePrompt = $function:prompt; function global:prompt { if ((Get-Location).Provider.Name -eq 'FileSystem') { $Host.UI.Write([string][char]27 + ']7;' + ([uri](Get-Location).ProviderPath).AbsoluteUri + [char]7) }; & $global:__agentOfficePrompt }";

/** A regular PowerShell with profiles on Windows (saying where it is at each prompt); retain the user's login shell elsewhere. */
export function consoleShellLaunch(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists = existsSync) {
  if (platform !== 'win32') return sideShellLaunch(platform, env, exists);
  const dirs = (env.PATH || env.Path || '').split(';').map(dir => dir.replace(/^"|"$/g, ''));
  const pwsh = dirs.filter(Boolean).map(dir => path.win32.join(dir, 'pwsh.exe')).find(exists);
  return { file: pwsh || path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo', '-NoExit', '-Command', POWERSHELL_CWD_PROMPT] };
}

/** OSC 7 (file://host/path) and ConEmu's OSC 9;9 (a plain path), ended by BEL or ST, as a shell's prompt writes them. */
const CWD_SEQUENCE = /\x1b\](?:7;file:\/\/[^/\x07\x1b]*(\/[^\x07\x1b]*)|9;9;"?([^\x07\x1b"]*)"?)(?:\x07|\x1b\\)/g;
/** How much of a chunk's tail is kept for a sequence split across two chunks. */
const CWD_TAIL = 2048;

/**
 * The last folder a shell's output says it's in (its prompt's OSC 7 or OSC 9;9), as a path for this
 * platform, or undefined when the output has none. `carry` is the previous chunk's tail, in case a
 * sequence straddled two chunks.
 */
export function reportedCwd(data: string, carry = '', platform: NodeJS.Platform = process.platform): { cwd?: string; tail: string } {
  const text = carry + data;
  let cwd: string | undefined;
  let end = 0;
  for (const m of text.matchAll(CWD_SEQUENCE)) {
    end = m.index + m[0].length;
    if (m[2] !== undefined) {
      if (m[2]) cwd = m[2];
      continue;
    }
    try {
      const p = decodeURIComponent(m[1]);
      cwd = platform === 'win32' ? p.replace(/^\/(?=[A-Za-z]:)/, '').split('/').join('\\') : p;
    } catch {
      // not a URI path: ignore it
    }
  }
  // Keep from the last unfinished escape on, so a sequence split across chunks is still read.
  const rest = text.slice(end);
  const esc = rest.lastIndexOf('\x1b');
  return { cwd, tail: esc >= 0 ? rest.slice(esc).slice(-CWD_TAIL) : '' };
}

/**
 * Where a process is now, where the platform can say: /proc on Linux, lsof on macOS. Windows can't
 * (the shell says so itself instead, see POWERSHELL_CWD_PROMPT).
 */
export async function processCwd(pid: number | undefined, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  if (!pid) return undefined;
  if (platform === 'linux') {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return undefined;
    }
  }
  if (platform === 'darwin') {
    return new Promise((resolve) =>
      execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
        const line = err ? undefined : stdout.split('\n').find((l) => l.startsWith('n/'));
        resolve(line ? line.slice(1) : undefined);
      }),
    );
  }
  return undefined;
}

type ConsoleMessage = Extract<ClientMsg, { t: `console.${string}` }>;

interface ConsoleSession {
  /** The folder the shell started in. */
  cwd: string;
  /** The folder the shell last said it's in (its prompt's OSC 7), once it has. */
  at?: string;
  /** The tail of its last output, for a sequence split across two chunks. */
  tail: string;
  cols: number;
  rows: number;
  attached: boolean;
}

/** One private shell per browser connection, independent of workers. Changing floor starts a new shell in that folder. */
export class ConsoleShells {
  private sessions = new Map<string, ConsoleSession>();
  private shells: SideShells;

  constructor(private send: (id: string, msg: ServerMsg) => void, private readCwd = processCwd) {
    this.shells = new SideShells({
      data: (id, data) => {
        const session = this.sessions.get(id);
        if (session) {
          const seen = reportedCwd(data, session.tail);
          session.tail = seen.tail;
          if (seen.cwd) session.at = seen.cwd;
        }
        this.send(id, { t: 'console.data', data });
      },
      size: (id, size) => {
        const session = this.sessions.get(id);
        if (!session) return;
        if (size) Object.assign(session, size);
        else {
          this.sessions.delete(id);
          if (session.attached) this.send(id, { t: 'console.exited' });
        }
      },
    }, () => consoleShellLaunch(process.platform, process.env));
  }

  handle(id: string, msg: ConsoleMessage, cwd: string) {
    const session = this.sessions.get(id);
    switch (msg.t) {
      case 'console.attach': {
        const previous = this.sessions.get(id);
        if (msg.fresh === true || (previous && !sameDir(previous.cwd, cwd))) this.close(id);
        const current = this.sessions.get(id);
        const cols = dimension(msg.cols, 80, 20, 400);
        const rows = dimension(msg.rows, 24, 5, 200);
        const startDir = current?.cwd ?? cwd;
        if (!current) {
          try {
            if (!statSync(startDir).isDirectory()) throw new Error('Not a directory');
          } catch {
            return this.send(id, { t: 'console.error', error: `Starting folder is unavailable: ${startDir}` });
          }
        }
        const snap = this.shells.attach(id, id, startDir, childEnv(), cols, rows);
        if (typeof snap === 'string') return this.send(id, { t: 'console.error', error: snap });
        this.sessions.set(id, { cwd: startDir, at: current?.at, tail: '', cols: snap.cols, rows: snap.rows, attached: true });
        this.send(id, { t: 'console.snapshot', cwd: startDir, ...snap });
        break;
      }
      case 'console.detach':
        this.shells.detach(id, id);
        if (session) session.attached = false;
        break;
      case 'console.input':
        if (session?.attached && typeof msg.data === 'string') {
          // A command may cd before its next prompt. Do not trust the previous prompt meanwhile.
          if (/[\r\n]/.test(msg.data)) session.at = undefined;
          this.shells.write(id, msg.data.slice(0, 64 * 1024));
        }
        break;
      case 'console.resize':
        if (session?.attached) this.shells.resize(id, dimension(msg.cols, 80, 20, 400), dimension(msg.rows, 24, 5, 200));
        break;
    }
  }

  /**
   * Where the open terminals are, for CleanBot (he never deletes a worktree one of them is in): the folder
   * each shell is in now, as it last said at its prompt (PowerShell on Windows) or as the platform says
   * of its process (Linux, macOS), and the folder it started in. Both are given: a shell that moved into
   * a worktree protects it, and one whose moves can't be read still protects where it started.
   */
  async locations(): Promise<{ folders: string[]; unlocated: boolean }> {
    const out = new Set<string>();
    let unlocated = false;
    for (const [id, s] of this.sessions) {
      out.add(s.cwd);
      if (s.at) out.add(s.at);
      const live = await this.readCwd(this.shells.pid(id));
      if (live) out.add(live);
      if (!live && !s.at) unlocated = true;
    }
    return { folders: [...out], unlocated };
  }

  async folders(): Promise<string[]> {
    return (await this.locations()).folders;
  }

  resync(id: string) {
    const s = this.sessions.get(id);
    if (s?.attached) this.handle(id, { t: 'console.attach', cols: s.cols, rows: s.rows }, s.cwd);
  }

  close(id: string) {
    this.sessions.delete(id);
    this.shells.kill(id);
  }

  shutdown() {
    this.sessions.clear();
    this.shells.killAll();
  }
}

function dimension(value: number, fallback: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

function sameDir(a: string, b: string) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
