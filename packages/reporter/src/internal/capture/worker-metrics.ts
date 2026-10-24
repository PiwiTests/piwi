import { monitorEventLoopDelay, performance, type EventLoopUtilization, type ELDHistogram } from 'node:perf_hooks';
import type { RoleCost } from '@piwitests/core/wire';
import { ProcFs, descendantsOf, roleOf, type ProcessRole } from '../support/system-readers.js';

export type { RoleCost };
import { internalCall } from './quiet-capture.js';

/**
 * What a test cost its worker, read at the test's start and end: the worker
 * process's own CPU and health (event loop, involuntary context switches,
 * heap), and on Linux the processes it started — its browsers — by role, with
 * their CPU, the time they waited for a CPU and their peak memory during the
 * test. Plus, over the Chrome DevTools Protocol, the main-thread CPU and weight
 * of the pages that outlive their test. Every read is best-effort.
 */

export interface TestMetrics {
  worker: {
    cpuMs: number;
    involuntarySwitches: number;
    /** Share of the test's time the event loop was busy. */
    loopUtilization: number;
    loopDelayP99Ms: number;
    loopDelayMaxMs: number;
    heapUsedMb: number;
    /** Open file descriptors at the test's end (Linux). */
    fds: number | null;
  };
  /** The processes the worker started, by role (Linux). */
  roles?: Partial<Record<ProcessRole, RoleCost>>;
}

/** A page's main thread and weight, over CDP (Chromium). */
export interface PageMain {
  /** Main-thread CPU since Piwi first read the page. */
  cpuMs: number;
  heapMb: number;
  nodes: number;
  listeners: number;
}

