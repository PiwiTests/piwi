import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProcessRole } from '@piwitests/core/wire';

/**
 * Readers for what the operating system knows about a run: processes, their
 * CPU and memory, the machine's load and pressure, and the container's limits.
 * Linux reads `/proc` and the cgroup filesystem, whose roots are parameters so
 * a test can stand a directory in for them; macOS reads `ps` and Windows CIM.
 * Every reader returns null when its source is missing or unreadable, never
 * zero, and none of them throws.
 */

/** Clock ticks per second of the CPU times in `/proc/<pid>/stat` (`USER_HZ`, 100 on Linux's user ABI). */
const CLK_TCK = 100;

export type { ProcessRole };

export interface ProcStat {
  pid: number;
  ppid: number;
  comm: string;
  /** User plus system CPU time. */
  cpuMs: number;
  /** Start time in clock ticks since boot: with the pid, it names one process even when the pid is reused. */
  start: number;
}

/** CPU ticks of the whole machine, from the first line of `/proc/stat`. */
export interface CpuTicks {
  busy: number;
  idle: number;
  iowait: number;
  steal: number;
  total: number;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** One line of `/proc/<pid>/stat`; the command name may hold spaces and parentheses. */
export function parseProcStat(pid: number, text: string): ProcStat | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const ppid = Number(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const start = Number(fields[19]);
  if (![ppid, utime, stime, start].every(Number.isFinite)) return null;
  return { pid, ppid, comm: text.slice(open + 1, close), cpuMs: ((utime + stime) * 1000) / CLK_TCK, start };
}

/** Time a process spent runnable but waiting for a CPU, from `/proc/<pid>/schedstat`. */
export function parseSchedstat(text: string): number | null {
  const waitNs = Number(text.trim().split(/\s+/)[1]);
  return Number.isFinite(waitNs) ? waitNs / 1e6 : null;
}

/** A `Key:   1234 kB` value of `/proc/<pid>/status`, `/proc/meminfo` or `smaps_rollup`, in kB. */
export function parseKbField(text: string, key: string): number | null {
  const match = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text);
  return match ? Number(match[1]) : null;
}

export function parseCpuTicks(text: string): CpuTicks | null {
  const line = text.split('\n', 1)[0] ?? '';
  if (!line.startsWith('cpu ')) return null;
  const v = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (v.length < 8 || v.some((n) => !Number.isFinite(n))) return null;
  const [user, nice, system, idle, iowait, irq, softirq, steal] = v as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return { busy: user + nice + system + irq + softirq, idle, iowait, steal, total: v.reduce((sum, n) => sum + n, 0) };
}

/** The `some` total of a pressure file: microseconds some task stalled on the resource. */
export function parsePsiTotal(text: string): number | null {
  const match = /^some\b.*\btotal=(\d+)/m.exec(text);
  return match ? Number(match[1]) : null;
}

/** `[[dd-]hh:]mm:ss[.cc]`, the CPU time `ps` prints, in ms. */
export function parsePsTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000;
}

export interface PsProcess {
  pid: number;
  ppid: number;
  rssKb: number;
  cpuMs: number;
  command: string;
}

/** The output of `ps -A -o pid=,ppid=,rss=,time=,command=`. */
export function parsePsOutput(text: string): PsProcess[] {
  const out: PsProcess[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const cpuMs = parsePsTime(match[4]!);
    if (cpuMs === null) continue;
    out.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      cpuMs,
      command: match[5]!.trim(),
    });
  }
  return out;
}

export interface WindowsProcess {
  pid: number;
  ppid: number;
  rssKb: number;
  cpuMs: number;
  name: string;
  commandLine: string;
}

/**
 * The JSON `Get-CimInstance Win32_Process` prints, one row per process or a
 * single row when the machine has one: the working set in bytes and the CPU
 * times in 100 ns units. A row without a process id is skipped.
 */
export function parseWindowsProcesses(text: string): WindowsProcess[] {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return [];
  }
  const rows: unknown[] = Array.isArray(data) ? data : [data];
  const out: WindowsProcess[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const pid = Number(record.ProcessId);
    const ppid = Number(record.ParentProcessId);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const workingSet = Number(record.WorkingSetSize);
    const user = Number(record.UserModeTime);
    const kernel = Number(record.KernelModeTime);
    out.push({
      pid,
      ppid,
      rssKb: Number.isFinite(workingSet) ? Math.round(workingSet / 1024) : 0,
      cpuMs: ((Number.isFinite(user) ? user : 0) + (Number.isFinite(kernel) ? kernel : 0)) / 10_000,
      name: typeof record.Name === 'string' ? record.Name : '',
      commandLine: typeof record.CommandLine === 'string' ? record.CommandLine : '',
    });
  }
  return out;
}

/**
 * A process's role from its name and command line, or null when only its place
 * in the tree can tell (a child of the runner is the web server, say).
 */
