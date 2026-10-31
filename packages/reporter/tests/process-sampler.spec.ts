import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunSampler } from '../src/internal/collect/process-sampler.js';
import {
  CgroupFs,
  descendantsOf,
  parseCpuTicks,
  parseProcStat,
  parsePsOutput,
  parsePsTime,
  parsePsiTotal,
  parseSchedstat,
  parseWindowsProcesses,
  roleOf,
} from '../src/internal/support/system-readers.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-sampler-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A process in a fake `/proc`: CPU in clock ticks (10 ms each), run-queue wait in ms, PSS in kB. */
function proc(
  root: string,
  pid: number,
  p: { ppid: number; comm: string; cmdline: string; ticks: number; waitMs: number; pssKb?: number; rssKb: number },
): void {
  const fields = Array.from({ length: 22 }, () => '0');
  fields[0] = 'S';
  fields[1] = String(p.ppid);
  fields[11] = String(p.ticks);
  fields[12] = '0';
  fields[19] = String(pid * 10);
  write(path.join(root, String(pid), 'stat'), `${pid} (${p.comm}) ${fields.join(' ')}\n`);
  write(path.join(root, String(pid), 'schedstat'), `0 ${p.waitMs * 1e6} 0\n`);
  write(path.join(root, String(pid), 'cmdline'), p.cmdline.split(' ').join('\0'));
  write(path.join(root, String(pid), 'status'), `Name:\t${p.comm}\nVmHWM:\t${p.rssKb} kB\nVmRSS:\t${p.rssKb} kB\n`);
  if (p.pssKb !== undefined)
    write(path.join(root, String(pid), 'smaps_rollup'), `Rss: ${p.rssKb} kB\nPss:   ${p.pssKb} kB\n`);
}

function machine(
  root: string,
  m: { busy: number; idle: number; steal: number; cpuPsiUs: number; memPsiUs: number; availKb: number },
) {
  write(path.join(root, 'stat'), `cpu  ${m.busy} 0 0 ${m.idle} 0 0 0 ${m.steal} 0 0\ncpu0 1 2 3\n`);
  write(path.join(root, 'meminfo'), `MemTotal: 16000000 kB\nMemAvailable: ${m.availKb} kB\n`);
  write(
    path.join(root, 'pressure', 'cpu'),
    `some avg10=0.00 avg60=0.00 avg300=0.00 total=${m.cpuPsiUs}\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`,
  );
  write(path.join(root, 'pressure', 'memory'), `some avg10=0.00 avg60=0.00 avg300=0.00 total=${m.memPsiUs}\n`);
}

