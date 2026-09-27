import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CODEX_HOOK_EVENTS, codexHookArgs, writeCodexHook } from '../src/server/codex.js';

test('generated Windows Codex hook commands deliver every event through the shell', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "office hook's %PATH% & data "));
  const file = writeCodexHook(dir);
  const received: { event: string | null; prompt?: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(req.headers.authorization, 'Bearer test-only');
      received.push({ event: new URL(req.url!, 'http://localhost').searchParams.get('event'), prompt: body.prompt });
      res.writeHead(200).end();
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const overrides = codexHookArgs(file);
    const prompt = 'Fix café 🐱: "quotes" & %PATH%\nsecond line';
    for (let i = 0; i < CODEX_HOOK_EVENTS.length; i++) {
      const event = CODEX_HOOK_EVENTS[i];
      const match = /command_windows=("(?:\\.|[^"\\])*")/.exec(overrides[i * 2 + 1]);
      assert.ok(match, 'use the documented Windows command override');
      const command: string = JSON.parse(match[1]);
      // Exercise both Windows shell dispatchers for the user-input event.
      const shells = event === 'UserPromptSubmit' ? ['powershell.exe', process.env.COMSPEC!] : ['powershell.exe'];
      for (const shell of shells) {
        const args = /cmd\.exe$/i.test(shell) ? ['/d', '/s', '/c', command] : ['-NoProfile', '-NonInteractive', '-Command', command];
        const child = spawn(shell, args, {
          env: { ...process.env, AGENT_OFFICE_HOOK_URL: `http://127.0.0.1:${address.port}`, AGENT_OFFICE_HOOK_TOKEN: 'test-only', AGENT_OFFICE_WORKER_ID: 'test-worker' },
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 3000,
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const finished = new Promise<void>((resolve, reject) => {
          child.on('error', reject);
          child.on('close', (code) => {
            try {
              assert.equal(code, 0, stderr);
              assert.equal(stdout.trim(), '{}');
              assert.equal(stderr, '');
              resolve();
            } catch (error) { reject(error); }
          });
        });
        child.stdin.end(JSON.stringify({ session_id: 'test-session', prompt }));
        await finished;
        assert.deepEqual(received.pop(), { event, prompt: event === 'UserPromptSubmit' ? prompt : undefined });
      }
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    unlinkSync(file);
    rmdirSync(dir);
  }
});
