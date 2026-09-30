import type { UpdatePr, UpdateWorker } from './office-update.js';

// 🔄 Sync everything (server/sync-all.ts, client ui/sync-all.ts, the push-button by the gong): one
// press saves the unsaved work in each repository of the floor and in the office's app folder as a
// commit, pulls, and uploads it; then says what the new code needs (packages, a build, a restart, a
// new launcher) as a short checklist. The fork is public: anything that looks secret or personal is
// left unticked, and the office's own folders are never committed.

/** A file with unsaved changes, as the review screen lists it. */
export interface SyncFile {
  path: string;
  /** A staged rename's old name. */
  from?: string;
  /** M changed, A added, D deleted, R renamed, ? new (untracked). */
  status: 'M' | 'A' | 'D' | 'R' | '?';
  /** Why it starts unticked: it looks secret or personal, or it's big. The owner may still tick it. */
  risky?: string;
  /** Why it can never be committed from here (the office's own folders, node_modules, dist…). */
  blocked?: string;
}

export interface SyncRepo {
  /** `floor:<path on the floor>`, or `office` for the app folder. */
  id: string;
  name: string;
  dir: string;
  kind: 'floor' | 'office';
  branch?: string;
  /** The GitHub branch it follows, e.g. origin/personal. */
  upstream?: string;
  /** Commits here that GitHub doesn't have yet (they're uploaded too). */
  ahead: number;
  /** New commits on GitHub, as of the review (they're pulled). */
  behind: number;
  /** Their subjects, newest first (a few). */
  outgoing: string[];
  files: SyncFile[];
  /** More files than the list shows. */
  more: number;
  /** A plain first line for the commit, from the files ticked at first. */
  suggested: string;
  /** Why this repository is skipped altogether (detached HEAD, no upstream, a merge half done…). */
  problem?: string;
  /** Why it's pulled but not uploaded (it follows someone else's repository…). */
  noPush?: string;
}

export interface SyncPlan {
  repos: SyncRepo[];
  /** Ties the Go to this review (10 minutes). */
  token: string;
  checkedAt: number;
  /** The floor has more repositories than are looked at. */
  truncated: boolean;
  /** Whether this person may press Go (the office's admins). */
  admin: boolean;
}

/** What the owner chose for one repository: the files ticked and the commit's message. */
export interface SyncChoice {
  id: string;
  files: string[];
  message: string;
}

export type SyncRepoState = 'done' | 'skipped' | 'failed' | 'conflict';

export interface SyncRepoResult {
  id: string;
  name: string;
  kind: 'floor' | 'office';
  state: SyncRepoState;
  /** Files saved in the new commit (0: nothing to save). */
  saved: number;
  commit?: string;
  /** New commits brought in from GitHub. */
  pulled: number;
  /** Commits uploaded (0: nothing to upload, or it wasn't uploaded). */
  pushed: number;
  /** One plain line: what happened, and what to do when it's on the owner. */
  message: string;
  /** Files that clash with GitHub's changes, when the pull stopped. */
  clashes?: string[];
  /** Git's own words, for "Show details". */
  details?: string;
  /** The commit before and after, when it moved. */
  before?: string;
  after?: string;
  /** Pull requests (and other changes) the pull brought in. */
  prs: UpdatePr[];
  otherCommits: number;
}

export type ChangeArea = 'packages' | 'server' | 'client' | 'launcher' | 'docs';

export type NextStepKind = 'packages' | 'build' | 'build-client' | 'reload' | 'stop' | 'launcher' | 'restart' | 'start' | 'nothing';

/** One line of the "what to do next" checklist. */
export interface NextStep {
  kind: NextStepKind;
  title: string;
  /** Why, in a few words. */
  why?: string;
  /** Commands to copy (PowerShell), when it's done by hand. */
  commands?: string[];
  /** The step-by-step update (#84's walkthrough) can do this one: offer its button. */
  walkthrough?: boolean;
}

export interface NextSteps {
  /** What the new commits in the app folder touch. */
  areas: ChangeArea[];
  steps: NextStep[];
  /** Plain lines on what the new commits bring. */
  news: string[];
  /** Workers mid-task (a restart interrupts them). */
  busy: UpdateWorker[];
  /** The app folder moved (so the checklist is about real changes). */
  changed: boolean;
  appDir?: string;
}

export interface SyncResult {
  repos: SyncRepoResult[];
  next: NextSteps;
}

// ---- What the new code changes ------------------------------------------------------------------

const LAUNCHER = new Set(['personal/windows/Launcher.cs', 'personal/windows/host.mjs', 'personal/windows/Install-Launcher.ps1']);
/** Files the running office never reads: docs, tests, CI, installers for new machines. */
const INERT = /^(docs|tests|\.github|pr-assets|deploy)\/|(^|\/)[^/]+\.(md|markdown|txt)$|^(LICENSE|\.gitignore|\.gitattributes|\.editorconfig|install\.ps1|install\.sh)$|^personal\/(?!windows\/(Launcher\.cs|host\.mjs|Install-Launcher\.ps1)$)/i;
const CLIENT = /^(src\/client\/|public\/|index\.html$|vite\.config\.|tsconfig\.client\.json$)/;
const SERVER = /^(src\/server\/|src\/shared\/|bin\/|tsconfig\.(server|base)\.json$)/;

