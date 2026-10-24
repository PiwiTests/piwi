/**
 * Booting, seeding and tearing down a throwaway dev server, shared by the
 * scripts that drive the running app with Playwright (the feature-screenshot
 * harness and the detail-page measurement). Everything here is server/process
 * plumbing — no browser — so a script that reuses a server it already has
 * (`--url`) never imports it.
 */
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The application workspace root (`scripts/lib/` sits two levels below it). */
export const APP_DIR = join(__dirname, '..', '..');

/** Default port for a booted throwaway server — off 3000 so a dev server can stay up. */
export const DEFAULT_PORT = 3050;

export function resolveChromium() {
  // The sandboxed environments provide a Chromium via PLAYWRIGHT_BROWSERS_PATH;
  // a normal checkout uses Playwright's own download.
  const provided = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (provided && existsSync(join(provided, 'chromium'))) return join(provided, 'chromium');
  return undefined;
}

/** The demo seed `app:seed:dev` loads, and the hash of it the repository records. */
const SEED_SQL = join(APP_DIR, 'public', 'demo', 'seed.sql');
const SEED_VERSION = join(APP_DIR, 'public', 'demo', 'seed.version.json');

/** Whether `public/demo/seed.sql` exists and hashes to what `seed.version.json` records. */
function demoSeedIsCurrent() {
  if (!existsSync(SEED_SQL) || !existsSync(SEED_VERSION)) return false;
  const recorded = JSON.parse(readFileSync(SEED_VERSION, 'utf8')).hash;
  return createHash('sha256').update(readFileSync(SEED_SQL)).digest('hex') === recorded;
}

/**
 * The machine settings a server on a throwaway database must not pick up from
 * the shell or from `.env`. `nuxt dev` loads `.env` into the keys that are still
 * undefined only, so a value set here wins, and the server reads an empty value
 * as unset. Each one would change what the pages show: a Postgres URL routes the
 * server away from the seeded SQLite file, S3 storage serves the evidence from
 * elsewhere, authentication puts a sign-in page in front of every route, an AI
 * provider turns the Next step of an undiagnosed failure into Diagnose (the
 * other `PIWI_AI_*` settings are ignored without one), Jira credentials connect
 * an issue tracker, and a locale or time zone rewrites every date.
 */
const THROWAWAY_SERVER_SETTINGS = {
  PIWI_DATABASE_URL: '',
  PIWI_STORAGE_TYPE: 'local',
  PIWI_AUTH_ENABLED: 'false',
  PIWI_AI_PROVIDER: '',
  PIWI_AI_API_KEY: '',
  PIWI_JIRA_BASE_URL: '',
  PIWI_JIRA_EMAIL: '',
  PIWI_JIRA_API_TOKEN: '',
  PIWI_LOCALE: '',
  PIWI_TIME_ZONE: '',
};

/**
 * Seed a throwaway database in `dir` from the demo seed, so a measurement reads
 * the same data on every run whatever the local dev database holds. It empties
 * `dir`, regenerates `public/demo/seed.sql` when the seed is missing or no
 * longer hashes to `seed.version.json` (into `dir` first, so the tracked
 * version file stays as it is), and loads it with `app:seed:dev` into
 * `<dir>/piwi.db` with the evidence media under `<dir>/storage`. Returns the
 * environment a server needs to run on that database with the default
 * settings: the database and storage paths, plus `THROWAWAY_SERVER_SETTINGS`
 * (no AI provider, no issue tracker, no authentication). Progress goes to
 * stderr, so a script printing JSON on stdout stays parseable.
 */
export function seedThrowawayDb(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const stdio = ['ignore', 2, 2];
  if (!demoSeedIsCurrent()) {
    console.error('The demo seed is missing or stale — regenerating public/demo/seed.sql…');
    const output = join(dir, 'demo-seed');
    execSync('npm run app:seed:demo', {
      cwd: APP_DIR,
      stdio,
      env: { ...process.env, PIWI_DEMO_SEED_OUTPUT_DIR: output },
    });
    copyFileSync(join(output, 'seed.sql'), SEED_SQL);
  }
  const env = {
    ...THROWAWAY_SERVER_SETTINGS,
    PIWI_DATABASE_PATH: join(dir, 'piwi.db'),
    PIWI_STORAGE_PATH: join(dir, 'storage'),
  };
  console.error(`Seeding a throwaway database in ${dir}…`);
  execSync('npm run app:seed:dev', { cwd: APP_DIR, stdio, env: { ...process.env, ...env } });
  return env;
}

export function ensureDevDb() {
  if (existsSync(join(APP_DIR, '.data', 'piwi.db'))) return;
  console.log('No dev DB — creating and seeding one (first run only)…');
  if (!existsSync(join(APP_DIR, 'public', 'demo', 'seed.sql'))) {
    execSync('npm run app:seed:demo', { cwd: APP_DIR, stdio: 'inherit' });
  }
  mkdirSync(join(APP_DIR, '.data'), { recursive: true });
  execSync('npm run db:migrate', { cwd: APP_DIR, stdio: 'inherit' });
  execSync('npm run app:seed:dev', { cwd: APP_DIR, stdio: 'inherit' });
}

