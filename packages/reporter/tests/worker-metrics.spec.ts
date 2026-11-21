import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PageReader, WorkerMetrics } from '../src/internal/capture/worker-metrics.js';
import { ProcFs } from '../src/internal/support/system-readers.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-worker-metrics-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A process in a fake `/proc`: CPU in clock ticks (10 ms each), run-queue wait in ms, peak RSS in kB. */
function proc(pid: number, p: { ppid: number; comm: string; cmdline: string; ticks: number; waitMs: number; hwmKb: number }) {
  const fields = Array.from({ length: 22 }, () => '0');
  fields[1] = String(p.ppid);
  fields[11] = String(p.ticks);
  fields[19] = String(pid);
  write(path.join(dir, String(pid), 'stat'), `${pid} (${p.comm}) ${fields.join(' ')}\n`);
  write(path.join(dir, String(pid), 'schedstat'), `0 ${p.waitMs * 1e6} 0\n`);
  write(path.join(dir, String(pid), 'cmdline'), p.cmdline.split(' ').join('\0'));
  write(path.join(dir, String(pid), 'status'), `VmHWM:\t${p.hwmKb} kB\nVmRSS:\t${p.hwmKb} kB\n`);
}

describe('WorkerMetrics', () => {
  it('reads what a test cost the worker and the browsers it started, by role', () => {
    write(path.join(dir, 'stat'), 'cpu  1 0 0 1 0 0 0 0\n');
    proc(10, { ppid: 1, comm: 'node', cmdline: 'node workerProcessEntry.js', ticks: 100, waitMs: 1, hwmKb: 100_000 });
    proc(20, { ppid: 10, comm: 'chrome', cmdline: '/pw/chrome --headless', ticks: 50, waitMs: 2, hwmKb: 150_000 });
    proc(21, { ppid: 20, comm: 'chrome', cmdline: '/pw/chrome --type=renderer', ticks: 10, waitMs: 1, hwmKb: 90_000 });
    write(path.join(dir, '10', 'fd', '0'), '');
    const metrics = new WorkerMetrics(new ProcFs(dir), 10, 'linux');

    metrics.start();
    // The peak of every process under the worker is reset at the test's start.
    expect(fs.readFileSync(path.join(dir, '20', 'clear_refs'), 'utf8')).toBe('5');
    expect(fs.readFileSync(path.join(dir, '21', 'clear_refs'), 'utf8')).toBe('5');
    proc(20, { ppid: 10, comm: 'chrome', cmdline: '/pw/chrome --headless', ticks: 80, waitMs: 12, hwmKb: 160_000 });
    proc(21, { ppid: 20, comm: 'chrome', cmdline: '/pw/chrome --type=renderer', ticks: 110, waitMs: 41, hwmKb: 120_000 });
    proc(22, { ppid: 20, comm: 'chrome', cmdline: '/pw/chrome --type=renderer', ticks: 20, waitMs: 3, hwmKb: 70_000 });
    const result = metrics.end()!;
    metrics.dispose();

    expect(result.roles).toEqual({
      browser: { cpuMs: 300, runWaitMs: 10, peakRssMb: 156.3, processes: 1 },
      renderer: { cpuMs: 1200, runWaitMs: 43, peakRssMb: 117.2, processes: 2 },
    });
    expect(result.worker.fds).toBe(1);
    expect(result.worker.loopUtilization).toBeGreaterThanOrEqual(0);
    expect(result.worker.loopUtilization).toBeLessThanOrEqual(1);
    expect(result.worker.cpuMs).toBeGreaterThanOrEqual(0);
    expect(metrics.end()).toBeNull();
  });

  it('reads only the worker itself where there is no /proc', () => {
    const metrics = new WorkerMetrics(new ProcFs(path.join(dir, 'missing')), process.pid, 'darwin');
    metrics.start();
    const result = metrics.end()!;
    metrics.dispose();
    expect(result.roles).toBeUndefined();
    expect(result.worker.fds).toBeNull();
    expect(result.worker.heapUsedMb).toBeGreaterThan(0);
  });
});

describe('PageReader', () => {
  it('opens one CDP session per page and reads its main thread and weight', async () => {
    const send = vi.fn(async (method: string) =>
      method === 'Performance.getMetrics'
        ? {
            metrics: [
              { name: 'TaskDuration', value: 1.25 },
              { name: 'JSHeapUsedSize', value: 3 * 1024 * 1024 },
              { name: 'Nodes', value: 420 },
              { name: 'JSEventListeners', value: 12 },
            ],
          }
        : {},
    );
    const newCDPSession = vi.fn(async () => ({ send }));
    const page = { context: () => ({ newCDPSession }) };
    const reader = new PageReader();

    expect(await reader.read(page)).toEqual({ cpuMs: 1250, heapMb: 3, nodes: 420, listeners: 12 });
    await reader.read(page);
    expect(newCDPSession).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('Performance.enable', { timeDomain: 'threadTicks' });
  });

  it('gives up on a page whose browser has no CDP, once', async () => {
    const newCDPSession = vi.fn(async () => {
      throw new Error('CDP session is only available in Chromium');
    });
    const page = { context: () => ({ newCDPSession }) };
    const reader = new PageReader();
    expect(await reader.read(page)).toBeNull();
    expect(await reader.read(page)).toBeNull();
    expect(newCDPSession).toHaveBeenCalledTimes(1);
  });
});
