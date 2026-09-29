import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ClientMsg, ServerMsg } from '../shared/protocol.js';
import { SideShells, sideShellLaunch } from './sideshell.js';
import { childEnv } from './workers.js';

/** A regular PowerShell with profiles on Windows; retain the user's login shell elsewhere. */
export function consoleShellLaunch(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists = existsSync) {
  if (platform !== 'win32') return sideShellLaunch(platform, env, exists);
  const dirs = (env.PATH || env.Path || '').split(';').map(dir => dir.replace(/^"|"$/g, ''));
  const pwsh = dirs.filter(Boolean).map(dir => path.win32.join(dir, 'pwsh.exe')).find(exists);
  return { file: pwsh || path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] };
}

type ConsoleMessage = Extract<ClientMsg, { t: `console.${string}` }>;

/** One private shell per browser connection, independent of workers. Changing floor starts a new shell in that folder. */
export class ConsoleShells {
  private sessions = new Map<string, { cwd: string; cols: number; rows: number; attached: boolean }>();
  private shells: SideShells;

  constructor(private send: (id: string, msg: ServerMsg) => void) {
    this.shells = new SideShells({
      data: (id, data) => this.send(id, { t: 'console.data', data }),
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
        this.sessions.set(id, { cwd: startDir, cols: snap.cols, rows: snap.rows, attached: true });
        this.send(id, { t: 'console.snapshot', cwd: startDir, ...snap });
        break;
      }
      case 'console.detach':
        this.shells.detach(id, id);
        if (session) session.attached = false;
        break;
      case 'console.input':
        if (session?.attached && typeof msg.data === 'string') this.shells.write(id, msg.data.slice(0, 64 * 1024));
        break;
      case 'console.resize':
        if (session?.attached) this.shells.resize(id, dimension(msg.cols, 80, 20, 400), dimension(msg.rows, 24, 5, 200));
        break;
    }
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
