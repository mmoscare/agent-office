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
