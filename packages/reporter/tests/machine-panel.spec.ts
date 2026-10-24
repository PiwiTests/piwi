import { describe, it, expect } from 'vitest';
import {
  artifactKind,
  formatBytes,
  formatMachinePanel,
  sparkline,
  workerHealthOf,
} from '../src/internal/collect/machine-panel.js';
import type { RunProfile } from '../src/internal/collect/process-sampler.js';
import type { ResourceCensus } from '../src/internal/capture/resource-ledger.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function profile(overrides: Partial<RunProfile> = {}): RunProfile {
  return {
    platform: 'linux',
    wallMs: 60_000,
    machine: { cores: 4, memoryBytes: 16 * GB, memoryLimitBytes: 14 * GB, cpuQuotaCores: null },
    cpu: {
      busyPct: 91.6,
      iowaitPct: 0.4,
      stealPct: 1.5,
      pressurePct: 79.2,
      series: [10, 40, 80, 100, 100, 100, 90, 60, 20],
      byRole: {
        renderer: { cpuMs: 41_000, runWaitMs: 39_000, processes: 30 },
        browser: { cpuMs: 22_000, runWaitMs: 4_000, processes: 4 },
        worker: { cpuMs: 18_000, runWaitMs: 2_000, processes: 4 },
        webServer: { cpuMs: 11_000, runWaitMs: 0, processes: 3 },
        runner: { cpuMs: 900, runWaitMs: 0, processes: 1 },
      },
      throttledMs: null,
    },
    memory: {
      kind: 'pss',
      peakBytes: 1.6 * GB,
      peakAtMs: 21_000,
      largest: { role: 'worker', bytes: 251 * MB },
      rssFallbacks: 0,
      pressurePct: 0,
      lowestAvailableBytes: 9 * GB,
      containerPeakBytes: null,
      oomKills: 0,
    },
    disk: { peakInUseBytes: 430 * MB, peakInUseIsLowerBound: false, lowestFreeBytes: 13.9 * GB, leftoverBytes: 0 },
    notMeasured: [],
    ...overrides,
  };
}

describe('formatMachinePanel', () => {
  it('says what the run had and what it used of it', () => {
    const lines = formatMachinePanel(profile(), {
      artifacts: { trace: 140 * MB, video: 0, screenshot: 5 * MB, other: 0 },
      workers: { tests: 40, loopUtilization: 0.28, loopDelayP99Ms: 181.4, involuntarySwitchesPerTest: 2100 },
    });
    expect(lines).toEqual([
      'Machine: 4 cores · 16.0 GB · container limit 14.0 GB · steal 1.5%',
      '  CPU      ▁▄▇████▅▂ 92% busy · a task waited for a CPU 79% of the time · 1 min 33 s of CPU: renderers 41.0 s · browsers 22.0 s · workers 18.0 s · web server 11.0 s · renderers waited 39.0 s for a CPU',
      '  Memory   peak 1.6 GB (PSS) at 0:21 · 11% of the limit · largest process: worker 251 MB · no memory pressure',
      '  Disk     145 MB of artifacts (traces 140 MB · screenshots 5 MB) · 430 MB in use at the peak · 13.9 GB free at the low point',
      '  Workers  event loop busy 28% · p99 delay 181 ms at worst · 2,100 involuntary context switches per test',
    ]);
  });

  it('names what it could not measure, and the container that killed or throttled', () => {
    const lines = formatMachinePanel(
      profile({
        cpu: { busyPct: 50, iowaitPct: null, stealPct: null, pressurePct: null, series: [], byRole: null, throttledMs: 2100 },
        memory: {
          kind: null,
          peakBytes: null,
          peakAtMs: null,
          largest: null,
          rssFallbacks: 0,
          pressurePct: null,
          lowestAvailableBytes: 1 * GB,
          containerPeakBytes: 13.5 * GB,
          oomKills: 1,
        },
        disk: { peakInUseBytes: 12 * GB, peakInUseIsLowerBound: true, lowestFreeBytes: 2 * GB, leftoverBytes: 3 * GB },
        notMeasured: ['CPU and memory of the run’s processes', 'CPU pressure'],
      }),
      { artifacts: null, workers: null },
    );
    expect(lines).toEqual([
      'Machine: 4 cores · 16.0 GB · container limit 14.0 GB',
      "  CPU      50% busy · the container's CPU quota held it back 2.1 s",
      '  Memory   the container peaked at 13.5 GB · 1 process killed for memory · 1.0 GB available at the low point',
      '  Disk     at least 12.0 GB in use at the peak · 2.0 GB free at the low point · 3.0 GB left in the temp folder by earlier runs',
      '  Not measured here: CPU and memory of the run’s processes, CPU pressure',
    ]);
  });
});

describe('workerHealthOf', () => {
  const census = (title: string | null, worker?: { loopUtilization: number; loopDelayP99Ms: number; involuntarySwitches: number }) =>
    ({
      v: 1,
      worker: 0,
      pid: 1,
      at: 0,
      test: title ? { id: title, file: 'a.spec.ts', suite: [], title } : null,
      born: [],
      closed: [],
      open: [],
      ...(worker
        ? { metrics: { worker: { cpuMs: 0, loopDelayMaxMs: 0, heapUsedMb: 0, fds: null, ...worker } } }
        : {}),
    }) as ResourceCensus;

  it('averages the event loop and switches over the tests that carried metrics, and keeps the worst delay', () => {
    const health = workerHealthOf([
      census('t1', { loopUtilization: 0.2, loopDelayP99Ms: 30, involuntarySwitches: 100 }),
      census('t2', { loopUtilization: 0.4, loopDelayP99Ms: 90, involuntarySwitches: 300 }),
      census('t3'),
      census(null, { loopUtilization: 1, loopDelayP99Ms: 999, involuntarySwitches: 999 }),
    ]);
    expect(health).toMatchObject({ tests: 2, loopDelayP99Ms: 90, involuntarySwitchesPerTest: 200 });
    expect(health!.loopUtilization).toBeCloseTo(0.3);
    expect(workerHealthOf([census('t1')])).toBeNull();
  });
});

describe('panel helpers', () => {
  it('draws a sparkline of at most the given width', () => {
    expect(sparkline([0, 50, 100])).toBe('▁▅█');
    expect(sparkline([1, 2])).toBe('');
    expect(sparkline(Array.from({ length: 100 }, (_, i) => i), 10)).toHaveLength(10);
  });

  it('formats bytes and sorts attachments into artifact kinds', () => {
    expect(formatBytes(512)).toBe('1 kB');
    expect(formatBytes(3 * MB)).toBe('3 MB');
    expect(formatBytes(1.45 * GB)).toBe('1.4 GB');
    expect(artifactKind('trace', 'application/zip')).toBe('trace');
    expect(artifactKind('video', 'video/webm')).toBe('video');
    expect(artifactKind('screenshot', 'image/png')).toBe('screenshot');
    expect(artifactKind('diff', 'image/png')).toBe('screenshot');
    expect(artifactKind('report.json', 'application/json')).toBe('other');
  });
});
