/**
 * The detectors that read inputs Piwi already stores: passed with errors (the
 * console, backend logs and responses of passing executions), assertion-light
 * (the matchers the locator index records per page), catalog method no test
 * calls (the function catalog against the locator index) and surface drift (the
 * gaps the ledger already holds on new surface).
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { eq } from 'drizzle-orm';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const gaps = await import('../../shared/handlers/scenario-gaps');
const { pruneStaleCanonicalNodes } = await import('../../server/utils/graph-ingest');

describe('assertionLightPages', () => {
  const pages = new Set(['/users', '/reports', '/login']);

  test('a page whose every check is on presence is light; a value check or a read clears it', () => {
    const out = gaps.assertionLightPages(
      [
        { testCaseId: 1, action: 'expect.toBeVisible', page: '/users' },
        { testCaseId: 2, action: 'expect.not.toBeHidden', page: '/users' },
        { testCaseId: 1, action: 'click', page: '/users' },
        { testCaseId: 3, action: 'expect.toBeVisible', page: '/reports' },
        { testCaseId: 4, action: 'expect.toHaveText', page: '/reports' },
        { testCaseId: 5, action: 'expect.toBeAttached', page: '/login' },
        { testCaseId: 5, action: 'count', page: '/login' },
        // A visible text holding a number names a value: the total is checked.
        { testCaseId: 6, action: 'expect.toBeVisible', page: '/orders', target: "getByText('Total: $42.00')" },
        { testCaseId: 7, action: 'expect.toBeVisible', page: '/orders', target: "getByText('Order placed')" },
      ],
      new Set([...pages, '/orders']),
    );
    expect(out).toEqual([
      { pageKey: '/users', testCount: 2, dataAssertions: 0 },
      { pageKey: '/reports', testCount: 2, dataAssertions: 1 },
      { pageKey: '/login', testCount: 1, dataAssertions: 1 },
      { pageKey: '/orders', testCount: 2, dataAssertions: 1 },
    ]);
    expect(gaps.detectAssertionLight(out).map((g) => g.key)).toEqual(['page:/users']);
  });

  test('a page no test asserts on, an unknown page and a page the graph lacks are left out', () => {
    const out = gaps.assertionLightPages(
      [
        { testCaseId: 1, action: 'fill', page: '/login' },
        { testCaseId: 1, action: 'waitFor', page: '/login' },
        { testCaseId: 1, action: 'expect.toBeVisible', page: '' },
        { testCaseId: 1, action: 'expect.toBeVisible', page: '/elsewhere' },
      ],
      pages,
    );
    expect(out).toEqual([]);
  });
});

describe('resolveCatalogMethodReach', () => {
  const entry = (over: Partial<gaps.CatalogEntryReachInput>): gaps.CatalogEntryReachInput => ({
    module: './pages/UsersPage',
    name: 'm',
    kind: 'page-object-method',
    receiver: 'usersPage',
    urlPattern: '**/users',
    steps: [],
    paramSources: [],
    ...over,
  });
  const pages = [
    { key: '/users', url: 'https://app.test/users', tests: new Set([1, 2, 3]) },
    { key: '/settings', url: 'https://app.test/settings', tests: new Set([4]) },
  ];

  test('a test calls a method when it runs one of its fixed steps on a page the pattern matches', () => {
    const out = gaps.resolveCatalogMethodReach(
      [
        entry({
          name: 'inviteUser',
          steps: [
            { action: 'click', target: { role: 'button', name: 'Invite user' } },
            { action: 'fill', target: { role: 'textbox', name: 'Email' } },
          ],
          paramSources: [{ param: 'email', stepIndex: 1, from: 'value' }],
        }),
        entry({ name: 'goToNextPage', steps: [{ action: 'click', target: { role: 'button', name: 'Next page' } }] }),
        entry({ name: 'confirm', steps: [{ action: 'press', target: { testId: 'confirm' } }] }),
        entry({
          name: 'save',
          steps: [{ action: 'click', target: { role: 'button', name: 'Save' } }],
        }),
      ],
      [
        { testCaseId: 1, target: "getByRole('button', { name: 'Invite user' })", action: 'click', page: '/users' },
        { testCaseId: 2, target: "getByTestId('confirm')", action: 'click', page: '' },
        // A Save on another page is not this method's Save.
        { testCaseId: 4, target: "getByRole('button', { name: 'Save' })", action: 'click', page: '/settings' },
      ],
      pages,
    );
    expect(out.map((m) => [m.label, m.callCount, m.pageReachedBy])).toEqual([
      ['usersPage.inviteUser', 1, 3],
      ['usersPage.goToNextPage', 0, 3],
      ['usersPage.confirm', 1, 3],
      ['usersPage.save', 0, 3],
    ]);
    expect(gaps.detectCatalogMethodNoTestCalls(out).map((g) => g.title)).toEqual([
      'usersPage.goToNextPage is never called',
      'usersPage.save is never called',
    ]);
  });

  test('a method whose targets all come from parameters gets no decision, and a fixture none either', () => {
    const out = gaps.resolveCatalogMethodReach(
      [
        entry({
          name: 'openSection',
          receiver: null,
          kind: 'helper',
          steps: [{ action: 'click', target: { role: 'link', name: 'Appearance' } }],
          paramSources: [{ param: 'section', stepIndex: 0, from: 'text' }],
        }),
        entry({
          name: 'signedIn',
          kind: 'fixture',
          steps: [{ action: 'click', target: { role: 'button', name: 'Go' } }],
        }),
        entry({ name: 'open', steps: [{ action: 'goto', target: {} }] }),
      ],
      [],
      pages,
    );
    expect(out).toEqual([]);
  });

  test('a pattern naming the origin matches a use on that page as it matches the page', () => {
    const out = gaps.resolveCatalogMethodReach(
      [
        entry({
          urlPattern: 'https://app.test/users',
          steps: [{ action: 'click', target: { role: 'button', name: 'Next' } }],
        }),
      ],
      [{ testCaseId: 1, target: "getByRole('button', { name: 'Next' })", action: 'click', page: '/users' }],
      pages,
    );
    expect(out[0]).toMatchObject({ callCount: 1, pageReachedBy: 3 });
  });

  test('stays quick on a large suite', () => {
    const entries = Array.from({ length: 200 }, (_, i) =>
      entry({ name: `m${i}`, steps: [{ action: 'click', target: { role: 'button', name: `Action ${i}` } }] }),
    );
    const uses = Array.from({ length: 50_000 }, (_, i) => ({
      testCaseId: i % 2000,
      target: `getByRole('${i % 3 === 0 ? 'link' : 'button'}', { name: 'Control ${i % 5000}' })`,
      action: i % 2 ? 'click' : 'expect.toBeVisible',
      page: '/users',
    }));
    const started = performance.now();
    gaps.resolveCatalogMethodReach(entries, uses, pages);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test('a method on a page no test reaches is not raised', () => {
    const out = gaps.resolveCatalogMethodReach(
      [entry({ urlPattern: '**/billing', steps: [{ action: 'click', target: { role: 'button', name: 'Pay' } }] })],
      [],
      pages,
    );
    expect(out[0]).toMatchObject({ callCount: 0, pageReachedBy: 0 });
    expect(gaps.detectCatalogMethodNoTestCalls(out)).toEqual([]);
  });
});

