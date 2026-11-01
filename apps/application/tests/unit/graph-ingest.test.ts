import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { pageNodeKey, collectOwnOrigins, isOwnOriginRequest } from '../../shared/graph';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const {
  collectRunGraphReaches,
  collectPageInventories,
  ingestChangesEdges,
  ingestRunGraph,
  pruneChangesEdges,
  pruneStaleBranchGraphRows,
  pruneStaleCanonicalNodes,
  pruneStaleReachesEdges,
  hardDeletePrunedNodes,
  deleteGraphRowsForRuns,
  deleteBranchGraphRows,
  resolveRunBranchTagFromStored,
  rebuildProjectGraph,
} = await import('../../server/utils/graph-ingest');

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'graph-project' });
});

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe('pageNodeKey', () => {
  test('collapses numeric ids so two order pages are one node', () => {
    expect(pageNodeKey('/orders/123')).toBe('/orders/:id');
    expect(pageNodeKey('/orders/456')).toBe('/orders/:id');
    expect(pageNodeKey('/orders/123')).toBe(pageNodeKey('/orders/456'));
  });

  test('drops the host, query and fragment — a page is its path pattern', () => {
    expect(pageNodeKey('https://staging.example.com/orders/9#tab')).toBe('/orders/:id');
    expect(pageNodeKey('https://prod.example.com/orders/9?ref=x')).toBe('/orders/:id');
  });

  test('returns null for non-http(s) URLs so they never become page nodes', () => {
    expect(pageNodeKey('about:blank')).toBeNull();
    expect(pageNodeKey('chrome-error://chromewebdata/')).toBeNull();
    expect(pageNodeKey('data:text/html,<p>x</p>')).toBeNull();
    expect(pageNodeKey('blob:https://app.test/abc')).toBeNull();
  });

  test('collapses token-like page segments so a page is not re-minted every run', () => {
    expect(pageNodeKey('/reset/01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('/reset/:ulid');
  });
});

describe('own-origin page filtering', () => {
  test('a third-party redirect page is not collected as a page node', () => {
    const origins = collectOwnOrigins(['https://app.test'], []);
    const reaches = collectRunGraphReaches(
      [
        { testCaseId: 1, pageState: { url: 'https://app.test/checkout' } },
        { testCaseId: 2, pageState: { url: 'https://checkout.stripe.com/pay/cs_test_123' } },
      ],
      [{ items: [] }, { items: [] }],
      { origins },
    );
    const pages = reaches.flatMap((r) => r.pages);
    expect(pages).toEqual(['https://app.test/checkout']);
  });
});

describe('own-origin route filtering', () => {
  test('collectOwnOrigins reduces base URLs and the allowlist to origins', () => {
    const origins = collectOwnOrigins(['https://app.test/checkout'], ['https://api.app.test']);
    expect([...origins].sort()).toEqual(['https://api.app.test', 'https://app.test']);
  });

  test('isOwnOriginRequest keeps own origins and drops third parties', () => {
    const origins = collectOwnOrigins(['https://app.test'], []);
    expect(isOwnOriginRequest('https://app.test/api/cart', origins)).toBe(true);
    expect(isOwnOriginRequest('https://cdn.vendor.com/lib.js', origins)).toBe(false);
    // With no known origin the caller cannot tell own from third-party, so keeps all.
    expect(isOwnOriginRequest('https://cdn.vendor.com/lib.js', new Set())).toBe(true);
  });

  test('third-party beacons and CDN assets never become route nodes', async () => {
    const origins = collectOwnOrigins(['https://app.test'], []);
    const reaches = collectRunGraphReaches(
      [{ testCaseId: 5, pageState: { url: 'https://app.test/checkout' } }],
      [
        {
          items: [
            { method: 'get', normalizedUrl: '/api/cart', status: 200, url: 'https://app.test/api/cart' },
            { method: 'post', normalizedUrl: '/collect', status: 204, url: 'https://analytics.beacon.io/collect' },
            { method: 'get', normalizedUrl: '/lib.js', status: 200, url: 'https://cdn.vendor.com/lib.js' },
          ],
        },
      ],
      { origins },
    );
    expect(reaches[0]!.routes.map((r) => r.normalizedUrl)).toEqual(['/api/cart']);

    await ingestRunGraph(db, 1, 1, reaches);
    const routeNodes = await db
      .select()
      .from(schema.graphNodes)
      .where(and(eq(schema.graphNodes.projectId, 1), eq(schema.graphNodes.kind, 'route')));
    expect(routeNodes.map((n) => n.key)).toEqual(['GET /api/cart']);
  });
});

describe('branch tagging', () => {
  test('a default-branch run writes canonical rows and a PR run writes branch-tagged rows', async () => {
    const reach = [{ testCaseId: 5, routes: [{ method: 'GET', normalizedUrl: '/api/cart', status: 200 }], pages: [] }];
    await ingestRunGraph(db, 1, 1, reach); // canonical (branch null)
    await ingestRunGraph(
      db,
      1,
      2,
      [{ testCaseId: 6, routes: [{ method: 'GET', normalizedUrl: '/api/new', status: 200 }], pages: [] }],
      { branch: 'pr-7' },
    );

    const canonical = await db
      .select()
      .from(schema.graphNodes)
      .where(and(eq(schema.graphNodes.projectId, 1), isNull(schema.graphNodes.branch)));
    expect(canonical.map((n) => n.key)).toEqual(['GET /api/cart']);

    const tagged = await db
      .select()
      .from(schema.graphNodes)
      .where(and(eq(schema.graphNodes.projectId, 1), eq(schema.graphNodes.branch, 'pr-7')));
    expect(tagged.map((n) => n.key)).toEqual(['GET /api/new']);

    // deleteBranchGraphRows drops only the branch's rows, leaving canonical intact.
    await deleteBranchGraphRows(db, 1, 'pr-7');
    const afterCanonical = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.projectId, 1));
    expect(afterCanonical.map((n) => n.key)).toEqual(['GET /api/cart']);
  });

  test('the same key on canonical and a branch are two distinct rows', async () => {
    const reach = [{ testCaseId: 5, routes: [{ method: 'GET', normalizedUrl: '/api/cart', status: 200 }], pages: [] }];
    await ingestRunGraph(db, 1, 1, reach);
    await ingestRunGraph(db, 1, 2, reach, { branch: 'pr-7' });
    const rows = await db
      .select()
      .from(schema.graphNodes)
      .where(and(eq(schema.graphNodes.projectId, 1), eq(schema.graphNodes.kind, 'route')));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.branch).sort()).toEqual([null, 'pr-7']);
  });
});

