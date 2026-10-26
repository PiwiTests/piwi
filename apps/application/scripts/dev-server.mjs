/**
 * Start the Nuxt dev server fully detached and wait until it responds.
 *
 * Usage: node scripts/dev-server.mjs [port]   |   node scripts/dev-server.mjs --stop [port]
 *
 * - Defaults to port 3000 (the port Playwright's webServer reuses).
 * - Records the spawned PID in `.data/dev-server.pid`; the next start (or
 *   `--stop`) kills that previous instance first, so no manual cleanup.
 * - Refuses to start only when the port is held by a *foreign* process
 *   (usually the Piwi desktop app) — stop that one yourself.
 * - Logs go to `.data/dev-server.log` — watch it for compile errors.
 *
 * The server is launched detached (no inherited handles) so the invoking
 * shell/tool call returns immediately. On Windows that goes through
 * PowerShell's `Start-Process` (a new process with a hidden window); on other
 * platforms Node's `detached: true` spawn with `stdio` pointed at the log file
 * does the same.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const stopOnly = args.includes('--stop');
const port = args.find((a) => !a.startsWith('-')) ?? '3000';

const dataDir = path.join(appDir, '.data');
const pidFile = path.join(dataDir, 'dev-server.pid');
const logPath = path.join(dataDir, 'dev-server.log');

// The recorded PID can outlive a crash, and the OS reuses PIDs, so before
// killing we confirm the live process still looks like our dev server (a node
// or nuxt/npx command). An unconfirmed PID is treated as stale — we never
// signal an unrelated program that happened to inherit the number.
function processMatchesServer(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return /node\.exe|npx/i.test(out);
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /nuxt|node/i.test(out);
  } catch {
    // ps/tasklist exits non-zero when the PID is gone — nothing to kill.
    return false;
  }
}

function killRecorded() {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  rmSync(pidFile, { force: true });
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (!processMatchesServer(pid)) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
    console.log(`Stopped previous dev server (pid ${pid})`);
  } catch {
    // already gone
  }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: Number(port), host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // A bounded fetch: the first request on a cold build compiles for a
      // while, and a hung request would otherwise stall the readiness loop
      // past its own deadline.
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.status < 500) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

function startServer() {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  // Inherited by the child process (Start-Process has no -Environment support
  // on older pwsh, and a plain spawn inherits the parent env). `nuxt dev`
  // outgrows Node's default heap (about 2 GB), so it gets 4 GB, as `app:dev` does.
  process.env.NUXT_IGNORE_LOCK = '1';
  process.env.NODE_OPTIONS = `--max-old-space-size=4096 ${process.env.NODE_OPTIONS ?? ''}`.trim();

  if (process.platform !== 'win32') {
    return new Promise((resolve, reject) => {
      const logFd = openSync(logPath, 'a');
      const child = spawn('npx', ['nuxt', 'dev', '--port', String(port)], {
        cwd: appDir,
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
      child.on('error', reject);
      child.once('spawn', () => {
        writeFileSync(pidFile, String(child.pid));
        child.unref();
        resolve(child.pid);
      });
    });
  }

  return new Promise((resolve, reject) => {
    // The PID travels through a file, not a pipe. `stdio: 'ignore'` makes
    // libuv spawn powershell with no inherited handles, so the nuxt process
    // tree never holds the invoking shell's stdout pipe — an inherited pipe
    // stays open as long as nuxt runs and keeps the caller from returning.
    const pidTmp = path.join(dataDir, 'dev-server.pid.tmp');
    rmSync(pidTmp, { force: true });
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        [
          `$p = Start-Process -FilePath 'npx.cmd'`,
          `-ArgumentList @('nuxt','dev','--port','${port}')`,
          `-WorkingDirectory '${appDir}'`,
          `-WindowStyle Hidden`,
          `-RedirectStandardOutput '${logPath}'`,
          `-RedirectStandardError '${logPath}.err'`,
          `-PassThru;`,
          `Set-Content -Path '${pidTmp}' -Value $p.Id`,
        ].join(' '),
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    ps.on('error', reject);
    ps.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Start-Process failed (code ${code})`));
        return;
      }
      const deadline = Date.now() + 15_000;
      const poll = () => {
        try {
          const pid = Number(readFileSync(pidTmp, 'utf8').trim());
          if (Number.isInteger(pid) && pid > 0) {
            rmSync(pidTmp, { force: true });
            writeFileSync(pidFile, String(pid));
            resolve(pid);
            return;
          }
        } catch {
          // not written yet
        }
        if (Date.now() > deadline) {
          reject(new Error('Start-Process finished without recording a PID'));
          return;
        }
        setTimeout(poll, 250);
      };
      poll();
    });
  });
}

killRecorded();
if (stopOnly) {
  console.log('Stopped.');
  process.exit(0);
}

// Give the killed process a moment to release the port.
await new Promise((r) => setTimeout(r, 1500));

if (await portInUse(port)) {
  console.error(`Port ${port} is held by a foreign process — if the Piwi desktop app is running, close it first.`);
  process.exit(1);
}

const pid = await startServer();
console.log(`Starting nuxt dev on http://localhost:${port} (pid ${pid}) — logs: .data/dev-server.log`);
const ready = await waitForServer(`http://localhost:${port}/api/projects`);
if (!ready) {
  console.error(`Server did not come up within 90s — check .data/dev-server.log`);
  process.exit(1);
}
console.log(`Dev server ready on http://localhost:${port}`);