/**
 * What a set of changed paths (forward slashes, from the app folder's root) means for the running
 * office. Anything unrecognised counts as `server`: a build and a restart never hurt.
 */
export function changeAreas(paths: string[]): ChangeArea[] {
  const areas = new Set<ChangeArea>();
  for (const raw of paths) {
    const p = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!p) continue;
    if (p === 'package.json' || p === 'package-lock.json') areas.add('packages');
    else if (LAUNCHER.has(p)) areas.add('launcher');
    else if (CLIENT.test(p)) areas.add('client');
    else if (SERVER.test(p)) areas.add('server');
    else if (INERT.test(p)) areas.add('docs');
    else areas.add('server');
  }
  const order: ChangeArea[] = ['packages', 'server', 'client', 'launcher', 'docs'];
  return order.filter((a) => areas.has(a));
}

/** The launcher's one-line reinstall, for PowerShell. */
export function launcherCommand(appDir: string): string {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${appDir}\\personal\\windows\\Install-Launcher.ps1"`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The checklist after a sync, from what the app folder's new commits touch. `startCommand` is how
 * the office is started by hand (the manual's START_COMMAND); `canRestart`: it runs under the
 * launcher, so the step-by-step update can restart it.
 */
export function planNextSteps(areas: ChangeArea[], appDir: string, opts: { busy?: number; canRestart?: boolean; startCommand?: string } = {}): NextStep[] {
  const has = (a: ChangeArea) => areas.includes(a);
  const cd = `cd "${appDir}"`;
  const busy = opts.busy ?? 0;
  const busyNote = busy ? `${plural(busy, 'worker is', 'workers are')} mid-task: restarting interrupts ${busy === 1 ? 'it' : 'them'}, and the office starts ${busy === 1 ? 'it' : 'them'} again.` : 'No workers are mid-task, so now is a good time.';
  const start: NextStep = { kind: 'start', title: 'Start the office again', why: 'Double-click Agent Office on your Desktop.', commands: opts.startCommand ? [opts.startCommand] : undefined };
  const stop: NextStep = { kind: 'stop', title: 'Stop the office', why: `Right-click the Agent Office icon near the clock → Stop Agent Office and exit. ${busy ? `${plural(busy, 'worker is', 'workers are')} mid-task and will be interrupted.` : 'No workers are mid-task.'}` };

  // A new launcher can only go in with the office stopped: do everything else in that same stop.
  if (has('launcher')) {
    const steps: NextStep[] = [stop];
    const build = has('packages') || has('server') || has('client');
    if (has('packages')) steps.push({ kind: 'packages', title: 'Install the new packages', why: 'package.json changed.', commands: [`${cd}\nnpm ci`] });
    if (build) steps.push({ kind: 'build', title: 'Build the new version', commands: [`${cd}\nnpm run build`] });
    steps.push({ kind: 'launcher', title: 'Reinstall the launcher', why: 'The Windows launcher itself changed.', commands: [launcherCommand(appDir)] }, start);
    return steps;
  }
  if (has('packages') || has('server')) {
    const byHand = !opts.canRestart;
    const steps: NextStep[] = [];
    if (has('packages')) steps.push({ kind: 'packages', title: 'Install the new packages', why: 'package.json changed. The office installs them in a separate copy, so the running office isn’t touched.', walkthrough: true });
    steps.push({ kind: 'build', title: 'Build the new version', why: has('packages') ? undefined : 'The server’s code changed.', walkthrough: true });
    if (byHand) {
      steps.push({ ...stop, why: `${stop.why} This office can’t restart itself (it isn’t running under the launcher).` });
      if (has('packages')) steps.push({ kind: 'packages', title: 'Install the packages for real', why: 'Safe now the office is stopped.', commands: [`${cd}\nnpm ci`] });
      steps.push(start);
    } else steps.push({ kind: 'restart', title: 'Restart the office', why: busyNote, walkthrough: true });
    return steps;
  }
  if (has('client')) {
    return [
      { kind: 'build-client', title: 'Build the new screens', why: 'Only the pages changed. This only rebuilds them, so it’s safe while the office runs.', commands: [`${cd}\nnpm run build:client`] },
      { kind: 'reload', title: 'Reload this page', why: 'No restart needed.' },
    ];
  }
  return [{ kind: 'nothing', title: 'Nothing else to do', why: has('docs') ? 'The new changes are only docs and tests.' : 'The office already has everything.' }];
}

// ---- Pull request titles, tidied ------------------------------------------------------------------

/** A PR title said plainly: no "feat(x):" or "WIP:" prefix, no trailing full stop, a capital first letter. */
export function tidyTitle(title: string): string {
  let t = title.trim().replace(/^(\[?wip\]?:?\s*)+/i, '');
  t = t.replace(/^(feat|fix|chore|docs|refactor|perf|test|tests|style|build|ci)(\([^)]*\))?!?:\s*/i, '');
  t = t.replace(/\s*\.+$/, '');
  return t ? t[0].toUpperCase() + t.slice(1) : title.trim();
}

/** "What's new": a line per pull request (tidied), and a count of other changes. */
export function newsLines(prs: UpdatePr[], other: number, max = 8): string[] {
  const lines = prs.slice(-max).map((p) => `${tidyTitle(p.title)} (#${p.number})`);
  if (prs.length > max) lines.unshift(`…and ${plural(prs.length - max, 'earlier pull request')}`);
  if (other) lines.push(`${plural(other, 'other change')}${prs.length ? '' : ' without a pull request'}`);
  return lines;
}

// ---- Which files may be committed ------------------------------------------------------------------

/** Over this, a file starts unticked. */
export const BIG_FILE = 5 * 1024 * 1024;

const NEVER = new Set(['.agent-office', 'node_modules', 'dist', 'worktrees']);
const CODE = /\.(ts|tsx|js|mjs|cjs|jsx|cs|py|go|rs|java|rb|css|html|md)$/i;

/** Why a path can never be committed from here, or undefined. */
export function blockedReason(p: string): string | undefined {
  const parts = p.replace(/\\/g, '/').split('/');
  if (p.endsWith('/')) return 'another Git repository inside this one';
  const hit = parts.slice(0, -1).find((s) => NEVER.has(s)) ?? (NEVER.has(parts[parts.length - 1]) ? parts[parts.length - 1] : undefined);
  if (!hit) return undefined;
  if (hit === '.agent-office') return 'the office’s own data (.agent-office)';
  if (hit === 'worktrees') return 'a worker’s worktree';
  if (hit === 'node_modules') return 'installed packages (node_modules)';
  return 'build output (dist)';
}

/** Why a path looks secret or personal by its name alone, or undefined. */
export function riskyName(p: string): string | undefined {
  const base = p.replace(/\\/g, '/').split('/').pop() ?? p;
  const lower = base.toLowerCase();
  if (/^\.env(\..*)?$/.test(lower) || lower.endsWith('.env')) return 'an environment file (may hold passwords or keys)';
  if (/\.(pem|key|p12|pfx|keystore|jks|kdbx|ppk|asc|gpg)$/.test(lower)) return 'looks like a key or certificate';
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(lower)) return 'an SSH key';
  if (/^(pw|pwd|passwords?|passwd)(\.[a-z0-9]+)?$/.test(lower)) return 'looks like a password file';
  if (/^\.(npmrc|netrc|pypirc|git-credentials)$/.test(lower)) return 'may hold login tokens';
  if (!CODE.test(lower) && /(^|[-_. ])(credentials?|secrets?|tokens?|passwords?|api[-_]?keys?|client[-_]secret)([-_. ]|$)/.test(lower)) return 'the name says it holds credentials';
  return undefined;
}

