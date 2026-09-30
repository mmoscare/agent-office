// ✨ What's new, on the queue staffer's clipboard: every change that landed on a floor's working
// branch, newest first, each in a line of plain words for someone who doesn't program.
//
// Where from: the branch's first-parent git history, which holds every pull request's merge and every
// commit pushed straight to it (a merge of the same branch from elsewhere, like `git pull`, is read
// through to what it brought). On a GitHub floor, the pull requests merged into the branch, over REST
// (github-rest.ts: GraphQL's quota runs dry), give their titles, descriptions and links, and any merged
// since this computer last fetched.
//
// The plain words: a small model through the `claude` CLI, the same one-shot call that names the task
// cards (tasks.ts), a few changes a call, only for the changes someone is looking at, when they look.
// Each line is written once and kept in the floor's .agent-office/whats-new.json, under the commit and
// the pull request both, so it's never paid for twice. Until then, or without Claude, the change's
// own title, tidied up.

import { execFile } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeRepo } from '../shared/floors.js';
import { WHATS_NEW_MAX, WHATS_NEW_PAGE, type ChangeNote, type WhatsNew } from '../shared/whats-new.js';
import { gh } from './github.js';
import { mergedPulls, type MergedPull } from './github-rest.js';
import { run } from './tasks.js';

const STORE = 'whats-new.json';
/** First-parent commits read, at most. */
const HISTORY_MAX = 5000;
/** The history is read again after this. */
const GIT_STALE_MS = 20_000;
/** GitHub is asked again after this, and origin fetched. */
const GITHUB_STALE_MS = 2 * 60_000;
/** A pull request's description, as kept. */
const BODY_MAX = 1500;
/** What the model is told about one change, at most. */
const ABOUT_MAX = 1200;
const LINE_MAX = 260;
/** Changes put in plain words in one call, and calls at once. */
const BATCH = 6;
const CONCURRENCY = 2;
/** After this many failed calls in a row (not signed in, no network), stop asking for a while. */
const FAILS_BEFORE_BACKOFF = 3;
const BACKOFF_MS = 10 * 60_000;
/** Repositories read on a floor that's a folder of them. */
const SOURCES_MAX = 10;

/** gh, as github.ts runs it. */
type Query = (args: string[], cwd: string, timeout?: number) => Promise<string>;

/** A commit on the branch's line. */
export interface Commit {
  sha: string;
  parents: string[];
  /** When it was committed (ms). */
  at: number;
  subject: string;
  body: string;
}

/** A change as read from git and GitHub, before it's put in plain words. */
export interface Landed {
  /** The key it's shown under; its line is kept under each of `keys`. */
  key: string;
  keys: string[];
  at: number;
  title: string;
  /** The developer's notes on it, cleaned up ('' when there are none). */
  body: string;
  author?: boolean;
  url?: string;
  /** The commit that put it on the branch, when it's in the history. */
  sha?: string;
  parents?: string[];
}

// ---- Reading the history --------------------------------------------------------------------------

function git(args: string[], cwd: string, timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }, (err, out) =>
      err ? reject(err) : resolve(out),
    ),
  );
}

const gitMaybe = (args: string[], cwd: string) => git(args, cwd).then((out) => out.trim(), () => undefined);

const FORMAT = '%H%x1f%P%x1f%ct%x1f%s%x1f%b%x1e';

async function firstParents(dir: string, range: string[], max = HISTORY_MAX): Promise<Commit[]> {
  const out = await git(['log', '--first-parent', `--max-count=${max}`, `--format=${FORMAT}`, ...range, '--'], dir, 60_000);
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\r?\n/, ''))
    .filter((r) => r.includes('\x1f'))
    .map((r) => {
      const [sha, parents, at, subject, body] = r.split('\x1f');
      return { sha, parents: parents ? parents.split(' ') : [], at: Number(at) * 1000, subject: subject ?? '', body: (body ?? '').trim() };
    });
}

