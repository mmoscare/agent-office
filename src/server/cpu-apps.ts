import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { CpuApp } from '../shared/protocol.js';

/** Cumulative CPU time for one process, so two readings a few seconds apart give how busy it was. */
export interface ProcSample {
  pid: number;
  name: string;
  /** Seconds of CPU time so far, across every core. */
  cpu: number;
}

const SKIP = new Set([
  'idle',
  'system',
  'system idle process',
  'registry',
  'memory compression',
  'secure system',
  '_total',
  'kernel_task',
]);

/** Process names people don't recognise, written the way the wall should say them. */
const FRIENDLY: Record<string, string> = {
  chrome: 'Chrome',
  'google chrome': 'Chrome',
  msedge: 'Edge',
  msedgewebview2: 'Edge',
  firefox: 'Firefox',
  code: 'VS Code',
  cursor: 'Cursor',
  node: 'Node',
  slack: 'Slack',
  discord: 'Discord',
  spotify: 'Spotify',
  explorer: 'File Explorer',
  dwm: 'Desktop Window Manager',
  searchhost: 'Windows Search',
  searchapp: 'Windows Search',
  searchindexer: 'Search Indexer',
  msmpeng: 'Windows Defender',
  audiodg: 'Windows Audio',
  powershell: 'PowerShell',
  pwsh: 'PowerShell',
  windowsterminal: 'Terminal',
  opencode: 'OpenCode',
  claude: 'Claude',
  windowserver: 'Window Server',
};

const TOP = 5;
/** Linux jiffies. 100 on every machine this office is likely to meet; a wrong value only scales the list. */
const CLK_TCK = 100;

/** A process name as an app on the wall, or '' when it isn't one (Idle, a kernel thread). */
export function appName(raw: string): string {
  let name = raw.trim().replace(/^\uFEFF/, '').replace(/^["']|["']$/g, '');
  if (!name || name === '-' || name.startsWith('[')) return '';
  name = name.split(/[/\\]/).pop() ?? name;
  name = name.replace(/\.exe$/i, '').replace(/#\d+$/, '');
  const key = name.toLowerCase();
  if (!key || SKIP.has(key)) return '';
  return FRIENDLY[key] ?? name;
}

/** `pid<tab>name<tab>cpuSeconds` lines from the Windows sampler. */
export function parseWinCpu(text: string): ProcSample[] {
  const out: ProcSample[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (!line || line === '---') continue;
    const tab = line.split('\t');
    if (tab.length < 3) continue;
    const pid = Number(tab[0]);
    const cpu = Number(tab[tab.length - 1].replace(',', '.'));
    const name = tab.slice(1, -1).join('\t').trim();
    if (!Number.isInteger(pid) || pid < 0 || !name || !Number.isFinite(cpu)) continue;
    out.push({ pid, name, cpu });
  }
  return out;
}

/** `ps` lines: a percent, then the command. The percent is of one core, and may be past 100. */
export function parsePsCpu(text: string): { name: string; pcpu: number }[] {
  const out: { name: string; pcpu: number }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    const m = /^(\d+(?:[.,]\d+)?)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pcpu = Number(m[1].replace(',', '.'));
    if (!Number.isFinite(pcpu) || pcpu < 0) continue;
    out.push({ name: m[2].trim(), pcpu });
  }
  return out;
}

/** One `/proc/<pid>/stat` line. `cpu` is seconds, the same unit Windows reports. */
export function parseProcStat(text: string): ProcSample | undefined {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close <= open) return undefined;
  const pid = Number(text.slice(0, open).trim());
  const name = text.slice(open + 1, close);
  const rest = text.slice(close + 2).trim().split(/\s+/);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isInteger(pid) || pid < 0 || !name || !Number.isFinite(utime) || !Number.isFinite(stime)) return undefined;
  return { pid, name, cpu: (utime + stime) / CLK_TCK };
}