describe('passedWithErrorsDetail', () => {
  test('names the 5xx responses, the backend errors and the console errors, in that order', () => {
    expect(
      gaps.passedWithErrorsDetail({
        runId: 7,
        serverErrors: [
          { route: 'POST /api/audit', status: 500 },
          { route: 'POST /api/audit', status: 502 },
          { route: 'GET /api/a', status: 503 },
          { route: 'GET /api/b', status: 500 },
        ],
        backendErrors: ['POST /api/audit', 'GET /api/c'],
        consoleErrors: 2,
      }),
    ).toBe(
      'run #7 · POST /api/audit returned 500 · GET /api/a returned 503 · 1 more 5xx · the backend logged an error on POST /api/audit and 1 more · the page logged 2 console errors',
    );
  });

  test('is null when the execution reported nothing', () => {
    expect(gaps.passedWithErrorsDetail({ runId: 1, serverErrors: [], backendErrors: [], consoleErrors: 0 })).toBeNull();
  });
});

// ── DB-backed ────────────────────────────────────────────────────────────────

let db: ReturnType<typeof drizzle<typeof schema>>;
beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'p', defaultBranch: 'main' });
});

const ORIGIN = 'https://app.test';
const metadata = { htmlReport: { projects: [{ use: { baseURL: ORIGIN } }] } };

/** One execution with its console lines and its requests. */
async function execution(opts: {
  id: number;
  runId: number;
  testCaseId: number;
  status?: string;
  console?: Array<{ type: string; text: string; location: string | null }>;
  requests?: Array<{
    method: string;
    path: string;
    status: number;
    logs?: Array<{ level: string; message: string }>;
    fulfilled?: boolean;
    resourceType?: string;
  }>;
}) {
  await db.insert(schema.testRunsCases).values({
    id: opts.id,
    testRunId: opts.runId,
    testCaseId: opts.testCaseId,
    status: opts.status ?? 'passed',
    consoleLogs: (opts.console ?? []).map((c) => ({ ...c, timestamp: 0 })) as never,
  });
  for (const r of opts.requests ?? []) {
    await db.insert(schema.networkRequests).values({
      testRunsCaseId: opts.id,
      testRunId: opts.runId,
      method: r.method,
      url: `${ORIGIN}${r.path}`,
      normalizedUrl: r.path,
      status: r.status,
      serverLogs: r.logs ? (r.logs.map((l) => ({ ...l, timestamp: 0, category: 'app' })) as never) : null,
      fulfilled: r.fulfilled ?? null,
      resourceType: r.resourceType ?? null,
    });
  }
}