/** The branch a checkout's changes land on: the one it has checked out, else origin's default. */
export async function workingBranch(dir: string): Promise<string | undefined> {
  const head = await gitMaybe(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  if (head && head !== 'HEAD') return head;
  return (await gitMaybe(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir))?.replace(/^origin\//, '') || undefined;
}

/** The newest the branch is on this computer: here or as last fetched, whichever has the other; GitHub's when they've parted. */
async function tipOf(dir: string, branch: string | undefined): Promise<string | undefined> {
  if (!branch) return gitMaybe(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], dir);
  const [local, remote] = await Promise.all([
    gitMaybe(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], dir),
    gitMaybe(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`], dir),
  ]);
  if (!local || !remote || local === remote) return local || remote;
  return (await gitMaybe(['merge-base', '--is-ancestor', remote, local], dir)) !== undefined ? local : remote;
}

const MERGED_PR = /^Merge pull request #(\d+) from (\S+)/i;
const MERGED_PR_BY_HAND = /^Merge (?:PR|pull request) #(\d+)\b[\s:-]*(.*)$/i;
const SQUASHED = /\s\(#(\d+)\)$/;
const MERGED_REF = /^Merge (?:remote-tracking branch |branch |tag )?'?([^'\s]+)'?/i;
const AUTHOR_TITLE = /\b(?:author'?s?|upstream)\b.*\blatest\b|\blatest\b.*\b(?:author|upstream)\b|^(?:sync|bring in)\b.*\bupstream\b/i;
const AUTHOR_HEAD = /^(?:sync\/)?upstream[-/]\d/i;

/** What a merge commit merged, from its message: a branch name, maybe with its remote. */
function mergedRef(subject: string): string | undefined {
  if (MERGED_PR.test(subject) || MERGED_PR_BY_HAND.test(subject)) return undefined;
  return MERGED_REF.exec(subject)?.[1];
}

/** A ref without refs/heads/, refs/remotes/ and its remote's name. */
function branchOf(ref: string): string {
  return ref.replace(/^refs\/(?:heads|remotes)\//, '').replace(/^(?:origin|upstream)\//, '');
}

function sameBranch(ref: string, branch: string): boolean {
  return branchOf(ref) === branch;
}

/** The original author's code: their main, or anything from the upstream remote, merged into another branch. */
function authorRef(ref: string, branch: string | undefined): boolean {
  if (/^(?:refs\/remotes\/)?upstream\//.test(ref)) return true;
  const b = branchOf(ref);
  return (b === 'main' || b === 'master') && b !== branch;
}

/**
 * The branch's line, newest first: its first parents, except that a merge of the branch itself (a
 * `git pull` of it) is read through to what that brought.
 */
async function branchLine(dir: string, range: string[], branch: string | undefined, depth = 0): Promise<Commit[]> {
  const out: Commit[] = [];
  for (const c of await firstParents(dir, range)) {
    const ref = c.parents.length > 1 ? mergedRef(c.subject) : undefined;
    if (ref && branch && sameBranch(ref, branch) && depth < 2) out.push(...(await branchLine(dir, [c.parents[1], `^${c.parents[0]}`], branch, depth + 1)));
    else out.push(c);
  }
  return out;
}

/**
 * The changes on a branch's line, newest first, with what GitHub says of the pull requests merged
 * into it (`pulls`, `web` its repository's page). A commit is its own change, told of by the pull
 * request it merged when GitHub (or its message) says which; pull requests merged after the newest
 * commit here (not fetched yet) come too. Keys never depend on GitHub answering, so a line kept for
 * one change is never shown for another.
 */
export function landedChanges(commits: Commit[], branch: string | undefined, pulls: MergedPull[] = [], web?: string): Landed[] {
  const inHistory = new Set(commits.map((c) => c.sha));
  const bySha = new Map(pulls.filter((p) => p.sha).map((p) => [p.sha!, p]));
  const used = new Set<number>();
  const owner = new Map<string, MergedPull>();
  // The commits GitHub itself says merged a pull request, first.
  for (const c of commits) {
    const p = bySha.get(c.sha);
    if (p && !used.has(p.number)) {
      used.add(p.number);
      owner.set(c.sha, p);
    }
  }
  // Then pull requests merged by hand, whose merge GitHub doesn't know: by number and branch.
  const unplaced = (n: number) => pulls.find((p) => p.number === n && !used.has(n) && !(p.sha && inHistory.has(p.sha)));
  const out: Landed[] = [];
  for (const c of commits) {
    const merge = c.parents.length > 1;
    let title = c.subject;
    let author = false;
    let pull = owner.get(c.sha);
    const viaGitHub = merge ? MERGED_PR.exec(c.subject) : null;
    const byHand = merge && !viaGitHub ? MERGED_PR_BY_HAND.exec(c.subject) : null;
    const squashed = !merge ? SQUASHED.exec(c.subject) : null;
    const ref = merge ? mergedRef(c.subject) : undefined;
    if (viaGitHub) {
      title = c.body.split('\n')[0].trim() || title;
      const head = viaGitHub[2].replace(/^[^/]+\//, '');
      const p = pull ? undefined : unplaced(Number(viaGitHub[1]));
      if (p && p.head === head) pull = p;
    } else if (byHand) {
      title = byHand[2].trim() || title;
      pull ??= unplaced(Number(byHand[1]));
    } else if (squashed) {
      title = c.subject.slice(0, squashed.index);
    } else if (ref) {
      author = authorRef(ref, branch);
      if (!pull) pull = pulls.find((p) => !used.has(p.number) && p.head === branchOf(ref) && !(p.sha && inHistory.has(p.sha)));
    }
    if (pull) {
      used.add(pull.number);
      title = pull.title || title;
    }
    author ||= AUTHOR_TITLE.test(title) || (!!pull && AUTHOR_HEAD.test(pull.head));
    const keys = [`commit:${c.sha}`, ...(pull ? [`pr:${pull.number}`] : [])];
    out.push({
      key: keys[0],
      keys,
      at: pull ? pull.mergedAt : c.at,
      title,
      body: cleanNotes(pull ? pull.body : c.body),
      ...(author ? { author } : {}),
      url: pull?.url || (web ? `${web}/commit/${c.sha}` : undefined),
      sha: c.sha,
      parents: c.parents,
    });
  }
  // Merged on GitHub since this computer last fetched.
  const newest = Math.max(0, ...commits.map((c) => c.at));
  for (const p of pulls) {
    if (used.has(p.number) || (p.sha && inHistory.has(p.sha)) || p.mergedAt <= newest) continue;
    used.add(p.number);
    const keys = [`pr:${p.number}`, ...(p.sha ? [`commit:${p.sha}`] : [])];
    out.push({ key: keys[0], keys, at: p.mergedAt, title: p.title, body: cleanNotes(p.body), ...(AUTHOR_TITLE.test(p.title) || AUTHOR_HEAD.test(p.head) ? { author: true } : {}), url: p.url });
  }
  // Newest first; the branch's own order where the times are the same.
  return out.map((l, i) => ({ l, i })).sort((a, b) => b.l.at - a.l.at || a.i - b.i).map(({ l }) => l);
}

// ---- Plain words ----------------------------------------------------------------------------------

/** A developer's notes without the markup, pictures, code and sign-offs. */
export function cleanNotes(text: string, max = BODY_MAX): string {
  const clean = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/^.*Generated with \[?Claude Code.*$/gim, '')
    .replace(/^Co-Authored-By:.*$/gim, '')
    .replace(/^\s*#+\s*/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** A title as a sentence, without the developer's shorthand: shown until the change is in plain words. */
export function tidyTitle(title: string, author?: boolean): string {
  if (author) return "Brought in the original author's latest updates.";
  // git's own words for a merge of a branch nobody opened a pull request for.
  const merged = /^Merge (?:remote-tracking branch |branch |tag )'([^']+)'|^Merge ((?:origin|upstream)\/\S+)/i.exec(title.trim());
  if (merged) return `Brought in the work on “${branchOf(merged[1] ?? merged[2])}”.`;
  const t = title
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:\[[^\]]*\]\s*)+/, '')
    .replace(/^(?:wip|feat|feature|fix|bugfix|hotfix|chore|docs|refactor|test|tests|perf|style|build|ci)(?:\([^)]*\))?!?\s*:\s*/i, '')
    .replace(/\s*\((?:#\d+[,\s]*)+\)$/, '')
    .replace(/[\s.;:,-]+$/, '');
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}.` : 'A change without a description.';
}

function tidyLine(s: string): string {
  let t = s.replace(/\s+/g, ' ').replace(/^["'\s]+|["'\s]+$/g, '').trim();
  if (!t) return '';
  if (t.length > LINE_MAX) t = `${t.slice(0, LINE_MAX - 1).trimEnd()}…`;
  else if (!/[.!?…]$/.test(t)) t += '.';
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
}

/** One change, as the model is told of it. */
export interface PlainInput {
  title: string;
  about: string;
  author?: boolean;
}

/** Puts a few changes in plain words in one go: a line for each (by position, where it wrote one), or null when it couldn't. */
export type Summarize = (items: PlainInput[]) => Promise<(string | undefined)[] | null>;

const SYSTEM = `You write the "What's new" list of a piece of software for someone who uses it but doesn't program.
You get a few changes, each with an id, the title its developer gave it and some of the developer's notes. For each change, write one or two short sentences about what the reader can now do or see, or what now works better, the way they'd notice it.

Examples of the style:
- You now have a notepad you can click to jot notes down.
- Each worker now shows its company's logo above its task card.
- Hiring a worker no longer gets stuck waiting for the repository list.

Rules:
- Plain, friendly, everyday words. Talk to the reader as "you" where it fits.
- No jargon: never say pull request, PR, merge, branch, commit, refactor, repository, repo, API, endpoint, CLI, script, test suite or upstream, and never name files, functions, settings keys or code.
- Say what changed for the person, not how it was built. Leave out ticket numbers and commit hashes.
- When a change brings in the original author's latest updates, begin with "The original author's latest updates:" and name the one to three things the reader would notice most.
- When nothing a person would notice changed (tests, tidying, bookkeeping), say so in a few words, like "Behind-the-scenes tidy-up; nothing looks different."
- At most 220 characters each. Don't begin with "This change".
Return every id exactly as given, each with its line.`;

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, line: { type: 'string' } }, required: ['id', 'line'], additionalProperties: false },
    },
  },
  required: ['lines'],
  additionalProperties: false,
});

