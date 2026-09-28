import type { IPty } from '@lydell/node-pty';
import type { Socket } from 'node:net';

/** Release ConPTY resources after exit, so an in-process Windows terminal cannot keep Node alive. */
export function releaseWindowsPtyOnExit(terminal: IPty): IPty {
  if (process.platform === 'win32') {
    // node-pty closes the output pipe on exit, but its system-ConPTY path leaves the input
    // socket and output worker alive. Confine its private shape here; newer versions may omit it.
    const native = terminal as IPty & { _agent?: { inSocket?: Socket; _conoutSocketWorker?: { dispose(): void } } };
    terminal.onExit(() => {
      native._agent?.inSocket?.destroy();
      native._agent?._conoutSocketWorker?.dispose();
    });
  }
  return terminal;
}