export function roleOf(comm: string, cmdline: string): ProcessRole | null {
  const command = `${comm} ${cmdline}`;
  // Playwright's workers run `workerProcessEntry`, and before 1.60 its `lib/common/process.js`.
  if (/workerProcessEntry|[\\/]playwright[\\/]lib[\\/]common[\\/]process\.js/.test(cmdline)) return 'worker';
  if (/loaderProcessEntry/.test(cmdline)) return 'runner';
  if (/(^|[\s/])ffmpeg/.test(command)) return 'ffmpeg';
  const type = /--type=([\w-]+)/.exec(cmdline)?.[1];
  if (/chrom|headless_shell|msedge|Google Chrome/i.test(command)) {
    if (!type) return 'browser';
    if (type === 'renderer') return 'renderer';
    if (type === 'gpu-process') return 'gpu';
    return 'utility';
  }
  if (/firefox/i.test(command)) return /-contentproc/.test(cmdline) ? 'renderer' : 'browser';
  if (/WebKitWebProcess/.test(command)) return 'renderer';
  if (/WebKitGPUProcess/.test(command)) return 'gpu';
  if (/WebKitNetworkProcess/.test(command)) return 'utility';
  if (/MiniBrowser|pw_run\.sh/.test(command)) return 'browser';
  return null;
}

/** The descendants of `root` in a process table keyed by pid, root excluded. */
export function descendantsOf<T extends { pid: number; ppid: number }>(root: number, table: Iterable<T>): T[] {
  const children = new Map<number, T[]>();
  for (const proc of table) {
    const list = children.get(proc.ppid) ?? [];
    list.push(proc);
    children.set(proc.ppid, list);
  }
  const out: T[] = [];
  const stack = [root];
  const seen = new Set<number>([root]);
  while (stack.length > 0) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      stack.push(child.pid);
    }
  }
  return out;
}

/** Linux's `/proc`, under a root a test can replace. */
export class ProcFs {
  constructor(readonly root = '/proc') {}

  /** Whether this looks like a Linux `/proc` at all. */
  available(): boolean {
    return fs.existsSync(path.join(this.root, 'stat'));
  }

  /** Every process, keyed by pid. */
  table(): Map<number, ProcStat> {
    const out = new Map<number, ProcStat>();
    let names: string[];
    try {
      names = fs.readdirSync(this.root);
    } catch {
      return out;
    }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const text = readText(path.join(this.root, name, 'stat'));
      const stat = text ? parseProcStat(Number(name), text) : null;
      if (stat) out.set(stat.pid, stat);
    }
    return out;
  }

  stat(pid: number): ProcStat | null {
    const text = readText(path.join(this.root, String(pid), 'stat'));
    return text ? parseProcStat(pid, text) : null;
  }

  runWaitMs(pid: number): number | null {
    const text = readText(path.join(this.root, String(pid), 'schedstat'));
    return text ? parseSchedstat(text) : null;
  }

  cmdline(pid: number): string {
    return (readText(path.join(this.root, String(pid), 'cmdline')) ?? '').split('\0').join(' ').trim();
  }

  /** A field of `/proc/<pid>/status`, in kB: `VmRSS`, `VmHWM`. */
  statusKb(pid: number, key: string): number | null {
    const text = readText(path.join(this.root, String(pid), 'status'));
    return text ? parseKbField(text, key) : null;
  }

  /** Proportional set size: shared pages split between the processes sharing them, so a sum counts them once. */
  async pssKb(pid: number): Promise<number | null> {
    try {
      return parseKbField(await fs.promises.readFile(path.join(this.root, String(pid), 'smaps_rollup'), 'utf8'), 'Pss');
    } catch {
      return null;
    }
  }

  /** Reset a process's peak RSS (`VmHWM`) to its current RSS. */
  resetPeakRss(pid: number): boolean {
    try {
      fs.writeFileSync(path.join(this.root, String(pid), 'clear_refs'), '5');
      return true;
    } catch {
      return false;
    }
  }

  cpuTicks(): CpuTicks | null {
    const text = readText(path.join(this.root, 'stat'));
    return text ? parseCpuTicks(text) : null;
  }

  /** Total stall time of a resource's pressure file, in µs. */
  pressureUs(resource: 'cpu' | 'memory' | 'io'): number | null {
    const text = readText(path.join(this.root, 'pressure', resource));
    return text ? parsePsiTotal(text) : null;
  }

  memAvailableKb(): number | null {
    const text = readText(path.join(this.root, 'meminfo'));
    return text ? parseKbField(text, 'MemAvailable') : null;
  }

  /** Open file descriptors of a process. */
  fdCount(pid: number): number | null {
    try {
      return fs.readdirSync(path.join(this.root, String(pid), 'fd')).length;
    } catch {
      return null;
    }
  }
}

/** What the run's container (its cgroup) allows and has used. Null where the cgroup does not say. */
export interface ContainerReads {
  version: 1 | 2;
  memoryLimitBytes: number | null;
  memoryCurrentBytes: number | null;
  /** The cgroup's peak since it was created. */
  memoryPeakBytes: number | null;
  oomKills: number | null;
  cpuQuotaCores: number | null;
  throttledMs: number | null;
}