describe('graph pruning', () => {
  test('pruneChangesEdges drops changes edges older than ninety days, keeps recent and other kinds', async () => {
    await db.insert(schema.graphEdges).values([
      {
        projectId: 1,
        fromKind: 'commit',
        fromKey: 'old',
        toKind: 'file',
        toKey: 'a.ts',
        kind: 'changes',
        lastSeenAt: daysAgo(100),
      },
      {
        projectId: 1,
        fromKind: 'commit',
        fromKey: 'new',
        toKind: 'file',
        toKey: 'b.ts',
        kind: 'changes',
        lastSeenAt: daysAgo(10),
      },
      {
        projectId: 1,
        fromKind: 'test',
        fromKey: '1',
        toKind: 'route',
        toKey: 'GET /x',
        kind: 'reaches',
        lastSeenAt: daysAgo(400),
      },
    ]);
    const removed = await pruneChangesEdges(db);
    expect(removed).toBe(1);
    const left = await db.select().from(schema.graphEdges).where(eq(schema.graphEdges.projectId, 1));
    expect(left.map((e) => e.fromKey).sort()).toEqual(['1', 'new']);
  });

  test('pruneStaleBranchGraphRows drops branch-tagged rows unseen for thirty days, keeps canonical', async () => {
    await db.insert(schema.graphNodes).values([
      { projectId: 1, kind: 'route', key: 'GET /canon', lastSeenAt: daysAgo(400) },
      { projectId: 1, kind: 'route', key: 'GET /stale', branch: 'pr-1', lastSeenAt: daysAgo(40) },
      { projectId: 1, kind: 'route', key: 'GET /fresh', branch: 'pr-2', lastSeenAt: daysAgo(5) },
    ]);
    const removed = await pruneStaleBranchGraphRows(db);
    expect(removed).toBe(1);
    const left = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.projectId, 1));
    expect(left.map((n) => n.key).sort()).toEqual(['GET /canon', 'GET /fresh']);
  });

  test('pruneStaleCanonicalNodes soft-deletes a stale node and its edges, keeping an open-gap node', async () => {
    // Thirty-one runs, so the thirty-run window floor is run #2.
    for (let i = 1; i <= 31; i++) {
      await db.insert(schema.testRuns).values({ id: i, projectId: 1, status: 'passed', startTime: new Date(i) });
    }
    await db.insert(schema.graphNodes).values([
      { projectId: 1, kind: 'route', key: 'GET /gone', firstSeenRunId: 1, lastSeenRunId: 1, lastSeenAt: daysAgo(1) },
      { projectId: 1, kind: 'route', key: 'GET /kept', firstSeenRunId: 1, lastSeenRunId: 1, lastSeenAt: daysAgo(1) },
      {
        projectId: 1,
        kind: 'route',
        key: 'GET /recent',
        firstSeenRunId: 31,
        lastSeenRunId: 31,
        lastSeenAt: daysAgo(1),
      },
    ]);
    // A reaches edge into the stale node is deleted with it.
    await db.insert(schema.graphEdges).values({
      projectId: 1,
      fromKind: 'test',
      fromKey: '9',
      toKind: 'route',
      toKey: 'GET /gone',
      kind: 'reaches',
      lastSeenAt: daysAgo(1),
    });
    // An open surface-drift gap protects its node from removal.
    await db.insert(schema.scenarioGaps).values({
      projectId: 1,
      detector: 'surface-drift',
      class: 'blind-spot',
      key: 'route:GET /kept',
      title: 'new route',
      status: 'open',
    });

    const removed = await pruneStaleCanonicalNodes(db);
    expect(removed).toBe(1);

    // The row is kept (soft delete) but stamped pruned_at; the others stay active.
    const active = await db
      .select()
      .from(schema.graphNodes)
      .where(and(eq(schema.graphNodes.projectId, 1), isNull(schema.graphNodes.prunedAt)));
    expect(active.map((n) => n.key).sort()).toEqual(['GET /kept', 'GET /recent']);
    const gone = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.key, 'GET /gone'));
    expect(gone[0]!.prunedAt).not.toBeNull();
    // Its reaches edge is gone.
    const edges = await db.select().from(schema.graphEdges).where(eq(schema.graphEdges.projectId, 1));
    expect(edges).toHaveLength(0);
  });

  test('a pruned node reappearing keeps its first-seen run and clears pruned_at', async () => {
    await db.insert(schema.graphNodes).values({
      projectId: 1,
      kind: 'route',
      key: 'GET /back',
      firstSeenRunId: 3,
      lastSeenRunId: 3,
      lastSeenAt: daysAgo(60),
      prunedAt: daysAgo(1),
    });

    await ingestRunGraph(db, 1, 40, [
      { testCaseId: 5, routes: [{ method: 'GET', normalizedUrl: '/back', status: 200 }], pages: [] },
    ]);

    const [node] = await db
      .select()
      .from(schema.graphNodes)
      .where(and(eq(schema.graphNodes.projectId, 1), eq(schema.graphNodes.key, 'GET /back')));
    expect(node!.firstSeenRunId).toBe(3);
    expect(node!.lastSeenRunId).toBe(40);
    expect(node!.prunedAt).toBeNull();
  });

  test('thirty pull-request runs without a default-branch run never prune the canonical graph', async () => {
    await db.update(schema.projects).set({ defaultBranch: 'main' }).where(eq(schema.projects.id, 1));
    // One default-branch run seeds the canonical node, then thirty PR runs pile up.
    await db
      .insert(schema.testRuns)
      .values({ id: 1, projectId: 1, status: 'passed', startTime: new Date(1), branch: 'main' });
    for (let i = 2; i <= 31; i++) {
      await db
        .insert(schema.testRuns)
        .values({ id: i, projectId: 1, status: 'passed', startTime: new Date(i), branch: 'pr-9' });
    }
    await db.insert(schema.graphNodes).values({
      projectId: 1,
      kind: 'route',
      key: 'GET /canonical',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
      lastSeenAt: daysAgo(1),
    });
    // An accepted gap on the node — the sweep must never strip its subject either.
    await db.insert(schema.scenarioGaps).values({
      projectId: 1,
      detector: 'single-covering-test',
      class: 'fragile',
      key: 'route:GET /canonical',
      title: 'one test',
      status: 'accepted',
    });

    const removed = await pruneStaleCanonicalNodes(db);
    expect(removed).toBe(0);
    const [node] = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.key, 'GET /canonical'));
    expect(node!.prunedAt).toBeNull();
  });

  test('a node backing a snoozed gap is never pruned even past the window', async () => {
    for (let i = 1; i <= 31; i++) {
      await db.insert(schema.testRuns).values({ id: i, projectId: 1, status: 'passed', startTime: new Date(i) });
    }
    await db.insert(schema.graphNodes).values({
      projectId: 1,
      kind: 'route',
      key: 'GET /snoozed',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
      lastSeenAt: daysAgo(1),
    });
    await db.insert(schema.scenarioGaps).values({
      projectId: 1,
      detector: 'success-only',
      class: 'false-comfort',
      key: 'route:GET /snoozed',
      title: 'only 2xx',
      status: 'snoozed',
    });
    expect(await pruneStaleCanonicalNodes(db)).toBe(0);
  });
});

