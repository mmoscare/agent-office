import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('a completed native Windows terminal lets its owner exit naturally', { skip: process.platform !== 'win32' }, () => {
  const script = `
    const { spawn } = require('@lydell/node-pty');
    import('./src/server/windows-pty.ts').then(({ releaseWindowsPtyOnExit }) => {
    const terminal = releaseWindowsPtyOnExit(spawn(process.execPath, ['-e', 'console.log(42);setTimeout(()=>{},200)'], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
    }));
    terminal.onData(data => process.stdout.write(data));
    terminal.onExit(() => console.log('terminal exited'));
    });
  `;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '-e', script], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  assert.match(output, /terminal exited/);
  assert.match(output, /42/);
});