const MB = 1024 * 1024;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export class WorkerMetrics {
  private readonly histogram: ELDHistogram | null;
  private readonly linux: boolean;
  private loop: EventLoopUtilization | null = null;
  private usage: NodeJS.ResourceUsage | null = null;
  /** Each process's CPU and wait at the start of the current window; null before the first. */
  private subtree: Map<string, { cpuMs: number; waitMs: number | null }> | null = null;
  private roles = new Map<string, ProcessRole>();

  constructor(
    private readonly proc = new ProcFs(),
    private readonly pid = process.pid,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.linux = platform === 'linux' && proc.available();
    let histogram: ELDHistogram | null = null;
    try {
      histogram = monitorEventLoopDelay({ resolution: 20 });
      histogram.enable();
    } catch {
      histogram = null;
    }
    this.histogram = histogram;
  }

  /** The worker's processes under it, keyed by pid and start time. */
  private tree(): Array<{ key: string; pid: number; cpuMs: number; role: ProcessRole }> {
    const table = this.proc.table();
    return descendantsOf(this.pid, table.values()).map((stat) => {
      const key = `${stat.pid}:${stat.start}`;
      let role = this.roles.get(key);
      if (!role) {
        role = roleOf(stat.comm, this.proc.cmdline(stat.pid)) ?? 'other';
        this.roles.set(key, role);
      }
      return { key, pid: stat.pid, cpuMs: stat.cpuMs, role };
    });
  }

  /**
   * The processes under the worker now, and the reset of their peak memory: the
   * start of the next window. Taken once per test, at its end, so the time
   * between two tests counts toward the next one.
   */
  private snapshot(): void {
    this.subtree = new Map();
    for (const proc of this.tree()) {
      this.subtree.set(proc.key, { cpuMs: proc.cpuMs, waitMs: this.proc.runWaitMs(proc.pid) });
      this.proc.resetPeakRss(proc.pid);
    }
  }

  /**
   * Start a test's window. `processes` says whether the worker has started any
   * browser to read; a worker that never did skips the process tree.
   */
  start(processes = true): void {
    try {
      this.histogram?.reset();
      this.loop = performance.eventLoopUtilization();
      this.usage = process.resourceUsage();
      if (this.linux && processes && !this.subtree) this.snapshot();
    } catch {
      // A test without metrics.
    }
  }

  /** Close the window. Null when the test's start was never read. */
  end(processes = true): TestMetrics | null {
    if (!this.usage || !this.loop) return null;
    try {
      const usage = process.resourceUsage();
      const loop = performance.eventLoopUtilization(this.loop);
      const metrics: TestMetrics = {
        worker: {
          cpuMs: Math.round(
            (usage.userCPUTime - this.usage.userCPUTime + usage.systemCPUTime - this.usage.systemCPUTime) / 1000,
          ),
          involuntarySwitches: usage.involuntaryContextSwitches - this.usage.involuntaryContextSwitches,
          loopUtilization: Math.round(loop.utilization * 1000) / 1000,
          loopDelayP99Ms: this.histogram ? round1(this.histogram.percentile(99) / 1e6) : 0,
          loopDelayMaxMs: this.histogram ? round1(this.histogram.max / 1e6) : 0,
          heapUsedMb: round1(process.memoryUsage().heapUsed / MB),
          fds: this.linux ? this.proc.fdCount(this.pid) : null,
        },
      };
      this.usage = null;
      this.loop = null;
      if (this.linux && processes) metrics.roles = this.roleCosts();
      return metrics;
    } catch {
      return null;
    }
  }

  /** The window's cost by role; what it reads becomes the start of the next window. */
  private roleCosts(): Partial<Record<ProcessRole, RoleCost>> {
    const roles: Partial<Record<ProcessRole, RoleCost>> = {};
    const start = this.subtree ?? new Map<string, { cpuMs: number; waitMs: number | null }>();
    const next = new Map<string, { cpuMs: number; waitMs: number | null }>();
    for (const proc of this.tree()) {
      // A process started during the window counts from zero.
      const from = start.get(proc.key) ?? { cpuMs: 0, waitMs: 0 };
      const waitMs = this.proc.runWaitMs(proc.pid);
      const peakKb = this.proc.statusKb(proc.pid, 'VmHWM');
      const cost = (roles[proc.role] ??= { cpuMs: 0, runWaitMs: null, peakRssMb: null, processes: 0 });
      cost.cpuMs += Math.max(0, proc.cpuMs - from.cpuMs);
      if (waitMs !== null && from.waitMs !== null)
        cost.runWaitMs = round1((cost.runWaitMs ?? 0) + Math.max(0, waitMs - from.waitMs));
      if (peakKb !== null) cost.peakRssMb = Math.max(cost.peakRssMb ?? 0, round1(peakKb / 1024));
      cost.processes++;
      next.set(proc.key, { cpuMs: proc.cpuMs, waitMs });
      this.proc.resetPeakRss(proc.pid);
    }
    this.subtree = next;
    return roles;
  }

  dispose(): void {
    this.histogram?.disable();
  }
}

interface CdpSessionLike {
  send(method: string, params?: object): Promise<unknown>;
}

interface PageLike {
  context(): { newCDPSession(page: unknown): Promise<CdpSessionLike> };
}

/**
 * Reads pages over CDP, one session per page, opened the first time a page is
 * read and kept while it lives. On a browser without CDP the read is null, and
 * the page is never tried again.
 */
export class PageReader {
  private readonly sessions = new WeakMap<object, Promise<CdpSessionLike | null>>();

  async read(page: object): Promise<PageMain | null> {
    let session = this.sessions.get(page);
    if (!session) {
      session = internalCall(page, async () => {
        const opened = await (page as PageLike).context().newCDPSession(page);
        await opened.send('Performance.enable', { timeDomain: 'threadTicks' });
        return opened;
      }).catch(() => null);
      this.sessions.set(page, session);
    }
    const opened = await session;
    if (!opened) return null;
    try {
      const result = (await internalCall(page, () => opened.send('Performance.getMetrics'))) as {
        metrics?: Array<{ name: string; value: number }>;
      };
      const values = new Map((result.metrics ?? []).map((metric) => [metric.name, metric.value]));
      return {
        cpuMs: Math.round((values.get('TaskDuration') ?? 0) * 1000),
        heapMb: round1((values.get('JSHeapUsedSize') ?? 0) / MB),
        nodes: values.get('Nodes') ?? 0,
        listeners: values.get('JSEventListeners') ?? 0,
      };
    } catch {
      return null;
    }
  }
}
