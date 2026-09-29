import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_LOGO_BYTES, readProjectLogo } from '../src/server/project-logo.js';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="9" fill="teal"/></svg>';

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'office-logo-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('office-logo-test-'));
    rmSync(root, { recursive: true, force: true });
  });
  const put = (file: string, data: string | Buffer = svg) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), data);
  };
  return { root, put };
}

test('discovers a project logo before a favicon, regardless of filename case', (t) => {
  const { root, put } = fixture(t);
  put('favicon.svg', '<svg/>');
  put('assets/Logo.SVG');
  const logo = readProjectLogo(root)!;
  assert.equal(logo.bytes.toString(), svg);
  assert.equal(logo.type, 'image/svg+xml');
  assert.match(logo.version, /^[a-f0-9]{16}$/);
});

test('explicit Office logo wins, and changing its bytes changes the cache version', (t) => {
  const { root, put } = fixture(t);
  put('logo.svg', '<svg/>');
  put('.agent-office/logo.svg');
  const before = readProjectLogo(root)!;
  assert.equal(before.bytes.toString(), svg);
  put('.agent-office/logo.svg', svg.replace('teal', 'coral'));
  assert.notEqual(readProjectLogo(root)!.version, before.version);
});

test('uses app icons and Agent Office’s nested public favicon when there is no logo', (t) => {
  const { root, put } = fixture(t);
  put('src/client/public/favicon.svg');
  assert.equal(readProjectLogo(root)!.bytes.toString(), svg);
  put('public/icon.png', Buffer.from([137, 80, 78, 71]));
  assert.equal(readProjectLogo(root)!.type, 'image/png');
});

test('empty folders, missing paths and unsupported formats have no logo', (t) => {
  const { root, put } = fixture(t);
  assert.equal(readProjectLogo(root), undefined);
  assert.equal(readProjectLogo(path.join(root, 'missing')), undefined);
  put('logo.html', '<script>test</script>');
  put('node_modules/package/logo.svg');
  assert.equal(readProjectLogo(root), undefined, 'does not crawl dependencies');
});

test('ignores empty, oversized and non-file candidates without blocking the fallback', (t) => {
  const { root, put } = fixture(t);
  put('.agent-office/logo.svg', Buffer.alloc(MAX_LOGO_BYTES + 1));
  put('logo.svg', '');
  mkdirSync(path.join(root, 'logo.png'));
  put('public/favicon.svg');
  assert.equal(readProjectLogo(root)!.bytes.toString(), svg);
});

test('does not read a logo through a directory link outside the project', (t) => {
  const { root, put } = fixture(t);
  put('outside/logo.svg');
  const project = path.join(root, 'project');
  mkdirSync(project);
  symlinkSync(path.join(root, 'outside'), path.join(project, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(readProjectLogo(project), undefined);
});

test('uses each personal floor’s launcher artwork, with the dashboard mark for Personal Portfolio', (t) => {
  const { root, put } = fixture(t);
  const sources = [
    ['Personal-Portfolio', 'personal-frontend/public/assets/site-logo.svg', 'image/svg+xml'],
    ['MFT-Trading-Dashboard', 'dashboard-backend/.launcher/maple-futures.png', 'image/png'],
    ['agent-office', 'personal/windows/Agent Office.png', 'image/png'],
    ['paper-cloud', '.launcher/paper-cloud-restored.ico', 'image/x-icon'],
    ['Dad Projects', 'bmo-frontend/public/bmo-launcher.ico', 'image/x-icon'],
    ['Database-App', 'database-app/public/icons/icon-512.png', 'image/png'],
    ['Autonomous-Dev-Projects', 'morning-brief/morning-brief.ico', 'image/x-icon'],
    ['TRACE', 'tools/trace.ico', 'image/x-icon'],
    ['Dock', 'assets/dock.ico', 'image/x-icon'],
  ];
  for (const [project, file, type] of sources) {
    const artwork = `chosen artwork for ${project}`;
    put(`${project}/${file}`, artwork);
    put(`${project}/public/favicon.svg`, '<svg/>');
    const logo = readProjectLogo(path.join(root, project))!;
    assert.equal(logo?.bytes.toString(), artwork, project);
    assert.equal(logo.type, type, project);
    put(`${project}/.agent-office/logo.svg`);
    assert.equal(readProjectLogo(path.join(root, project))!.bytes.toString(), svg, 'explicit override still wins');
  }
});

test('Personal Portfolio chooses the dashboard over launcher and sibling app logos', (t) => {
  const { root, put } = fixture(t);
  put('Personal Portfolio/personal-frontend/public/assets/site-logo.svg');
  put('Personal Portfolio/personal-frontend/.launcher/logo-256.png', 'launcher');
  put('Personal Portfolio/budget-tracker/public/logo.svg', 'sibling');
  assert.equal(readProjectLogo(path.join(root, 'Personal Portfolio'))!.bytes.toString(), svg);
});

test('mapped launcher paths fall back when missing or unusable, including on a cloned floor', (t) => {
  const { root, put } = fixture(t);
  const project = path.join(root, 'paper-cloud');
  put('paper-cloud/.launcher/paper-cloud-restored.ico', Buffer.alloc(MAX_LOGO_BYTES + 1));
  put('paper-cloud/frontend/public/paper-cloud-logo.png', 'cloned artwork');
  assert.equal(readProjectLogo(project)!.bytes.toString(), 'cloned artwork');
  put('paper-cloud/frontend/public/paper-cloud-logo.png', '');
  put('paper-cloud/public/logo.svg');
  assert.equal(readProjectLogo(project)!.bytes.toString(), svg);
});

test('ordinary projects can use launcher icons without changing conventional discovery', (t) => {
  const { root, put } = fixture(t);
  put('Other App/public/logo.svg');
  put('Other App/.launcher/Logo-256.PNG', 'launcher artwork');
  assert.equal(readProjectLogo(path.join(root, 'Other App'))!.bytes.toString(), 'launcher artwork');
  put('Other App/.agent-office/logo.svg');
  assert.equal(readProjectLogo(path.join(root, 'Other App'))!.bytes.toString(), svg);
  put('constructor/public/logo.svg');
  assert.equal(readProjectLogo(path.join(root, 'constructor'))!.bytes.toString(), svg);
  put('another-app/launcher/another-app.ico', 'shortcut artwork');
  assert.equal(readProjectLogo(path.join(root, 'another-app'))!.bytes.toString(), 'shortcut artwork');
});

test('mapped nested assets and generic launcher folders cannot follow links outside the floor', (t) => {
  const { root, put } = fixture(t);
  put('outside/public/assets/site-logo.svg', 'outside dashboard');
  put('outside/logo-256.png', 'outside launcher');
  put('Personal-Portfolio/public/favicon.svg');
  const project = path.join(root, 'Personal-Portfolio');
  for (const relative of ['personal-frontend', '.launcher']) {
    symlinkSync(path.join(root, 'outside'), path.join(project, relative), process.platform === 'win32' ? 'junction' : 'dir');
  }
  assert.equal(readProjectLogo(project)!.bytes.toString(), svg);
});
