#!/usr/bin/env node
// Agent Office floor mirror: carry this machine's building (its floors and the checkouts each
// floor is made of) to another machine, such as a Mac, so its floors look the same.
//
//   node personal/mac/floors-mirror.mjs export [officeDir] [--out <bundleDir>] [--dev-root <dir>] [--state] [--quick]
//   node personal/mac/floors-mirror.mjs import <bundleDir|manifest.json> --dev-root <dir>
//        [--projects <dir>] [--office <dir>] [--map <floorId>=<dir>]... [--skip <floor>/<path>]...
//        [--no-clone] [--state] [--dry-run]
//
// export reads <officeDir>/.agent-office/floors.json, walks every floor for git checkouts (the floor
// itself, or the repositories nested in a workspace floor) and writes a bundle folder holding
// manifest.json: each floor's id, name, colours, order and its checkouts' relative paths, origins
// and branches, plus what won't travel through GitHub (uncommitted or unpushed work, repositories
// with no remote, linked worktrees). With --state it also copies the portable per-floor office
// files (task queue, To Do Next plans, meetings, jukebox, pictures, dog, whiteboard, the building's
// todos and chat). Workers, scrollback, hooks, worktrees, the password and spend stay here.
//
// import, on the other machine, recreates the same folder structure under --dev-root, clones every
// checkout that has an origin and is missing, leaves whatever is already there untouched, writes
// <office>/.agent-office/floors.json with the same floors (ids, names, colours, order) at their new
// paths, and lists what it could not carry. It never deletes, overwrites or resets anything.
//
// No dependencies: node >= 20 and git (gh is not needed; clones use your git credentials).

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_VERSION = 1;
/** Floor colours, in the order src/shared/floors.ts keeps them; only the names, for people reading the manifest. */
const PALETTE_NAMES = ['Maple', 'Mint', 'Sky', 'Lavender', 'Peach', 'Lemon', 'Walnut', 'Slate', 'Rose', 'Teal'];
/** Folders never looked in for checkouts (as the office's own workspace discovery skips them). */
const SKIP = new Set(['.git', '.agent-office', 'node_modules', 'vendor', 'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__', '.next', '.cache', 'coverage']);
const MAX_DEPTH = 4;
const MAX_VISITED = 3000;
const MAX_CHECKOUTS = 60;
/** Per-floor office files that mean the same thing on another machine. Everything else in .agent-office is this machine's. */
export const PORTABLE_STATE = ['queue.json', 'plans.json', 'meetings.json', 'jukebox.json', 'decor.json', 'dog.json', 'todos.json', 'chat.jsonl', path.join('whiteboard', 'elements.json')];

// ---------------------------------------------------------------------------
// git

function git(dir, args, timeout = 20_000) {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout, windowsHide: true }).trim();
  } catch {
    return null;
  }
}

/** owner/name for a github.com origin (https, ssh or git@, with or without .git); null for anything else. */
export function githubRepo(url) {
  if (typeof url !== 'string') return null;
  let s = url.trim().replace(/^(?:https?:\/\/|ssh:\/\/)?(?:[\w.-]+@)?github\.com[/:]/i, '');
  if (s === url.trim()) return null;
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = s.split('/');
  return parts.length >= 2 && parts[0] && parts[1] ? `${parts[0]}/${parts[1]}` : null;
}

/** Whether two origins name the same repository: the same GitHub owner/name, or the same URL otherwise. */
export function sameOrigin(a, b) {
  if (!a || !b) return false;
  const ga = githubRepo(a);
  const gb = githubRepo(b);
  if (ga && gb) return ga.toLowerCase() === gb.toLowerCase();
  const norm = (u) => u.trim().replace(/[\\/]+$/, '').replace(/\.git$/i, '').replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

function describeCheckout(dir, rel, quick) {
  const dotGit = path.join(dir, '.git');
  const linked = statSync(dotGit).isFile();
  const origin = git(dir, ['remote', 'get-url', 'origin']);
  const branchRaw = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const out = {
    path: rel,
    kind: linked ? 'worktree' : 'repo',
    origin: origin || null,
    repo: githubRepo(origin),
    branch: branchRaw && branchRaw !== 'HEAD' ? branchRaw : null,
    head: git(dir, ['rev-parse', '--short', 'HEAD']),
  };
  if (linked) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    out.gitdir = m ? m[1].trim() : null;
  } else if (!quick) {
    const status = git(dir, ['status', '--porcelain', '-unormal'], 120_000);
    out.dirty = status === null ? null : status.split('\n').filter(Boolean).length;
    const unpushed = git(dir, ['rev-list', '--count', '@{u}..HEAD']);
    out.unpushed = unpushed === null ? null : Number(unpushed);
  }
  return out;
}