describe('computeScenarioGaps — success only', () => {
  test("a page load's status never counts toward a route's error paths", async () => {
    await db.insert(schema.testRuns).values({
      id: 1,
      projectId: 1,
      status: 'passed',
      startTime: new Date(),
      branch: 'main',
      metadata: metadata as never,
    });
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'lists users' });
    await db
      .insert(schema.graphNodes)
      .values({ projectId: 1, kind: 'route', key: 'GET /users', firstSeenRunId: 1, lastSeenRunId: 1 });
    await execution({
      id: 1,
      runId: 1,
      testCaseId: 1,
      requests: [
        ...Array.from({ length: 5 }, () => ({ method: 'GET', path: '/users', status: 200, resourceType: 'xhr' })),
        { method: 'GET', path: '/users', status: 500, resourceType: 'document' },
      ],
    });

    await gaps.computeScenarioGaps(db, 1);
    const raised = await gaps.listScenarioGaps(db, 1, { detector: 'success-only' });
    expect(raised.map((g) => g.subject)).toEqual([{ kind: 'route', key: 'GET /users' }]);
  });

  test("a form's POST is a call: always answered with a redirect, it has no error path under test", async () => {
    await db.insert(schema.testRuns).values({
      id: 1,
      projectId: 1,
      status: 'passed',
      startTime: new Date(),
      branch: 'main',
      metadata: metadata as never,
    });
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'contacts us' });
    await db
      .insert(schema.graphNodes)
      .values({ projectId: 1, kind: 'route', key: 'POST /contact', firstSeenRunId: 1, lastSeenRunId: 1 });
    await execution({
      id: 1,
      runId: 1,
      testCaseId: 1,
      requests: [
        ...Array.from({ length: 5 }, () => ({
          method: 'POST',
          path: '/contact',
          status: 303,
          resourceType: 'document',
        })),
      ],
    });

    await gaps.computeScenarioGaps(db, 1);
    const raised = await gaps.listScenarioGaps(db, 1, { detector: 'success-only' });
    expect(raised.map((g) => g.subject)).toEqual([{ kind: 'route', key: 'POST /contact' }]);
  });
});

describe('computeScenarioGaps — the evidence window', () => {
  const node = (key: string, firstSeenRunId: number, lastSeenRunId = firstSeenRunId) => ({
    projectId: 1,
    kind: 'route',
    key,
    firstSeenRunId,
    lastSeenRunId,
  });
  const reach = (testCaseId: number, key: string) => ({
    projectId: 1,
    fromKind: 'test',
    fromKey: String(testCaseId),
    toKind: 'route',
    toKey: key,
    kind: 'reaches',
    lastSeenAt: new Date(),
  });

  test('a pull-request run neither erases new surface nor closes an error path with its 500', async () => {
    await db.insert(schema.testRuns).values([
      { id: 1, projectId: 1, status: 'passed', startTime: new Date(), branch: 'main', metadata: metadata as never },
      { id: 2, projectId: 1, status: 'passed', startTime: new Date(), branch: 'main', metadata: metadata as never },
      {
        id: 3,
        projectId: 1,
        status: 'failed',
        startTime: new Date(),
        branch: 'feature/x',
        metadata: metadata as never,
      },
    ]);
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'orders' });
    await db.insert(schema.graphNodes).values([node('GET /api/orders', 1, 2), node('GET /api/billing', 2)]);
    await db.insert(schema.graphEdges).values(reach(1, 'GET /api/orders'));
    await execution({
      id: 1,
      runId: 2,
      testCaseId: 1,
      requests: Array.from({ length: 5 }, () => ({ method: 'GET', path: '/api/orders', status: 200 })),
    });
    await execution({
      id: 2,
      runId: 3,
      testCaseId: 1,
      status: 'failed',
      requests: [{ method: 'GET', path: '/api/orders', status: 500 }],
    });

    await gaps.computeScenarioGaps(db, 1);
    expect((await gaps.listScenarioGaps(db, 1, { detector: 'surface-drift' })).map((g) => g.subject.key)).toEqual([
      'GET /api/billing',
    ]);
    expect((await gaps.listScenarioGaps(db, 1, { detector: 'success-only' })).map((g) => g.subject.key)).toEqual([
      'GET /api/orders',
    ]);
  });

  test('only a complete run that misses a node says it vanished', async () => {
    await db.insert(schema.testRuns).values([
      { id: 1, projectId: 1, status: 'passed', startTime: new Date(), branch: 'main', metadata: metadata as never },
      ...Array.from({ length: 30 }, (_, i) => ({
        id: i + 2,
        projectId: 1,
        status: 'passed',
        startTime: new Date(),
        branch: 'main',
        isFullRun: 0,
        metadata: metadata as never,
      })),
    ]);
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'billing' },
      { id: 2, projectId: 1, filePath: 'a.spec.ts', title: 'orders' },
    ]);
    await db.insert(schema.graphNodes).values([node('GET /api/billing', 1), node('GET /api/orders', 1, 31)]);
    await db.insert(schema.graphEdges).values([reach(1, 'GET /api/billing'), reach(2, 'GET /api/orders')]);

    await gaps.computeScenarioGaps(db, 1);
    expect(await gaps.listScenarioGaps(db, 1, { detector: 'orphan-test' })).toEqual([]);
  });

  test('a test whose nodes no complete run reached is an orphan, partial runs between them or not', async () => {
    const run = (id: number, isFullRun: number) => ({
      id,
      projectId: 1,
      status: 'passed',
      startTime: new Date(),
      branch: 'main',
      isFullRun,
      metadata: metadata as never,
    });
    // Run 1 saw the node; 30 complete runs since, with a partial run after each, never did.
    await db
      .insert(schema.testRuns)
      .values([run(1, 1), ...Array.from({ length: 30 }, (_, i) => [run(2 * i + 2, 1), run(2 * i + 3, 0)]).flat()]);
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'billing' });
    await db.insert(schema.graphNodes).values(node('GET /api/billing', 1));
    await db.insert(schema.graphEdges).values(reach(1, 'GET /api/billing'));

    await gaps.computeScenarioGaps(db, 1);
    expect((await gaps.listScenarioGaps(db, 1, { detector: 'orphan-test' })).map((g) => g.key)).toEqual(['test:1']);
  });

  test('partial runs never age a node toward retirement', async () => {
    await db.insert(schema.testRuns).values(
      Array.from({ length: 40 }, (_, i) => ({
        id: i + 2,
        projectId: 1,
        status: 'passed',
        startTime: new Date(),
        branch: 'main',
        isFullRun: 0,
        metadata: metadata as never,
      })),
    );
    await db.insert(schema.graphNodes).values(node('GET /api/billing', 1));
    const { pruneStaleCanonicalNodes } = await import('../../server/utils/graph-ingest');
    expect(await pruneStaleCanonicalNodes(db as never)).toBe(0);
  });
});

