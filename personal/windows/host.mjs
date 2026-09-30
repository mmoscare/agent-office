// A launcher-owned stdin channel gives Windows a graceful stop without changing upstream's CLI.
// The office can also ask the launcher to start it again (exit code 75, see Launcher.cs): before
// anything of the app loads, a build the office staged for that restart is switched in
// (src/server/app-swap.ts), and if that build doesn't start, the previous one is put back (exit 76).
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const RESTART = 75;
const ROLLED_BACK = 76;
const [codeDir, officeDir, port] = process.argv.slice(2);
if (!codeDir || !officeDir || !/^\d+$/.test(port ?? '')) throw new Error('Missing launcher configuration');

let swap;
const swapFile = path.join(codeDir, 'dist/server/server/app-swap.js');
if (existsSync(swapFile)) {
  try { swap = await import(pathToFileURL(swapFile).href); }
  catch (err) { console.error(`agent-office launcher: ${err.message}`); }
}
let started = { swapped: false };
try { started = swap?.beforeStart?.(codeDir) ?? started; }
catch (err) { console.error(`agent-office launcher: ${err.message}`); }
if (started.message) console.log(`  ${started.message}`);

let restarting = false;
let up = false;
// How the office finds out it can restart itself (src/server/office-update.ts).
globalThis[Symbol.for('agent-office.launcher')] = {
  version: 2,
  restart() {
    restarting = true;
    // The office's own restart path: it closes down gracefully, then exits.
    process.emit('SIGTERM', 'SIGTERM');
  },
};
process.on('exit', (code) => {
  if (restarting && code === 0) process.exitCode = RESTART;
  else if (started.swapped && !up && code !== 0 && swap?.startFailed(codeDir, `The office stopped while starting (exit code ${code}).`)) process.exitCode = ROLLED_BACK;
});

const cli = path.join(codeDir, 'dist/server/server/cli.js');
process.argv = [process.execPath, cli, officeDir, '--port', port];
try {
  await import(pathToFileURL(cli).href);
} catch (err) {
  if (started.swapped && swap?.startFailed(codeDir, String(err?.stack ?? err))) {
    console.error(err);
    process.exit(ROLLED_BACK);
  }
  throw err;
}
// cli.js finishes loading once the server is listening: the office is up on this build.
up = true;
if (started.swapped) swap?.startSucceeded?.(codeDir);
const input = createInterface({ input: process.stdin });
input.on('line', line => { if (line === 'stop') process.emit('SIGINT', 'SIGINT'); });
input.on('close', () => process.emit('SIGINT', 'SIGINT'));