/** The git checkouts a floor is made of: itself, or the repositories nested in it (bounded, no links followed). */
export function findCheckouts(floor, quick = false) {
  const result = { checkouts: [], truncated: false };
  let visited = 0;
  const walk = (dir, depth) => {
    if (++visited > MAX_VISITED || result.checkouts.length >= MAX_CHECKOUTS) { result.truncated = true; return; }
    if (existsSync(path.join(dir, '.git'))) {
      const rel = path.relative(floor, dir).split(path.sep).join('/') || '.';
      result.checkouts.push(describeCheckout(dir, rel, quick));
      return; // nested repositories inside a checkout are its own business (submodules, vendored trees)
    }
    if (depth >= MAX_DEPTH) { result.truncated = true; return; }
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(e.name) || e.name.startsWith('.') || e.isSymbolicLink() || !e.isDirectory()) continue;
      const child = path.join(dir, e.name);
      try { if (lstatSync(child).isSymbolicLink()) continue; } catch { continue; }
      walk(child, depth + 1);
    }
  };
  walk(floor, 0);
  return result;
}

// ---------------------------------------------------------------------------
// where a folder is, said relative to the places that exist on both machines

/** `dir` said relative to `base` (with / separators), or null when it isn't under it (another drive counts as not under). */
function under(dir, base) {
  if (!base) return null;
  const rel = path.relative(base, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/') || '.';
}

function classify(dir, from) {
  const dev = under(dir, from.devRoot);
  if (dev !== null) return { base: 'development', rel: dev };
  const proj = under(dir, from.projectsDir);
  if (proj !== null) return { base: 'projects', rel: proj };
  const home = under(dir, from.home);
  if (home !== null) return { base: 'home', rel: home };
  return { base: 'absolute', rel: dir };
}

function joinRel(base, rel) {
  return rel === '.' ? base : path.join(base, ...rel.split('/'));
}

// ---------------------------------------------------------------------------
// export

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** The office folder: the one given, or the nearest of cwd and its parents with a .agent-office/floors.json. */
export function findOfficeDir(given) {
  if (given) {
    const dir = path.resolve(given);
    if (!existsSync(path.join(dir, '.agent-office', 'floors.json'))) throw new Error(`${dir} has no .agent-office/floors.json — give the folder the office is started in`);
    return dir;
  }
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.agent-office', 'floors.json'))) return dir;
    if (path.dirname(dir) === dir) break;
  }
  const home = path.join(os.homedir(), 'agent-office');
  if (existsSync(path.join(home, '.agent-office', 'floors.json'))) return home;
  throw new Error('No office found: give the folder the office is started in (the one with .agent-office/floors.json)');
}

/**
 * Writes the bundle for `officeDir`'s building into `out` (default <officeDir>/.agent-office/mac-mirror).
 * Returns the manifest.
 */