describe('computeScenarioGaps — which tests are trusted', () => {
  /** One run on the default branch, and the attempts of test 1 in it. */
  async function run(id: number, attempts: Array<{ status: string; retries?: number }>, origin?: string) {
    await db
      .insert(schema.testCases)
      .values({ id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'checkout' })
      .onConflictDoNothing();
    await db.insert(schema.testRuns).values({
      id,
      projectId: 1,
      status: 'passed',
      startTime: new Date(),
      branch: 'main',
      metadata: { ...metadata, ...(origin ? { piwiOrigin: { kind: origin } } : {}) } as never,
      origin: origin ?? 'ci',
    });
    for (const [k, a] of attempts.entries()) {
      await db.insert(schema.testRunsCases).values({
        id: id * 10 + k,
        testRunId: id,
        testCaseId: 1,
        status: a.status,
        retries: a.retries ?? 0,
      });
    }
  }

  async function onlyTestGap() {
    await db
      .insert(schema.graphNodes)
      .values({ projectId: 1, kind: 'route', key: 'POST /api/orders', firstSeenRunId: 1, lastSeenRunId: 1 });
    await db.insert(schema.graphEdges).values({
      projectId: 1,
      fromKind: 'test',
      fromKey: '1',
      toKind: 'route',
      toKey: 'POST /api/orders',
      kind: 'reaches',
      lastSeenAt: new Date(),
    });
    await gaps.computeScenarioGaps(db, 1);
    const [gap] = await gaps.listScenarioGaps(db, 1, { detector: 'single-covering-test' });
    return gap!;
  }

  test('a flaky classification from long ago does not make a test untrusted today', async () => {
    await run(1, [{ status: 'passed' }]);
    await run(2, [{ status: 'passed' }]);
    const gap = await onlyTestGap();
    await db.update(schema.testCases).set({ flakyRootCause: 'timing' as never });
    await gaps.computeScenarioGaps(db, 1);
    const [after] = await gaps.listScenarioGaps(db, 1, { detector: 'single-covering-test' });
    expect(gap.title).toBe('Only one test reaches route POST /api/orders');
    expect(after!.title).toBe('Only one test reaches route POST /api/orders');
  });

  test('a test that passed only after a retry lately is flaky', async () => {
    await run(1, [{ status: 'failed' }, { status: 'passed', retries: 1 }]);
    await run(2, [{ status: 'passed' }]);
    expect((await onlyTestGap()).evidence.join(' ')).toContain('(flaky)');
  });

  test('a test whose outcome flips between failed and passed across runs is flaky, with no retry', async () => {
    for (const [id, status] of [
      [1, 'passed'],
      [2, 'failed'],
      [3, 'passed'],
      [4, 'failed'],
      [5, 'passed'],
    ] as const)
      await run(id, [{ status }]);
    expect((await onlyTestGap()).evidence.join(' ')).toContain('(flaky)');
  });

  test('one failure fixed in the next run is not flaky', async () => {
    for (const [id, status] of [
      [1, 'passed'],
      [2, 'failed'],
      [3, 'passed'],
    ] as const)
      await run(id, [{ status }]);
    expect((await onlyTestGap()).title).toBe('Only one test reaches route POST /api/orders');
  });

  test('a test failing its last three runs protects nothing', async () => {
    await run(1, [{ status: 'passed' }]);
    for (const id of [2, 3, 4]) await run(id, [{ status: 'failed' }, { status: 'failed', retries: 1 }]);
    expect((await onlyTestGap()).evidence.join(' ')).toContain('(failing)');
  });

  test("a probe run's statuses say nothing about the test", async () => {
    await run(1, [{ status: 'passed' }]);
    await run(2, [{ status: 'didnotrun' }], 'probe');
    expect((await onlyTestGap()).title).toBe('Only one test reaches route POST /api/orders');
  });
});