/**
 * Turns a sampler's stdout into finished `---` batches of lines. Chunks end anywhere (mid-line, inside
 * the marker, inside a character), so only complete lines are decoded and judged; the unterminated tail
 * waits as bytes for the next chunk. Output is UTF-8 unless it starts like UTF-16 (a BOM, or a zero
 * second byte).
 */
export class BatchReader {
  private tail: Buffer = Buffer.alloc(0);
  private lines: string[] = [];
  private utf16?: boolean;

  push(chunk: Buffer): string[][] {
    const raw = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    if (this.utf16 === undefined) {
      if (raw.length < 2) {
        this.tail = raw;
        return [];
      }
      this.utf16 = raw[1] === 0 || (raw[0] === 0xff && raw[1] === 0xfe);
    }
    const end = this.linesEnd(raw);
    this.tail = raw.subarray(end);
    // A megabyte with no newline is not a process list; drop it, keeping UTF-16 pairs aligned.
    if (this.tail.length > 1_000_000) this.tail = this.tail.subarray(this.tail.length - (this.utf16 ? this.tail.length % 2 : 0));
    if (!end) return [];
    const text = raw.subarray(0, end).toString(this.utf16 ? 'utf16le' : 'utf8');
    const batches: string[][] = [];
    for (const part of text.slice(0, -1).split('\n')) {
      const line = part.replace(/^﻿/, '').replace(/\r$/, '');
      if (line.trim() === '---') {
        batches.push(this.lines);
        this.lines = [];
      } else if (this.lines.length < 100_000) this.lines.push(line);
    }
    return batches;
  }

  /** Bytes up to and including the last `\n`: the complete lines. 0 when there are none. */
  private linesEnd(raw: Buffer): number {
    if (!this.utf16) return raw.lastIndexOf(0x0a) + 1;
    for (let i = raw.length - (raw.length % 2) - 2; i >= 0; i -= 2) {
      if (raw[i] === 0x0a && raw[i + 1] === 0) return i + 2;
    }
    return 0;
  }
}

function finish(byName: Map<string, number>, limit: number): CpuApp[] {
  return [...byName.entries()]
    .map(([name, pct]) => ({ name, pct: Math.max(0, Math.min(100, Math.round(pct * 10) / 10)) }))
    .filter((app) => app.pct >= 0.1)
    .sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * How busy each app was between two readings, as a percent of the whole machine (so it lines up with
 * the CPU gauge). A process seen for the first time only counts when its CPU time fits in the window:
 * otherwise it was already running, and the next reading is the first honest one.
 */
export function rankCpuApps(prev: Map<number, ProcSample>, prevAt: number, next: ProcSample[], now: number, cores: number, limit = TOP): CpuApp[] {
  const elapsed = (now - prevAt) / 1000;
  if (elapsed <= 0 || cores < 1) return [];
  const cap = elapsed * cores;
  const byName = new Map<string, number>();
  for (const proc of next) {
    const old = prev.get(proc.pid);
    const used = old && old.name === proc.name ? Math.min(cap, Math.max(0, proc.cpu - old.cpu)) : proc.cpu >= 0 && proc.cpu <= cap ? proc.cpu : 0;
    if (used <= 0) continue;
    const name = appName(proc.name);
    if (!name) continue;
    byName.set(name, (byName.get(name) ?? 0) + (used / elapsed / cores) * 100);
  }
  return finish(byName, limit);
}

/** `ps` already reports a rate. It is a percent of one core; divide by the core count for the machine's share. */
export function rankFromPercents(rows: { name: string; pcpu: number }[], cores: number, limit = TOP): CpuApp[] {
  const div = Math.max(1, cores);
  const byName = new Map<string, number>();
  for (const row of rows) {
    const name = appName(row.name);
    if (!name) continue;
    byName.set(name, (byName.get(name) ?? 0) + row.pcpu / div);
  }
  return finish(byName, limit);
}

const WIN_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$ProgressPreference = 'SilentlyContinue'",
  '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  'while ($true) {',
  '  Get-Process | ForEach-Object {',
  '    try {',
  '      if ($null -ne $_.CPU) {',
  '        "{0}`t{1}`t{2}" -f $_.Id, $_.ProcessName, $_.CPU.ToString([cultureinfo]::InvariantCulture)',
  '      }',
  '    } catch {}',
  '  }',
  "  Write-Output '---'",
  '  Start-Sleep -Seconds 4',
  '}',
].join('\n');

function powershellPath(): string {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function encoded(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

function run(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, out) => {
      resolve(err && !out ? undefined : String(out ?? ''));
    });
  });
}