describe('probe runs never feed the canonical graph', () => {
  test('rebuildProjectGraph skips probe runs', async () => {
    // A real run and a probe run, each with a page-visiting case.
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date(1) });
    await db
      .insert(schema.testRuns)
      .values({ id: 2, projectId: 1, status: 'passed', startTime: new Date(2), metadata: { piwiProbe: true } });
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'real' },
      { id: 2, projectId: 1, filePath: 'b.spec.ts', title: 'probe' },
    ]);
    await db.insert(schema.testRunsCases).values([
      { testRunId: 1, testCaseId: 1, status: 'passed', pageState: { url: 'https://app.test/real' } },
      { testRunId: 2, testCaseId: 2, status: 'passed', pageState: { url: 'https://app.test/probe' } },
    ]);

    await rebuildProjectGraph(db, 1);
    const pages = await db
      .select()
      .from(schema.graphNodes)
      .where(and(eq(schema.graphNodes.projectId, 1), eq(schema.graphNodes.kind, 'page')));
    expect(pages.map((n) => n.key)).toEqual(['/real']);
  });
});

describe('rebuildProjectGraph reads the pages a test ran locators on', () => {
  test('a stored locator-pages payload adds reaches to the pages the test passed through', async () => {
    await db.insert(schema.testRuns).values({
      id: 1,
      projectId: 1,
      status: 'passed',
      startTime: new Date(1),
      metadata: { htmlReport: { projects: [{ use: { baseURL: 'https://app.test' } }] } },
    });
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'users.spec.ts', title: 'invites' });
    const content = JSON.stringify([
      {
        location: '/repo/users.spec.ts:4:3',
        locator: "getByRole('button', { name: 'Invite user' })",
        origin: 'https://app.test',
        page: '/users',
        arrival: false,
      },
      {
        location: '/repo/users.spec.ts:5:3',
        locator: "getByLabel('Email address')",
        origin: 'https://app.test',
        page: '/users/invite',
        arrival: true,
      },
    ]);
    const [payload] = await db
      .insert(schema.casePayloads)
      .values({ projectId: 1, hash: 'h1', content, size: content.length })
      .returning({ id: schema.casePayloads.id });
    await db.insert(schema.testRunsCases).values({
      testRunId: 1,
      testCaseId: 1,
      status: 'passed',
      pageState: { url: 'https://app.test/users' },
      locatorPagesPayloadId: payload!.id,
    });

    await rebuildProjectGraph(db, 1);
    const reached = await db
      .select({ key: schema.graphEdges.toKey })
      .from(schema.graphEdges)
      .where(and(eq(schema.graphEdges.kind, 'reaches'), eq(schema.graphEdges.toKind, 'page')));
    expect(reached.map((e) => e.key).sort()).toEqual(['/users', '/users/invite']);
  });
});

