import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error — the mirror is plain JavaScript (no build step) so it runs on a Mac straight from the checkout.
import { exportBundle, findCheckouts, githubRepo, importBundle, safeUrl, sameOrigin, targetDir } from '../personal/mac/floors-mirror.mjs';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A bare "GitHub" with one commit on main and one on `branch`, plus a checkout of it at `dir`. */
function seedRepo(root: string, name: string, dir: string, branch?: string): string {
  const bare = path.join(root, 'remotes', `${name}.git`);
  mkdirSync(path.dirname(bare), { recursive: true });
  git(root, 'init', '--quiet', '--bare', '-b', 'main', bare);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--quiet', '-b', 'main');
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '-m', 'first');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '--quiet', '-u', 'origin', 'main');
  if (branch) {
    git(dir, 'checkout', '--quiet', '-b', branch);
    writeFileSync(path.join(dir, 'work.txt'), 'on a branch\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '--quiet', '-m', 'branch work');
    git(dir, 'push', '--quiet', '-u', 'origin', branch);
  }
  return bare;
}

/** A nested repository whose work sits on a branch with no upstream: its last commit is on no remote. */
function addLocalOnlyBranch(office: string, root: string): string {
  const dir = path.join(office, 'apps', 'frontend');
  seedRepo(root, 'frontend', dir);
  git(dir, 'checkout', '--quiet', '-b', 'wip');
  writeFileSync(path.join(dir, 'wip.txt'), 'not pushed\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '-m', 'local only work');
  return dir;
}

/** A nested repository whose origin URL carries a token, as a pasted PAT remote would. */
function addTokenedRepo(office: string): string {
  const dir = path.join(office, 'apps', 'tokened');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--quiet', '-b', 'main');
  writeFileSync(path.join(dir, 'README.md'), 'tokened\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '-m', 'first');
  git(dir, 'remote', 'add', 'origin', 'https://user:s3cret@example.com/org/tokened.git');
  return dir;
}

/**
 * A building like the Windows one: the office runs in a workspace floor made of nested repositories
 * (one with no remote, one linked worktree), and a second floor that is a single checkout.
 */
function building() {
  const root = mkdtempSync(path.join(tmpdir(), 'floors-mirror-'));
  const home = path.join(root, 'home');
  const dev = path.join(home, 'Documents', 'Development');
  const projects = path.join(home, 'agent-office');
  const office = path.join(dev, 'Personal-Portfolio');
  mkdirSync(office, { recursive: true });
  const backend = path.join(office, 'apps', 'backend');
  const backendOrigin = seedRepo(root, 'backend', backend, 'feature/x');
  const local = path.join(office, 'tools', 'local');
  mkdirSync(local, { recursive: true });
  git(local, 'init', '--quiet', '-b', 'main');
  writeFileSync(path.join(local, 'notes.txt'), 'no remote\n');
  git(local, 'add', '.');
  git(local, 'commit', '--quiet', '-m', 'local only');
  git(backend, 'worktree', 'add', '--quiet', path.join(office, 'wt', 'pr-backend'), 'main');
  writeFileSync(path.join(backend, 'dirty.txt'), 'uncommitted\n');
  mkdirSync(path.join(office, 'node_modules', 'trap', '.git'), { recursive: true });
  const solo = path.join(projects, 'owner', 'solo');
  const soloOrigin = seedRepo(root, 'solo', solo);
  const data = path.join(office, '.agent-office');
  mkdirSync(path.join(data, 'whiteboard'), { recursive: true });
  writeFileSync(path.join(data, 'floors.json'), JSON.stringify([
    { id: 'personal-portfolio', name: 'Personal-Portfolio', dir: office, palette: 0, addedBy: 'the office', addedAt: 1 },
    { id: 'solo', name: 'solo', repo: 'owner/solo', dir: solo, palette: 3, addedBy: 'Michael', addedAt: 2, backOffice: true },
  ], null, 2));
  writeFileSync(path.join(data, 'todos.json'), '{"items":[{"text":"carry me"}]}');
  writeFileSync(path.join(data, 'workers.json'), '[{"id":"stays-here"}]');
  writeFileSync(path.join(data, 'whiteboard', 'elements.json'), '[]');
  mkdirSync(path.join(solo, '.agent-office'));
  writeFileSync(path.join(solo, '.agent-office', 'queue.json'), '{"tasks":[]}');
  return { root, home, dev, projects, office, backend, backendOrigin, solo, soloOrigin, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('github origins are recognised in every spelling', () => {
  assert.equal(githubRepo('https://github.com/mmoscare/agent-office.git'), 'mmoscare/agent-office');
  assert.equal(githubRepo('git@github.com:mmoscare/Agent-Office'), 'mmoscare/Agent-Office');
  assert.equal(githubRepo('ssh://git@github.com/mmoscare/x.git'), 'mmoscare/x');
  assert.equal(githubRepo('https://gitlab.com/a/b.git'), null);
  assert.equal(githubRepo(null), null);
  assert.ok(sameOrigin('https://github.com/mmoscare/agent-office.git', 'git@github.com:MMOSCARE/agent-office'));
  assert.ok(!sameOrigin('https://github.com/mmoscare/a.git', 'https://github.com/mmoscare/b.git'));
  assert.ok(sameOrigin('C:\\remotes\\x.git', 'c:/remotes/x.git/'));
  assert.ok(!sameOrigin(null, 'https://github.com/mmoscare/a.git'));
  // A token pasted into a remote URL never decides identity, and never reaches a message.
  assert.equal(githubRepo('https://user:tok@github.com/a/b.git'), 'a/b');
  assert.ok(sameOrigin('https://user:tok@github.com/mmoscare/a.git', 'https://github.com/mmoscare/a'));
  assert.ok(sameOrigin('https://user:tok@example.com/x.git', 'https://example.com/x'));
  assert.equal(safeUrl('https://user:tok@example.com/x.git'), 'https://example.com/x.git');
  assert.equal(safeUrl('ssh://git@github.com/a/b.git'), 'ssh://github.com/a/b.git');
  assert.equal(safeUrl('git@github.com:a/b.git'), 'git@github.com:a/b.git');
  assert.equal(safeUrl(null), null);
});

test('export records every floor, the checkouts in it and what will not travel', () => {
  const b = building();
  try {
    const out = path.join(b.root, 'bundle');
    const manifest = exportBundle({ officeDir: b.office, out, home: b.home, state: true });
    assert.equal(manifest.version, 1);
    assert.deepEqual(manifest.floors.map((f: any) => [f.id, f.base, f.rel, f.isOffice, f.palette, f.paletteName, f.backOffice]), [
      ['personal-portfolio', 'development', 'Personal-Portfolio', true, 0, 'Maple', false],
      ['solo', 'projects', 'owner/solo', false, 3, 'Lavender', true],
    ]);
    const office = manifest.floors[0];
    const byPath = Object.fromEntries(office.checkouts.map((c: any) => [c.path, c]));
    assert.deepEqual(Object.keys(byPath).sort(), ['apps/backend', 'tools/local', 'wt/pr-backend']);
    assert.equal(byPath['apps/backend'].kind, 'repo');
    assert.ok(sameOrigin(byPath['apps/backend'].origin, b.backendOrigin));
    assert.equal(byPath['apps/backend'].branch, 'feature/x');
    assert.equal(byPath['apps/backend'].dirty, 1);
    assert.equal(byPath['apps/backend'].unpushed, 0);
    assert.equal(byPath['tools/local'].origin, null);
    assert.equal(byPath['wt/pr-backend'].kind, 'worktree');
    assert.equal(byPath['wt/pr-backend'].branch, 'main');
    assert.ok(byPath['wt/pr-backend'].gitdir);
    assert.deepEqual(manifest.floors[1].checkouts.map((c: any) => [c.path, c.kind, c.branch]), [['.', 'repo', 'main']]);
    // The bundle: the manifest and only the portable office files.
    const written = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.equal(written.floors.length, 2);
    assert.deepEqual(readdirSync(path.join(out, 'state', 'personal-portfolio')).sort(), ['todos.json', 'whiteboard']);
    assert.deepEqual(readdirSync(path.join(out, 'state', 'solo')), ['queue.json']);
    assert.ok(!existsSync(path.join(out, 'state', 'personal-portfolio', 'workers.json')));
    // --quick leaves the slow counts out.
    const quick = findCheckouts(b.office, true);
    assert.ok(quick.checkouts.every((c: any) => c.dirty === undefined && c.unpushed === undefined));
  } finally { b.close(); }
});

test('import recreates the building elsewhere: clones what is missing, keeps what is there, writes floors.json', () => {
  const b = building();
  try {
    const out = path.join(b.root, 'bundle');
    exportBundle({ officeDir: b.office, out, home: b.home, state: true, quick: true });
    const mac = path.join(b.root, 'mac');
    const devRoot = path.join(mac, 'Development');
    const projects = path.join(mac, 'agent-office');
    // A dry run changes nothing.
    const dry = importBundle({ bundle: out, devRoot, projects, home: mac, dryRun: true });
    assert.ok(!existsSync(mac));
    assert.deepEqual(dry.cloned, ['Personal-Portfolio/apps/backend', 'solo']);
    assert.deepEqual(dry.made, ['Personal-Portfolio']);

    const report = importBundle({ bundle: out, devRoot, projects, home: mac, state: true });
    const office = path.join(devRoot, 'Personal-Portfolio');
    const backend = path.join(office, 'apps', 'backend');
    assert.ok(sameOrigin(git(backend, 'remote', 'get-url', 'origin'), b.backendOrigin));
    assert.equal(git(backend, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/x');
    assert.equal(readFileSync(path.join(backend, 'work.txt'), 'utf8').replace(/\r\n/g, '\n'), 'on a branch\n');
    assert.ok(!existsSync(path.join(backend, 'dirty.txt')), 'uncommitted work stays on the source machine');
    const solo = path.join(projects, 'owner', 'solo');
    assert.equal(git(solo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.ok(!existsSync(path.join(office, 'tools', 'local')), 'a repository with no remote is not invented');
    assert.ok(!existsSync(path.join(office, 'wt')), 'linked worktrees are not recreated');
    assert.ok(!existsSync(path.join(office, 'node_modules')));
    assert.equal(report.manual.length, 1);
    assert.match(report.manual[0], /tools\/local.*no remote/);
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0], /wt\/pr-backend.*linked worktree/);
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.state.sort(), ['Personal-Portfolio/todos.json', 'Personal-Portfolio/whiteboard/elements.json', 'solo/queue.json']);
    assert.equal(readFileSync(path.join(office, '.agent-office', 'todos.json'), 'utf8'), '{"items":[{"text":"carry me"}]}');
    assert.ok(!existsSync(path.join(office, '.agent-office', 'workers.json')));

    const floors = JSON.parse(readFileSync(path.join(office, '.agent-office', 'floors.json'), 'utf8'));
    assert.deepEqual(floors, [
      { id: 'personal-portfolio', name: 'Personal-Portfolio', dir: office, palette: 0, addedBy: 'the office', addedAt: 1 },
      { id: 'solo', name: 'solo', repo: 'owner/solo', dir: solo, palette: 3, addedBy: 'Michael', addedAt: 2, backOffice: true },
    ]);
    assert.equal(report.backup, null);

    // Again: nothing is cloned twice, nothing overwritten, and the last list is backed up.
    const again = importBundle({ bundle: out, devRoot, projects, home: mac, state: true });
    assert.deepEqual(again.cloned, []);
    assert.deepEqual(again.kept.sort(), ['Personal-Portfolio', 'Personal-Portfolio/apps/backend', 'solo']);
    assert.deepEqual(again.problems, []);
    assert.deepEqual(again.state, []);
    assert.ok(again.backup && existsSync(again.backup));
    assert.ok(readdirSync(path.join(office, '.agent-office')).some((n) => n.startsWith('floors.json.before-mirror-')));
  } finally { b.close(); }
});

test('import --skip leaves a scratch checkout out without counting it as left behind', () => {
  const b = building();
  try {
    const out = path.join(b.root, 'bundle');
    exportBundle({ officeDir: b.office, out, home: b.home, quick: true });
    const mac = path.join(b.root, 'mac');
    const devRoot = path.join(mac, 'Development');
    const report = importBundle({ bundle: out, devRoot, projects: path.join(mac, 'agent-office'), home: mac, skip: ['Personal-Portfolio/apps/backend'] });
    assert.ok(!existsSync(path.join(devRoot, 'Personal-Portfolio', 'apps')));
    assert.deepEqual(report.cloned, ['solo']);
    assert.ok(report.skipped.some((s: string) => s.startsWith('Personal-Portfolio/apps/backend: left out')));
    assert.deepEqual(report.leftBehind, []);
    assert.deepEqual(report.problems, []);
    assert.equal(JSON.parse(readFileSync(path.join(devRoot, 'Personal-Portfolio', '.agent-office', 'floors.json'), 'utf8')).length, 2);
  } finally { b.close(); }
});

test('import keeps floors that only exist here, honours --map, and refuses to mistake another checkout for a floor', () => {
  const b = building();
  try {
    const out = path.join(b.root, 'bundle');
    exportBundle({ officeDir: b.office, out, home: b.home, quick: true });
    const mac = path.join(b.root, 'mac');
    const devRoot = path.join(mac, 'Development');
    const projects = path.join(mac, 'agent-office');
    const office = path.join(devRoot, 'Personal-Portfolio');
    // The Mac already has a floor of its own, and the solo repo lives elsewhere on it.
    mkdirSync(path.join(office, '.agent-office'), { recursive: true });
    const macOnly = path.join(devRoot, 'Mac-Only');
    mkdirSync(macOnly);
    writeFileSync(path.join(office, '.agent-office', 'floors.json'), JSON.stringify([{ id: 'mac-only', name: 'Mac-Only', dir: macOnly, palette: 5, addedBy: 'Mac', addedAt: 9 }]));
    const soloHere = path.join(devRoot, 'Solo-Here');
    git(mac, 'clone', '--quiet', b.soloOrigin, soloHere);
    // And something else sits where the backend would go.
    const backend = path.join(office, 'apps', 'backend');
    mkdirSync(backend, { recursive: true });
    writeFileSync(path.join(backend, 'unrelated.txt'), 'mine\n');

    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.equal(targetDir(manifest.floors[1], { devRoot, projects, home: mac, map: { solo: soloHere } }), soloHere);
    const report = importBundle({ bundle: out, devRoot, projects, home: mac, map: { solo: soloHere } });
    assert.deepEqual(report.cloned, []);
    assert.ok(report.kept.includes('solo'));
    assert.equal(report.problems.length, 1);
    assert.match(report.problems[0], /apps\/backend.*isn't a git checkout/);
    assert.equal(readFileSync(path.join(backend, 'unrelated.txt'), 'utf8'), 'mine\n');
    const floors = JSON.parse(readFileSync(path.join(office, '.agent-office', 'floors.json'), 'utf8'));
    assert.deepEqual(floors.map((f: any) => [f.id, f.dir]), [['personal-portfolio', office], ['solo', soloHere], ['mac-only', macOnly]]);
    assert.ok(report.backup && existsSync(report.backup));
  } finally { b.close(); }
});

test('export counts commits no remote has, upstream or not, and keeps credentials out of the manifest and the log', () => {
  const b = building();
  try {
    addLocalOnlyBranch(b.office, b.root);
    addTokenedRepo(b.office);
    const lines: string[] = [];
    const out = path.join(b.root, 'bundle');
    const manifest = exportBundle({ officeDir: b.office, out, home: b.home, log: (l: string) => lines.push(l) });
    const byPath = Object.fromEntries(manifest.floors[0].checkouts.map((c: any) => [c.path, c]));
    assert.equal(byPath['apps/frontend'].branch, 'wip');
    assert.equal(byPath['apps/frontend'].unpushed, 1, 'a branch with no upstream still reports its local-only commit');
    assert.equal(byPath['apps/backend'].unpushed, 0);
    assert.equal(byPath['tools/local'].unpushed, 1, 'with no remote at all, every commit is unpushed');
    assert.equal(byPath['apps/tokened'].origin, 'https://example.com/org/tokened.git');
    assert.ok(!JSON.stringify(manifest).includes('s3cret'));
    assert.ok(!readFileSync(path.join(out, 'manifest.json'), 'utf8').includes('s3cret'));
    assert.ok(lines.some((l) => l.includes('apps/tokened https://example.com/org/tokened.git')), lines.join('\n'));
    assert.ok(!lines.some((l) => l.includes('s3cret')));
    // The import report names the local-only work, and never the credential.
    const mac = path.join(b.root, 'mac');
    const said: string[] = [];
    const dry = importBundle({ bundle: out, devRoot: path.join(mac, 'Development'), projects: path.join(mac, 'agent-office'), home: mac, dryRun: true, log: (l: string) => said.push(l) });
    assert.ok(dry.leftBehind.includes('Personal-Portfolio/apps/frontend: 1 unpushed commit on wip stayed on the other machine'), JSON.stringify(dry.leftBehind));
    assert.ok(!dry.leftBehind.some((s: string) => s.includes('tools/local')), 'a repository with no remote is under "copy by hand", not "left behind"');
    assert.ok(said.some((l) => l.includes('clone https://example.com/org/tokened.git')), said.join('\n'));
    assert.ok(!said.some((l) => l.includes('s3cret')));
    assert.ok(!JSON.stringify(dry).includes('s3cret'));
  } finally { b.close(); }
});

test('import leaves out floors it cannot place: absolute paths without --map, and floors that are linked worktrees', () => {
  const b = building();
  try {
    const out = path.join(b.root, 'bundle');
    exportBundle({ officeDir: b.office, out, home: b.home, quick: true });
    const file = path.join(out, 'manifest.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    const wt = manifest.floors[0].checkouts.find((c: any) => c.path === 'wt/pr-backend');
    manifest.floors.push(
      { id: 'elsewhere', name: 'Elsewhere', repo: null, palette: 2, paletteName: 'Sky', addedBy: 'x', addedAt: 3, backOffice: false, dir: 'Z:\weird\place', base: 'absolute', rel: 'Z:\weird\place', isOffice: false, exists: true, checkouts: [], truncated: false },
      { id: 'wt-floor', name: 'wt-floor', repo: null, palette: 4, paletteName: 'Peach', addedBy: 'x', addedAt: 4, backOffice: false, dir: path.join(b.office, 'wt', 'pr-backend'), base: 'development', rel: 'Personal-Portfolio/wt/pr-backend', isOffice: false, exists: true, checkouts: [{ ...wt, path: '.' }], truncated: false },
    );
    writeFileSync(file, JSON.stringify(manifest));
    const mac = path.join(b.root, 'mac');
    const devRoot = path.join(mac, 'Development');
    const projects = path.join(mac, 'agent-office');
    const report = importBundle({ bundle: out, devRoot, projects, home: mac });
    assert.ok(report.problems.some((s: string) => s.startsWith('Elsewhere: Z:\weird\place') && s.includes('--map elsewhere=')), JSON.stringify(report.problems));
    assert.ok(report.skipped.some((s: string) => s.startsWith('wt-floor: the floor itself is a linked worktree')), JSON.stringify(report.skipped));
    assert.ok(!existsSync(path.join(devRoot, 'Personal-Portfolio', 'wt')), 'no empty folder for a worktree floor');
    assert.ok(!existsSync(path.resolve('Z:\weird\place')), 'no folder made from a path that is only absolute on the other machine');
    assert.deepEqual(report.floors.map((f: any) => f.id), ['personal-portfolio', 'solo']);
    const office = path.join(devRoot, 'Personal-Portfolio');
    let floors = JSON.parse(readFileSync(path.join(office, '.agent-office', 'floors.json'), 'utf8'));
    assert.deepEqual(floors.map((f: any) => f.id), ['personal-portfolio', 'solo']);
    // Given a place, the absolute floor comes along.
    const placed = path.join(mac, 'Elsewhere');
    const again = importBundle({ bundle: out, devRoot, projects, home: mac, map: { elsewhere: placed } });
    assert.ok(!again.problems.some((s: string) => s.startsWith('Elsewhere')), JSON.stringify(again.problems));
    assert.ok(existsSync(placed));
    floors = JSON.parse(readFileSync(path.join(office, '.agent-office', 'floors.json'), 'utf8'));
    assert.deepEqual(floors.map((f: any) => [f.id, f.dir]), [['personal-portfolio', office], ['solo', path.join(projects, 'owner', 'solo')], ['elsewhere', placed]]);
  } finally { b.close(); }
});

test('export --state rebuilds the state folder, so a file a floor no longer has does not come back', () => {
  const b = building();
  try {
    const out = path.join(b.root, 'bundle');
    exportBundle({ officeDir: b.office, out, home: b.home, quick: true, state: true });
    assert.ok(existsSync(path.join(out, 'state', 'solo', 'queue.json')));
    unlinkSync(path.join(b.solo, '.agent-office', 'queue.json'));
    exportBundle({ officeDir: b.office, out, home: b.home, quick: true, state: true });
    assert.ok(!existsSync(path.join(out, 'state', 'solo', 'queue.json')), 'the deleted queue is gone from the bundle');
    assert.ok(existsSync(path.join(out, 'state', 'personal-portfolio', 'todos.json')), 'state that still exists is still there');
  } finally { b.close(); }
});