describe('system readers', () => {
  it('parses a process stat line, its name holding spaces and parentheses', () => {
    const fields = Array.from({ length: 22 }, (_, i) => String(i));
    fields[1] = '7';
    fields[11] = '150';
    fields[12] = '50';
    expect(parseProcStat(12, `12 (Web (Content) x) ${fields.join(' ')}`)).toEqual({
      pid: 12,
      ppid: 7,
      comm: 'Web (Content) x',
      cpuMs: 2000,
      start: 19,
    });
    expect(parseProcStat(1, 'garbage')).toBeNull();
  });

  it('parses schedstat, /proc/stat, pressure files and ps output', () => {
    expect(parseSchedstat('123 5000000 9')).toBe(5);
    expect(parseCpuTicks('cpu  10 1 4 100 3 1 1 2 0 0\n')).toEqual({
      busy: 17,
      idle: 100,
      iowait: 3,
      steal: 2,
      total: 122,
    });
    expect(parseCpuTicks('intr 1 2 3')).toBeNull();
    expect(parsePsiTotal('some avg10=1.00 avg60=0.00 avg300=0.00 total=4242\nfull avg10=0 total=1')).toBe(4242);
    expect(parsePsTime('1:02.50')).toBe(62_500);
    expect(parsePsTime('01:00:03')).toBe(3_603_000);
    expect(parsePsTime('2-00:00:01')).toBe(172_801_000);
    expect(
      parsePsOutput(
        '  10     1  2048   0:01.20 /usr/bin/node runner.js\n  11    10  1024 0:00.30 /Apps/Chromium Helper --type=renderer\n',
      ),
    ).toEqual([
      { pid: 10, ppid: 1, rssKb: 2048, cpuMs: 1200, command: '/usr/bin/node runner.js' },
      { pid: 11, ppid: 10, rssKb: 1024, cpuMs: 300, command: '/Apps/Chromium Helper --type=renderer' },
    ]);
  });

  it('parses the CIM JSON of Win32_Process, one row or an array', () => {
    const row = (
      pid: number,
      ppid: number,
      ticks: number,
      workingSetKb: number,
      name: string,
      commandLine: string | null,
    ) => ({
      ProcessId: pid,
      ParentProcessId: ppid,
      WorkingSetSize: workingSetKb * 1024,
      UserModeTime: ticks / 2,
      KernelModeTime: ticks / 2,
      Name: name,
      CommandLine: commandLine,
    });
    expect(
      parseWindowsProcesses(
        JSON.stringify([
          row(10, 1, 10_000_000, 2048, 'node.exe', 'node runner.js'),
          row(11, 10, 3_000_000, 1024, 'chrome.exe', null),
        ]),
      ),
    ).toEqual([
      { pid: 10, ppid: 1, rssKb: 2048, cpuMs: 1000, name: 'node.exe', commandLine: 'node runner.js' },
      { pid: 11, ppid: 10, rssKb: 1024, cpuMs: 300, name: 'chrome.exe', commandLine: '' },
    ]);
    // One process comes as a single row, with a byte-order mark ahead of it.
    expect(parseWindowsProcesses(`\uFEFF${JSON.stringify(row(10, 1, 10_000, 1024, 'node.exe', 'node'))}`)).toHaveLength(
      1,
    );
    expect(parseWindowsProcesses('not json')).toEqual([]);
    expect(parseWindowsProcesses(JSON.stringify([{ WorkingSetSize: 1 }]))).toEqual([]);
  });

  it('names each process the run starts by its command line', () => {
    expect(roleOf('node', 'node /x/playwright/lib/worker/workerProcessEntry.js')).toBe('worker');
    expect(roleOf('node', 'node C:\\x\\playwright\\lib\\common\\process.js')).toBe('worker');
    expect(roleOf('chrome', '/ms-playwright/chromium/chrome --headless --remote-debugging-pipe')).toBe('browser');
    expect(roleOf('chrome', '/ms-playwright/chromium/chrome --type=renderer --lang=en')).toBe('renderer');
    expect(roleOf('chrome', '/chromium/chrome --type=gpu-process')).toBe('gpu');
    expect(roleOf('chrome', '/chromium/chrome --type=utility --utility-sub-type=network')).toBe('utility');
    expect(roleOf('headless_shell', '/x/chrome-headless-shell/headless_shell --headless')).toBe('browser');
    expect(roleOf('firefox', '/x/firefox/firefox -contentproc 3')).toBe('renderer');
    expect(roleOf('WebKitWebProcess', '/x/WebKitWebProcess 7')).toBe('renderer');
    expect(roleOf('ffmpeg', '/x/ffmpeg -f image2pipe')).toBe('ffmpeg');
    expect(roleOf('node', 'node vite')).toBeNull();
  });

  it('lists the descendants of a process, parents first', () => {
    const table = [
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 2 },
      { pid: 4, ppid: 9 },
    ];
    expect(descendantsOf(1, table).map((p) => p.pid)).toEqual([2, 3]);
  });

  it('reads the limits and peaks of a cgroup v2 container and of a v1 one', () => {
    const procRoot = path.join(dir, 'proc');
    const v2 = path.join(dir, 'cg2');
    write(path.join(procRoot, 'self', 'cgroup'), '0::/job\n');
    write(path.join(v2, 'cgroup.controllers'), 'cpu memory\n');
    write(path.join(v2, 'job', 'memory.max'), '2147483648\n');
    write(path.join(v2, 'job', 'memory.current'), '1000\n');
    write(path.join(v2, 'job', 'memory.peak'), '5000\n');
    write(path.join(v2, 'job', 'memory.events'), 'low 0\nhigh 0\nmax 0\noom 1\noom_kill 1\n');
    write(path.join(v2, 'job', 'cpu.max'), '200000 100000\n');
    write(path.join(v2, 'job', 'cpu.stat'), 'usage_usec 9\nnr_throttled 2\nthrottled_usec 1500\n');
    expect(new CgroupFs(procRoot, v2).read()).toEqual({
      version: 2,
      memoryLimitBytes: 2147483648,
      memoryCurrentBytes: 1000,
      memoryPeakBytes: 5000,
      oomKills: 1,
      cpuQuotaCores: 2,
      throttledMs: 1.5,
    });

    const v1 = path.join(dir, 'cg1');
    write(path.join(procRoot, 'self', 'cgroup'), '4:memory:/job\n2:cpu,cpuacct:/\n');
    write(path.join(v1, 'memory', 'job', 'memory.limit_in_bytes'), '9223372036854771712\n');
    write(path.join(v1, 'memory', 'job', 'memory.usage_in_bytes'), '700\n');
    write(path.join(v1, 'memory', 'job', 'memory.max_usage_in_bytes'), '900\n');
    write(path.join(v1, 'memory', 'job', 'memory.oom_control'), 'oom_kill_disable 0\nunder_oom 0\noom_kill 0\n');
    write(path.join(v1, 'cpu,cpuacct', 'cpu.cfs_quota_us'), '-1\n');
    write(path.join(v1, 'cpu,cpuacct', 'cpu.cfs_period_us'), '100000\n');
    write(path.join(v1, 'cpu,cpuacct', 'cpu.stat'), 'nr_periods 0\nnr_throttled 0\nthrottled_time 0\n');
    expect(new CgroupFs(procRoot, v1).read()).toEqual({
      version: 1,
      memoryLimitBytes: null,
      memoryCurrentBytes: 700,
      memoryPeakBytes: 900,
      oomKills: 0,
      cpuQuotaCores: null,
      throttledMs: 0,
    });
  });
});