function readLinuxProcs(): ProcSample[] | undefined {
  try {
    const out: ProcSample[] = [];
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const sample = parseProcStat(readFileSync(`/proc/${name}/stat`, 'utf8'));
        if (sample) out.push(sample);
      } catch {
        // exited between the listing and the read
      }
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * The apps using the most CPU, for the list above the wall monitor. Windows keeps a PowerShell
 * reading process CPU time (two readings a few seconds apart); Linux reads /proc the same way; macOS
 * asks `ps`, which already has a rate. A failed read leaves the last list alone.
 */
export class CpuAppSampler {
  private running = false;
  private timer?: NodeJS.Timeout;
  private restart?: NodeJS.Timeout;
  private child?: ChildProcess;
  private reader = new BatchReader();
  private prev?: { at: number; procs: Map<number, ProcSample> };

  constructor(
    private cores: () => number,
    private onApps: (apps: CpuApp[]) => void,
  ) {}

  start() {
    if (this.running) return;
    this.running = true;
    if (process.platform === 'win32') {
      this.spawnWindows();
      return;
    }
    void this.sampleUnix();
    this.timer = setInterval(() => void this.sampleUnix(), 5_000);
    this.timer.unref();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    clearTimeout(this.restart);
    this.child?.kill();
    this.child = undefined;
  }

  private spawnWindows() {
    if (!this.running) return;
    const child = spawn(powershellPath(), encoded(WIN_SCRIPT), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    child.unref();
    child.stdout?.on('data', (chunk: Buffer) => this.onWinChunk(chunk));
    const again = () => {
      if (this.child !== child || !this.running) return;
      this.child = undefined;
      this.reader = new BatchReader();
      this.restart = setTimeout(() => this.spawnWindows(), 5_000);
      this.restart.unref();
    };
    child.on('error', again);
    child.on('exit', again);
  }

  private onWinChunk(chunk: Buffer) {
    for (const lines of this.reader.push(chunk)) this.take(parseWinCpu(lines.join('\n')));
  }

  /** A percent of the machine from two cumulative readings. The first reading only starts the clock. */
  private take(samples: ProcSample[]) {
    const at = Date.now();
    const self = this.child?.pid;
    const next = self === undefined ? samples : samples.filter((proc) => proc.pid !== self);
    if (this.prev) {
      const elapsed = (at - this.prev.at) / 1000;
      if (elapsed >= 0.5 && elapsed <= 30) this.onApps(rankCpuApps(this.prev.procs, this.prev.at, next, at, Math.max(1, this.cores())));
    }
    this.prev = { at, procs: new Map(next.map((proc) => [proc.pid, proc])) };
  }

  private async sampleUnix() {
    if (!this.running) return;
    if (process.platform === 'linux') {
      const procs = readLinuxProcs();
      if (procs) {
        this.take(procs);
        return;
      }
    }
    const args = process.platform === 'darwin' ? ['-axc', '-o', 'pcpu=,comm='] : ['-axo', 'pcpu=,comm='];
    const text = await run('ps', args);
    if (!this.running || text === undefined) return;
    this.onApps(rankFromPercents(parsePsCpu(text), this.cores()));
  }
}