describe('last_seen never moves backwards', () => {
  test('an older run re-ingested does not lower last_seen_run_id', async () => {
    const reach = [{ testCaseId: 5, routes: [{ method: 'GET', normalizedUrl: '/x', status: 200 }], pages: [] }];
    await ingestRunGraph(db, 1, 10, reach);
    await ingestRunGraph(db, 1, 5, reach); // older run, must not win
    const [node] = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.key, 'GET /x'));
    expect(node!.lastSeenRunId).toBe(10);
  });
});

describe('graph growth retention', () => {
  test('pruneStaleReachesEdges drops reaches unseen past the window, keeps recent', async () => {
    await db.insert(schema.graphEdges).values([
      {
        projectId: 1,
        fromKind: 'test',
        fromKey: '1',
        toKind: 'route',
        toKey: 'GET /old',
        kind: 'reaches',
        lastSeenAt: daysAgo(200),
      },
      {
        projectId: 1,
        fromKind: 'test',
        fromKey: '2',
        toKind: 'route',
        toKey: 'GET /new',
        kind: 'reaches',
        lastSeenAt: daysAgo(1),
      },
    ]);
    expect(await pruneStaleReachesEdges(db)).toBe(1);
    const left = await db.select().from(schema.graphEdges).where(eq(schema.graphEdges.projectId, 1));
    expect(left.map((e) => e.toKey)).toEqual(['GET /new']);
  });

  test('hardDeletePrunedNodes removes long-pruned nodes but keeps grace-period and gap-backed ones', async () => {
    await db.insert(schema.graphNodes).values([
      {
        projectId: 1,
        kind: 'route',
        key: 'GET /a',
        firstSeenRunId: 1,
        lastSeenRunId: 1,
        lastSeenAt: daysAgo(90),
        prunedAt: daysAgo(40),
      },
      {
        projectId: 1,
        kind: 'route',
        key: 'GET /b',
        firstSeenRunId: 1,
        lastSeenRunId: 1,
        lastSeenAt: daysAgo(90),
        prunedAt: daysAgo(5),
      },
      {
        projectId: 1,
        kind: 'route',
        key: 'GET /c',
        firstSeenRunId: 1,
        lastSeenRunId: 1,
        lastSeenAt: daysAgo(90),
        prunedAt: daysAgo(40),
      },
    ]);
    // A live gap protects /c even though it is long-pruned.
    await db.insert(schema.scenarioGaps).values({
      projectId: 1,
      detector: 'surface-drift',
      class: 'blind-spot',
      key: 'route:GET /c',
      title: 'kept',
      status: 'open',
    });
    expect(await hardDeletePrunedNodes(db)).toBe(1);
    const left = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.projectId, 1));
    expect(left.map((n) => n.key).sort()).toEqual(['GET /b', 'GET /c']);
  });

  test('deleteGraphRowsForRuns removes rows whose last-seen run was deleted', async () => {
    await db.insert(schema.graphNodes).values([
      { projectId: 1, kind: 'route', key: 'GET /gone', firstSeenRunId: 1, lastSeenRunId: 7, lastSeenAt: daysAgo(1) },
      { projectId: 1, kind: 'route', key: 'GET /live', firstSeenRunId: 1, lastSeenRunId: 9, lastSeenAt: daysAgo(1) },
    ]);
    await db.insert(schema.graphEdges).values({
      projectId: 1,
      fromKind: 'test',
      fromKey: '1',
      toKind: 'route',
      toKey: 'GET /gone',
      kind: 'reaches',
      lastSeenRunId: 7,
      lastSeenAt: daysAgo(1),
    });
    const removed = await deleteGraphRowsForRuns(db, 1, [7]);
    expect(removed).toBe(2);
    const nodes = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.projectId, 1));
    expect(nodes.map((n) => n.key)).toEqual(['GET /live']);
  });
});