/** What the model is given: each change as c1, c2, … */
export function describeChanges(items: PlainInput[]): string {
  return items
    .map((it, i) =>
      [`Change c${i + 1}`, `Title: ${it.title}`, it.author ? "(This brings in the original author's latest updates.)" : '', it.about ? `Notes:\n${it.about}` : ''].filter(Boolean).join('\n'),
    )
    .join('\n\n');
}

/** The model's answer (the CLI's JSON output) as a line per change, by position. */
export function parseLines(out: string, n: number): (string | undefined)[] | null {
  try {
    const res = JSON.parse(out);
    if (res?.is_error) return null;
    let v = res?.structured_output;
    if (!v && typeof res?.result === 'string') v = JSON.parse(res.result.trim().replace(/^```(?:json)?|```$/g, ''));
    const lines: (string | undefined)[] = new Array(n).fill(undefined);
    for (const l of Array.isArray(v?.lines) ? v.lines : []) {
      const i = Number(/^c(\d+)$/i.exec(String(l?.id ?? '').trim())?.[1]) - 1;
      const text = tidyLine(String(l?.line ?? ''));
      if (i >= 0 && i < n && text) lines[i] = text;
    }
    return lines.some(Boolean) ? lines : null;
  } catch {
    return null;
  }
}

/** The small model through the `claude` CLI (tasks.ts's call), or null without it. */
export function claudeSummarizer(claude: string | null, env: Record<string, string>): Summarize | null {
  if (!claude) return null;
  return async (items) => {
    const out = await run(claude, env, SYSTEM, describeChanges(items), SCHEMA);
    return out === null ? null : parseLines(out, items.length);
  };
}