export async function waitForHealth(base, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server at ${base} did not become healthy within ${timeoutMs / 1000}s`);
}

/**
 * Whether something already listens on `port` on this machine, HTTP or not:
 * a TCP connection to `localhost` that opens.
 */
export function portInUse(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: 'localhost' });
    const done = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(2000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Wait for a stopped server to release the port, so the next `startServer` on
 * it does not find the port taken and refuse.
 */
export async function waitForPortFree(base, timeoutMs = 30_000) {
  const port = Number(new URL(base).port);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portInUse(port))) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server at ${base} did not shut down within ${timeoutMs / 1000}s`);
}

/**
 * What each mode adds to a booted server's environment, and how the boot names
 * it. `web` is the dashboard as a browser serves it. `tour` is the same with
 * the demo's guided tour switched on (`runtimeConfig.public.demoTour`). `desktop`
 * enables the desktop UI, which only that mode may: the sidebar's back/forward
 * pair exists in the Tauri shell alone, and would misrepresent the web app in a
 * full-viewport capture.
 */
const SERVER_MODES = {
  web: { env: {}, label: '' },
  tour: { env: { NUXT_PUBLIC_DEMO_TOUR: 'true' }, label: ' (guided tour enabled)' },
  desktop: { env: { NUXT_PUBLIC_DESKTOP: 'true' }, label: ' (desktop UI enabled)' },
};

/**
 * Boot a dev server in `mode` (`web`, `tour` or `desktop`, see `SERVER_MODES`);
 * returns { base, stop }. `env` is added to the server's environment; when it
 * names its own database (`PIWI_DATABASE_PATH`, as `seedThrowawayDb` returns)
 * the dev database is left alone, otherwise a missing one is created and
 * seeded first.
 *
 * It refuses a port something already listens on: `nuxt dev` would quietly bind
 * another port, and the health check would then pass against the server that
 * was already there, so the run would drive that server's code and data.
 */
export async function startServer({ mode = 'web', port = DEFAULT_PORT, env = {} } = {}) {
  const serverMode = SERVER_MODES[mode];
  if (!serverMode) throw new Error(`unknown server mode "${mode}" — use ${Object.keys(SERVER_MODES).join(', ')}`);
  if (await portInUse(port)) throw new Error(`port ${port} is already in use; stop the server on it first`);
  if (!env.PIWI_DATABASE_PATH) ensureDevDb();
  const child = spawn('npx', ['nuxt', 'dev', '--port', String(port)], {
    cwd: APP_DIR,
    env: { ...process.env, NUXT_IGNORE_LOCK: '1', ...serverMode.env, ...env },
    stdio: 'ignore',
    // Detached puts nuxt in its own process group so stop() can kill the whole
    // tree; on Windows npx needs a shell and group-kill is unsupported anyway.
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
  });
  return superviseServer(child, port, `dev server${serverMode.label}`);
}

/**
 * The settings a production build keeps from the machine that built it
 * (`runtimeConfig` in `nuxt.config.ts`), under the `NUXT_` names a built server
 * reads at startup: no authentication, no AI provider, the default locale and
 * time zone, as `THROWAWAY_SERVER_SETTINGS` gives a dev server.
 */
const BUILT_SERVER_SETTINGS = {
  NUXT_AUTH_ENABLED: 'false',
  NUXT_PUBLIC_AUTH_ENABLED: 'false',
  NUXT_AI_PROVIDER: '',
  NUXT_AI_API_KEY: '',
  NUXT_PUBLIC_DATE_LOCALE: '',
  NUXT_PUBLIC_DATE_TIME_ZONE: '',
};

/**
 * Boot the production build in `outputDir` (`.output`) on `port`; returns
 * { base, stop } as `startServer` does. `env` is added to the server's
 * environment and must name its database (`seedThrowawayDb` returns one). It
 * refuses a port something already listens on, for the reason `startServer`
 * does.
 */
export async function startBuiltServer({ outputDir, port = DEFAULT_PORT, env = {} }) {
  const entry = join(outputDir, 'server', 'index.mjs');
  if (!existsSync(entry)) throw new Error(`no build at ${entry}; run \`npm run app:build\` first`);
  if (await portInUse(port)) throw new Error(`port ${port} is already in use; stop the server on it first`);
  const child = spawn(process.execPath, [entry], {
    cwd: APP_DIR,
    env: { ...process.env, ...BUILT_SERVER_SETTINGS, ...env, NITRO_PORT: String(port) },
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  return superviseServer(child, port, `the build in ${outputDir}`);
}

/**
 * Wait for a server process to answer its health check on `port`; returns
 * { base, stop }. It is stopped when the check times out or the script is
 * interrupted.
 */
async function superviseServer(child, port, name) {
  const stop = () => {
    // Negative pid kills the whole process group where supported. On Windows
    // child.kill() only terminates the cmd wrapper — the nuxt node process
    // survives and keeps the port bound, so kill the tree explicitly.
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
      } else {
        process.kill(-child.pid, 'SIGTERM');
      }
    } catch {
      // already gone
    }
  };
  process.on('SIGINT', () => {
    stop();
    process.exit(130);
  });
  const base = `http://localhost:${port}`;
  console.error(`Starting ${name} at ${base}…`);
  try {
    await waitForHealth(base);
  } catch (err) {
    stop();
    throw err;
  }
  return { base, stop };
}
