import { execFile, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkerWorkspace, WorkspaceRepositories, WorkspaceRequest, RepositoryWorktree } from '../shared/workspaces.js';
import type { WorktreeState } from '../shared/protocol.js';
import { gitError, Worktrees } from './worktrees.js';
import { excludeFromGit } from './config.js';
import { workspaceBranches, workspaceStart } from './workspace-branches.js';

const exec = promisify(execFile);
export const WORKSPACES_DIR = path.join('.agent-office', 'workspaces');
const SKIP = new Set(['.git', '.agent-office', 'node_modules', 'vendor', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', '.cache']);
const MAX_REPOSITORIES = 12;

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, windowsHide: true }).trim();
}

function within(root: string, dir: string): boolean {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.split(path.sep).includes('..') && !path.isAbsolute(rel));
}

/** Give gh an explicit host/owner/repo, regardless of HTTPS vs SSH or a stored gh default. */
export function workspaceGitHubRepo(remote: string): string {
  let host: string;
  let pathname: string;
  const ssh = /^(?:[^/@:]+@)?([^/:]+):([^/].*)$/.exec(remote);
  if (ssh && !remote.includes('://')) { host = ssh[1]; pathname = ssh[2]; }
  else {
    const url = new URL(remote);
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol)) throw new Error('This repository needs a GitHub origin remote to open a PR');
    host = url.host;
    pathname = url.pathname;
  }
  const parts = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/');
  if (parts.length !== 2 || parts.some(p => !/^[\w.-]+$/.test(p) || p === '.' || p === '..')) throw new Error('This repository needs a GitHub origin remote to open a PR');
  return `${host}/${parts.join('/')}`;
}

/** Refuse paths outside the floor, aliases, and directories inside a repo instead of its root. */
function source(floor: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => p === '..' || p === '.agent-office')) throw new Error('Choose a repository inside this floor');
  const root = realpathSync(floor);
  const dir = realpathSync(path.resolve(root, relative));
  if (!within(root, dir) || path.relative(root, dir).split(path.sep).some(p => p.toLowerCase() === '.agent-office') || !existsSync(path.join(dir, '.git'))) throw new Error(`Not a repository inside this floor: ${relative}`);
  if (path.relative(dir, realpathSync(git(dir, ['rev-parse', '--show-toplevel']))) !== '') throw new Error(`Choose the repository root: ${relative}`);
  return dir;
}

/** Bounded discovery, ignoring dependency trees and directory links. Never follows a link outside a floor. */
export async function workspaceRepositories(floor: string): Promise<WorkspaceRepositories> {
  const root = realpathSync(floor);
  const result: WorkspaceRepositories = { repositories: [], truncated: false };
  let visited = 0;
  async function walk(dir: string, depth: number) {
    if (++visited > 1500 || result.repositories.length >= 50) { result.truncated = true; return; }
    if (existsSync(path.join(dir, '.git'))) {
      const relative = path.relative(root, dir).split(path.sep).join('/') || '.';
      try {
        source(root, relative);
        const opts = { cwd: dir, encoding: 'utf8' as const, timeout: 10_000, windowsHide: true };
        const [head, status, branches] = await Promise.all([
          exec('git', ['rev-parse', '--verify', 'HEAD'], opts),
          exec('git', ['status', '--porcelain=v1', '-z', '-unormal'], opts),
          workspaceBranches(dir),
        ]);
        if (!head.stdout.trim()) throw new Error('No commits yet');
        const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
        result.repositories.push({ path: relative, name: path.basename(dir), branch: branch === 'HEAD' ? undefined : branch, branches, dirty: status.stdout.split('\0').filter(Boolean).length });
      } catch (err) {
        result.repositories.push({ path: relative, name: path.basename(dir), dirty: 0, error: gitError(err) });
      }
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(e.name) || e.name.startsWith('.') || !e.isDirectory() || e.isSymbolicLink()) continue;
      if (depth >= 4) { result.truncated = true; continue; }
      const child = path.join(dir, e.name);
      if ((await lstat(child)).isSymbolicLink()) continue;
      await walk(child, depth + 1);
      if (visited > 1500 || result.repositories.length >= 50) break;
    }
  }
  await walk(root, 0);
  return result;
}