interface Job {
  /** Unique across the building: the floor's, then the change's key. */
  id: string;
  input: () => Promise<PlainInput>;
  done: (text: string) => void;
}

/**
 * Puts changes in plain words for every floor: only those asked for, a few a call, a couple of calls
 * at a time, each asked for once while it's waiting. After a few failures in a row it rests a while.
 */
export class PlainWriter {
  private queue: Job[] = [];
  private waiting = new Set<string>();
  private running = 0;
  private fails = 0;
  private pausedUntil = 0;

  /** @param budgetSpent whether today's budget is spent (⚙️ Settings), when nothing new is written */
  constructor(
    private summarize: Summarize | null,
    private budgetSpent: () => boolean = () => false,
  ) {}

  /** Why nothing is being put in plain words right now, when that's so. */
  get resting(): string | undefined {
    if (!this.summarize) return "Claude isn't set up on the office's computer, so these are the changes' own titles, tidied up.";
    if (Date.now() < this.pausedUntil) return "Claude didn't answer (is it signed in?), so some of these are the changes' own titles, tidied up. They'll be rewritten another time.";
    if (this.budgetSpent()) return "Today's budget is spent, so new lines wait until tomorrow. Until then these are the changes' own titles, tidied up.";
    return undefined;
  }

  want(jobs: Job[]) {
    if (this.resting) return;
    for (const j of jobs) {
      if (this.waiting.has(j.id)) continue;
      this.waiting.add(j.id);
      this.queue.push(j);
    }
    this.pump();
  }

