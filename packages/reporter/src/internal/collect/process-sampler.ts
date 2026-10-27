import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import {
  CgroupFs,
  ProcFs,
  descendantsOf,
  parsePsOutput,
  parseWindowsProcesses,
  roleOf,
  type ContainerReads,
  type CpuTicks,
  type ProcessRole,
} from '../support/system-readers.js';
import type { RoleUsage, SeriesPoint, WireRunProfile } from '@piwitests/core/wire';

/**
 * The run sampler: what the run cost the machine, read from the operating
 * system on a background timer in the reporter's process, so it needs no
 * fixtures. Every second it reads the CPU time and run-queue wait of each
 * process under the runner (workers, browsers, the web server) and the
 * machine's load; every few seconds the tree's memory (PSS), the container's
 * counters, free space and the disk the run's output takes. Each reading of
 * the tree is also added up under each Playwright worker process, the browsers
 * it started included. Linux reads all of it; macOS reads the tree through
 * `ps` and Windows through a CIM query, every few seconds; elsewhere the tree
 * is not measured. What a platform cannot read is listed as not measured,
 * never reported as zero.
 */

/** What a run cost the machine it ran on. */
export type RunProfile = WireRunProfile;

/** The machine's CPU and the run's memory over time, each point at the time it was read. */
export interface RunSamples {
  /** Epoch milliseconds of the first sample; every point counts from it. */
  startedAt: number;
  cpuPct: SeriesPoint[];
  memoryBytes: SeriesPoint[];
  /** Each Playwright worker process with the processes under it (its browsers), by its process id. */
  workers: Array<{ pid: number; cpuCores: SeriesPoint[]; memoryBytes: SeriesPoint[] }>;
}

/** One worker process and the processes under it, over time. */
interface WorkerTree {
  pid: number;
  cpuCores: SeriesPoint[];
  memoryBytes: SeriesPoint[];
}

export interface SamplerOptions {
  /** The runner's process, whose descendants are the run's processes. */
  rootPid?: number;
  platform?: NodeJS.Platform;
  procRoot?: string;
  cgroupRoot?: string;
  /** The projects' output directories. */
  outputDirs?: string[];
  tmpDir?: string;
  intervalMs?: number;
  /** Every how many samples the heavy reads run: memory, container, disk. */
  heavyEvery?: number;
  /** Every how many heavy samples Windows reads the tree; its CIM query costs about half a second of CPU. */
  windowsTreeEvery?: number;
  now?: () => number;
  /** `ps` output on macOS; a test stands in for it. */
  runPs?: () => Promise<string>;
  /** CIM JSON on Windows; a test stands in for it. */
  runWindows?: () => Promise<string>;
}

/** The most files a disk walk visits per sample; past it the size is a lower bound. */
const WALK_FILE_CAP = 10_000;
/** The most series points kept: an hour at one per second. */
const SERIES_CAP = 3600;
/** The most timed points kept per series; past it, neighbors merge two by two. */
const TIMED_CAP = 3600;
/** Names Playwright gives the browser profiles and artifact folders it writes in the temp directory. */
const PLAYWRIGHT_TEMP = /^(playwright_\w+dev_profile-|playwright-artifacts-)/;