describe('RunSampler', () => {
  it('measures the run’s processes by role, the machine, the container and the disk on Linux', async () => {
    const procRoot = path.join(dir, 'proc');
    const cgroupRoot = path.join(dir, 'cgroup');
    const outputDir = path.join(dir, 'test-results');
    const tmpDir = path.join(dir, 'tmp');
    write(path.join(procRoot, 'self', 'cgroup'), '0::/\n');
    write(path.join(cgroupRoot, 'cgroup.controllers'), 'memory\n');
    write(path.join(cgroupRoot, 'memory.max'), '1073741824\n');
    write(path.join(cgroupRoot, 'memory.peak'), '100\n');
    write(path.join(cgroupRoot, 'memory.events'), 'oom_kill 0\n');
    // A profile an earlier run left behind, older than this one.
    write(path.join(tmpDir, 'playwright_chromiumdev_profile-old', 'Default', 'History'), 'x'.repeat(4000));
    fs.utimesSync(path.join(tmpDir, 'playwright_chromiumdev_profile-old'), new Date(0), new Date(0));

    let clock = 1_000_000;
    machine(procRoot, { busy: 1000, idle: 9000, steal: 0, cpuPsiUs: 0, memPsiUs: 0, availKb: 8_000_000 });
    proc(procRoot, 100, {
      ppid: 1,
      comm: 'node',
      cmdline: 'node playwright test',
      ticks: 50,
      waitMs: 5,
      pssKb: 50_000,
      rssKb: 90_000,
    });
    proc(procRoot, 200, {
      ppid: 100,
      comm: 'node',
      cmdline: 'node /pw/lib/worker/workerProcessEntry.js',
      ticks: 10,
      waitMs: 1,
      pssKb: 80_000,
      rssKb: 120_000,
    });
    proc(procRoot, 300, {
      ppid: 200,
      comm: 'chrome',
      cmdline: '/pw/chromium/chrome --headless',
      ticks: 20,
      waitMs: 2,
      pssKb: 60_000,
      rssKb: 200_000,
    });
    proc(procRoot, 400, {
      ppid: 100,
      comm: 'sh',
      cmdline: 'sh -c npm run dev',
      ticks: 1,
      waitMs: 0,
      pssKb: 1_000,
      rssKb: 2_000,
    });
    proc(procRoot, 401, {
      ppid: 400,
      comm: 'node',
      cmdline: 'node vite',
      ticks: 100,
      waitMs: 10,
      pssKb: 40_000,
      rssKb: 70_000,
    });

    const sampler = new RunSampler({
      rootPid: 100,
      platform: 'linux',
      procRoot,
      cgroupRoot,
      outputDirs: [outputDir],
      tmpDir,
      intervalMs: 60_000,
      heavyEvery: 1,
      now: () => clock,
    });
    sampler.start();

    // Ten seconds later: CPU spent, a renderer born, the output written, a peak reached.
    clock += 10_000;
    machine(procRoot, { busy: 4000, idle: 10_000, steal: 100, cpuPsiUs: 2_000_000, memPsiUs: 0, availKb: 6_000_000 });
    proc(procRoot, 200, {
      ppid: 100,
      comm: 'node',
      cmdline: 'node /pw/lib/worker/workerProcessEntry.js',
      ticks: 310,
      waitMs: 41,
      pssKb: 90_000,
      rssKb: 130_000,
    });
    proc(procRoot, 300, {
      ppid: 200,
      comm: 'chrome',
      cmdline: '/pw/chromium/chrome --headless',
      ticks: 120,
      waitMs: 12,
      pssKb: 70_000,
      rssKb: 210_000,
    });
    proc(procRoot, 301, {
      ppid: 300,
      comm: 'chrome',
      cmdline: '/pw/chromium/chrome --type=renderer',
      ticks: 500,
      waitMs: 300,
      rssKb: 150_000,
    });
    proc(procRoot, 401, {
      ppid: 400,
      comm: 'node',
      cmdline: 'node vite',
      ticks: 200,
      waitMs: 10,
      pssKb: 40_000,
      rssKb: 70_000,
    });
    write(path.join(outputDir, 'cart-adds', 'trace.zip'), 'x'.repeat(10_000));
    write(path.join(tmpDir, 'playwright-artifacts-new', 'video.webm'), 'x'.repeat(5_000));
    write(path.join(cgroupRoot, 'memory.peak'), '900000000\n');

    const profile = await sampler.stop();
    expect(profile.wallMs).toBe(10_000);
    expect(profile.cpu.byRole).toEqual({
      runner: { cpuMs: 0, runWaitMs: 0, processes: 1 },
      worker: { cpuMs: 3000, runWaitMs: 40, processes: 1 },
      browser: { cpuMs: 1000, runWaitMs: 10, processes: 1 },
      renderer: { cpuMs: 5000, runWaitMs: 300, processes: 1 },
      webServer: { cpuMs: 1000, runWaitMs: 0, processes: 2 },
    });
    expect(profile.cpu.busyPct).toBe(cpuShare(3000, 4100));
    expect(profile.cpu.stealPct).toBe(cpuShare(100, 4100));
    expect(profile.cpu.pressurePct).toBe(20);
    expect(profile.memory).toMatchObject({
      kind: 'pss',
      // The renderer has no smaps_rollup here, so it counts by RSS.
      peakBytes: (50_000 + 90_000 + 70_000 + 1_000 + 40_000 + 150_000) * 1024,
      peakAtMs: 10_000,
      largest: { role: 'renderer', bytes: 150_000 * 1024 },
      rssFallbacks: 1,
      pressurePct: 0,
      lowestAvailableBytes: 6_000_000 * 1024,
      containerPeakBytes: 900_000_000,
      oomKills: 0,
    });
    expect(profile.machine.memoryLimitBytes).toBe(1073741824);
    expect(profile.disk.peakInUseBytes).toBe(15_000);
    expect(profile.disk.leftoverBytes).toBe(4000);
    expect(profile.disk.lowestFreeBytes).toBeGreaterThan(0);
    expect(profile.notMeasured).toEqual([]);

    // Each reading at the time its sample started: the first CPU share needs two readings.
    const series = sampler.timedSeries();
    expect(series.startedAt).toBe(1_000_000);
    expect(series.cpuPct).toEqual([[10_000, cpuShare(3000, 4100)]]);
    expect(series.memoryBytes.map(([at]) => at)).toEqual([0, 10_000]);
    // The worker and the browser it started, with the renderer born since: 9 s of CPU over 10 s.
    expect(series.workers).toHaveLength(1);
    expect(series.workers[0]).toMatchObject({ pid: 200, cpuCores: [[10_000, 0.9]] });
    expect(series.workers[0]!.memoryBytes[series.workers[0]!.memoryBytes.length - 1]).toEqual([
      10_000,
      (90_000 + 70_000 + 150_000) * 1024,
    ]);
    expect(series.memoryBytes[series.memoryBytes.length - 1]![1]).toBe(profile.memory.peakBytes);
  });

  it('keeps a long run’s whole span by merging neighboring points', async () => {
    let clock = 0;
    let busy = 0;
    const procRoot = path.join(dir, 'proc');
    machine(procRoot, { busy: 0, idle: 0, steal: 0, cpuPsiUs: 0, memPsiUs: 0, availKb: 1 });
    const sampler = new RunSampler({ platform: 'linux', procRoot, intervalMs: 60_000, tmpDir: dir, now: () => clock });
    sampler.start();
    // One more reading than the timed series keeps, each a second apart: half busy. Only the
    // CPU counters change between readings.
    for (let i = 0; i < 3601; i++) {
      clock += 1000;
      busy += 50;
      fs.writeFileSync(path.join(procRoot, 'stat'), `cpu  ${busy} 0 0 ${busy} 0 0 0 0 0 0\ncpu0 1 2 3\n`);
      await (sampler as unknown as { sample(heavy: boolean): Promise<void> }).sample(false);
    }
    const { cpuPct } = sampler.timedSeries();
    expect(cpuPct).toHaveLength(1801);
    expect(cpuPct[0]).toEqual([1000, 50]);
    expect(cpuPct[1]).toEqual([3000, 50]);
    expect(cpuPct[cpuPct.length - 1]).toEqual([3_601_000, 50]);
    await sampler.stop();
  }, 20_000);

  it('reads the tree through ps on macOS, and names what it could not read', async () => {
    let clock = 0;
    let ps =
      '  100     1  50000   0:01.00 /usr/local/bin/node playwright test\n  200   100  90000   0:02.00 /usr/local/bin/node /pw/lib/worker/workerProcessEntry.js\n';
    const sampler = new RunSampler({
      rootPid: 100,
      platform: 'darwin',
      procRoot: path.join(dir, 'no-proc'),
      intervalMs: 60_000,
      heavyEvery: 1,
      tmpDir: dir,
      now: () => clock,
      runPs: async () => ps,
    });
    sampler.start();
    clock += 5000;
    ps =
      ps.replace('0:02.00', '0:04.50') +
      '  300   200 300000   0:03.00 /Apps/Chromium.app/Contents/MacOS/Chromium --headless\n';
    const profile = await sampler.stop();
    expect(profile.cpu.byRole).toEqual({
      runner: { cpuMs: 0, runWaitMs: null, processes: 1 },
      worker: { cpuMs: 2500, runWaitMs: null, processes: 1 },
      browser: { cpuMs: 3000, runWaitMs: null, processes: 1 },
    });
    expect(profile.memory).toMatchObject({ kind: 'rss', peakBytes: (50_000 + 90_000 + 300_000) * 1024 });
    // The worker's 2.5 s and its new browser's 3 s over the 5 s between the two reads.
    expect(sampler.timedSeries().workers).toEqual([
      {
        pid: 200,
        cpuCores: [[5000, 1.1]],
        memoryBytes: [
          [0, 90_000 * 1024],
          [5000, (90_000 + 300_000) * 1024],
        ],
      },
    ]);
    expect(profile.cpu.pressurePct).toBeNull();
    expect(profile.notMeasured).toEqual(['time waiting for a CPU', 'steal', 'CPU pressure']);
  });

  it('reads the tree through CIM on Windows, and names what it could not read', async () => {
    let clock = 0;
    const row = (
      pid: number,
      ppid: number,
      ticks: number,
      workingSetKb: number,
      name: string,
      commandLine: string,
    ) => ({
      ProcessId: pid,
      ParentProcessId: ppid,
      WorkingSetSize: workingSetKb * 1024,
      UserModeTime: ticks / 2,
      KernelModeTime: ticks / 2,
      Name: name,
      CommandLine: commandLine,
    });
    let query = JSON.stringify([
      row(100, 1, 10_000_000, 50_000, 'node.exe', 'node playwright test'),
      row(200, 100, 20_000_000, 90_000, 'node.exe', 'node /pw/lib/worker/workerProcessEntry.js'),
    ]);
    const sampler = new RunSampler({
      rootPid: 100,
      platform: 'win32',
      procRoot: path.join(dir, 'no-proc'),
      intervalMs: 60_000,
      heavyEvery: 1,
      windowsTreeEvery: 1,
      tmpDir: dir,
      now: () => clock,
      runWindows: async () => query,
    });
    sampler.start();
    clock += 5000;
    query = JSON.stringify([
      row(100, 1, 10_000_000, 50_000, 'node.exe', 'node playwright test'),
      row(200, 100, 45_000_000, 90_000, 'node.exe', 'node /pw/lib/worker/workerProcessEntry.js'),
      row(300, 200, 30_000_000, 300_000, 'chrome.exe', 'chrome --headless'),
    ]);
    const profile = await sampler.stop();
    expect(profile.cpu.byRole).toEqual({
      runner: { cpuMs: 0, runWaitMs: null, processes: 1 },
      worker: { cpuMs: 2500, runWaitMs: null, processes: 1 },
      browser: { cpuMs: 3000, runWaitMs: null, processes: 1 },
    });
    expect(profile.memory).toMatchObject({ kind: 'rss', peakBytes: (50_000 + 90_000 + 300_000) * 1024 });
    // The worker's 2.5 s and its new browser's 3 s over the 5 s between the two reads.
    expect(sampler.timedSeries().workers).toEqual([
      {
        pid: 200,
        cpuCores: [[5000, 1.1]],
        memoryBytes: [
          [0, 90_000 * 1024],
          [5000, (90_000 + 300_000) * 1024],
        ],
      },
    ]);
    expect(profile.cpu.pressurePct).toBeNull();
    expect(profile.notMeasured).toEqual(['time waiting for a CPU', 'steal', 'CPU pressure']);
  });

  it('measures only the machine where the tree cannot be read', async () => {
    const sampler = new RunSampler({
      platform: 'win32',
      procRoot: path.join(dir, 'no-proc'),
      intervalMs: 60_000,
      tmpDir: dir,
      runWindows: async () => {
        throw new Error('PowerShell is not available');
      },
    });
    sampler.start();
    const profile = await sampler.stop();
    expect(profile.cpu.byRole).toBeNull();
    expect(profile.memory.kind).toBeNull();
    expect(profile.notMeasured).toContain('CPU and memory of the run’s processes');
    expect(profile.machine.cores).toBeGreaterThan(0);
  });
});

function cpuShare(part: number, whole: number): number {
  return Math.round((part / whole) * 1000) / 10;
}