  /** How many of `prefix`'s are waiting or being written. */
  writing(prefix: string): number {
    let n = 0;
    for (const id of this.waiting) if (id.startsWith(prefix)) n++;
    return n;
  }

  private pump() {
    while (this.running < CONCURRENCY && this.queue.length) {
      const batch = this.queue.splice(0, BATCH);
      this.running++;
      void this.write(batch).finally(() => {
        this.running--;
        for (const j of batch) this.waiting.delete(j.id);
        this.pump();
      });
    }
  }

  private async write(batch: Job[]) {
    if (this.resting) return;
    const inputs = await Promise.all(batch.map((j) => j.input()));
    const lines = await this.summarize!(inputs).catch(() => null);
    if (!lines) {
      if (++this.fails >= FAILS_BEFORE_BACKOFF) {
        this.fails = 0;
        this.pausedUntil = Date.now() + BACKOFF_MS;
        // The rest would fail too: they're asked for again next time someone looks.
        for (const j of this.queue) this.waiting.delete(j.id);
        this.queue = [];
      }
      return;
    }
    this.fails = 0;
    lines.forEach((text, i) => text && batch[i].done(text));
  }
}

// ---- A floor's list -------------------------------------------------------------------------------

/** A repository the floor's changes are read from: the floor itself, or one of the checkouts in its folder. */
export interface Source {
  dir: string;
  /** owner/name, on a floor of several. */
  repo?: string;
}

interface PullCache {
  base: string;
  web: string;
  syncedAt: number;
  items: MergedPull[];
}

interface Stored {
  /** The plain words, by `pr:<n>` and `commit:<sha>` (after `owner/name ` on a floor of several). */
  lines: Record<string, { text: string; at: number }>;
  /** What GitHub said of the merged pull requests, by repository ('' on a floor that is one). */
  pulls: Record<string, PullCache>;
}

function load(file: string): Stored {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return { lines: v?.lines && typeof v.lines === 'object' ? v.lines : {}, pulls: v?.pulls && typeof v.pulls === 'object' ? v.pulls : {} };
  } catch {
    return { lines: {}, pulls: {} };
  }
}

interface Read {
  list: (Landed & { dir: string; repo?: string })[];
  branch?: string;
  error?: string;
  at: number;
}

export interface ChangeNotesOptions {
  /** gh, for the REST calls (tests pass their own). */
  query?: Query;
  /** Brings origin's copy of the branch up to date (tests pass their own). */
  fetch?: (dir: string, branch: string) => Promise<void>;
}