describe('computeScenarioGaps — passed with errors', () => {
  test('raises the passing tests the application reported an error under, on the default branch only', async () => {
    await db.insert(schema.testRuns).values([
      { id: 1, projectId: 1, status: 'passed', startTime: new Date(), branch: 'main', metadata: metadata as never },
      {
        id: 2,
        projectId: 1,
        status: 'passed',
        startTime: new Date(),
        branch: 'feature/x',
        metadata: metadata as never,
      },
      { id: 3, projectId: 1, status: 'failed', startTime: new Date(), branch: 'main', metadata: metadata as never },
    ]);
    const titles = ['backend', 'console', 'widget', 'resource', 'routed', 'server', 'branch', 'fails now'];
    await db
      .insert(schema.testCases)
      .values(titles.map((title, i) => ({ id: i + 1, projectId: 1, filePath: 'a.spec.ts', title })));
    await db.insert(schema.graphNodes).values(
      ['PATCH /api/orgs', 'GET /api/report'].map((key) => ({
        projectId: 1,
        kind: 'route',
        key,
        firstSeenRunId: 1,
        lastSeenRunId: 1,
      })),
    );

    const backendError = [
      { method: 'PATCH', path: '/api/orgs', status: 200, logs: [{ level: 'Error', message: 'x' }] },
    ];
    await execution({ id: 1, runId: 1, testCaseId: 1, requests: backendError });
    await execution({
      id: 2,
      runId: 1,
      testCaseId: 2,
      console: [{ type: 'error', text: 'TypeError: boom', location: `${ORIGIN}/assets/app.js:1:200` }],
    });
    await execution({
      id: 3,
      runId: 1,
      testCaseId: 3,
      console: [{ type: 'error', text: 'widget failed', location: 'https://widget.other/loader.js:1:1' }],
    });
    await execution({
      id: 4,
      runId: 1,
      testCaseId: 4,
      console: [{ type: 'error', text: 'Failed to load resource: 403', location: `${ORIGIN}/api/orgs` }],
    });
    const fiveHundred = [{ method: 'GET', path: '/api/report', status: 500 }];
    // The test fulfilled a 503 itself: its 5xx and the console error it causes are its own doing.
    await execution({
      id: 5,
      runId: 1,
      testCaseId: 5,
      requests: [{ method: 'GET', path: '/api/report', status: 503, fulfilled: true }],
      console: [{ type: 'error', text: 'Failed to load the report', location: `${ORIGIN}/assets/app.js:9:1` }],
    });
    await execution({ id: 6, runId: 1, testCaseId: 6, requests: fiveHundred });
    await execution({ id: 7, runId: 2, testCaseId: 7, requests: backendError });
    await execution({ id: 8, runId: 1, testCaseId: 8, requests: backendError });
    await execution({ id: 9, runId: 3, testCaseId: 8, status: 'failed' });

    await gaps.computeScenarioGaps(db, 1);
    const raised = await gaps.listScenarioGaps(db, 1, { detector: 'passed-with-errors' });
    expect(raised.map((g) => g.title).sort()).toEqual([
      'backend passed with errors',
      'console passed with errors',
      'server passed with errors',
    ]);
    expect(raised.find((g) => g.title.startsWith('server'))!.evidence[0]).toContain('GET /api/report returned 500');
    expect(raised.find((g) => g.title.startsWith('backend'))!.evidence[0]).toContain(
      'the backend logged an error on PATCH /api/orgs',
    );
  });

  test('reads the default branch’s own runs, however many pull-request runs came after, and a skip is no failure', async () => {
    await db.insert(schema.testRuns).values({
      id: 1,
      projectId: 1,
      status: 'passed',
      startTime: new Date(),
      branch: 'main',
      metadata: metadata as never,
    });
    await db.insert(schema.testRuns).values(
      Array.from({ length: 31 }, (_, i) => ({
        id: i + 2,
        projectId: 1,
        status: 'passed',
        startTime: new Date(),
        branch: 'feature/busy',
        metadata: metadata as never,
      })),
    );
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'saves' });
    await db
      .insert(schema.graphNodes)
      .values({ projectId: 1, kind: 'route', key: 'PATCH /api/orgs', firstSeenRunId: 1, lastSeenRunId: 1 });
    await execution({
      id: 1,
      runId: 1,
      testCaseId: 1,
      requests: [{ method: 'PATCH', path: '/api/orgs', status: 200, logs: [{ level: 'error', message: 'x' }] }],
    });
    // Skipped on a second browser: not a failure.
    await db
      .insert(schema.testRunsCases)
      .values({ id: 2, testRunId: 1, testCaseId: 1, status: 'skipped', browserName: 'webkit' });

    await gaps.computeScenarioGaps(db, 1);
    const raised = await gaps.listScenarioGaps(db, 1, { detector: 'passed-with-errors' });
    expect(raised.map((g) => g.title)).toEqual(['saves passed with errors']);
  });

  test('without a recorded baseURL, the origins of the graph’s routes tell the page’s own scripts from others', async () => {
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date() });
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'own' },
      { id: 2, projectId: 1, filePath: 'a.spec.ts', title: 'third party' },
    ]);
    await db
      .insert(schema.graphNodes)
      .values({ projectId: 1, kind: 'route', key: 'GET /api/report', firstSeenRunId: 1, lastSeenRunId: 1 });
    const requests = [{ method: 'GET', path: '/api/report', status: 200 }];
    await execution({
      id: 1,
      runId: 1,
      testCaseId: 1,
      requests,
      console: [{ type: 'error', text: 'boom', location: `${ORIGIN}/assets/app.js:4:2` }],
    });
    await execution({
      id: 2,
      runId: 1,
      testCaseId: 2,
      requests,
      console: [{ type: 'error', text: 'widget', location: 'https://widget.other/w.js:1:1' }],
    });

    await gaps.computeScenarioGaps(db, 1);
    const raised = await gaps.listScenarioGaps(db, 1, { detector: 'passed-with-errors' });
    expect(raised.map((g) => g.title)).toEqual(['own passed with errors']);
  });
});