export function workspaceBrief(workspace: WorkerWorkspace): string {
  return [
    '# Agent Office workspace',
    '',
    'This desk has a separate Git worktree for each repository listed below. Work from this workspace folder.',
    ...workspace.repositories.map(r => `- ${JSON.stringify(r.repository)}: worktree ${JSON.stringify(path.relative(workspace.path, r.path).split(path.sep).join('/'))}, branch ${JSON.stringify(r.branch)}, source branch ${JSON.stringify(r.fromRef?.replace(/^refs\/(heads|remotes)\//, '') ?? r.from ?? 'detached HEAD')}.`),
    '',
    'Make all task edits inside these worktrees. Do not edit, switch branches in, stash, reset, or clean the original checkouts. Existing uncommitted changes were NOT copied here.',
    'Read each repository\'s own instructions. Install dependencies and configure local services inside the worktrees as needed; ignored files and credentials are not copied automatically.',
    'If the task spans repositories, update and test them together. Commit separately in each repository. Each repository needs its own pull request. Do not merge or push unless asked.',
    'If another repository is needed, ask the user to add it with the desk\'s Add repositories action before editing it. Never fall back to its original checkout.',
    '',
  ].join('\n');
}

/** Multi-repository workspaces are kept separate from upstream's single-repo Worktrees helper. */
export class Workspaces {
  constructor(private floor: string) {}

  create(slug: string, request: WorkspaceRequest): WorkerWorkspace | string {
    return this.add({ path: path.join(WORKSPACES_DIR, slug), repositories: [] }, request);
  }