describe('resolveRunBranchTagFromStored keeps canonical rows through the fallback chain', () => {
  test('the stored default branch is canonical', async () => {
    expect(await resolveRunBranchTagFromStored(db, { id: 1, defaultBranch: 'main' }, null, 'main')).toBeNull();
    expect(await resolveRunBranchTagFromStored(db, { id: 1, defaultBranch: 'main' }, null, 'pr-3')).toBe('pr-3');
  });

  test('with no stored default, the most common branch among runs is canonical', async () => {
    for (let i = 1; i <= 3; i++) {
      await db
        .insert(schema.testRuns)
        .values({ id: i, projectId: 1, status: 'passed', startTime: new Date(i), branch: 'develop' });
    }
    await db
      .insert(schema.testRuns)
      .values({ id: 4, projectId: 1, status: 'passed', startTime: new Date(4), branch: 'feature-x' });
    expect(await resolveRunBranchTagFromStored(db, { id: 1, defaultBranch: null }, null, 'develop')).toBeNull();
    expect(await resolveRunBranchTagFromStored(db, { id: 1, defaultBranch: null }, null, 'feature-x')).toBe(
      'feature-x',
    );
  });

  test('with no default and no runs, main is the canonical fallback', async () => {
    expect(await resolveRunBranchTagFromStored(db, { id: 1, defaultBranch: null }, null, 'main')).toBeNull();
    expect(await resolveRunBranchTagFromStored(db, { id: 1, defaultBranch: null }, null, 'topic')).toBe('topic');
  });
});