interface Tracked {
  role: ProcessRole | null;
  firstCpuMs: number;
  firstWaitMs: number | null;
  lastCpuMs: number;
  lastWaitMs: number | null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function mean(a: number, b: number): number {
  return round1((a + b) / 2);
}

function mean2(a: number, b: number): number {
  return Math.round(((a + b) / 2) * 100) / 100;
}

/**
 * A timed series with one more point. Past `TIMED_CAP`, neighbors merge two by
 * two (at the first one's time, their values merged by `merge`), so a long run
 * keeps its whole span at a coarser step.
 */
function pushTimed(points: SeriesPoint[], point: SeriesPoint, merge: (a: number, b: number) => number): SeriesPoint[] {
  points.push(point);
  if (points.length <= TIMED_CAP) return points;
  const merged: SeriesPoint[] = [];
  for (let i = 0; i < points.length; i += 2) {
    const next = points[i + 1];
    merged.push(next ? [points[i]![0], merge(points[i]![1], next[1])] : points[i]!);
  }
  return merged;
}

function pct(part: number, whole: number): number | null {
  return whole > 0 ? round1((part / whole) * 100) : null;
}

/** CPU ticks from Node, for platforms without `/proc/stat`: no iowait, no steal. */
function nodeCpuTicks(): CpuTicks | null {
  const cpus = os.cpus();
  if (cpus.length === 0) return null;
  let busy = 0;
  let idle = 0;
  for (const cpu of cpus) {
    busy += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq;
    idle += cpu.times.idle;
  }
  return { busy, idle, iowait: 0, steal: 0, total: busy + idle };
}

function defaultPs(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-A', '-o', 'pid=,ppid=,rss=,time=,command='],
      { timeout: 2000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/**
 * CIM's `Win32_Process` on Windows, the query's own process and its children
 * excluded, so reading the tree never counts as the run: working set, CPU time
 * and the parent to build the tree. A cold machine's first query can take
 * several seconds, so the timeout leaves room for it.
 */
function defaultWindowsQuery(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.ParentProcessId -ne $PID } | Select-Object ProcessId,ParentProcessId,WorkingSetSize,UserModeTime,KernelModeTime,Name,CommandLine | ConvertTo-Json -Compress',
      ],
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** Free bytes on the filesystem holding `dir`, or on its nearest existing parent. */
function freeBytes(dir: string): number | null {
  let current = path.resolve(dir);
  for (;;) {
    try {
      const stats = fs.statfsSync(current);
      return stats.bavail * stats.bsize;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** Bytes under a directory, visiting at most `budget.files` files. */
async function dirBytes(dir: string, budget: { files: number }): Promise<number> {
  let bytes = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (budget.files <= 0) return bytes;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) bytes += await dirBytes(full, budget);
    else if (entry.isFile()) {
      budget.files--;
      try {
        bytes += (await fs.promises.lstat(full)).size;
      } catch {
        // Removed while the walk ran.
      }
    }
  }
  return bytes;
}

/** The machine's memory, and its container's limit when lower than it. */
function memoryOf(container: ContainerReads | null): { memoryBytes: number; memoryLimitBytes: number | null } {
  const totalMemory = os.totalmem();
  const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : undefined;
  const limit = container?.memoryLimitBytes ?? (constrained && constrained > 0 ? constrained : null);
  return { memoryBytes: totalMemory, memoryLimitBytes: limit !== null && limit < totalMemory ? limit : null };
}

export class RunSampler {
  private readonly rootPid: number;
  private readonly platform: NodeJS.Platform;
  private readonly proc: ProcFs;
  private readonly cgroup: CgroupFs;
  private readonly outputDirs: string[];
  private readonly tmpDir: string;
  private readonly intervalMs: number;
  private readonly heavyEvery: number;
  private readonly windowsTreeEvery: number;
  private readonly now: () => number;
  private readonly runPs: () => Promise<string>;
  private readonly runWindows: () => Promise<string>;
  private readonly linux: boolean;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private samples = 0;
  private startedAt = 0;
  private tracked = new Map<string, Tracked>();
  private treeMeasured = false;
  private waitMeasured = false;
  private cpuStart: CpuTicks | null = null;
  private cpuPrevious: CpuTicks | null = null;
  private series: number[] = [];
  private cpuPoints: SeriesPoint[] = [];
  private memoryPoints: SeriesPoint[] = [];
  /** Each worker process's tree, by the worker's process key. */
  private workerTrees = new Map<string, WorkerTree>();
  /** When the workers' CPU was last read, for the cores they used since. */
  private workersReadAt: number | null = null;
  private pressureStart: { cpu: number | null; memory: number | null } = { cpu: null, memory: null };
  private containerStart: ContainerReads | null = null;
  private memoryKind: 'pss' | 'rss' | null = null;
  private peakBytes: number | null = null;
  private peakAtMs: number | null = null;
  private largest: { role: ProcessRole; bytes: number } | null = null;
  private rssFallbackPids = new Set<string>();
  private lowestAvailableKb: number | null = null;
  private peakInUse: number | null = null;
  private peakInUseIsLowerBound = false;
  private lowestFree: number | null = null;
  private capacityBytes: number | undefined;

  constructor(options: SamplerOptions = {}) {
    this.rootPid = options.rootPid ?? process.pid;
    this.platform = options.platform ?? process.platform;
    this.proc = new ProcFs(options.procRoot);
    this.cgroup = new CgroupFs(options.procRoot, options.cgroupRoot);
    this.outputDirs = [...new Set((options.outputDirs ?? []).map((dir) => path.resolve(dir)))];
    this.tmpDir = options.tmpDir ?? os.tmpdir();
    this.intervalMs = options.intervalMs ?? 1000;
    this.heavyEvery = Math.max(1, options.heavyEvery ?? 5);
    this.windowsTreeEvery = Math.max(1, options.windowsTreeEvery ?? 3);
    this.now = options.now ?? Date.now;
    this.runPs = options.runPs ?? defaultPs;
    this.runWindows = options.runWindows ?? defaultWindowsQuery;
    this.linux = this.platform === 'linux' && this.proc.available();
  }

  /** Take the first sample and sample on a timer that never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    this.startedAt = this.now();
    this.cpuStart = this.cpuTicks();
    this.cpuPrevious = this.cpuStart;
    if (this.linux) {
      this.pressureStart = { cpu: this.proc.pressureUs('cpu'), memory: this.proc.pressureUs('memory') };
      this.containerStart = this.cgroup.read();
    }
    this.schedule();
    this.timer = setInterval(() => this.schedule(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Take the last sample and return the run's profile. Never throws. */
  async stop(): Promise<RunProfile> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      await this.running;
      await this.sample(true, true);
    } catch {
      // A profile from what was read so far.
    }
    return this.profile(await this.leftoverBytes());
  }

  /**
   * What a live run's memory is drawn against: the machine's memory, or its
   * container's limit when lower, read once, and how the run's memory is
   * measured so far.
   */
  liveMemory(): { capacityBytes: number | null; kind: 'pss' | 'rss' | null } {
    if (this.capacityBytes === undefined) {
      const machine = memoryOf(this.linux ? this.cgroup.read() : null);
      this.capacityBytes = machine.memoryLimitBytes ?? machine.memoryBytes;
    }
    return { capacityBytes: this.capacityBytes || null, kind: this.memoryKind };
  }

  /** The series read so far, each point at the time it was read. */
  timedSeries(): RunSamples {
    return {
      startedAt: this.startedAt,
      cpuPct: [...this.cpuPoints],
      memoryBytes: [...this.memoryPoints],
      workers: [...this.workerTrees.values()].map((tree) => ({
        pid: tree.pid,
        cpuCores: [...tree.cpuCores],
        memoryBytes: [...tree.memoryBytes],
      })),
    };
  }

  private schedule(): void {
    if (this.running) return;
    const heavy = this.samples % this.heavyEvery === 0;
    this.running = this.sample(heavy)
      .catch(() => undefined)
      .finally(() => {
        this.running = null;
      });
  }

  private cpuTicks(): CpuTicks | null {
    return this.linux ? this.proc.cpuTicks() : nodeCpuTicks();
  }

  private async sample(heavy: boolean, forceTree = false): Promise<void> {
    const treeDue = forceTree || this.samples % (this.heavyEvery * this.windowsTreeEvery) === 0;
    this.samples++;
    // Every reading of this sample is stamped with the time it started.
    const at = this.now() - this.startedAt;
    const ticks = this.cpuTicks();
    if (ticks && this.cpuPrevious) {
      const busy = pct(ticks.busy - this.cpuPrevious.busy, ticks.total - this.cpuPrevious.total);
      if (busy !== null && this.series.length < SERIES_CAP) this.series.push(busy);
      if (busy !== null) this.cpuPoints = pushTimed(this.cpuPoints, [at, busy], mean);
    }
    if (ticks) this.cpuPrevious = ticks;

    const availableKb = this.linux ? this.proc.memAvailableKb() : Math.round(os.freemem() / 1024);
    if (availableKb !== null) this.lowestAvailableKb = Math.min(this.lowestAvailableKb ?? Infinity, availableKb);

    if (this.linux) await this.sampleLinuxTree(heavy, at);
    else if (this.platform === 'darwin' && heavy) await this.samplePsTree(at);
    else if (this.platform === 'win32' && treeDue) await this.sampleWindowsTree(at);
    if (heavy) await this.sampleDisk();
  }

  private track(key: string, role: ProcessRole | null, cpuMs: number, waitMs: number | null): void {
    const known = this.tracked.get(key);
    if (known) {
      known.lastCpuMs = cpuMs;
      known.lastWaitMs = waitMs;
      if (role) known.role = role;
      return;
    }
    // A process alive at the first sample counts from there; one born later counts from zero.
    const first = this.samples === 1;
    this.tracked.set(key, {
      role,
      firstCpuMs: first ? cpuMs : 0,
      firstWaitMs: first ? waitMs : waitMs === null ? null : 0,
      lastCpuMs: cpuMs,
      lastWaitMs: waitMs,
    });
  }

  /**
   * The worker each process of the tree belongs to: a worker process itself,
   * or the worker it descends from (its browsers and their children). The
   * runner and the web server belong to none. The tree lists parents first.
   */
  private workersOf<T extends { pid: number; ppid: number }>(
    tree: T[],
    roles: Map<number, ProcessRole>,
    keyOf: (proc: T) => string,
  ): Map<number, { key: string; pid: number }> {
    const out = new Map<number, { key: string; pid: number }>();
    for (const proc of tree) {
      if (roles.get(proc.pid) === 'worker') out.set(proc.pid, { key: keyOf(proc), pid: proc.pid });
      else {
        const parent = out.get(proc.ppid);
        if (parent) out.set(proc.pid, parent);
      }
    }
    return out;
  }

  /** The CPU a process used since the previous sample: all of it for one born since, none at the first sample. */
  private cpuSince(key: string, cpuMs: number): number {
    const known = this.tracked.get(key);
    if (known) return Math.max(0, cpuMs - known.lastCpuMs);
    return this.samples === 1 ? 0 : cpuMs;
  }

  /**
   * Add a reading to each worker's tree: the cores its processes used since
   * the previous reading, and on heavy samples their memory.
   */
  private noteWorkers(
    workers: Map<number, { key: string; pid: number }>,
    cpuMsByWorker: Map<string, number>,
    bytesByWorker: Map<string, number> | null,
    at: number,
  ): void {
    const elapsed = this.workersReadAt === null ? 0 : at - this.workersReadAt;
    for (const { key, pid } of new Map([...workers.values()].map((w) => [w.key, w])).values()) {
      let tree = this.workerTrees.get(key);
      if (!tree) {
        tree = { pid, cpuCores: [], memoryBytes: [] };
        this.workerTrees.set(key, tree);
      }
      if (elapsed > 0) {
        const cores = Math.round(((cpuMsByWorker.get(key) ?? 0) / elapsed) * 100) / 100;
        tree.cpuCores = pushTimed(tree.cpuCores, [at, cores], mean2);
      }
      const bytes = bytesByWorker?.get(key);
      if (bytes !== undefined) tree.memoryBytes = pushTimed(tree.memoryBytes, [at, bytes], Math.max);
    }
    this.workersReadAt = at;
  }

  /** The role of each process of the tree, a child of the runner being the web server unless it says otherwise. */
  private resolveRoles<T extends { pid: number; ppid: number }>(tree: T[], explicit: (proc: T) => ProcessRole | null) {
    const roles = new Map<number, ProcessRole>([[this.rootPid, 'runner']]);
    for (const proc of tree) {
      const parent = roles.get(proc.ppid);
      const inherited = parent === 'runner' || parent === 'webServer' ? 'webServer' : 'other';
      roles.set(proc.pid, explicit(proc) ?? inherited);
    }
    return roles;
  }

  private async sampleLinuxTree(heavy: boolean, at: number): Promise<void> {
    const table = this.proc.table();
    const root = table.get(this.rootPid);
    if (!root) return;
    this.treeMeasured = true;
    const tree = [root, ...descendantsOf(this.rootPid, table.values())];
    const roles = this.resolveRoles(tree.slice(1), (proc) => {
      const key = `${proc.pid}:${proc.start}`;
      const known = this.tracked.get(key)?.role;
      // The command line is read once, and again on heavy samples: a forked process may exec later.
      return known && !heavy ? known : roleOf(proc.comm, this.proc.cmdline(proc.pid));
    });
    const workers = this.workersOf(tree, roles, (proc) => `${proc.pid}:${proc.start}`);
    const cpuMsByWorker = new Map<string, number>();
    for (const proc of tree) {
      const key = `${proc.pid}:${proc.start}`;
      const worker = workers.get(proc.pid);
      if (worker) {
        cpuMsByWorker.set(worker.key, (cpuMsByWorker.get(worker.key) ?? 0) + this.cpuSince(key, proc.cpuMs));
      }
      const waitMs = this.proc.runWaitMs(proc.pid);
      if (waitMs !== null) this.waitMeasured = true;
      this.track(key, roles.get(proc.pid) ?? 'other', proc.cpuMs, waitMs);
    }
    if (!heavy) {
      this.noteWorkers(workers, cpuMsByWorker, null, at);
      return;
    }

    let total = 0;
    let largest: { role: ProcessRole; bytes: number } | null = null;
    const memory = await Promise.all(
      tree.map(async (proc) => {
        const pss = await this.proc.pssKb(proc.pid);
        if (pss !== null) return { proc, kb: pss, fallback: false };
        return { proc, kb: this.proc.statusKb(proc.pid, 'VmRSS'), fallback: true };
      }),
    );
    const bytesByWorker = new Map<string, number>();
    for (const { proc, kb, fallback } of memory) {
      if (kb === null) continue;
      if (fallback) this.rssFallbackPids.add(`${proc.pid}:${proc.start}`);
      total += kb * 1024;
      if (!largest || kb * 1024 > largest.bytes) largest = { role: roles.get(proc.pid) ?? 'other', bytes: kb * 1024 };
      const worker = workers.get(proc.pid);
      if (worker) bytesByWorker.set(worker.key, (bytesByWorker.get(worker.key) ?? 0) + kb * 1024);
    }
    this.memoryKind = memory.some((m) => m.kb !== null && !m.fallback) ? 'pss' : memory.length ? 'rss' : null;
    this.notePeak(total, largest, at);
    this.noteWorkers(workers, cpuMsByWorker, bytesByWorker, at);
  }

  private async samplePsTree(at: number): Promise<void> {
    let list;
    try {
      list = parsePsOutput(await this.runPs());
    } catch {
      return;
    }
    this.noteTree(list, (proc) => roleOf(path.basename(proc.command.split(' ')[0] ?? ''), proc.command), at);
  }

  private async sampleWindowsTree(at: number): Promise<void> {
    let list;
    try {
      list = parseWindowsProcesses(await this.runWindows());
    } catch {
      return;
    }
    this.noteTree(list, (proc) => roleOf(proc.name, proc.commandLine), at);
  }

  /** One reading of the run's tree: each process's role, CPU time and memory, and each worker's share of both. */
  private noteTree<T extends { pid: number; ppid: number; rssKb: number; cpuMs: number }>(
    list: T[],
    role: (proc: T) => ProcessRole | null,
    at: number,
  ): void {
    const root = list.find((proc) => proc.pid === this.rootPid);
    if (!root) return;
    this.treeMeasured = true;
    const tree = [root, ...descendantsOf(this.rootPid, list)];
    const roles = this.resolveRoles(tree.slice(1), role);
    let total = 0;
    let largest: { role: ProcessRole; bytes: number } | null = null;
    const workers = this.workersOf(tree, roles, (proc) => String(proc.pid));
    const cpuMsByWorker = new Map<string, number>();
    const bytesByWorker = new Map<string, number>();
    for (const proc of tree) {
      const procRole = roles.get(proc.pid) ?? 'other';
      const worker = workers.get(proc.pid);
      if (worker) {
        const cpuMs = this.cpuSince(String(proc.pid), proc.cpuMs);
        cpuMsByWorker.set(worker.key, (cpuMsByWorker.get(worker.key) ?? 0) + cpuMs);
        bytesByWorker.set(worker.key, (bytesByWorker.get(worker.key) ?? 0) + proc.rssKb * 1024);
      }
      this.track(String(proc.pid), procRole, proc.cpuMs, null);
      total += proc.rssKb * 1024;
      if (!largest || proc.rssKb * 1024 > largest.bytes) largest = { role: procRole, bytes: proc.rssKb * 1024 };
    }
    this.memoryKind = 'rss';
    this.notePeak(total, largest, at);
    this.noteWorkers(workers, cpuMsByWorker, bytesByWorker, at);
  }

  private notePeak(total: number, largest: { role: ProcessRole; bytes: number } | null, at: number): void {
    this.memoryPoints = pushTimed(this.memoryPoints, [at, total], Math.max);
    if (this.peakBytes === null || total > this.peakBytes) {
      this.peakBytes = total;
      this.peakAtMs = this.now() - this.startedAt;
    }
    if (largest && (!this.largest || largest.bytes > this.largest.bytes)) this.largest = largest;
  }

  private async sampleDisk(): Promise<void> {
    for (const dir of [...this.outputDirs, this.tmpDir]) {
      const free = freeBytes(dir);
      if (free !== null) this.lowestFree = Math.min(this.lowestFree ?? Infinity, free);
    }
    const budget = { files: WALK_FILE_CAP };
    let bytes = 0;
    for (const dir of this.outputDirs) bytes += await dirBytes(dir, budget);
    for (const name of await this.playwrightTempEntries((mtimeMs) => mtimeMs >= this.startedAt - 1000)) {
      bytes += await dirBytes(path.join(this.tmpDir, name), budget);
    }
    if (budget.files <= 0) this.peakInUseIsLowerBound = true;
    this.peakInUse = Math.max(this.peakInUse ?? 0, bytes);
  }

  /** Playwright's folders in the temp directory whose modification time passes `keep`. */
  private async playwrightTempEntries(keep: (mtimeMs: number) => boolean): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.tmpDir);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const name of names) {
      if (!PLAYWRIGHT_TEMP.test(name)) continue;
      try {
        if (keep((await fs.promises.stat(path.join(this.tmpDir, name))).mtimeMs)) out.push(name);
      } catch {
        // Removed while listed.
      }
    }
    return out;
  }

  private async leftoverBytes(): Promise<number | null> {
    try {
      const budget = { files: WALK_FILE_CAP };
      let bytes = 0;
      for (const name of await this.playwrightTempEntries((mtimeMs) => mtimeMs < this.startedAt - 1000)) {
        bytes += await dirBytes(path.join(this.tmpDir, name), budget);
      }
      return bytes;
    } catch {
      return null;
    }
  }

  private profile(leftoverBytes: number | null): RunProfile {
    const wallMs = Math.max(0, this.now() - this.startedAt);
    const notMeasured: string[] = [];

    let byRole: RunProfile['cpu']['byRole'] = null;
    if (this.treeMeasured) {
      byRole = {};
      for (const entry of this.tracked.values()) {
        const role = entry.role ?? 'other';
        const usage = (byRole[role] ??= { cpuMs: 0, runWaitMs: this.waitMeasured ? 0 : null, processes: 0 });
        usage.cpuMs += Math.max(0, entry.lastCpuMs - entry.firstCpuMs);
        if (usage.runWaitMs !== null && entry.lastWaitMs !== null && entry.firstWaitMs !== null) {
          usage.runWaitMs += Math.max(0, entry.lastWaitMs - entry.firstWaitMs);
        }
        usage.processes++;
      }
    } else {
      notMeasured.push('CPU and memory of the run’s processes');
    }
    if (this.treeMeasured && !this.waitMeasured) notMeasured.push('time waiting for a CPU');

    const end = this.cpuTicks();
    const start = this.cpuStart;
    const total = end && start ? end.total - start.total : 0;
    const machineCpu = {
      busyPct: end && start ? pct(end.busy - start.busy, total) : null,
      iowaitPct: this.linux && end && start ? pct(end.iowait - start.iowait, total) : null,
      stealPct: this.linux && end && start ? pct(end.steal - start.steal, total) : null,
    };
    if (!this.linux) notMeasured.push('steal');

    const pressure = (resource: 'cpu' | 'memory', from: number | null) => {
      if (!this.linux || from === null) return null;
      const to = this.proc.pressureUs(resource);
      return to === null || wallMs === 0 ? null : Math.min(100, round1(((to - from) / 1000 / wallMs) * 100));
    };
    const cpuPressure = pressure('cpu', this.pressureStart.cpu);
    const memoryPressure = pressure('memory', this.pressureStart.memory);
    if (cpuPressure === null) notMeasured.push('CPU pressure');

    const container = this.linux ? this.cgroup.read() : null;
    const startContainer = this.containerStart;
    const raisedPeak =
      container?.memoryPeakBytes != null &&
      startContainer?.memoryPeakBytes != null &&
      container.memoryPeakBytes > startContainer.memoryPeakBytes
        ? container.memoryPeakBytes
        : null;
    const delta = (to: number | null | undefined, from: number | null | undefined) =>
      to != null && from != null ? Math.max(0, to - from) : null;

    return {
      platform: this.platform,
      wallMs,
      machine: {
        cores: typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
        ...memoryOf(container),
        cpuQuotaCores: container?.cpuQuotaCores ?? null,
      },
      cpu: {
        ...machineCpu,
        pressurePct: cpuPressure,
        series: this.series,
        byRole,
        throttledMs: delta(container?.throttledMs, startContainer?.throttledMs),
      },
      memory: {
        kind: this.memoryKind,
        peakBytes: this.peakBytes,
        peakAtMs: this.peakAtMs,
        largest: this.largest,
        rssFallbacks: this.memoryKind === 'pss' ? this.rssFallbackPids.size : 0,
        pressurePct: memoryPressure,
        lowestAvailableBytes: this.lowestAvailableKb === null ? null : this.lowestAvailableKb * 1024,
        containerPeakBytes: raisedPeak,
        oomKills: delta(container?.oomKills, startContainer?.oomKills),
      },
      disk: {
        peakInUseBytes: this.peakInUse,
        peakInUseIsLowerBound: this.peakInUseIsLowerBound,
        lowestFreeBytes: this.lowestFree,
        leftoverBytes,
      },
      notMeasured,
    };
  }
}
