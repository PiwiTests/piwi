// The team's instance: the dashboard's dev server on a database of its own, seeded with the demo's history, the shop's
// project with its live view on, and the "CI" runs, each a real headless run of a fresh clone of `origin`, told as CI
// (`CI=true`, which the reporter's `detectCi` reads, and `PIWI_ORIGIN=ci`, the run's origin).
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { seedThrowawayDb, startServer } from '../../application/scripts/lib/dev-server.mjs';
import { PROJECT_NAME, at, checkout } from './workspace.mjs';

/** The instance's port: off the dev server's (7494), the throwaway servers' (3050, 3060) and the desktop app's. */
export const INSTANCE_PORT = 3077;

/** The instance, read through its API. */
export class Instance {
  constructor(base, stop, logFile) {
    this.base = base;
    this.stop = stop;
    this.logFile = logFile;
  }

  async api(route, init = {}) {
    const response = await fetch(`${this.base}${route}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${route}: ${response.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  /** The shop's project, created with its live view on. */
  async createProject() {
    const project = await this.api('/api/projects', {
      method: 'POST',
      body: { name: PROJECT_NAME, label: 'Acme Shop', description: 'The Acme Shop storefront and its checkout.' },
    });
    const id = project.id ?? project.project?.id;
    await this.api(`/api/projects/${id}`, { method: 'PATCH', body: { liveView: true } });
    this.projectId = id;
    return id;
  }

  /** The project's runs, the latest first. */
  async runs() {
    const { items } = await this.api('/api/test-runs/recent?limit=50');
    return items.filter((run) => run.projectId === this.projectId);
  }

  async run(id) {
    return this.api(`/api/test-runs/${id}`);
  }
}

/** Seeds a database under `dir` and boots the dashboard on it; its output goes to `logFile`. */
export async function startInstance(dir, { logFile }) {
  const env = seedThrowawayDb(path.join(dir, 'data'));
  // The dev server's build needs more than Node's default heap.
  const heap = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=4096`.trim() };
  // A signal stops the server and leaves the take to keep its logs, end the set and exit. It listens on the address
  // every part of the take reaches it by: on `localhost`, a machine with IPv6 would serve it on `::1` alone.
  const { base, stop } = await startServer({
    port: INSTANCE_PORT,
    host: '127.0.0.1',
    env: { ...env, ...heap },
    logFile,
    exitOnSignal: false,
  });
  return new Instance(base, stop, logFile);
}

/**
 * A "CI" run: `origin` cloned into `dir` at `commit` on `main`, the whole suite run headless and reported to the
 * instance. Resolves with the run's exit code once Playwright ends; its output goes to `log`, and its JSON report
 * (`ci-report.json` of the checkout) beside it, as `<log>.json`.
 */
export function startCiRun({ origin, dir, commit, instance, log, extraEnv = {} }) {
  fs.rmSync(dir, { recursive: true, force: true });
  checkout(origin, dir);
  at(dir, commit);
  const child = spawn('npx', ['playwright', 'test'], {
    cwd: dir,
    env: {
      ...process.env,
      CI: 'true',
      PIWI_ORIGIN: 'ci',
      PIWI_DASHBOARD_URL: instance.base,
      PIWI_PROJECT_NAME: PROJECT_NAME,
      SAMPLE_BACKEND: 'nitro',
      ...extraEnv,
    },
    stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')],
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      const report = path.join(dir, 'ci-report.json');
      if (fs.existsSync(report)) fs.copyFileSync(report, log.replace(/\.log$/, '.json'));
      resolve(code);
    });
  });
}