describe('computeScenarioGaps — assertion-light and the function catalog', () => {
  test('raise a page tests check only for presence and a catalog method no test calls, and close them once covered', async () => {
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date() });
    await db
      .insert(schema.testCases)
      .values({ id: 1, projectId: 1, filePath: 'users.spec.ts', title: 'lists users', feature: 'Users' });
    await db.insert(schema.graphNodes).values({
      projectId: 1,
      kind: 'page',
      key: '/users',
      attrs: { url: `${ORIGIN}/users` },
      firstSeenRunId: 1,
      lastSeenRunId: 1,
    });
    await db.insert(schema.graphEdges).values({
      projectId: 1,
      fromKind: 'test',
      fromKey: '1',
      toKind: 'page',
      toKey: '/users',
      kind: 'reaches',
      lastSeenAt: new Date(),
    });
    const use = (action: string, target = "getByRole('table')") => ({
      projectId: 1,
      testCaseId: 1,
      locator: target,
      target,
      action,
      browserName: 'chromium',
      callSite: `users.spec.ts:${action.length}:5`,
      page: '/users',
      lastSeenAt: new Date(),
    });
    await db.insert(schema.locatorUsages).values(use('expect.toBeVisible'));
    const steps = (name: string) => JSON.stringify([{ action: 'click', target: { role: 'button', name } }]);
    await db.insert(schema.testFunctions).values(
      ['Invite user', 'Next page'].map((name) => ({
        projectId: 1,
        name: name === 'Invite user' ? 'inviteUser' : 'goToNextPage',
        kind: 'page-object-method',
        module: './pages/UsersPage',
        receiver: 'usersPage',
        params: '[]',
        urlPattern: '**/users',
        steps: steps(name),
        paramSources: '[]',
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );

    await gaps.computeScenarioGaps(db, 1);
    expect((await gaps.listScenarioGaps(db, 1, { detector: 'assertion-light' })).map((g) => g.title)).toEqual([
      '/users is asserted only by visibility',
    ]);
    expect(
      (await gaps.listScenarioGaps(db, 1, { detector: 'catalog-method-no-test-calls' })).map((g) => g.title).sort(),
    ).toEqual(['usersPage.goToNextPage is never called', 'usersPage.inviteUser is never called']);

    // A gap on a catalog method sits under the feature owning its page, one on a test under the test's feature.
    await db
      .insert(schema.graphNodes)
      .values({ projectId: 1, kind: 'route', key: 'GET /api/users', firstSeenRunId: 1, lastSeenRunId: 1 });
    await execution({
      id: 1,
      runId: 1,
      testCaseId: 1,
      requests: [{ method: 'GET', path: '/api/users', status: 200, logs: [{ level: 'error', message: 'x' }] }],
    });
    await gaps.computeScenarioGaps(db, 1);
    const listed = await gaps.listScenarioGaps(db, 1, {});
    expect(
      listed
        .filter((g) => g.detector === 'catalog-method-no-test-calls' || g.detector === 'passed-with-errors')
        .map((g) => [g.detector, g.feature]),
    ).toEqual(
      expect.arrayContaining([
        ['catalog-method-no-test-calls', 'Users'],
        ['catalog-method-no-test-calls', 'Users'],
        ['passed-with-errors', 'Users'],
      ]),
    );
    const { getFeatureMap } = await import('../../server/utils/feature-graph');
    const map = await getFeatureMap(db as never, 1);
    expect(map.ungrouped.gaps).toEqual({});

    await db
      .insert(schema.locatorUsages)
      .values([use('expect.toHaveCount'), use('click', "getByRole('button', { name: 'Invite user' })")]);
    await gaps.computeScenarioGaps(db, 1);
    expect(await gaps.listScenarioGaps(db, 1, { detector: 'assertion-light' })).toEqual([]);
    expect(
      (await gaps.listScenarioGaps(db, 1, { detector: 'catalog-method-no-test-calls' })).map((g) => g.title),
    ).toEqual(['usersPage.goToNextPage is never called']);
  });
});

describe('undeclareOpenApiRoutes', () => {
  test('a route the new OpenAPI document no longer declares stops being declared, and its gap closes', async () => {
    const { ingestProjectManifest } = await import('../../server/utils/surface-manifest');
    const { undeclareOpenApiRoutes } = await import('../../server/utils/openapi-surface');
    await db.insert(schema.testRuns).values({
      id: 1,
      projectId: 1,
      status: 'passed',
      startTime: new Date(),
      branch: 'main',
      metadata: metadata as never,
    });
    const openGaps = async () =>
      (await db.select().from(schema.scenarioGaps))
        .filter((g) => g.detector === 'declared-never-hit' && g.status === 'open')
        .map((g) => g.key)
        .sort();

    await ingestProjectManifest(db as never, 1, { routes: [{ method: 'GET', pattern: '/orders/{id}' }] }, 'openapi');
    await gaps.computeScenarioGaps(db as never, 1);
    expect(await openGaps()).toEqual(['route:GET /orders/:id']);

    const moved = { routes: [{ method: 'GET', pattern: '/api/v1/orders/{id}' }] };
    await ingestProjectManifest(db as never, 1, moved, 'openapi');
    expect(await undeclareOpenApiRoutes(db as never, 1, moved)).toBe(1);
    await gaps.computeScenarioGaps(db as never, 1);
    expect(await openGaps()).toEqual(['route:GET /api/v1/orders/:id']);

    const [old] = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.key, 'GET /orders/:id'));
    expect(old?.origin).toBe('observed');
    expect((old?.attrs as { declared?: boolean } | null)?.declared).toBeUndefined();

    expect(await undeclareOpenApiRoutes(db as never, 1, null)).toBe(1);
    await gaps.computeScenarioGaps(db as never, 1);
    expect(await openGaps()).toEqual([]);
  });
});