describe('collectRunGraphReaches', () => {
  test('folds a test case that ran twice into one reach with a union of routes', () => {
    const reaches = collectRunGraphReaches(
      [
        { testCaseId: 5, pageState: { url: 'https://app.test/checkout?x=1' } },
        { testCaseId: 5, pageState: null },
      ],
      [
        { items: [{ method: 'get', normalizedUrl: '/api/cart', status: 200 }] },
        { items: [{ method: 'post', normalizedUrl: '/api/orders', status: 201 }] },
      ],
    );
    expect(reaches).toHaveLength(1);
    expect(reaches[0]!.testCaseId).toBe(5);
    expect(reaches[0]!.routes).toHaveLength(2);
    expect(reaches[0]!.pages).toEqual(['https://app.test/checkout?x=1']);
  });

  test('a test also reaches every own-origin page it ran a locator call on, by its key', () => {
    const reaches = collectRunGraphReaches(
      [
        {
          testCaseId: 7,
          pageState: { url: 'https://app.test/users' },
          locatorPages: [
            { origin: 'https://app.test', page: '/users/invite' },
            { origin: 'https://app.test', page: '/users' },
            { origin: 'https://sso.vendor.test', page: '/authorize' },
          ],
        },
      ],
      [{ items: [] }],
      { origins: new Set(['https://app.test']) },
    );
    expect(reaches[0]!.pages).toEqual(['https://app.test/users']);
    expect(reaches[0]!.visitedPages).toEqual(['/users/invite', '/users']);
  });

  test('locator pages need a known origin: a host-less key could be a third-party page', () => {
    const reaches = collectRunGraphReaches(
      [
        {
          testCaseId: 7,
          pageState: null,
          locatorPages: [{ origin: 'https://sso.vendor.test', page: '/login' }],
        },
      ],
      [{ items: [] }],
    );
    expect(reaches[0]!.visitedPages).toEqual([]);
  });
});

