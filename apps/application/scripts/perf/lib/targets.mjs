/**
 * A target is one production build (`.output`) run as a server process of its
 * own, against its own copy of the dataset, with authentication on and an
 * administrator signed in — the setup of a self-hosted instance in use.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ADMIN = { username: 'perf-admin', password: 'perf-admin-password', name: 'Perf Admin' };
const AUTH_SECRET = 'piwi-performance-suite-session-secret-not-for-production';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The environment of a target server: the caller's, minus anything that would configure Piwi. */
function serverEnv({ port, database, storageDir, otel }) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(PIWI_|NUXT_|NITRO_|OTEL_)/.test(key) && key !== 'PORT' && key !== 'HOST') env[key] = value;
  }
  return {
    ...env,
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
    PIWI_AUTH_ENABLED: 'true',
    PIWI_AUTH_SECRET: AUTH_SECRET,
    NUXT_AUTH_ENABLED: 'true',
    NUXT_AUTH_SECRET: AUTH_SECRET,
    NUXT_PUBLIC_AUTH_ENABLED: 'true',
    PIWI_SECRET_KEY: 'piwi-performance-suite-encryption-key-not-for-production',
    PIWI_STORAGE_TYPE: 'local',
    PIWI_STORAGE_PATH: storageDir,
    ...(database.url ? { PIWI_DATABASE_URL: database.url } : { PIWI_DATABASE_PATH: database.path }),
    ...(otel
      ? {
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: otel.endpoint,
          OTEL_SERVICE_NAME: otel.serviceName,
          // Export fast and never drop: the suite reads every span of every request it makes.
          OTEL_BSP_SCHEDULE_DELAY: '100',
          OTEL_BSP_MAX_QUEUE_SIZE: '262144',
          OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '8192',
        }
      : {}),
  };
}

/** CPU time the process has used, in ms (Linux), or null where /proc is unavailable. */
function cpuTimeMs(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return ((Number(fields[11]) + Number(fields[12])) * 1000) / 100;
  } catch {
    return null;
  }
}

/**
 * Start `outputDir/server/index.mjs` on `port`. `database` is `{ url }` for
 * PostgreSQL or `{ path }` for SQLite; `otel`, when given, exports spans to
 * the suite's receiver. Resolves once `/api/health` answers.
 */
export async function startServer({ name, outputDir, port, database, workDir, otel = null, log = console.log }) {
  const entry = resolve(outputDir, 'server', 'index.mjs');
  if (!existsSync(entry)) throw new Error(`${name}: no build at ${entry} — run \`npm run app:build\` first`);
  mkdirSync(workDir, { recursive: true });
  const storageDir = join(workDir, 'storage');
  mkdirSync(storageDir, { recursive: true });
  const logPath = join(workDir, `server-${Date.now()}.log`);
  const logStream = createWriteStream(logPath);
  const child = spawn(process.execPath, [entry], {
    cwd: workDir,
    env: serverEnv({ port, database, storageDir, otel }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  let exited = null;
  child.on('exit', (code, signal) => (exited = { code, signal }));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 300_000;
  for (;;) {
    if (exited) throw new Error(`${name}: server exited (${JSON.stringify(exited)}) — see ${logPath}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`${name}: not healthy after 300 s — see ${logPath}`);
    }
    await sleep(500);
  }
  log(`  ${name} is up at ${base} (log: ${logPath})`);

  return {
    name,
    base,
    pid: child.pid,
    logPath,
    cookie: null,
    async stop() {
      if (exited) return;
      child.kill('SIGTERM');
      for (let i = 0; i < 100 && !exited; i++) await sleep(100);
      if (!exited) child.kill('SIGKILL');
      for (let i = 0; i < 50 && !exited; i++) await sleep(100);
      logStream.end();
    },
    cpuTimeMs: () => cpuTimeMs(child.pid),
  };
}

/** Create the first administrator on a fresh instance. */
export async function createAdmin(server) {
  const res = await fetch(`${server.base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  if (!res.ok) throw new Error(`${server.name}: initial setup failed (${res.status}): ${await res.text()}`);
}

/** Sign the administrator in; the session cookie lands on `server.cookie`. */
export async function signIn(server) {
  const res = await fetch(`${server.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN.username, password: ADMIN.password }),
  });
  if (!res.ok) throw new Error(`${server.name}: sign-in failed (${res.status}): ${await res.text()}`);
  // A build compared against may name its session cookie with or without the `__Host-` prefix.
  const session = res.headers.getSetCookie().find((c) => /^(?:__Host-)?piwi_session=/.test(c));
  if (!session) throw new Error(`${server.name}: sign-in returned no session cookie`);
  server.cookie = session.split(';')[0];
  return server.cookie;
}

/**
 * Wait until the server has finished its startup work (migrations, backfills,
 * re-clustering): its CPU time stays flat for three seconds and, on
 * PostgreSQL, no statement of its database is running.
 */
export async function waitForIdle(
  server,
  { activeStatements = null, timeoutMs = 600_000, strict = false, log = console.log } = {},
) {
  const started = Date.now();
  let previous = server.cpuTimeMs();
  let quiet = 0;
  while (quiet < 3) {
    await sleep(1000);
    const now = server.cpuTimeMs();
    const busyCpu = now != null && previous != null && now - previous > 30;
    const busyDb = activeStatements ? (await activeStatements()) > 0 : false;
    previous = now;
    quiet = busyCpu || busyDb ? 0 : quiet + 1;
    if (Date.now() - started > timeoutMs) {
      if (strict) throw new Error(`${server.name}: startup work still running after ${timeoutMs / 1000} s`);
      log(`  ${server.name}: still busy after ${timeoutMs / 1000} s — measuring anyway`);
      return;
    }
  }
  const waited = Math.round((Date.now() - started) / 1000);
  if (waited > 4) log(`  ${server.name}: startup work done after ${waited} s`);
}
