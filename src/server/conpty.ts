import type { IPty } from '@lydell/node-pty';
import type { Pty, PtyExit } from './ptys.js';

/**
 * Windows terminals run in the office's own process (there is no terminal host there), and node-pty
 * gives a new ConPTY 5 seconds to hand over its output before it gives up: exit code -1, no output,
 * and the program never ran. A busy office misses that: a synchronous `git worktree add` for each
 * hire takes about 2 seconds, so a few hires (or a restart waking every worker) in a row kill the
 * earlier ones' terminals before their agents start. Such a terminal is started again a moment later,
 * once the burst has passed.
 */
export const CONPTY_RETRY_MS = 750;
/** A -1 exit this long after the spawn, or after any output, is the program's own, not ConPTY's. */
const CONNECT_WINDOW_MS = 60_000;

/** A local terminal that starts its program (`name`, for the log) again when ConPTY never got it going (see above). */
export function spawnLocal(start: (cols?: number, rows?: number) => IPty, name: string, retries = 1, retryMs = CONPTY_RETRY_MS): Pty {
  const dataCbs: ((data: string) => void)[] = [];
  const exitCbs: ((e: PtyExit) => void)[] = [];
  let proc: IPty;
  let killed = false;
  let size: [number, number] | undefined;
  const run = () => {
    const began = Date.now();
    let output = false;
    const p = (proc = size ? start(size[0], size[1]) : start());
    p.onData((data) => {
      output = true;
      for (const cb of dataCbs) cb(data);
    });
    p.onExit(({ exitCode }) => {
      if (p !== proc) return;
      if (!killed && retries > 0 && exitCode === -1 && !output && Date.now() - began < CONNECT_WINDOW_MS) {
        retries--;
        console.error(`agent-office: ${name}'s terminal never connected (ConPTY timed out while the office was busy); starting it again`);
        setTimeout(() => {
          if (!killed) run();
          else for (const cb of exitCbs) cb({ exitCode });
        }, retryMs);
        return;
      }
      for (const cb of exitCbs) cb({ exitCode });
    });
  };
  run();
  return {
    get pid() {
      return proc.pid;
    },
    write: (data) => proc.write(data),
    resize(cols, rows) {
      size = [cols, rows];
      proc.resize(cols, rows);
    },
    kill() {
      killed = true;
      proc.kill();
    },
    onData: (cb) => void dataCbs.push(cb),
    onExit: (cb) => void exitCbs.push(cb),
  };
}
