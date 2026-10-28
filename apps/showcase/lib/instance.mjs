// The team's instance: the dashboard's dev server on a database of its own, seeded with the demo's history, the shop's
// project with its live view on, and the "CI" runs, each a real headless run of a fresh clone of `origin`, told as CI
// (`CI=true`, which the reporter's `detectCi` reads, and `PIWI_ORIGIN=ci`, the run's origin).
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { seedThrowawayDb, startServer } from '../../application/scripts/lib/dev-server.mjs';
import { PROJECT_NAME, at, checkout } from './workspace.mjs';

/** The instance's port: off the dev server's (7494), the throwaway servers' (3050, 3060) and the desktop app's. */
export const INSTANCE_PORT = 3077;

const appRequire = createRequire(new URL('../../application/package.json', import.meta.url));

/**
 * The bugs that keep the healing's candidate from a failure on a click: what the instance's store says of the clicked
 * element's capture in the test's passing runs.
 */
export const HEALING_BUGS = {
  navigatingClick: 'the reporter keeps no element of a click that navigates the page at once',
  esmCallSites: "the reporter's call sites lose their leading slash in an ES module suite",
};

/** The instance, read through its API, and through its database where no route says what a check needs. */
export class Instance {
  constructor(base, stop, logFile, dbPath) {
    this.base = base;
    this.stop = stop;
    this.logFile = logFile;
    this.dbPath = dbPath;
  }

  async query(sql, args = []) {
    const { createClient } = appRequire('@libsql/client');
    const db = createClient({ url: `file:${this.dbPath}` });
    try {
      return (await db.execute({ sql, args })).rows;
    } finally {
      db.close();
    }
  }

  /**
   * Why the healing of the failing click at `place` (`file:line`) of the test `testCaseId` has no candidate, when a
   * known bug explains it: no element captured at that call site in any run, or captured call sites that are absolute
   * paths without their leading slash. Null when neither does.
   */
  async whyNoHealing(testCaseId, place) {
    const rows = await this.query('select location, element_tag from locator_snapshots where test_case_id = ?', [
      testCaseId,
    ]);
    const [file, line] = place.split(':');
    const found = [];
    if (!rows.some((r) => r.location?.includes(`${file}:${line}:`) && r.element_tag)) {
      found.push({ bug: HEALING_BUGS.navigatingClick, detail: `no element was captured at ${place}` });
    }
    const slashless = rows.find((r) => /^(tmp|home|Users|var|private|runner)\//.test(r.location ?? ''));
    if (slashless) found.push({ bug: HEALING_BUGS.esmCallSites, detail: `a call site reads ${slashless.location}` });
    if (!found.length) return null;
    return { bug: found.map((f) => f.bug).join('; '), detail: found.map((f) => f.detail).join('; ') };
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

/** Seeds a database under `dir` and boots the dashboard on it; its output goes to `dir/dashboard.log`. */
export async function startInstance(dir) {
  const env = seedThrowawayDb(path.join(dir, 'data'));
  const logFile = path.join(dir, 'dashboard.log');
  // The dev server's build needs more than Node's default heap.
  const heap = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=4096`.trim() };
  const { base, stop } = await startServer({ port: INSTANCE_PORT, env: { ...env, ...heap }, logFile });
  return new Instance(base.replace('localhost', '127.0.0.1'), stop, logFile, env.PIWI_DATABASE_PATH);
}

/**
 * A "CI" run: `origin` cloned into `dir` at `commit` on `main`, the whole suite run headless and reported to the
 * instance. Resolves with the run's exit code once Playwright ends; its output goes to `log`.
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
    child.once('exit', (code) => resolve(code));
  });
}
