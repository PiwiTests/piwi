// Runs one command and measures it as a whole: wall time, CPU time of every process it started (Chromium
// included), and peak memory of the process tree.
//
// Linux: the command runs under a subreaper (python3), which adopts and reaps every process orphaned below it, such
// as Chromium's zygotes and renderers once the browser process exits first: the kernel's account of this process's
// reaped children then holds the CPU time of all of them (exact). Memory as the peak sum of PSS. Without python3, no
// CPU. macOS: memory as the peak sum of RSS (overcounts shared pages), no CPU. Windows: wall time only.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// Runs the command as its child, adopts every process orphaned below it (PR_SET_CHILD_SUBREAPER), reaps them all, and
// writes the command's exit code and lifetime to the file named first.
const SUBREAPER = `
import ctypes, json, os, subprocess, sys, time
ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)
started = time.monotonic()
child = subprocess.Popen(sys.argv[2:])
code = child.wait()
wall_ms = (time.monotonic() - started) * 1000
deadline = time.monotonic() + 30
while time.monotonic() < deadline:
    try:
        pid, _ = os.waitpid(-1, os.WNOHANG)
    except ChildProcessError:
        break
    if pid == 0:
        time.sleep(0.02)
with open(sys.argv[1], 'w') as out:
    json.dump({'exitCode': code if code >= 0 else 1, 'wallMs': wall_ms}, out)
sys.exit(code if code >= 0 else 1)
`;

let subreaper;
function hasSubreaper() {
  if (subreaper === undefined) {
    try {
      execFileSync('python3', ['-c', 'import ctypes; ctypes.CDLL(None).prctl'], { stdio: 'ignore' });
      subreaper = true;
    } catch {
      subreaper = false;
    }
  }
  return subreaper;
}

/** A command line for Windows' shell: an argument with a space or a shell character is quoted. */
export function windowsCommandLine(command, args) {
  return [command, ...args]
    .map((part) => (/[\s&|<>^()]/.test(part) && !part.includes('"') ? `"${part}"` : part))
    .join(' ');
}

/** Spawns `command`: on Linux under the subreaper when there is one, on Windows through the shell. */
export function spawnCommand(command, args, options, resultFile) {
  if (linux && resultFile) return spawn('python3', ['-c', SUBREAPER, resultFile, command, ...args], options);
  if (process.platform === 'win32') return spawn(windowsCommandLine(command, args), [], { ...options, shell: true });
  return spawn(command, args, options);
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

function linuxMemoryKb(rootPid, { includeRoot = true } = {}) {
  let total = 0;
  for (const pid of linuxTree(rootPid)) {
    if (!includeRoot && pid === rootPid) continue;
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
    const rows = output
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number));
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
    const reaped = linux && hasSubreaper();
    const resultDir = reaped ? mkdtempSync(join(tmpdir(), 'turbo-bench-run-')) : undefined;
    const resultFile = resultDir && join(resultDir, 'result.json');
    const cpuBefore = reaped ? childrenCpuMs() : undefined;
    const started = process.hrtime.bigint();
    const child = spawnCommand(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }, resultFile);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let peakKb = 0;
    const sample = () => {
      if (!memoryMetric || !child.pid) return;
      // The subreaper itself is not the command's.
      peakKb = Math.max(peakKb, linux ? linuxMemoryKb(child.pid, { includeRoot: !reaped }) : psMemoryKb(child.pid));
    };
    const timer = setInterval(sample, sampleMs);
    child.on('error', (error) => {
      clearInterval(timer);
      reject(error);
    });
    child.on('close', (code) => {
      let wallMs = Number(process.hrtime.bigint() - started) / 1e6;
      clearInterval(timer);
      const cpuAfter = cpuBefore === undefined ? undefined : childrenCpuMs();
      let exitCode = code ?? 1;
      if (resultFile) {
        // The command's own lifetime and exit code, without the subreaper's start or its wait for orphans.
        try {
          const result = JSON.parse(readFileSync(resultFile, 'utf8'));
          wallMs = result.wallMs;
          exitCode = result.exitCode;
        } catch {
          // The subreaper did not get to write it: the measures taken from outside stand.
        }
        rmSync(resultDir, { recursive: true, force: true });
      }
      log.end();
      resolve({
        exitCode,
        wallMs,
        cpuMs: cpuBefore === undefined ? undefined : cpuAfter - cpuBefore,
        // No sample before the command ended: no peak to report.
        peakMemoryMb: memoryMetric && peakKb > 0 ? peakKb / 1024 : undefined,
      });
    });
  });
}
