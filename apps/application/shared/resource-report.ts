/**
 * The resource data a reporter sends, made safe to store.
 *
 * A run has one report per reporter that ran it: a sharded run gets one per
 * shard, each measured on its own machine and stored as its own row
 * (`shared/handlers/resource-reports.ts`). Every incoming report and execution
 * cost is rebuilt field by field here, with bounded arrays and strings and
 * finite numbers only, so an arbitrary submitter cannot store more than this
 * shape allows. Pure, so the server and the demo share it.
 */
import type {
  ProcessRole,
  RoleCost,
  RoleUsage,
  SeriesPoint,
  WireExecutionResources,
  WireResourceFinding,
  WireResourceReport,
  WireResourceTimeline,
  WireRunProfile,
  WorkerHealth,
} from '#shared/types';

/** A run's report: the part each of its reporters sent, in shard order. */
export interface StoredResourceReport {
  v: 1;
  parts: WireResourceReport[];
}

const ROLES: ReadonlySet<string> = new Set<ProcessRole>([
  'runner',
  'worker',
  'browser',
  'renderer',
  'gpu',
  'utility',
  'ffmpeg',
  'webServer',
  'other',
]);
const VERDICTS: ReadonlySet<string> = new Set(['leaked', 'idle', 'piling', 'handle', 'probable']);
const KINDS: ReadonlySet<string> = new Set(['browser', 'context', 'page', 'request', 'handle', 'worker']);
const ARTIFACT_KINDS = ['trace', 'video', 'screenshot', 'other'] as const;
const GROWTH: ReadonlySet<string> = new Set(['pages', 'listeners', 'routes', 'elements', 'heapMb', 'descriptors']);

const FINDINGS_CAP = 100;
const SERIES_CAP = 240;
const WORKERS_CAP = 64;
const WORKER_POINTS_CAP = 200;
const TIMELINE_SERIES_CAP = 600;
const TIMELINE_WORKER_POINTS_CAP = 300;
/** The most cores a worker's processes are read as using. */
const CORES_CAP = 1024;
const TEXT_CAP = 300;

type Raw = Record<string, unknown>;

function obj(value: unknown): Raw | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : null;
}

/** A finite, non-negative number, or null. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function int(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.round(n);
}

function text(value: unknown, cap = TEXT_CAP): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, cap) : null;
}

function byRole<T>(value: unknown, read: (raw: Raw) => T | null): Partial<Record<ProcessRole, T>> | null {
  const raw = obj(value);
  if (!raw) return null;
  const out: Partial<Record<ProcessRole, T>> = {};
  for (const [role, entry] of Object.entries(raw)) {
    const item = obj(entry);
    const read_ = item && ROLES.has(role) ? read(item) : null;
    if (read_) out[role as ProcessRole] = read_;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function roleCost(raw: Raw): RoleCost | null {
  const cpuMs = num(raw.cpuMs);
  if (cpuMs === null) return null;
  return { cpuMs, runWaitMs: num(raw.runWaitMs), peakRssMb: num(raw.peakRssMb), processes: int(raw.processes) ?? 0 };
}

function roleUsage(raw: Raw): RoleUsage | null {
  const cpuMs = num(raw.cpuMs);
  if (cpuMs === null) return null;
  return { cpuMs, runWaitMs: num(raw.runWaitMs), processes: int(raw.processes) ?? 0 };
}

function artifactBytes(value: unknown): Partial<Record<(typeof ARTIFACT_KINDS)[number], number>> | null {
  const raw = obj(value);
  if (!raw) return null;
  const out: Partial<Record<(typeof ARTIFACT_KINDS)[number], number>> = {};
  for (const kind of ARTIFACT_KINDS) {
    const bytes = int(raw[kind]);
    if (bytes) out[kind] = bytes;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** An execution's cost as a reporter sent it, rebuilt; null when it is not one. */
export function sanitizeExecutionResources(value: unknown): WireExecutionResources | null {
  const raw = obj(value);
  const workerCpuMs = raw ? num(raw.workerCpuMs) : null;
  if (!raw || workerCpuMs === null) return null;
  const open = obj(raw.openAtStart);
  return {
    workerCpuMs,
    roles: byRole(raw.roles, roleCost),
    loopUtilization: Math.min(1, num(raw.loopUtilization) ?? 0),
    loopDelayP99Ms: num(raw.loopDelayP99Ms) ?? 0,
    involuntarySwitches: int(raw.involuntarySwitches) ?? 0,
    heapUsedMb: num(raw.heapUsedMb) ?? 0,
    openAtStart: open ? { contexts: int(open.contexts) ?? 0, pages: int(open.pages) ?? 0 } : null,
    leftOpen: int(raw.leftOpen),
    artifactBytes: artifactBytes(raw.artifactBytes),
  };
}

