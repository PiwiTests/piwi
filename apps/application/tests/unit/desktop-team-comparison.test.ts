/**
 * Compare with team instance, on the desktop app's server: a failing local execution is named to the team instance
 * the app is connected to (its identity, Playwright project, environment, commit, branch and fingerprint) through the
 * run target's key; the answer is checked, kept two minutes, and compared on this machine (the conclusion and the
 * environment diff against the closest CI pass). An answer the app cannot read, or a project with no folder, says so.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ folder: null as string | null }));
vi.mock('../../server/utils/desktop-links', () => ({ desktopLinkedFolder: () => state.folder }));

const { resetDesktopRunTarget, runTargetConnection, useKeptKey } = await import('@piwitests/editor/run-target');
const { compareExecutionWithTeam, compareTestCaseWithTeam, forgetTeamComparisons } =
  await import('../../server/utils/desktop-team-comparison');
const { FINGERPRINT_VERSION } = await import('#shared/error-fingerprint');

const KEY = `pd_${'a'.repeat(64)}`;
const COMMIT = 'c0ffee0000000000000000000000000000000001';
const FINGERPRINT = 'f'.repeat(64);
const T0 = Date.parse('2026-11-20T08:00:00Z');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let projectId: number;
let testCaseId: number;
let executionId: number;
let folder: string;
/** What the fake team instance answers a comparison with. */
let answer: unknown;
const asked: URLSearchParams[] = [];
let server: http.Server;
let instanceUrl: string;

const comparison = () => ({
  testCase: {
    id: 12,
    title: 'pays with a saved card',
    filePath: 'tests/checkout.spec.ts',
    suitePath: '',
    quarantined: false,
    flakyRootCause: null,
    path: '/test-cases/12',
  },
  defaultBranch: 'main',
  playwrightProjectMatched: true,
  history: [
    {
      executionId: 40,
      runId: 4,
      source: 'ci',
      status: 'passed',
      flaky: false,
      incident: false,
      startTime: T0,
      environment: 'mco',
      branch: 'main',
      commit: COMMIT,
      playwrightProject: 'chromium',
      path: '/test-run-cases/40',
    },
  ],
  fingerprintComparable: true,
  cluster: null,
  closestPass: {
    executionId: 40,
    runId: 4,
    startTime: T0,
    environment: 'mco',
    branch: 'main',
    commit: COMMIT,
    worktree: 'clean',
    sameCommit: true,
    snapshot: { values: { playwrightVersion: '1.60.0', environment: 'mco' }, inferred: [] },
    path: '/test-run-cases/40',
  },
});

const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  const [project] = await db.insert(schema.projects).values({ name: 'shop' }).returning();
  projectId = project!.id;
  const [testCase] = await db
    .insert(schema.testCases)
    .values({ projectId, filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card' })
    .returning();
  testCaseId = testCase!.id;
  const [run] = await db
    .insert(schema.testRuns)
    .values({
      projectId,
      status: 'failed',
      origin: 'desktop',
      startTime: new Date(T0),
      environment: 'mco',
      branch: 'main',
      commit: COMMIT,
      playwrightVersion: '1.58.0',
      metadata: { scm: { worktree: 'clean' } },
    })
    .returning();
  const [cluster] = await db
    .insert(schema.failureClusters)
    .values({
      projectId,
      fingerprint: FINGERPRINT,
      signature: 'Timeout',
      firstSeenRunId: run!.id,
      lastSeenRunId: run!.id,
    })
    .returning();
  const [execution] = await db
    .insert(schema.testRunsCases)
    .values({
      testRunId: run!.id,
      testCaseId,
      status: 'failed',
      browserName: 'chromium',
      failureClusterId: cluster!.id,
    })
    .returning();
  executionId = execution!.id;

  folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-team-comparison-')));
  state.folder = folder;
  answer = comparison();
  asked.length = 0;
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://instance');
    if (url.pathname === '/api/run-targets/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'snapshot', requests: [], stops: [] })}\n\n`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/api/run-targets/projects/7/test-comparison') {
      asked.push(url.searchParams);
      res.end(JSON.stringify(answer));
    } else if (url.pathname === '/api/run-targets/self') res.end(JSON.stringify({ compares: true }));
    else res.end(JSON.stringify({ requests: [], stops: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  instanceUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  void useKeptKey(instanceUrl, KEY, new Map([[7, folder]]));
  await until(() => runTargetConnection().compares === true);
});

afterEach(async () => {
  resetDesktopRunTarget();
  forgetTeamComparisons();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(folder, { recursive: true, force: true });
});

describe('a failing local execution', () => {
  test('is named to the team project of its folder, and compared on this machine', async () => {
    const result = await compareExecutionWithTeam(db as never, projectId, executionId, T0);
    expect(result).toMatchObject({
      status: 'ok',
      instance: instanceUrl,
      teamProjectId: 7,
      conclusion: { rule: 'passes-on-commit', environment: 'mco' },
    });
    if (result?.status !== 'ok') throw new Error('no comparison');
    expect(result.rows.map((row) => [row.environment, row.isLocalEnvironment])).toEqual([['mco', true]]);
    expect(result.environmentDiff?.map((entry) => [entry.key, entry.failing, entry.baseline])).toContainEqual([
      'playwrightVersion',
      '1.58.0',
      '1.60.0',
    ]);
    expect(Object.fromEntries(asked[0]!)).toEqual({
      filePath: 'tests/checkout.spec.ts',
      title: 'pays with a saved card',
      playwrightProject: 'chromium',
      environment: 'mco',
      branch: 'main',
      commit: COMMIT,
      fingerprint: FINGERPRINT,
      fingerprintVersion: String(FINGERPRINT_VERSION),
    });
  });

  test('keeps the answer two minutes', async () => {
    await compareExecutionWithTeam(db as never, projectId, executionId, T0);
    await compareExecutionWithTeam(db as never, projectId, executionId, T0 + 60_000);
    expect(asked).toHaveLength(1);
    await compareExecutionWithTeam(db as never, projectId, executionId, T0 + 3 * 60_000);
    expect(asked).toHaveLength(2);
  });

  test('says when the answer cannot be read, or the project has no folder here', async () => {
    answer = { ...comparison(), testCase: { id: 12, path: 'https://elsewhere.example/test-cases/12' } };
    expect(await compareExecutionWithTeam(db as never, projectId, executionId, T0)).toMatchObject({
      status: 'unavailable',
      problem: 'unreadable',
    });
    state.folder = null;
    expect(await compareExecutionWithTeam(db as never, projectId, executionId, T0)).toMatchObject({
      status: 'unavailable',
      problem: 'no-folder',
    });
  });

  test('a test is named by its identity alone, with no conclusion', async () => {
    const result = await compareTestCaseWithTeam(db as never, projectId, testCaseId, T0);
    expect(result).toMatchObject({ status: 'ok', conclusion: null, environmentDiff: null });
    expect(Object.fromEntries(asked[0]!)).toEqual({
      filePath: 'tests/checkout.spec.ts',
      title: 'pays with a saved card',
    });
    expect(await compareExecutionWithTeam(db as never, projectId, 999_999, T0)).toBeNull();
  });
});
