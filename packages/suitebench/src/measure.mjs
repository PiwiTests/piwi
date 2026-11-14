// Runs one command and measures it as a whole: wall time, CPU time of every process it started (Chromium
// included), and peak memory of the process tree.
//
// Linux: CPU from the kernel's account of reaped children (exact), memory as the peak sum of PSS.
// macOS: memory as the peak sum of RSS (overcounts shared pages), no CPU. Windows: wall time only.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, createWriteStream } from 'node:fs';

const linux = process.platform === 'linux';

let clockTicks;
function ticksPerSecond() {
  if (clockTicks === undefined) {
    try {
      clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100;
    } catch {
      clockTicks = 100;
    }
  }
  return clockTicks;
}

/** CPU milliseconds of this process's reaped children (user + system), Linux only. */
function childrenCpuMs() {
  if (!linux) return undefined;
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // Fields after the command name start at field 3; cutime and cstime are fields 16 and 17.
  const cutime = Number(fields[13]);
  const cstime = Number(fields[14]);
  return ((cutime + cstime) * 1000) / ticksPerSecond();
}

function linuxTree(rootPid) {
  const children = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(entry));
    } catch {
      // The process exited while the tree was being read.
    }
  }
  const pids = [];
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    pids.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return pids;
}

function linuxMemoryKb(rootPid) {
  let total = 0;
  for (const pid of linuxTree(rootPid)) {
    try {
      const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
      const match = /^Pss:\s+(\d+) kB/m.exec(rollup);
      if (match) total += Number(match[1]);
    } catch {
      // The process exited, or its memory map is not readable.
    }
  }
  return total;
}

function psMemoryKb(rootPid) {
  try {
    const output = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' });
    const rows = output.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
    const children = new Map();
    for (const [pid, ppid] of rows) {
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }
    const rss = new Map(rows.map(([pid, , kb]) => [pid, kb]));
    let total = 0;
    const queue = [rootPid];
    while (queue.length) {
      const pid = queue.shift();
      total += rss.get(pid) ?? 0;
      queue.push(...(children.get(pid) ?? []));
    }
    return total;
  } catch {
    return 0;
  }
}

/** The memory measure this platform offers, or undefined. */
export const memoryMetric = linux ? 'PSS' : process.platform === 'darwin' ? 'RSS' : undefined;

/**
 * Runs `command` with `args` and resolves with its measurements. Output goes to `logFile`.
 * @returns {Promise<{ exitCode: number, wallMs: number, cpuMs?: number, peakMemoryMb?: number }>}
 */
export function measure({ command, args, cwd, env, logFile, sampleMs = 200 }) {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logFile);
    const cpuBefore = childrenCpuMs();
    const started = process.hrtime.bigint();
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let peakKb = 0;
    const sample = () => {
      if (!memoryMetric || !child.pid) return;
      peakKb = Math.max(peakKb, linux ? linuxMemoryKb(child.pid) : psMemoryKb(child.pid));
    };
    const timer = setInterval(sample, sampleMs);
    child.on('error', (error) => {
      clearInterval(timer);
      reject(error);
    });
    child.on('close', (code) => {
      const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
      clearInterval(timer);
      const cpuAfter = childrenCpuMs();
      log.end();
      resolve({
        exitCode: code ?? 1,
        wallMs,
        cpuMs: cpuBefore === undefined ? undefined : cpuAfter - cpuBefore,
        peakMemoryMb: memoryMetric ? peakKb / 1024 : undefined,
      });
    });
  });
}