/** Limits beyond this are cgroup v1's way of saying "no limit". */
const UNLIMITED = 2 ** 60;

function numberIn(text: string | null, pattern?: RegExp): number | null {
  if (text === null) return null;
  const raw = pattern ? pattern.exec(text)?.[1] : text.trim();
  const value = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(value) ? value : null;
}

/** The cgroup of a process, through `/proc/<pid>/cgroup`, under roots a test can replace. */
export class CgroupFs {
  constructor(
    readonly procRoot = '/proc',
    readonly cgroupRoot = '/sys/fs/cgroup',
    readonly pid: number | 'self' = 'self',
  ) {}

  /** The directory of a controller (v1) or of the unified hierarchy (v2), when it exists. */
  private dirs(): { version: 1 | 2; memory: string | null; cpu: string | null } | null {
    const text = readText(path.join(this.procRoot, String(this.pid), 'cgroup'));
    if (!text) return null;
    const v1 = new Map<string, string>();
    let v2: string | null = null;
    for (const line of text.split('\n')) {
      const match = /^\d+:([^:]*):(.*)$/.exec(line.trim());
      if (!match) continue;
      if (match[1] === '') v2 = match[2]!;
      else for (const controller of match[1]!.split(',')) v1.set(controller, match[2]!);
    }
    // A path the namespace hides resolves to the mount itself, which is then the container's own cgroup.
    const pick = (mount: string, sub: string) => {
      const nested = path.join(mount, sub);
      if (fs.existsSync(nested)) return nested;
      return fs.existsSync(mount) ? mount : null;
    };
    if (v1.has('memory') || v1.has('cpu')) {
      const memoryPath = v1.get('memory');
      const cpuPath = v1.get('cpu');
      const cpuMount = ['cpu,cpuacct', 'cpu']
        .map((name) => path.join(this.cgroupRoot, name))
        .find((dir) => fs.existsSync(dir));
      return {
        version: 1,
        memory: memoryPath !== undefined ? pick(path.join(this.cgroupRoot, 'memory'), memoryPath) : null,
        cpu: cpuPath !== undefined && cpuMount ? pick(cpuMount, cpuPath) : null,
      };
    }
    if (v2 !== null && fs.existsSync(path.join(this.cgroupRoot, 'cgroup.controllers'))) {
      const dir = pick(this.cgroupRoot, v2);
      return { version: 2, memory: dir, cpu: dir };
    }
    return null;
  }

  read(): ContainerReads | null {
    const dirs = this.dirs();
    if (!dirs) return null;
    const file = (dir: string | null, name: string) => (dir ? readText(path.join(dir, name)) : null);
    if (dirs.version === 2) {
      const max = file(dirs.memory, 'memory.max');
      const cpuMax = file(dirs.cpu, 'cpu.max')?.trim().split(/\s+/);
      const quota = cpuMax && cpuMax[0] !== 'max' ? Number(cpuMax[0]) / Number(cpuMax[1]) : null;
      const throttledUs = numberIn(file(dirs.cpu, 'cpu.stat'), /^throttled_usec (\d+)/m);
      return {
        version: 2,
        memoryLimitBytes: max === null || max.trim() === 'max' ? null : numberIn(max),
        memoryCurrentBytes: numberIn(file(dirs.memory, 'memory.current')),
        memoryPeakBytes: numberIn(file(dirs.memory, 'memory.peak')),
        oomKills: numberIn(file(dirs.memory, 'memory.events'), /^oom_kill (\d+)/m),
        cpuQuotaCores: quota !== null && Number.isFinite(quota) ? quota : null,
        throttledMs: throttledUs === null ? null : throttledUs / 1000,
      };
    }
    const limit = numberIn(file(dirs.memory, 'memory.limit_in_bytes'));
    const quotaUs = numberIn(file(dirs.cpu, 'cpu.cfs_quota_us'));
    const periodUs = numberIn(file(dirs.cpu, 'cpu.cfs_period_us'));
    const throttledNs = numberIn(file(dirs.cpu, 'cpu.stat'), /^throttled_time (\d+)/m);
    return {
      version: 1,
      memoryLimitBytes: limit !== null && limit < UNLIMITED ? limit : null,
      memoryCurrentBytes: numberIn(file(dirs.memory, 'memory.usage_in_bytes')),
      memoryPeakBytes: numberIn(file(dirs.memory, 'memory.max_usage_in_bytes')),
      oomKills: numberIn(file(dirs.memory, 'memory.oom_control'), /^oom_kill (\d+)/m),
      cpuQuotaCores: quotaUs !== null && quotaUs > 0 && periodUs ? quotaUs / periodUs : null,
      throttledMs: throttledNs === null ? null : throttledNs / 1e6,
    };
  }
}