function finding(value: unknown): WireResourceFinding | null {
  const raw = obj(value);
  const where = raw ? text(raw.where) : null;
  if (!raw || !where || !VERDICTS.has(String(raw.verdict)) || !KINDS.has(String(raw.kind))) return null;
  const out: WireResourceFinding = {
    verdict: raw.verdict as WireResourceFinding['verdict'],
    kind: raw.kind as WireResourceFinding['kind'],
    where,
    tests: int(raw.tests) ?? 0,
    count: int(raw.count) ?? 0,
  };
  const site = text(raw.site);
  if (site) out.site = site;
  if (raw.scope === 'test' || raw.scope === 'describe') out.scope = raw.scope;
  const heldMs = int(raw.heldMs);
  if (heldMs !== null) out.heldMs = heldMs;
  if (raw.untilWorkerEnd === true) out.untilWorkerEnd = true;
  const pages = int(raw.pages);
  if (pages) out.pages = pages;
  if (raw.closedByPiwi === true) out.closedByPiwi = true;
  const afterTestCpuMs = int(raw.afterTestCpuMs);
  if (afterTestCpuMs) out.afterTestCpuMs = afterTestCpuMs;
  const growth = obj(raw.growth);
  if (growth && GROWTH.has(String(growth.what))) {
    out.growth = {
      what: growth.what as NonNullable<WireResourceFinding['growth']>['what'],
      from: int(growth.from) ?? 0,
      to: int(growth.to) ?? 0,
      tests: int(growth.tests) ?? 0,
    };
  }
  const detail = text(raw.detail);
  if (detail) out.detail = detail;
  return out;
}

function profile(value: unknown): WireRunProfile | null {
  const raw = obj(value);
  const machine = raw ? obj(raw.machine) : null;
  const cpu = raw ? obj(raw.cpu) : null;
  const memory = raw ? obj(raw.memory) : null;
  const disk = raw ? obj(raw.disk) : null;
  if (!raw || !machine || !cpu || !memory || !disk) return null;
  const largest = obj(memory.largest);
  const largestRole = largest && ROLES.has(String(largest.role)) ? (largest.role as ProcessRole) : null;
  const largestBytes = largest ? num(largest.bytes) : null;
  return {
    platform: text(raw.platform, 20) ?? 'unknown',
    wallMs: int(raw.wallMs) ?? 0,
    machine: {
      cores: int(machine.cores) ?? 0,
      memoryBytes: num(machine.memoryBytes) ?? 0,
      memoryLimitBytes: num(machine.memoryLimitBytes),
      cpuQuotaCores: num(machine.cpuQuotaCores),
    },
    cpu: {
      busyPct: num(cpu.busyPct),
      iowaitPct: num(cpu.iowaitPct),
      stealPct: num(cpu.stealPct),
      pressurePct: num(cpu.pressurePct),
      series: Array.isArray(cpu.series)
        ? cpu.series.slice(0, SERIES_CAP).map((point) => Math.min(100, num(point) ?? 0))
        : [],
      byRole: byRole(cpu.byRole, roleUsage),
      throttledMs: num(cpu.throttledMs),
    },
    memory: {
      kind: memory.kind === 'pss' || memory.kind === 'rss' ? memory.kind : null,
      peakBytes: num(memory.peakBytes),
      peakAtMs: int(memory.peakAtMs),
      largest: largestRole && largestBytes !== null ? { role: largestRole, bytes: largestBytes } : null,
      rssFallbacks: int(memory.rssFallbacks) ?? 0,
      pressurePct: num(memory.pressurePct),
      lowestAvailableBytes: num(memory.lowestAvailableBytes),
      containerPeakBytes: num(memory.containerPeakBytes),
      oomKills: int(memory.oomKills),
    },
    disk: {
      peakInUseBytes: num(disk.peakInUseBytes),
      peakInUseIsLowerBound: disk.peakInUseIsLowerBound === true,
      lowestFreeBytes: num(disk.lowestFreeBytes),
      leftoverBytes: num(disk.leftoverBytes),
    },
    notMeasured: Array.isArray(raw.notMeasured)
      ? raw.notMeasured
          .map((item) => text(item, 80))
          .filter((item): item is string => item !== null)
          .slice(0, 10)
      : [],
  };
}

function workerHealth(value: unknown): WorkerHealth | null {
  const raw = obj(value);
  const tests = raw ? int(raw.tests) : null;
  if (!raw || !tests) return null;
  return {
    tests,
    loopUtilization: Math.min(1, num(raw.loopUtilization) ?? 0),
    loopDelayP99Ms: num(raw.loopDelayP99Ms) ?? 0,
    involuntarySwitchesPerTest: num(raw.involuntarySwitchesPerTest) ?? 0,
  };
}