export function exportBundle({ officeDir, out, devRoot, projectsDir, home, state = false, quick = false, log = () => {} }) {
  officeDir = findOfficeDir(officeDir);
  home = path.resolve(home ?? os.homedir());
  const dataDir = path.join(officeDir, '.agent-office');
  const floors = readJson(path.join(dataDir, 'floors.json'), null);
  if (!Array.isArray(floors)) throw new Error(`${path.join(dataDir, 'floors.json')} isn't a list of floors`);
  const picked = readJson(path.join(dataDir, 'projects-folder.json'), {});
  projectsDir = path.resolve(projectsDir ?? (typeof picked.dir === 'string' && picked.dir ? picked.dir : path.join(home, 'agent-office')));
  devRoot = devRoot ? path.resolve(devRoot) : existsSync(path.join(home, 'Documents', 'Development')) ? path.join(home, 'Documents', 'Development') : undefined;
  out = path.resolve(out ?? path.join(dataDir, 'mac-mirror'));
  const from = { platform: process.platform, hostname: os.hostname(), home, devRoot: devRoot ?? null, projectsDir, officeDir };

  const manifest = { version: MANIFEST_VERSION, exportedAt: new Date().toISOString(), from, floors: [] };
  for (const f of floors) {
    if (typeof f?.id !== 'string' || typeof f?.dir !== 'string') continue;
    const dir = path.resolve(f.dir);
    log(`floor ${f.name ?? f.id}: ${dir}`);
    const entry = {
      id: f.id,
      name: typeof f.name === 'string' && f.name ? f.name : path.basename(dir),
      repo: typeof f.repo === 'string' ? f.repo : null,
      palette: Number.isInteger(f.palette) ? f.palette : 0,
      paletteName: PALETTE_NAMES[(Number.isInteger(f.palette) ? f.palette : 0) % PALETTE_NAMES.length],
      addedBy: typeof f.addedBy === 'string' ? f.addedBy : '?',
      addedAt: typeof f.addedAt === 'number' ? f.addedAt : Date.now(),
      backOffice: f.backOffice === true,
      dir,
      ...classify(dir, from),
      isOffice: path.resolve(officeDir) === dir,
      exists: existsSync(dir),
      checkouts: [],
      truncated: false,
    };
    if (entry.exists) Object.assign(entry, findCheckouts(dir, quick));
    for (const c of entry.checkouts) log(`  ${c.kind === 'worktree' ? 'worktree' : 'repo'} ${c.path} ${c.origin ?? '(no remote)'}${c.branch ? ` @ ${c.branch}` : ''}${c.dirty ? ` dirty=${c.dirty}` : ''}${c.unpushed ? ` unpushed=${c.unpushed}` : ''}`);
    manifest.floors.push(entry);
  }

  mkdirSync(out, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  if (state) {
    for (const f of manifest.floors) {
      if (!f.exists) continue;
      for (const rel of PORTABLE_STATE) {
        const src = path.join(f.dir, '.agent-office', rel);
        if (!existsSync(src)) continue;
        const dst = path.join(out, 'state', f.id, rel);
        mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
        copyFileSync(src, dst);
        log(`  state ${f.id}/${rel.split(path.sep).join('/')}`);
      }
    }
  }
  log(`bundle written to ${out}`);
  return manifest;
}

// ---------------------------------------------------------------------------
// import

function loadManifest(given) {
  const p = path.resolve(given);
  const file = existsSync(p) && statSync(p).isDirectory() ? path.join(p, 'manifest.json') : p;
  const manifest = readJson(file, null);
  if (!manifest || manifest.version !== MANIFEST_VERSION || !Array.isArray(manifest.floors)) throw new Error(`${file} isn't a floors-mirror manifest (version ${MANIFEST_VERSION})`);
  return { manifest, bundleDir: path.dirname(file) };
}

/** Where a floor goes on this machine. */
export function targetDir(floor, opts) {
  if (opts.map?.[floor.id]) return path.resolve(opts.map[floor.id]);
  switch (floor.base) {
    case 'development': return joinRel(opts.devRoot, floor.rel);
    case 'projects': return joinRel(opts.projects, floor.rel);
    case 'home': return joinRel(opts.home, floor.rel);
    default: return floor.rel;
  }
}

function isEmptyDir(dir) {
  try { return statSync(dir).isDirectory() && readdirSync(dir).length === 0; } catch { return false; }
}

/**
 * Recreates the manifest's building under `devRoot` (and `projects` for floors the office cloned):
 * clones what's missing, keeps what's there, writes floors.json. Returns the report.
 */
export function importBundle({ bundle, devRoot, projects, office, home, map = {}, skip = [], clone = true, state = false, dryRun = false, log = () => {} }) {
  const { manifest, bundleDir } = loadManifest(bundle);
  home = path.resolve(home ?? os.homedir());
  if (!devRoot) throw new Error('--dev-root is needed: the folder that plays the part of Documents/Development here');
  const opts = { devRoot: path.resolve(devRoot), projects: path.resolve(projects ?? path.join(home, 'agent-office')), home, map };
  const report = { floors: [], cloned: [], kept: [], made: [], skipped: [], manual: [], problems: [], leftBehind: [], floorsFile: null, backup: null, state: [] };
  const say = (line) => log(`${dryRun ? '[dry-run] ' : ''}${line}`);
  const run = (what, fn) => { say(what); if (!dryRun) fn(); };
  /** `--skip <floor>/<path>` names a checkout not wanted here (a scratch clone), by the floor's id or name. */
  const unwanted = (f, c) => skip.some((s) => { const key = s.replace(/\\/g, '/'); return key === `${f.id}/${c.path}` || key === `${f.name}/${c.path}`; });

  const cloneInto = (origin, dest, branch, label) => {
    if (!clone) { report.skipped.push(`${label}: missing, and --no-clone was given`); say(`skip ${label} (--no-clone)`); return; }
    run(`clone ${origin} -> ${dest}${branch ? ` @ ${branch}` : ''}`, () => {
      mkdirSync(path.dirname(dest), { recursive: true });
      execFileSync('git', ['clone', '--quiet', origin, dest], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 30 * 60_000, windowsHide: true });
      if (branch && git(dest, ['rev-parse', '--abbrev-ref', 'HEAD']) !== branch) {
        try {
          execFileSync('git', ['checkout', '--quiet', branch], { cwd: dest, stdio: ['ignore', 'inherit', 'inherit'], timeout: 60_000, windowsHide: true });
        } catch {
          report.problems.push(`${label}: cloned, but branch ${branch} isn't on the remote — left on the default branch`);
        }
      }
    });
    report.cloned.push(label);
  };

  for (const f of manifest.floors) {
    const dir = targetDir(f, opts);
    const label = f.name;
    report.floors.push({ id: f.id, name: f.name, from: f.dir, to: dir });
    if (f.base === 'absolute') report.problems.push(`${label}: ${f.dir} was outside the home folder there, so it stays at the same path here — use --map ${f.id}=<dir> to move it`);
    const root = f.checkouts.find((c) => c.path === '.');
    if (!existsSync(dir)) {
      if (root?.kind === 'repo' && root.origin) cloneInto(root.origin, dir, root.branch, label);
      else {
        run(`mkdir ${dir}`, () => mkdirSync(dir, { recursive: true }));
        report.made.push(label);
        if (root && !root.origin) report.manual.push(`${label}: a git repository with no remote — copy the whole ${f.dir} folder from the other machine into ${dir}`);
      }
    } else if (root?.kind === 'repo' && root.origin) {
      const here = git(dir, ['remote', 'get-url', 'origin']);
      if (!existsSync(path.join(dir, '.git'))) report.problems.push(`${label}: ${dir} exists but isn't a git checkout of ${root.origin}`);
      else if (!sameOrigin(here, root.origin)) report.problems.push(`${label}: ${dir} is a checkout of ${here ?? '(no remote)'}, not ${root.origin}`);
      else { report.kept.push(label); say(`keep ${dir}`); }
    } else {
      report.kept.push(label);
      say(`keep ${dir}`);
    }
    for (const c of f.checkouts) {
      if (c.path === '.') continue;
      const dest = joinRel(dir, c.path);
      const clabel = `${label}/${c.path}`;
      if (unwanted(f, c)) { report.skipped.push(`${clabel}: left out (--skip)`); say(`skip ${clabel} (--skip)`); continue; }
      if (c.kind === 'worktree') { report.skipped.push(`${clabel}: a linked worktree of ${c.gitdir ?? 'another checkout'}${c.branch ? ` (branch ${c.branch})` : ''} — make it again with git worktree add if you need it`); continue; }
      if (!c.origin) { report.manual.push(`${clabel}: a git repository with no remote — copy the whole folder from the other machine into ${dest}`); continue; }
      if (existsSync(dest) && !isEmptyDir(dest)) {
        if (!existsSync(path.join(dest, '.git'))) { report.problems.push(`${clabel}: ${dest} exists and isn't a git checkout — left alone`); continue; }
        const here = git(dest, ['remote', 'get-url', 'origin']);
        if (!sameOrigin(here, c.origin)) { report.problems.push(`${clabel}: ${dest} is a checkout of ${here ?? '(no remote)'}, not ${c.origin} — left alone`); continue; }
        report.kept.push(clabel);
        say(`keep ${dest}`);
        continue;
      }
      cloneInto(c.origin, dest, c.branch, clabel);
    }
    for (const c of f.checkouts) {
      if (c.kind !== 'repo' || unwanted(f, c)) continue;
      const what =[c.dirty ? `${c.dirty} uncommitted change${c.dirty === 1 ? '' : 's'}` : '', c.unpushed ? `${c.unpushed} unpushed commit${c.unpushed === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
      if (what) report.leftBehind.push(`${label}/${c.path}: ${what} on ${c.branch ?? 'a detached HEAD'} stayed on the other machine`);
    }
  }

  // The building's own folder: the floor the office is started in, or whatever --office says.
  const officeFloor = manifest.floors.find((f) => f.isOffice);
  const officeDir = office ? path.resolve(office) : officeFloor ? targetDir(officeFloor, opts) : null;
  if (!officeDir) report.problems.push('No floor is the office folder in the manifest and --office wasn\'t given: floors.json not written');
  else {
    const dataDir = path.join(officeDir, '.agent-office');
    const file = path.join(dataDir, 'floors.json');
    const existing = readJson(file, []);
    const ours = manifest.floors.map((f) => ({
      id: f.id,
      name: f.name,
      ...(f.repo ? { repo: f.repo } : {}),
      dir: targetDir(f, opts),
      palette: f.palette,
      addedBy: f.addedBy,
      addedAt: f.addedAt,
      ...(f.backOffice ? { backOffice: true } : {}),
    }));
    const taken = new Set(ours.map((f) => f.id));
    const dirs = new Set(ours.map((f) => path.resolve(f.dir).toLowerCase()));
    const preserved = (Array.isArray(existing) ? existing : []).filter((f) => typeof f?.id === 'string' && typeof f?.dir === 'string' && !taken.has(f.id) && !dirs.has(path.resolve(f.dir).toLowerCase()));
    for (const f of preserved) say(`keep floor ${f.name ?? f.id} (only here): ${f.dir}`);
    const list = [...ours, ...preserved];
    report.floorsFile = file;
    if (existsSync(file)) {
      report.backup = `${file}.before-mirror-${Date.now()}.bak`;
      run(`back up ${file} -> ${report.backup}`, () => copyFileSync(file, report.backup));
    }
    run(`write ${file} (${list.length} floor${list.length === 1 ? '' : 's'})`, () => {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
    });
  }

  if (state) {
    for (const f of manifest.floors) {
      const dir = targetDir(f, opts);
      for (const rel of PORTABLE_STATE) {
        const src = path.join(bundleDir, 'state', f.id, rel);
        if (!existsSync(src)) continue;
        const dst = path.join(dir, '.agent-office', rel);
        if (existsSync(dst)) { report.skipped.push(`${f.name}: ${rel.split(path.sep).join('/')} is already there — not overwritten`); continue; }
        run(`state ${f.name}/${rel.split(path.sep).join('/')}`, () => {
          mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
          copyFileSync(src, dst);
        });
        report.state.push(`${f.name}/${rel.split(path.sep).join('/')}`);
      }
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// command line

function parseArgs(argv) {
  const opts = { _: [], map: {}, skip: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--out') opts.out = value();
    else if (a === '--skip') opts.skip.push(value());
    else if (a === '--dev-root') opts.devRoot = value();
    else if (a === '--projects') opts.projects = value();
    else if (a === '--office') opts.office = value();
    else if (a === '--map') { const v = value(); const eq = v.indexOf('='); if (eq < 1) throw new Error('--map takes floorId=<dir>'); opts.map[v.slice(0, eq)] = v.slice(eq + 1); }
    else if (a === '--state') opts.state = true;
    else if (a === '--quick') opts.quick = true;
    else if (a === '--no-clone') opts.clone = false;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else opts._.push(a);
  }
  return opts;
}

const HELP = `floors-mirror — carry an Agent Office building to another machine

  export [officeDir] [--out <bundleDir>] [--dev-root <dir>] [--state] [--quick]
      Writes <officeDir>/.agent-office/mac-mirror/manifest.json (or --out) describing every floor and the
      checkouts in it. --state also copies each floor's portable office files. --quick skips the
      uncommitted/unpushed counts. officeDir defaults to the office found from the current folder.

  import <bundleDir|manifest.json> --dev-root <dir> [--projects <dir>] [--office <dir>]
         [--map <floorId>=<dir>]... [--skip <floor>/<path>]... [--no-clone] [--state] [--dry-run]
      Recreates the floors under --dev-root (floors that lived under Documents/Development there) and
      --projects (floors the office cloned into ~/agent-office; default ~/agent-office), clones the
      checkouts that are missing, writes <office>/.agent-office/floors.json, and reports what stayed
      behind. --map puts one floor somewhere else; --skip leaves a checkout out (a scratch clone you
      don't want again). --dry-run only says what it would do.
`;

function section(title, lines) {
  if (!lines.length) return;
  console.log(`\n${title}`);
  for (const l of lines) console.log(`  - ${l}`);
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const [cmd, arg] = opts._;
  if (opts.help || !cmd) { console.log(HELP); return 0; }
  const log = (line) => console.log(line);
  if (cmd === 'export') {
    const manifest = exportBundle({ officeDir: arg, out: opts.out, devRoot: opts.devRoot, state: opts.state, quick: opts.quick, log });
    const left = manifest.floors.flatMap((f) => f.checkouts.filter((c) => c.kind === 'repo' && (c.dirty || c.unpushed)).map((c) => `${f.name}/${c.path}: ${[c.dirty ? `${c.dirty} uncommitted` : '', c.unpushed ? `${c.unpushed} unpushed` : ''].filter(Boolean).join(', ')}`));
    const noRemote = manifest.floors.flatMap((f) => f.checkouts.filter((c) => c.kind === 'repo' && !c.origin).map((c) => `${f.name}/${c.path}`));
    section('Work that only GitHub can\'t carry (commit and push it first, or copy the folders):', left);
    section('Repositories with no remote (copy these folders by hand, or create a remote and push):', noRemote);
    return 0;
  }
  if (cmd === 'import') {
    if (!arg) throw new Error('import needs the bundle folder or manifest.json');
    const report = importBundle({ bundle: arg, devRoot: opts.devRoot, projects: opts.projects, office: opts.office, map: opts.map, skip: opts.skip, clone: opts.clone !== false, state: opts.state, dryRun: opts.dryRun, log });
    console.log(`\nFloors: ${report.floors.map((f) => `${f.name} -> ${f.to}`).join('\n        ')}`);
    section('Cloned:', report.cloned);
    section('Already there, kept as they are:', report.kept);
    section('Folders made:', report.made);
    section('Office files carried over:', report.state);
    section('Copy by hand (no remote):', report.manual);
    section('Not carried:', report.skipped);
    section('Stayed on the other machine:', report.leftBehind);
    section('Problems:', report.problems);
    if (report.floorsFile) console.log(`\nfloors.json: ${report.floorsFile}${report.backup ? ` (previous list backed up to ${path.basename(report.backup)})` : ''}`);
    return report.problems.length ? 1 : 0;
  }
  throw new Error(`unknown command ${cmd} (export or import)`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]);
const self = fileURLToPath(import.meta.url);
if (invoked && (process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self)) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`floors-mirror: ${err.message}`);
    process.exit(2);
  }
}