  /** Preflight every repo before creating any branch. Roll back only newly made, still-clean trees. */
  add(workspace: WorkerWorkspace, request: WorkspaceRequest): WorkerWorkspace | string {
    const made: RepositoryWorktree[] = [];
    try {
      if (!request || !Array.isArray(request.repositories) || !request.repositories.length || request.repositories.length + workspace.repositories.length > MAX_REPOSITORIES || request.repositories.some(r => typeof r !== 'string' || r.length > 2048)) throw new Error(`Choose between 1 and ${MAX_REPOSITORIES} repositories`);
      if (request.startRefs !== undefined && (!request.startRefs || typeof request.startRefs !== 'object' || Array.isArray(request.startRefs) || Object.entries(request.startRefs).some(([repo, ref]) => !request.repositories.includes(repo) || typeof ref !== 'string'))) throw new Error('Choose a starting branch for a selected repository');
      const branch = request.branch === undefined || request.branch === '' ? workspace.repositories[0]?.branch ?? `office/${path.basename(workspace.path)}` : request.branch;
      if (typeof branch !== 'string' || branch.length > 200 || branch.startsWith('-')) throw new Error('Enter a valid new branch name');
      const common = new Set(workspace.repositories.map(r => git(source(this.floor, r.repository), ['rev-parse', '--path-format=absolute', '--git-common-dir']).toLowerCase()));
      const refs = request.repositories.map(relative => {
        const dir = source(this.floor, relative);
        const repository = path.relative(realpathSync(this.floor), dir).split(path.sep).join('/') || '.';
        const key = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).toLowerCase();
        if (common.has(key)) throw new Error(`Already selected this repository: ${relative}`);
        common.add(key);
        if (git(dir, ['check-ref-format', '--branch', branch]) !== branch) throw new Error('Enter a literal new branch name');
        let present = false;
        try { git(dir, ['show-ref', '--verify', `refs/heads/${branch}`]); present = true; } catch { /* new branch */ }
        if (present) throw new Error(`${repository} already has branch ${branch}. Choose a new branch name.`);
        const startRef = request.startRefs && Object.hasOwn(request.startRefs, relative) ? request.startRefs[relative] : undefined;
        const start = startRef === undefined
          ? { base: git(dir, ['rev-parse', '--verify', 'HEAD']), from: new Worktrees(dir).currentBranch() }
          : workspaceStart(dir, startRef);
        const rel = path.join(workspace.path, repository === '.' ? 'project' : repository);
        if (existsSync(path.join(this.floor, rel))) throw new Error(`Workspace folder already exists: ${rel}`);
        return { repository, name: path.basename(dir), path: rel, branch, ...start };
      });
      const root = this.root(workspace);
      mkdirSync(root, { recursive: true });
      for (const ref of refs) {
        const dir = source(this.floor, ref.repository);
        // Record branch ownership before checkout, so a failed checkout can be rolled back too.
        git(dir, ['branch', '--no-track', ref.branch, ref.base]);
        made.push(ref);
        git(dir, ['worktree', 'add', path.join(this.floor, ref.path), ref.branch]);
      }
      const result = { ...workspace, repositories: [...workspace.repositories, ...made] };
      this.save(result);
      return result;
    } catch (err) {
      const retained: string[] = [];
      for (const ref of made.reverse()) {
        try {
          const dir = source(this.floor, ref.repository);
          const cwd = path.join(this.floor, ref.path);
          if (existsSync(cwd)) {
            if (git(cwd, ['status', '--porcelain']) || git(cwd, ['rev-parse', 'HEAD']) !== ref.base) throw new Error('contains work');
            git(dir, ['worktree', 'remove', cwd]);
          }
          if (git(dir, ['rev-parse', `refs/heads/${ref.branch}`]) !== ref.base) throw new Error('branch contains work');
          git(dir, ['branch', '-D', ref.branch]);
        } catch { retained.push(ref.path); }
      }
      if (made.length && workspace.repositories.length) {
        try { this.save(workspace); } catch { /* original worker metadata remains in workers.json */ }
      }
      return `Could not create workspace: ${gitError(err)}${retained.length ? ` Kept work at: ${retained.join(', ')}` : ''}`;
    }
  }

  /** Re-check on every launch and Git action, so a missing worktree never falls back to the originals. */
  check(workspace: WorkerWorkspace, ref?: RepositoryWorktree): string {
    const root = this.root(workspace);
    for (const r of ref ? [ref] : workspace.repositories) {
      const cwd = path.resolve(this.floor, r.path);
      if (!within(root, cwd) || cwd === root || !existsSync(cwd) || !within(realpathSync(root), realpathSync(cwd))) throw new Error(`Worktree is missing or outside the workspace: ${r.path}`);
      const dir = source(this.floor, r.repository);
      if (path.relative(realpathSync(cwd), realpathSync(git(cwd, ['rev-parse', '--show-toplevel']))) !== '') throw new Error(`Not a worktree root: ${r.path}`);
      if (git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) throw new Error(`Wrong repository at ${r.path}`);
      if (git(cwd, ['symbolic-ref', '--short', 'HEAD']) !== r.branch) throw new Error(`${r.name} is no longer on ${r.branch}. Switch it back before using the desk's Git actions.`);
    }
    return root;
  }

  async inspect(workspace: WorkerWorkspace): Promise<WorktreeState> {
    const states = await Promise.all(workspace.repositories.map(async ref => {
      try {
        this.check(workspace, ref);
        const dir = source(this.floor, ref.repository);
        return { repository: ref.repository, ...await new Worktrees(dir).inspect({ ...ref, path: path.relative(dir, path.join(this.floor, ref.path)) }) };
      } catch (err) { return { repository: ref.repository, exists: false, dirty: 0, ahead: 0, unpushed: 0, error: gitError(err) }; }
    }));
    return { exists: states.every(s => s.exists), dirty: states.reduce((n, s) => n + s.dirty, 0), ahead: states.reduce((n, s) => n + s.ahead, 0), unpushed: states.reduce((n, s) => n + s.unpushed, 0), error: states.filter(s => s.error).map(s => `${s.repository}: ${s.error}`).join('; ') || undefined, repositories: states };
  }

  async remove(workspace: WorkerWorkspace, cleanup: 'worktree' | 'all'): Promise<string | undefined> {
    try {
      this.check(workspace);
      // No recursive filesystem fallback: Git must recognize each managed worktree before it is removed.
      for (const ref of workspace.repositories) {
        const dir = source(this.floor, ref.repository);
        const cwd = path.resolve(this.floor, ref.path);
        await exec('git', ['worktree', 'remove', '--force', cwd], { cwd: dir, timeout: 60_000, windowsHide: true });
        if (cleanup === 'all') await exec('git', ['branch', '-D', ref.branch], { cwd: dir, timeout: 20_000, windowsHide: true });
      }
      // Keep the small workspace manifest/instructions, and any notes the user put beside the repos.
      return undefined;
    } catch (err) { return gitError(err); }
  }

  save(workspace: WorkerWorkspace) {
    const root = this.root(workspace);
    writeFileSync(path.join(root, 'AGENTS.md'), workspaceBrief(workspace), { mode: 0o600 });
    writeFileSync(path.join(root, 'CLAUDE.md'), '@AGENTS.md\n', { mode: 0o600 });
    writeFileSync(path.join(root, 'workspace.json'), JSON.stringify(workspace, null, 2), { mode: 0o600 });
    // If the floor itself is a repository, exclude office metadata through Git's local exclude file.
    excludeFromGit(this.floor);
  }

  private root(workspace: WorkerWorkspace): string {
    const floor = realpathSync(this.floor);
    const home = path.join(floor, WORKSPACES_DIR);
    const root = path.resolve(floor, workspace.path);
    if (!within(home, root) || root === home) throw new Error('Invalid workspace folder');
    // Check existing parents too: an .agent-office junction must not redirect writes elsewhere.
    for (let p = root; within(floor, p) && p !== floor; p = path.dirname(p)) {
      if (existsSync(p) && (lstatSync(p).isSymbolicLink() || !within(floor, realpathSync(p)))) throw new Error('Workspace folder must not be a directory link');
    }
    return root;
  }
}

/** A repository root inside the floor, by its path relative to it (throws for anything else). */
export const floorRepository = source;