/** A timed series rebuilt: `[ms, value]` pairs of finite, non-negative numbers, each value at most `max`. */
function points(value: unknown, cap: number, max = Infinity): SeriesPoint[] {
  if (!Array.isArray(value)) return [];
  const out: SeriesPoint[] = [];
  for (const entry of value.slice(0, cap)) {
    if (!Array.isArray(entry)) continue;
    const at = num(entry[0]);
    const v = num(entry[1]);
    if (at !== null && v !== null) out.push([Math.round(at), Math.min(max, v)]);
  }
  return out;
}

/** A timeline as a reporter sent it, rebuilt within the report's bounds; null when it holds nothing. */
export function sanitizeResourceTimeline(value: unknown): WireResourceTimeline | null {
  const raw = obj(value);
  const startedAt = raw ? num(raw.startedAt) : null;
  if (!raw || !startedAt) return null;
  const pages: WireResourceTimeline['pages'] = [];
  for (const entry of Array.isArray(raw.pages) ? raw.pages.slice(0, WORKERS_CAP) : []) {
    const item = obj(entry);
    const worker = item ? int(item.worker) : null;
    if (!item || worker === null) continue;
    const series = points(item.points, TIMELINE_WORKER_POINTS_CAP).map(([at, n]): SeriesPoint => [at, Math.round(n)]);
    if (series.length > 0) pages.push({ worker, points: series });
  }
  const workers: NonNullable<WireResourceTimeline['workers']> = [];
  for (const entry of Array.isArray(raw.workers) ? raw.workers.slice(0, WORKERS_CAP) : []) {
    const item = obj(entry);
    const worker = item ? int(item.worker) : null;
    if (!item || worker === null) continue;
    const cpuCores = points(item.cpuCores, TIMELINE_WORKER_POINTS_CAP, CORES_CAP);
    const memoryBytes = points(item.memoryBytes, TIMELINE_WORKER_POINTS_CAP);
    if (cpuCores.length > 0 || memoryBytes.length > 0) workers.push({ worker, cpuCores, memoryBytes });
  }
  const cpuPct = points(raw.cpuPct, TIMELINE_SERIES_CAP, 100);
  const memoryBytes = points(raw.memoryBytes, TIMELINE_SERIES_CAP);
  if (cpuPct.length === 0 && memoryBytes.length === 0 && pages.length === 0 && workers.length === 0) return null;
  return { startedAt: Math.round(startedAt), cpuPct, memoryBytes, pages, workers };
}

/** A run report as a reporter sent it, rebuilt; null when it is not one. */
export function sanitizeResourceReport(value: unknown): WireResourceReport | null {
  const raw = obj(value);
  if (!raw || raw.v !== 1) return null;
  const counts = obj(raw.counts) ?? {};
  const workers: WireResourceReport['workers'] = [];
  for (const entry of Array.isArray(raw.workers) ? raw.workers.slice(0, WORKERS_CAP) : []) {
    const item = obj(entry);
    const worker = item ? int(item.worker) : null;
    if (item && worker !== null && Array.isArray(item.openPages)) {
      workers.push({ worker, openPages: item.openPages.slice(0, WORKER_POINTS_CAP).map((n) => int(n) ?? 0) });
    }
  }
  return {
    v: 1,
    shardIndex: int(raw.shardIndex),
    findings: (Array.isArray(raw.findings) ? raw.findings.slice(0, FINDINGS_CAP) : [])
      .map(finding)
      .filter((f): f is WireResourceFinding => f !== null),
    counts: {
      leaked: int(counts.leaked) ?? 0,
      idle: int(counts.idle) ?? 0,
      piling: int(counts.piling) ?? 0,
      handle: int(counts.handle) ?? 0,
      probable: int(counts.probable) ?? 0,
    },
    profile: profile(raw.profile),
    workers,
    artifactBytes: artifactBytes(raw.artifactBytes) ?? {},
    workerHealth: workerHealth(raw.workerHealth),
    timeline: sanitizeResourceTimeline(raw.timeline),
  };
}

/** The CPU of an execution's browser processes, when its worker could read them (Linux). */
export function browserCpuMs(resources: WireExecutionResources): number | null {
  if (!resources.roles) return null;
  return Object.values(resources.roles).reduce((sum, cost) => sum + (cost?.cpuMs ?? 0), 0);
}

/** The largest browser process of an execution, in MB. */
export function peakRssMb(resources: WireExecutionResources): number | null {
  const peaks = Object.values(resources.roles ?? {})
    .map((cost) => cost?.peakRssMb)
    .filter((mb): mb is number => typeof mb === 'number');
  return peaks.length > 0 ? Math.max(...peaks) : null;
}