/** Credentials that turn up in text: private keys and the usual API token shapes. */
const SECRET_TEXT: [RegExp, string][] = [
  [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/, 'a private key'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/, 'a GitHub token'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic API key'],
  [/\bxai-[A-Za-z0-9]{40,}/, 'an xAI API key'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/, 'an API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bnpm_[A-Za-z0-9]{36,}\b/, 'an npm token'],
];

/** What secret-looking text contains, or undefined. */
export function riskyText(text: string): string | undefined {
  for (const [re, what] of SECRET_TEXT) if (re.test(text)) return `contains what looks like ${what}`;
  return undefined;
}

// ---- The commit's first line -------------------------------------------------------------------------

function names(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A plain commit message for these files: "Update a.ts and b.ts", "Add 5 files in src/client". */
export function suggestMessage(files: Pick<SyncFile, 'path' | 'status'>[]): string {
  if (!files.length) return '';
  const added = files.every((f) => f.status === '?' || f.status === 'A');
  const removed = files.every((f) => f.status === 'D');
  const verb = added ? 'Add' : removed ? 'Remove' : 'Update';
  const base = (p: string) => p.replace(/\/$/, '').split('/').pop() ?? p;
  if (files.length <= 3) return `${verb} ${names(files.map((f) => base(f.path)))}`;
  const dirs = files.map((f) => f.path.split('/').slice(0, -1));
  const common: string[] = [];
  for (let i = 0; dirs.every((d) => d.length > i && d[i] === dirs[0][i]); i++) common.push(dirs[0][i]);
  if (common.length) return `${verb} ${files.length} files in ${common.join('/')}`;
  const tops = [...new Set(files.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : 'the top folder')))];
  return tops.length <= 3 ? `${verb} ${files.length} files (${names(tops)})` : `${verb} ${files.length} files`;
}