async function fetchBranch(dir: string, branch: string) {
  await git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], dir, 60_000).catch(() => undefined);
}

/** One floor's ✨ What's new: read quickly from git, brought up to date from GitHub in the background. */
export class ChangeNotes {
  private file: string;
  private stored: Stored;
  private read?: Read;
  private reading?: Promise<Read>;
  private refreshing?: Promise<void>;
  private githubAt = 0;
  private githubError?: string;
  private query: Query;
  private fetchBranch: (dir: string, branch: string) => Promise<void>;

  constructor(
    private floorId: string,
    dataDir: string,
    private sources: () => Source[],
    private writer: PlainWriter,
    opts: ChangeNotesOptions = {},
  ) {
    this.file = path.join(dataDir, STORE);
    this.stored = load(this.file);
    this.query = opts.query ?? gh;
    this.fetchBranch = opts.fetch ?? fetchBranch;
  }

  /** The newest `show` changes, each in plain words or on its way there. Never waits for Claude or GitHub. */
  async list(show = WHATS_NEW_PAGE): Promise<WhatsNew> {
    show = Math.min(WHATS_NEW_MAX, Math.max(1, Math.floor(show) || WHATS_NEW_PAGE));
    if (!this.read || (Date.now() - this.read.at > GIT_STALE_MS && !this.refreshing)) await this.fromGit();
    if (Date.now() - this.githubAt > GITHUB_STALE_MS && !this.refreshing) this.refresh();
    const read = this.read!;
    const prefix = `${this.floorId}|`;
    const shown = read.list.slice(0, show);
    // The first time GitHub is asked, its descriptions make better lines: they're written once it answers.
    const firstLook = this.refreshing && !Object.keys(this.stored.pulls).length;
    if (!firstLook) {
      this.writer.want(
        shown
          .filter((l) => !this.line(l))
          .map((l) => ({ id: prefix + l.key, input: () => this.input(l), done: (text: string) => this.keep(l, text) })),
      );
    }
    const multi = this.sources().length > 1;
    const notes: ChangeNote[] = shown.map((l) => {
      const line = this.line(l);
      return {
        key: l.key,
        at: l.at,
        text: line ?? tidyTitle(l.title, l.author),
        plain: !!line,
        title: l.title,
        ...(l.author ? { author: true } : {}),
        ...(l.url ? { url: l.url } : {}),
        ...(multi && l.repo ? { repo: l.repo } : {}),
      };
    });
    const resting = this.writer.resting;
    return {
      floor: this.floorId,
      ...(read.branch ? { branch: read.branch } : {}),
      notes,
      total: read.list.length,
      writing: this.writer.writing(prefix),
      refreshing: !!this.refreshing,
      ...(resting && notes.some((n) => !n.plain) ? { writer: resting } : {}),
      ...(read.error || this.githubError ? { error: [read.error, this.githubError].filter(Boolean).join(' ') } : {}),
    };
  }

  /** Waits for GitHub to be asked (for tests, and for whoever wants the list complete). */
  async settled(): Promise<void> {
    while (this.refreshing) await this.refreshing;
  }

  private line(l: Landed): string | undefined {
    for (const k of l.keys) {
      const v = this.stored.lines[k];
      if (typeof v?.text === 'string' && v.text) return v.text;
    }
    return undefined;
  }

  private keep(l: Landed, text: string) {
    const at = Date.now();
    for (const k of l.keys) this.stored.lines[k] = { text, at };
    this.save();
  }

