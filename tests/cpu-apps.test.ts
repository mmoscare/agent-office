import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appName, parseProcStat, parsePsCpu, parseWinCpu, rankCpuApps, rankFromPercents, splitBatches, type ProcSample } from '../src/server/cpu-apps.js';

const at = 1_000_000;

function sample(pid: number, name: string, cpu: number): ProcSample {
  return { pid, name, cpu };
}

test('app names drop paths, .exe and kernel threads', () => {
  assert.equal(appName('C:\\Program Files\\Google\\chrome.exe'), 'Chrome');
  assert.equal(appName('/Applications/Cursor.app/Contents/MacOS/Cursor'), 'Cursor');
  assert.equal(appName('Agent Office'), 'Agent Office');
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
  const split = splitBatches('1\tnode\t1\n2\tchrome\t2\n---\n3\tcode\t');
  assert.deepEqual(split.batches, [['1\tnode\t1', '2\tchrome\t2']]);
  assert.equal(split.rest, '3\tcode\t');
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
