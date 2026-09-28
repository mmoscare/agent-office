// Whether an agent the office launched actually came up, and what to tell its owner when it didn't.
//
// Claude, Codex and OpenCode report in to the office once they run: a hook, or for OpenCode its
// plugin's "ready" as it loads. One that exits before that, or stays silent for STARTUP_MS, didn't
// start. Its desk then asks for a person (see WorkerManager.markNotStarted), its terminal keeps the
// error, and Start again launches it once more with its task.

import type { AgentProvider } from '../shared/protocol.js';

/** How long a launched agent may stay silent before its desk says it didn't start. */
export const STARTUP_MS = 45_000;

const LABEL: Record<AgentProvider, string> = { claude: 'Claude', opencode: 'OpenCode', codex: 'Codex', custom: 'The agent' };

/**
 * Providers that always report in once they run, so exiting first means they never started. A
 * custom wrapper may never report at all.
 */
export function reportsIn(provider: AgentProvider | undefined): boolean {
  return provider === 'claude' || provider === 'codex' || provider === 'opencode';
}

/**
 * Whether silence alone says it didn't start. OpenCode's plugin says it's ready as it loads; Codex
 * reports its session once it has a prompt to run. Claude has its own check for the setup screens
 * it can sit on (see WorkerManager.follow).
 */
export function watchesSilence(provider: AgentProvider | undefined, prompted: boolean): boolean {
  return provider === 'opencode' || (provider === 'codex' && prompted);
}

/**
 * OpenCode's Windows build is a Bun app. With its embedded app damaged (a reinstall that replaced
 * opencode.exe while it ran), plain Bun runs instead and takes the arguments for a script to run.
 */
const BARE_BUN = /Script not found "|Bun is a fast JavaScript runtime/;

/** The command that reinstalls OpenCode, letting npm run the install script that puts opencode.exe in place. */
export const REINSTALL_OPENCODE = 'npm install -g opencode-ai --allow-scripts=opencode-ai';

/**
 * What the desk says (`activity`) and, once the process has exited, what the terminal says under
 * its last output (`note`), for an agent that didn't start. `exitCode` is undefined while it still
 * runs (it went silent), and `screen` is what this run printed.
 */
export function notStarted(provider: AgentProvider | undefined, exitCode: number | undefined, screen: string): { activity: string; note?: string } {
  const label = LABEL[provider ?? 'custom'];
  if (provider === 'opencode' && BARE_BUN.test(screen)) {
    return {
      activity: "OpenCode's install is broken (it runs as plain Bun): reinstall it, then Start again",
      note: `OpenCode didn't start: its executable ran as plain Bun, so the OpenCode install is damaged. With no OpenCode running, reinstall it (${REINSTALL_OPENCODE}), then press Start again.`,
    };
  }
  if (exitCode === undefined) return { activity: `${label} still hasn't started: open the terminal, then Start again` };
  return {
    activity: `${label} exited before it started (code ${exitCode}): open the terminal, then Start again`,
    note: `${label} didn't start: it exited with code ${exitCode} before reporting to the office. What it printed is above. Start again runs it once more with its task.`,
  };
}

/** The same, for a launch that failed before the agent ran at all (its command, or its folder, is missing). */
export function couldNotLaunch(provider: AgentProvider | undefined, message: string): string {
  return `Couldn't start ${LABEL[provider ?? 'custom']}: ${message}`;
}