describe('ingestRunGraph', () => {
  test('a page reached only by its key keeps the real URL another test ended on', async () => {
    await ingestRunGraph(db, 1, 1, [
      { testCaseId: 5, routes: [], pages: ['https://app.test/orders/42'] },
      { testCaseId: 6, routes: [], pages: [], visitedPages: ['/orders/:id'] },
    ]);
    await ingestRunGraph(db, 1, 2, [{ testCaseId: 6, routes: [], pages: [], visitedPages: ['/orders/:id'] }]);
    const [node] = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.key, '/orders/:id'));
    expect(node!.attrs).toEqual({ url: 'https://app.test/orders/42' });
    const reached = await db
      .select({ from: schema.graphEdges.fromKey })
      .from(schema.graphEdges)
      .where(and(eq(schema.graphEdges.kind, 'reaches'), eq(schema.graphEdges.toKey, '/orders/:id')));
    expect(reached.map((e) => e.from).sort()).toEqual(['5', '6']);
  });

  test('upserts route and page nodes and reaches edges, and bumps last-seen on re-ingest', async () => {
    const reach = [
      {
        testCaseId: 5,
        routes: [{ method: 'POST', normalizedUrl: '/api/orders', status: 201 }],
        pages: ['https://app.test/checkout'],
      },
    ];
    await ingestRunGraph(db, 1, 1, reach);

    const nodes = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.projectId, 1));
    expect(nodes.map((n) => `${n.kind}:${n.key}`).sort()).toEqual(['page:/checkout', 'route:POST /api/orders']);
    expect(nodes.every((n) => n.firstSeenRunId === 1)).toBe(true);

    const edges = await db
      .select()
      .from(schema.graphEdges)
      .where(and(eq(schema.graphEdges.projectId, 1), eq(schema.graphEdges.kind, 'reaches')));
    expect(edges).toHaveLength(2);

    // Re-ingest under a later run keeps first-seen but advances last-seen.
    await ingestRunGraph(db, 1, 2, reach);
    const after = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.projectId, 1));
    expect(after).toHaveLength(2);
    expect(after.every((n) => n.firstSeenRunId === 1 && n.lastSeenRunId === 2)).toBe(true);
  });
});

describe('collectPageInventories', () => {
  const origins = new Set(['https://app.example.com']);

  test('attributes each request to the page current when it started (two-page test)', () => {
    // A test that signs in on /login then lands on /orders. Each page carries its
    // settle time; the login POST fired while /login was current, the orders
    // fetch after /orders settled.
    const pages = collectPageInventories(
      [
        {
          pageInventory: [
            { url: 'https://app.example.com/login', controls: [], links: [], capturedAt: 1000 },
            { url: 'https://app.example.com/orders', controls: [], links: [], capturedAt: 2000 },
          ],
          networkItems: [
            {
              method: 'POST',
              normalizedUrl: '/api/login',
              url: 'https://app.example.com/api/login',
              resourceType: 'fetch',
              startTime: 1500,
            },
            {
              method: 'GET',
              normalizedUrl: '/api/orders',
              url: 'https://app.example.com/api/orders',
              resourceType: 'fetch',
              startTime: 2500,
            },
          ],
        },
      ],
      origins,
    );
    const login = pages.find((p) => p.pageKey === '/login');
    const orders = pages.find((p) => p.pageKey === '/orders');
    // The login POST attaches to /login, not to the end-of-test /orders page.
    expect(login?.loadsRouteKeys).toEqual(['POST /api/login']);
    expect(orders?.loadsRouteKeys).toEqual(['GET /api/orders']);
  });

  test('writes no loads edge when a request cannot be placed', () => {
    const pages = collectPageInventories(
      [
        {
          pageInventory: [{ url: 'https://app.example.com/orders', controls: [], links: [], capturedAt: 2000 }],
          networkItems: [
            // Before the first settle — cannot be attributed.
            {
              method: 'GET',
              normalizedUrl: '/api/early',
              url: 'https://app.example.com/api/early',
              resourceType: 'document',
              startTime: 500,
            },
            // No start time — cannot be attributed.
            {
              method: 'GET',
              normalizedUrl: '/api/untimed',
              url: 'https://app.example.com/api/untimed',
              resourceType: 'fetch',
              startTime: null,
            },
          ],
        },
      ],
      origins,
    );
    expect(pages.find((p) => p.pageKey === '/orders')?.loadsRouteKeys).toEqual([]);
  });
});

describe('ingestChangesEdges', () => {
  test('a commit edge names the base of its diff, a ticket edge carries none', async () => {
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date() });
    await ingestChangesEdges(db as never, 1, 1, 'abc1234', ['PIWI-7'], ['server/api/orders.post.ts'], {
      baseSha: 'fed4321',
    });
    const rows = await db.select().from(schema.graphEdges).where(eq(schema.graphEdges.kind, 'changes'));
    expect(
      rows
        .map((r) => ({ from: `${r.fromKind}:${r.fromKey}`, evidence: r.evidence }))
        .sort((a, b) => a.from.localeCompare(b.from)),
    ).toEqual([
      { from: 'commit:abc1234', evidence: { base: 'fed4321' } },
      { from: 'ticket:PIWI-7', evidence: null },
    ]);
  });
});