  private save() {
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.stored));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error(`agent-office: couldn't save ${STORE}: ${(err as Error).message}`);
    }
  }

  /** What the model is told of a change: its notes, and for a merge with few notes, what the merge brought in. */
  private async input(l: Landed & { dir: string }): Promise<PlainInput> {
    const now = this.read?.list.find((x) => x.key === l.key) ?? l;
    let about = now.body;
    if (now.parents && now.parents.length > 1 && about.length < 200) {
      const brought = await gitMaybe(['log', '--no-merges', '--max-count=25', '--format=%s', `${now.parents[0]}..${now.parents[1]}`, '--'], now.dir);
      const subjects = brought?.split('\n').filter(Boolean) ?? [];
      if (subjects.length) about = `${about}\nWhat it brought in:\n${subjects.map((s) => `- ${s}`).join('\n')}`.trim();
    }
    return { title: now.title, about: about.length > ABOUT_MAX ? `${about.slice(0, ABOUT_MAX - 1)}…` : about, ...(now.author ? { author: true } : {}) };
  }

  private fromGit(): Promise<Read> {
    this.reading ??= (async () => {
      const sources = this.sources().slice(0, SOURCES_MAX);
      const multi = sources.length > 1;
      const list: Read['list'] = [];
      const errors: string[] = [];
      let branch: string | undefined;
      for (const src of sources) {
        try {
          const b = await workingBranch(src.dir);
          const tip = await tipOf(src.dir, b);
          if (!tip) throw new Error('it has no commits yet');
          const cache = this.stored.pulls[src.repo ?? ''];
          const origin = normalizeRepo(await gitMaybe(['remote', 'get-url', 'origin'], src.dir));
          const web = cache?.web ?? (origin ? `https://github.com/${origin}` : undefined);
          const changes = landedChanges(await branchLine(src.dir, [tip], b), b, cache && cache.base === b ? cache.items : [], web);
          const prefix = multi && src.repo ? `${src.repo} ` : '';
          for (const c of changes) list.push({ ...c, key: prefix + c.key, keys: c.keys.map((k) => prefix + k), dir: src.dir, ...(src.repo ? { repo: src.repo } : {}) });
          if (!multi) branch = b;
        } catch (err) {
          const why = (err as Error).message || String(err);
          errors.push(/not a git repository/i.test(why) ? "This floor's folder isn't a git repository, so there's no history to read." : `${src.repo ?? 'This floor'}: its history couldn't be read (${why.split('\n')[0]}).`);
        }
      }
      if (multi) list.sort((a, b) => b.at - a.at);
      if (!sources.length) errors.push('There is nothing on this floor to read changes from yet.');
      return { list, branch, error: errors.join(' ') || undefined, at: Date.now() };
    })();
    const reading = this.reading;
    return reading.then(
      (r) => {
        this.read = r;
        this.reading = undefined;
        return r;
      },
      (err) => {
        this.reading = undefined;
        throw err;
      },
    );
  }

  /** In the background: origin fetched and GitHub asked, then the history read again. */
  private refresh() {
    this.githubAt = Date.now();
    this.refreshing = (async () => {
      const errors: string[] = [];
      let answered = false;
      for (const src of this.sources().slice(0, SOURCES_MAX)) {
        const origin = normalizeRepo(await gitMaybe(['remote', 'get-url', 'origin'], src.dir));
        const branch = origin ? await workingBranch(src.dir) : undefined;
        if (!origin || !branch) continue;
        await this.fetchBranch(src.dir, branch);
        const key = src.repo ?? '';
        const cache = this.stored.pulls[key];
        const same = cache?.base === branch;
        const asked = Date.now();
        try {
          // After the first time, only what changed since (with some slack for GitHub's clock).
          const r = await mergedPulls(branch, src.dir, this.query, same ? cache.syncedAt - 10 * 60_000 : 0);
          const byNumber = new Map((same ? cache.items : []).map((p) => [p.number, p]));
          for (const p of r.pulls) byNumber.set(p.number, { ...p, body: cleanNotes(p.body) });
          this.stored.pulls[key] = { base: branch, web: r.web, syncedAt: asked, items: [...byNumber.values()].sort((a, b) => b.mergedAt - a.mergedAt) };
          answered = true;
        } catch (err) {
          errors.push(`GitHub didn't answer just now (${((err as Error).message || 'no answer').split('\n')[0]}), so this is what this computer already knew.`);
        }
      }
      this.githubError = errors[0];
      if (answered) this.save();
      await this.fromGit();
    })()
      .catch((err) => {
        this.githubError = `The list couldn't be brought up to date (${(err as Error).message}).`;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
  }
}
