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
 * The known bugs that keep the healing's candidate from a failure on a click: what the instance's store says of the
 * clicked element's capture in the test's passing runs.
 */
export const HEALING_BUGS = {
  navigatingClick: 'the reporter keeps no element of a click that navigates the page at once',
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
   * Why the healing of the click at `place` (`file:line`) of the test `testCaseId` has no candidate, when the known
   * bug explains it, read in its exact state: the passing CI run's report (`snapshots`, the reporter's
   * `piwi-locators` of that test, `ciSnapshots`) holds that call's snapshot without its element, and the instance
   * keeps no row of it. Null when that state is not there: a missing report, no snapshot of the test, or an element
   * captured at that place are failures of the check, not this bug.
   */
  async whyNoHealing(testCaseId, place, { snapshots }) {
    if (!Array.isArray(snapshots) || snapshots.length === 0) return null;
    const [file, line] = place.split(':');
    const atPlace = (location) => new RegExp(`(^|/)${escapeRegExp(`${file}:${line}`)}:\\d+$`).test(location ?? '');
    const call = snapshots.find((snap) => atPlace(snap.location));
    if (!call || call.element !== null) return null;
    const rows = await this.query('select location from locator_snapshots where test_case_id = ?', [testCaseId]);
    if (rows.some((row) => atPlace(row.location))) return null;
    return { bug: HEALING_BUGS.navigatingClick, detail: `the passing run kept no element of ${call.location}` };
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

/** `text` as a regular expression's literal. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The locator snapshots the reporter attached to the first result of the test `title` (`piwi-locators`), from a "CI"
 * run's JSON report; null when the report, the test or the attachment is missing.
 */
export function ciSnapshots(reportFile, title) {
  if (!fs.existsSync(reportFile)) return null;
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const specs = [];
  const walk = (suite) => {
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  const result = specs.find((spec) => spec.title === title)?.tests?.[0]?.results?.[0];
  const attachment = result?.attachments?.find((a) => a.name === 'piwi-locators' && a.body);
  return attachment ? JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf8')) : null;
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
  return new Instance(base, stop, logFile, env.PIWI_DATABASE_PATH);
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
