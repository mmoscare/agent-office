import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appName, BatchReader, parseProcStat, parsePsCpu, parseWinCpu, rankCpuApps, rankFromPercents, type ProcSample } from '../src/server/cpu-apps.js';

const at = 1_000_000;

function sample(pid: number, name: string, cpu: number): ProcSample {
  return { pid, name, cpu };
}

test('app names drop paths, .exe and kernel threads', () => {
  assert.equal(appName('C:\\Program Files\\Google\\chrome.exe'), 'Chrome');
  assert.equal(appName('/Applications/Cursor.app/Contents/MacOS/Cursor'), 'Cursor');
  assert.equal(appName('Agent Office'), 'Agent Office');
  assert.equal(appName('claude.exe'), 'Claude');
  assert.equal(appName('Idle'), '');
  assert.equal(appName('[kworker/0:1]'), '');
  assert.equal(appName('kernel_task'), '');
});

test('windows lines are pid, name, cumulative seconds', () => {
  const parsed = parseWinCpu('12\tchrome\t1.5\r\n\r\nnope\n7\tAdobe Desktop Service\t0,25\n');
  assert.deepEqual(parsed, [
    { pid: 12, name: 'chrome', cpu: 1.5 },
    { pid: 7, name: 'Adobe Desktop Service', cpu: 0.25 },
  ]);
});

test('ps lines keep a command that has spaces', () => {
  const parsed = parsePsCpu('  12.5 Google Chrome\n  0.0 kernel_task\n');
  assert.deepEqual(parsed, [
    { name: 'Google Chrome', pcpu: 12.5 },
    { name: 'kernel_task', pcpu: 0 },
  ]);
});

test('a proc stat line is seconds of user plus system time', () => {
  const rest = Array.from({ length: 15 }, () => '0');
  rest[11] = '150';
  rest[12] = '50';
  const parsed = parseProcStat(`42 (chrome) ${rest.join(' ')}`);
  assert.deepEqual(parsed, { pid: 42, name: 'chrome', cpu: 2 });
});

test('a batch closes on --- and a partial line stays behind', () => {
  const reader = new BatchReader();
  assert.deepEqual(reader.push(Buffer.from('1\tnode\t1\n2\tchrome\t2\n---\n3\tcode\t')), [['1\tnode\t1', '2\tchrome\t2']]);
  assert.deepEqual(reader.push(Buffer.from('4\n---\n')), [['3\tcode\t4']]);
});

test('a chunk that ends right after a line keeps that line apart from the next one', () => {
  const reader = new BatchReader();
  assert.deepEqual(reader.push(Buffer.from('1\tnode\t1\n---\n3\tcode\t1\n')), [['1\tnode\t1']]);
  assert.deepEqual(reader.push(Buffer.from('4\tnode\t2\n---\n')), [['3\tcode\t1', '4\tnode\t2']]);
  assert.deepEqual(reader.push(Buffer.from('5\tcode\t2\n')), []);
  assert.deepEqual(reader.push(Buffer.from('---\n')), [['5\tcode\t2']]);
});

test('batches come out whole wherever stdout splits', () => {
  // CRLF like PowerShell, a name with multi-byte characters, and an unfinished line at the end.
  const stream = '12\tchrome\t1.5\r\n7\tcafé 字\t0.25\r\n---\r\n12\tchrome\t2\r\n7\tcafé 字\t0.5\r\n---\r\n13\tcode\t';
  const want = [
    ['12\tchrome\t1.5', '7\tcafé 字\t0.25'],
    ['12\tchrome\t2', '7\tcafé 字\t0.5'],
  ];
  for (const bytes of [Buffer.from(stream, 'utf8'), Buffer.from(`﻿${stream}`, 'utf16le')]) {
    // Two chunks, cut at every byte: mid-line, right after a newline, inside \r\n, inside ---, inside a character.
    for (let cut = 0; cut <= bytes.length; cut++) {
      const reader = new BatchReader();
      const got = [...reader.push(bytes.subarray(0, cut)), ...reader.push(bytes.subarray(cut))];
      assert.deepEqual(got, want, `cut at byte ${cut} of ${bytes.length}`);
    }
    const reader = new BatchReader();
    assert.deepEqual([...bytes].flatMap((byte) => reader.push(Buffer.from([byte]))), want, 'one byte at a time');
  }
});

test('two readings rank apps by share of the machine, busiest five', () => {
  const prev = new Map<number, ProcSample>([
    [1, sample(1, 'chrome', 0)],
    [2, sample(2, 'chrome', 0)],
    [3, sample(3, 'Cursor', 0)],
    [4, sample(4, 'Idle', 0)],
    [5, sample(5, 'node', 10)],
  ]);
  const next = [
    sample(1, 'chrome', 2),
    sample(2, 'chrome', 2),
    sample(3, 'Cursor', 1),
    sample(4, 'Idle', 40),
    sample(5, 'node', 10.2),
    sample(6, 'slack', 0.4),
    sample(7, 'old-but-new-to-us', 100),
  ];
  // 4 seconds, 8 cores. chrome used 4s of CPU: 4/4/8 = 12.5% of the machine.
  const ranked = rankCpuApps(prev, at, next, at + 4_000, 8);
  assert.deepEqual(ranked, [
    { name: 'Chrome', pct: 12.5 },
    { name: 'Cursor', pct: 3.1 },
    { name: 'Slack', pct: 1.3 },
    { name: 'Node', pct: 0.6 },
  ]);
  assert.equal(ranked.some((app) => app.name === 'Idle' || app.name === 'old-but-new-to-us'), false);
});

test('ps percents are of one core, and only the top five are kept', () => {
  const rows = [
    { name: 'chrome', pcpu: 80 },
    { name: 'chrome', pcpu: 80 },
    { name: 'Cursor', pcpu: 40 },
    { name: 'a', pcpu: 8 },
    { name: 'b', pcpu: 8 },
    { name: 'c', pcpu: 8 },
    { name: 'd', pcpu: 8 },
    { name: 'kernel_task', pcpu: 400 },
  ];
  const ranked = rankFromPercents(rows, 8);
  assert.equal(ranked.length, 5);
  assert.deepEqual(ranked[0], { name: 'Chrome', pct: 20 });
  assert.deepEqual(ranked[1], { name: 'Cursor', pct: 5 });
  assert.equal(ranked.some((app) => app.name === 'kernel_task'), false);
});