describe('computeScenarioGaps — surface drift', () => {
  const run = (id: number) =>
    db.insert(schema.testRuns).values({ id, projectId: 1, status: 'passed', startTime: new Date(id) });
  const edge = (kind: string, fromKind: string, fromKey: string, toKind: string, toKey: string) =>
    db
      .insert(schema.graphEdges)
      .values({ projectId: 1, kind, fromKind, fromKey, toKind, toKey, lastSeenAt: new Date() });
  const drift = () =>
    db
      .select()
      .from(schema.scenarioGaps)
      .where(eq(schema.scenarioGaps.detector, 'surface-drift'))
      .orderBy(schema.scenarioGaps.key);

  test('a node new in a run stays an open gap after the next run’s recompute, and closes once a test reaches it', async () => {
    await run(1);
    await run(2);
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'billing.spec.ts', title: 'pays' });
    // Run 1 built the graph, so its surface is the baseline; the billing page appeared in run 2.
    await db.insert(schema.graphNodes).values([
      { projectId: 1, kind: 'page', key: '/users', firstSeenRunId: 1, lastSeenRunId: 2 },
      { projectId: 1, kind: 'page', key: '/billing', firstSeenRunId: 2, lastSeenRunId: 2 },
    ]);
    await gaps.computeScenarioGaps(db, 1);
    expect((await drift()).map((g) => [g.key, g.status])).toEqual([['page:/billing', 'open']]);

    // Run 3 sees the page again, and still no test reaches it.
    await run(3);
    await db.update(schema.graphNodes).set({ lastSeenRunId: 3 });
    await gaps.computeScenarioGaps(db, 1);
    expect(await drift()).toMatchObject([
      {
        key: 'page:/billing',
        status: 'open',
        closedAt: null,
        evidence: ['Appeared in run #2; no test reaches it yet — observed reach.'],
      },
    ]);

    await edge('reaches', 'test', '1', 'page', '/billing');
    await gaps.computeScenarioGaps(db, 1);
    expect(await drift()).toMatchObject([{ key: 'page:/billing', status: 'closed', closedByRunId: 3 }]);

    // The reach ages out: the page is no longer new, so its gap stays closed.
    await db.delete(schema.graphEdges);
    await gaps.computeScenarioGaps(db, 1);
    expect((await drift()).map((g) => [g.key, g.status])).toEqual([['page:/billing', 'closed']]);
  });

  test('a dismissed gap keeps its verdict and is not raised again', async () => {
    await run(1);
    await run(2);
    await db.insert(schema.graphNodes).values([
      { projectId: 1, kind: 'page', key: '/users', firstSeenRunId: 1, lastSeenRunId: 2 },
      { projectId: 1, kind: 'page', key: '/billing', firstSeenRunId: 2, lastSeenRunId: 2 },
    ]);
    await gaps.computeScenarioGaps(db, 1);
    const [billing] = await drift();
    await gaps.triageGap(db, 1, billing!.id, { verb: 'dismiss', reason: 'not-worth-testing' });
    const [dismissed] = await drift();

    await run(3);
    await gaps.computeScenarioGaps(db, 1);
    expect(await drift()).toEqual([dismissed]);
    expect(dismissed).toMatchObject({ status: 'dismissed', dismissReason: 'not-worth-testing' });
  });

  test('the stale-node sweep prunes a node only its drift gap backs, and the next recompute closes that gap', async () => {
    await run(1);
    await run(2);
    await db.insert(schema.graphNodes).values([
      { projectId: 1, kind: 'page', key: '/users', firstSeenRunId: 1, lastSeenRunId: 2 },
      { projectId: 1, kind: 'page', key: '/billing', firstSeenRunId: 2, lastSeenRunId: 2 },
      { projectId: 1, kind: 'link', key: 'link:Pricing', firstSeenRunId: 2, lastSeenRunId: 2 },
    ]);
    await gaps.computeScenarioGaps(db, 1);
    const billing = (await drift()).find((g) => g.key === 'page:/billing')!;
    expect(await gaps.triageGap(db, 1, billing.id, { verb: 'accept' })).toEqual({ status: 'accepted' });

    // Thirty more runs see both pages, never the link.
    for (let id = 3; id <= 32; id++) await run(id);
    await db.update(schema.graphNodes).set({ lastSeenRunId: 32 }).where(eq(schema.graphNodes.kind, 'page'));
    await gaps.computeScenarioGaps(db, 1);
    expect((await drift()).map((g) => [g.key, g.status])).toEqual([
      ['link:link:Pricing', 'open'],
      ['page:/billing', 'accepted'],
    ]);

    expect(await pruneStaleCanonicalNodes(db as never)).toBe(1);
    const [link] = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.key, 'link:Pricing'));
    expect(link!.prunedAt).not.toBeNull();
    await gaps.computeScenarioGaps(db, 1);
    expect((await drift()).map((g) => [g.key, g.status])).toEqual([
      ['link:link:Pricing', 'closed'],
      ['page:/billing', 'accepted'],
    ]);
  });

  test('any test reaching the node closes its gap; one only untrusted tests reach is a single-covering-test gap', async () => {
    await run(1);
    await run(2);
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'billing.spec.ts', title: 'pays' });
    await db.insert(schema.quarantinedTests).values({ projectId: 1, testCaseId: 1 });
    await db.insert(schema.graphNodes).values([
      { projectId: 1, kind: 'page', key: '/users', firstSeenRunId: 1, lastSeenRunId: 2 },
      { projectId: 1, kind: 'page', key: '/billing', firstSeenRunId: 2, lastSeenRunId: 2 },
    ]);
    await gaps.computeScenarioGaps(db, 1);
    expect((await drift()).map((g) => [g.key, g.status])).toEqual([['page:/billing', 'open']]);

    await run(3);
    await edge('reaches', 'test', '1', 'page', '/billing');
    await gaps.computeScenarioGaps(db, 1);
    expect((await drift()).map((g) => [g.key, g.status])).toEqual([['page:/billing', 'closed']]);
    expect((await gaps.listScenarioGaps(db, 1, { detector: 'single-covering-test' })).map((g) => g.title)).toEqual([
      'No trusted test reaches page /billing',
    ]);
  });

  test('a handler is reached through the routes it serves, a dependency through its handlers, and a file never drifts', async () => {
    await run(1);
    await run(2);
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'orders.spec.ts', title: 'orders' });
    await db.insert(schema.graphNodes).values([
      { projectId: 1, kind: 'route', key: 'POST /api/orders', firstSeenRunId: 1, lastSeenRunId: 2 },
      { projectId: 1, kind: 'route', key: 'POST /api/export', firstSeenRunId: 1, lastSeenRunId: 2 },
      { projectId: 1, kind: 'handler', key: 'server/api/orders.post.ts', firstSeenRunId: 2, lastSeenRunId: 2 },
      { projectId: 1, kind: 'handler', key: 'server/api/export.post.ts', firstSeenRunId: 2, lastSeenRunId: 2 },
      { projectId: 1, kind: 'dependency', key: 'payments-svc', firstSeenRunId: 2, lastSeenRunId: 2 },
      { projectId: 1, kind: 'file', key: 'src/lib/money.ts', origin: 'import', firstSeenRunId: 2, lastSeenRunId: 2 },
    ]);
    await edge('handled-by', 'route', 'POST /api/orders', 'handler', 'server/api/orders.post.ts');
    await edge('handled-by', 'route', 'POST /api/export', 'handler', 'server/api/export.post.ts');
    await edge('calls', 'handler', 'server/api/orders.post.ts', 'dependency', 'payments-svc');
    await edge('reaches', 'test', '1', 'route', 'POST /api/orders');

    await gaps.computeScenarioGaps(db, 1);
    expect((await drift()).map((g) => [g.key, g.status])).toEqual([['handler:server/api/export.post.ts', 'open']]);

    await edge('reaches', 'test', '1', 'route', 'POST /api/export');
    await gaps.computeScenarioGaps(db, 1);
    expect((await drift()).map((g) => [g.key, g.status])).toEqual([['handler:server/api/export.post.ts', 'closed']]);
  });

  test('a control a test may have operated through a locator the index cannot name is not drift', async () => {
    await run(1);
    await run(2);
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'org.spec.ts', title: 'archives' });
    await db.insert(schema.graphNodes).values([
      { projectId: 1, kind: 'page', key: '/settings', firstSeenRunId: 1, lastSeenRunId: 2 },
      { projectId: 1, kind: 'page', key: '/reports', firstSeenRunId: 1, lastSeenRunId: 2 },
      { projectId: 1, kind: 'control', key: 'button:Archive', firstSeenRunId: 2, lastSeenRunId: 2 },
      { projectId: 1, kind: 'control', key: 'button:Print', firstSeenRunId: 2, lastSeenRunId: 2 },
    ]);
    await edge('contains', 'page', '/settings', 'control', 'button:Archive');
    await edge('contains', 'page', '/reports', 'control', 'button:Print');
    await db.insert(schema.locatorUsages).values({
      projectId: 1,
      testCaseId: 1,
      locator: "getByTestId('archive')",
      target: "getByTestId('archive')",
      action: 'click',
      browserName: 'chromium',
      callSite: 'org.spec.ts:4:5',
      page: '/settings',
      lastSeenAt: new Date(),
    });

    await gaps.computeScenarioGaps(db, 1);
    expect((await drift()).map((g) => g.key)).toEqual(['control:button:Print']);
  });
});
