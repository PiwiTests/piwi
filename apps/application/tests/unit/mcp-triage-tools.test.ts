import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import type { McpContext } from '../../server/utils/mcp/tools';
import type { User } from '../../server/database/schema';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const rerun = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../../server/utils/ci-rerun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/utils/ci-rerun')>()),
  rerunClusterInCi: rerun.fn,
}));
vi.mock('../../server/utils/integrations/link-unfurl', () => ({
  unfurlLink: async () => ({ title: 'Checkout total is wrong', statusText: 'In Progress', statusColor: 'blue' }),
}));

const { MCP_TOOLS } = await import('../../server/utils/mcp/tools');

const tool = (name: string) => {
  const found = MCP_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found.handler;
};

const asUser = (id: number, name: string) =>
  ({ id, role: InstanceRole.MEMBER, name, username: name.toLowerCase() }) as User;
const roles = (...grants: Array<[number, ProjectRole]>) =>
  buildAccessSummary(
    InstanceRole.MEMBER,
    grants.map(([projectId, role]) => ({ projectId, role })),
  );
// A Maintainer of project 1, and a Viewer of the same project; neither holds a role on project 2.
const maintainer: McpContext = {
  user: asUser(2, 'Robin'),
  access: roles([1, ProjectRole.MAINTAINER]),
  scope: new Set([1]),
};
const viewer: McpContext = { user: asUser(3, 'Sam'), access: roles([1, ProjectRole.VIEWER]), scope: new Set([1]) };
const refused = (permission: string, projectId = 1) =>
  `This action requires the ${permission} permission on project ${projectId}`;

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  rerun.fn.mockReset();
  await db.insert(schema.users).values([
    { id: 2, username: 'robin', password: '', role: InstanceRole.MEMBER, name: 'Robin' },
    { id: 3, username: 'sam', password: '', role: InstanceRole.MEMBER, name: 'Sam' },
  ]);
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'other' },
  ]);
  await db.insert(schema.testRuns).values([
    { id: 1, projectId: 1, status: 'failed', startTime: new Date() },
    { id: 2, projectId: 2, status: 'failed', startTime: new Date() },
  ]);
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'adds an item' },
    { id: 2, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'removes an item' },
  ]);
  const cluster = (id: number, projectId: number, runId: number) => ({
    id,
    projectId,
    fingerprint: `fp-${id}`,
    signature: `Error ${id}`,
    errorType: 'assertion',
    firstSeenRunId: runId,
    lastSeenRunId: runId,
    occurrences: 1,
  });
  await db.insert(schema.failureClusters).values([cluster(1, 1, 1), cluster(2, 1, 1), cluster(3, 2, 2)]);
  await db.insert(schema.testRunsCases).values([
    { testRunId: 1, testCaseId: 1, status: 'failed', failureClusterId: 1 },
    { testRunId: 1, testCaseId: 2, status: 'failed', failureClusterId: 2 },
  ]);
});

afterEach(async () => {
  await close();
});

describe('list_open_clusters', () => {
  test("the Mine queue matches the caller's name, username or email, as the dashboard does", async () => {
    const robin: McpContext = {
      user: { id: 2, role: InstanceRole.MEMBER, name: 'Robin', username: 'rob', email: 'robin@example.com' } as User,
      access: roles([1, ProjectRole.MAINTAINER]),
      scope: new Set([1]),
    };
    for (const [id, assignee] of [
      [1, 'rob'],
      [2, 'robin@example.com'],
    ] as const) {
      await db.update(schema.failureClusters).set({ assignee }).where(eq(schema.failureClusters.id, id));
    }
    const mine = (await tool('list_open_clusters')(db as never, { queue: 'mine' }, robin)) as {
      items: Array<{ id: number }>;
    };
    expect(mine.items.map((c) => c.id).sort()).toEqual([1, 2]);
  });
});

describe('triage_cluster', () => {
  test('resolves several clusters with a note and skips the ones out of scope or missing', async () => {
    const result = await tool('triage_cluster')(
      db as never,
      { clusterIds: [1, 2, 3, 999], action: 'status', status: 'resolved', note: 'Fixed in #42' },
      maintainer,
    );
    expect(result).toEqual({ action: 'status', requested: 4, updated: 2, skippedIds: [3, 999] });
    const rows = await db.select().from(schema.failureClusters).orderBy(schema.failureClusters.id);
    expect(rows.map((r) => [r.status, r.triageNote])).toEqual([
      ['resolved', 'Fixed in #42'],
      ['resolved', 'Fixed in #42'],
      ['open', null],
    ]);
  });

  test('assigns and snoozes through the bulk triage', async () => {
    await tool('triage_cluster')(db as never, { clusterIds: [1, 2], action: 'assign', assignee: 'robin' }, maintainer);
    await tool('triage_cluster')(
      db as never,
      { clusterIds: [1], action: 'snooze', snooze: 'until-recurs' },
      maintainer,
    );
    const rows = await db.select().from(schema.failureClusters).orderBy(schema.failureClusters.id);
    expect(rows.slice(0, 2).map((r) => r.assignee)).toEqual(['robin', 'robin']);
    expect(rows[0]!.snoozeMode).toBe('until-recurs');
    expect(rows[1]!.snoozeMode).toBeNull();
  });

  test("quarantines a cluster's tests, then releases them", async () => {
    const quarantined = await tool('triage_cluster')(
      db as never,
      { clusterIds: [1], action: 'quarantine', reason: 'flaky on CI' },
      maintainer,
    );
    expect(quarantined).toEqual({ action: 'quarantine', requested: 1, updated: 1, tests: 1, quarantined: 1 });
    const released = await tool('triage_cluster')(db as never, { clusterIds: [1], action: 'release' }, maintainer);
    expect(released).toEqual({ action: 'release', requested: 1, updated: 1, tests: 1, released: 1 });
    const [row] = await db.select().from(schema.quarantinedTests).where(eq(schema.quarantinedTests.testCaseId, 1));
    expect(row!.releasedAt).not.toBeNull();
  });

  test('refuses a read-only key', async () => {
    await expect(
      tool('triage_cluster')(db as never, { clusterIds: [1], action: 'status', status: 'resolved' }, viewer),
    ).rejects.toThrow('This action requires the triage:write permission');
  });

  test('skips the clusters of a project the caller only reads', async () => {
    const readsTwo: McpContext = {
      ...maintainer,
      access: roles([1, ProjectRole.MAINTAINER], [2, ProjectRole.VIEWER]),
      scope: new Set([1, 2]),
    };
    const result = await tool('triage_cluster')(
      db as never,
      { clusterIds: [1, 3], action: 'status', status: 'resolved' },
      readsTwo,
    );
    expect(result).toEqual({ action: 'status', requested: 2, updated: 1, skippedIds: [3] });
  });

  test('refuses an unknown action, a bad status and an empty id list before changing anything', async () => {
    await expect(
      tool('triage_cluster')(db as never, { clusterIds: [1], action: 'delete' }, maintainer),
    ).rejects.toThrow('action must be one of');
    await expect(
      tool('triage_cluster')(db as never, { clusterIds: [1], action: 'status', status: 'done' }, maintainer),
    ).rejects.toThrow('status must be one of');
    await expect(tool('triage_cluster')(db as never, { clusterIds: [], action: 'assign' }, maintainer)).rejects.toThrow(
      'clusterIds must be a non-empty array',
    );
  });
});

describe('triage_gap', () => {
  beforeEach(async () => {
    await db.insert(schema.scenarioGaps).values({
      id: 7,
      projectId: 1,
      detector: 'success-only',
      class: 'blind-spot',
      key: 'GET /api/cart',
      title: 'No test sees GET /api/cart fail',
    });
  });

  test('accepts a gap for someone and records who gave the verdict', async () => {
    const result = await tool('triage_gap')(
      db as never,
      { projectId: 1, gapId: 7, verb: 'accept', assignedTo: 'robin' },
      maintainer,
    );
    expect(result).toEqual({ id: 7, projectId: 1, status: 'accepted' });
    const [gap] = await db.select().from(schema.scenarioGaps).where(eq(schema.scenarioGaps.id, 7));
    expect([gap!.status, gap!.assignedTo, gap!.triagedBy]).toEqual(['accepted', 'robin', 2]);
  });

  test('answers null for a gap of another project, and refuses a project out of scope', async () => {
    await db.insert(schema.projects).values({ id: 3, name: 'third' });
    const inScope: McpContext = {
      ...maintainer,
      access: roles([1, ProjectRole.MAINTAINER], [3, ProjectRole.MAINTAINER]),
      scope: new Set([1, 3]),
    };
    expect(await tool('triage_gap')(db as never, { projectId: 3, gapId: 7, verb: 'accept' }, inScope)).toBeNull();
    await expect(
      tool('triage_gap')(db as never, { projectId: 2, gapId: 7, verb: 'accept' }, maintainer),
    ).rejects.toThrow('No access to project 2');
  });

  test('refuses a read-only key', async () => {
    await expect(tool('triage_gap')(db as never, { projectId: 1, gapId: 7, verb: 'accept' }, viewer)).rejects.toThrow(
      refused('triage:write'),
    );
  });

  test('refuses an unknown verb or dismiss reason', async () => {
    await expect(
      tool('triage_gap')(db as never, { projectId: 1, gapId: 7, verb: 'close' }, maintainer),
    ).rejects.toThrow('verb');
    await expect(
      tool('triage_gap')(db as never, { projectId: 1, gapId: 7, verb: 'dismiss', reason: 'meh' }, maintainer),
    ).rejects.toThrow('reason');
  });
});

describe('decide_merge_suggestion', () => {
  beforeEach(async () => {
    await db
      .insert(schema.clusterMergeSuggestions)
      .values({ id: 5, projectId: 1, clusterAId: 1, clusterBId: 2, method: 'embedding' });
  });

  test('rejects the one pending suggestion of a cluster, leaving both clusters', async () => {
    const result = await tool('decide_merge_suggestion')(db as never, { clusterId: 2, decision: 'reject' }, maintainer);
    expect(result).toEqual({ suggestionId: 5, decision: 'reject', ok: true });
    const [row] = await db
      .select()
      .from(schema.clusterMergeSuggestions)
      .where(eq(schema.clusterMergeSuggestions.id, 5));
    expect(row!.status).toBe('rejected');
    expect(await db.select().from(schema.failureClusters)).toHaveLength(3);
  });

  test('approves a suggestion by id: the lower id survives and the other cluster is merged into it', async () => {
    const result = await tool('decide_merge_suggestion')(
      db as never,
      { suggestionId: 5, decision: 'approve' },
      maintainer,
    );
    expect(result).toEqual({ suggestionId: 5, decision: 'approve', survivorId: 1 });
    const ids = (await db.select().from(schema.failureClusters)).map((c) => c.id);
    expect(ids).toEqual([1, 3]);
  });

  test('asks for the suggestion when the cluster has several pending', async () => {
    await db.insert(schema.failureClusters).values({
      id: 4,
      projectId: 1,
      fingerprint: 'fp-4',
      signature: 'Error 4',
      errorType: 'assertion',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
      occurrences: 1,
    });
    await db
      .insert(schema.clusterMergeSuggestions)
      .values({ id: 6, projectId: 1, clusterAId: 1, clusterBId: 4, method: 'embedding' });
    await expect(
      tool('decide_merge_suggestion')(db as never, { clusterId: 1, decision: 'approve' }, maintainer),
    ).rejects.toThrow('2 pending merge suggestions: 5 (with cluster 2), 6 (with cluster 4); pass suggestionId');
  });

  test('get_cluster lists the pending suggestions to decide', async () => {
    const cluster = (await tool('get_cluster')(db as never, { clusterId: 2 }, maintainer)) as Record<string, unknown>;
    expect(cluster.mergeSuggestions).toEqual([{ suggestionId: 5, otherClusterId: 1 }]);
  });

  test('refuses a read-only key', async () => {
    await expect(
      tool('decide_merge_suggestion')(db as never, { suggestionId: 5, decision: 'approve' }, viewer),
    ).rejects.toThrow(refused('triage:write'));
  });

  test('refuses an unknown decision, and a call naming neither a cluster nor a suggestion', async () => {
    await expect(
      tool('decide_merge_suggestion')(db as never, { suggestionId: 5, decision: 'maybe' }, maintainer),
    ).rejects.toThrow('decision must be approve or reject');
    await expect(tool('decide_merge_suggestion')(db as never, { decision: 'reject' }, maintainer)).rejects.toThrow(
      'Pass clusterId or suggestionId',
    );
  });
});

describe('set_bug_report_status', () => {
  beforeEach(async () => {
    await db.insert(schema.bugReports).values({
      id: 9,
      projectId: 1,
      title: 'Coupon is refused',
      status: 'open',
      steps: { v: 1, steps: [] },
      evidence: {},
      context: {},
    });
  });

  test('dismisses a report, then reopens it', async () => {
    expect(await tool('set_bug_report_status')(db as never, { id: 9, status: 'dismissed' }, maintainer)).toEqual({
      id: 9,
      status: 'dismissed',
    });
    expect(await tool('set_bug_report_status')(db as never, { id: 9, status: 'open' }, maintainer)).toEqual({
      id: 9,
      status: 'open',
    });
  });

  test('refuses a read-only key', async () => {
    await expect(tool('set_bug_report_status')(db as never, { id: 9, status: 'dismissed' }, viewer)).rejects.toThrow(
      refused('bug-report:write'),
    );
  });

  test('refuses a status the runs set', async () => {
    await expect(
      tool('set_bug_report_status')(db as never, { id: 9, status: 'looks-fixed' }, maintainer),
    ).rejects.toThrow('status must be one of: open, dismissed, closed');
  });
});

describe('rerun_cluster_in_ci', () => {
  test('dispatches the re-run as the calling user and returns where to watch it', async () => {
    rerun.fn.mockResolvedValue({
      ok: true,
      dispatch: {
        provider: 'github',
        url: 'https://github.com/acme/shop/actions',
        args: 'tests/cart.spec.ts',
        at: Date.UTC(2026, 9, 2),
        byName: 'Robin',
        byUserId: 2,
      },
    });
    const result = await tool('rerun_cluster_in_ci')(db as never, { clusterId: 1 }, maintainer);
    expect(result).toEqual({
      clusterId: 1,
      provider: 'github',
      url: 'https://github.com/acme/shop/actions',
      args: 'tests/cart.spec.ts',
      dispatchedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(rerun.fn).toHaveBeenCalledWith(db, 1, { id: 2, name: 'Robin' });
  });

  test('passes on why the re-run is not available', async () => {
    rerun.fn.mockResolvedValue({ ok: false, error: 'unavailable', message: 'CI re-run is off for this project.' });
    await expect(tool('rerun_cluster_in_ci')(db as never, { clusterId: 1 }, maintainer)).rejects.toThrow(
      'CI re-run is off for this project.',
    );
  });

  test('refuses a read-only key and a cluster out of scope', async () => {
    await expect(tool('rerun_cluster_in_ci')(db as never, { clusterId: 1 }, viewer)).rejects.toThrow(
      refused('run:control'),
    );
    await expect(tool('rerun_cluster_in_ci')(db as never, { clusterId: 3 }, maintainer)).rejects.toThrow(
      'No access to project 2',
    );
    expect(rerun.fn).not.toHaveBeenCalled();
  });

  test('refuses a cluster id that is not a number', async () => {
    await expect(tool('rerun_cluster_in_ci')(db as never, { clusterId: 'latest' }, maintainer)).rejects.toThrow(
      'clusterId',
    );
  });
});

describe('link_issue', () => {
  test('links a ticket to a cluster and stores what the tracker says about it', async () => {
    const result = await tool('link_issue')(
      db as never,
      { entityType: 'failure_cluster', entityId: 1, url: 'https://acme.atlassian.net/browse/SHOP-12' },
      maintainer,
    );
    expect(result).toMatchObject({
      entityType: 'failure_cluster',
      entityId: 1,
      url: 'https://acme.atlassian.net/browse/SHOP-12',
      title: 'Checkout total is wrong',
      statusText: 'In Progress',
    });
    const links = await db.select().from(schema.entityLinks).where(eq(schema.entityLinks.failureClusterId, 1));
    expect(links).toHaveLength(1);
  });

  test('links a ticket to a bug report, whose id no test case shares', async () => {
    await db.insert(schema.bugReports).values({
      id: 9,
      projectId: 1,
      title: 'Coupon is refused',
      steps: { v: 1, steps: [] },
      evidence: {},
      context: {},
    });
    const result = await tool('link_issue')(
      db as never,
      { entityType: 'bug_report', entityId: 9, url: 'https://github.com/acme/shop/issues/3' },
      maintainer,
    );
    expect(result).toMatchObject({ entityType: 'bug_report', entityId: 9 });
    const links = await db.select().from(schema.entityLinks).where(eq(schema.entityLinks.bugReportId, 9));
    expect(links).toHaveLength(1);
  });

  test('refuses a read-only key', async () => {
    await expect(
      tool('link_issue')(
        db as never,
        { entityType: 'failure_cluster', entityId: 1, url: 'https://acme.atlassian.net/browse/SHOP-12' },
        viewer,
      ),
    ).rejects.toThrow(refused('link:write'));
  });

  test('refuses a URL that is not http(s) and an unknown entity type', async () => {
    await expect(
      tool('link_issue')(
        db as never,
        { entityType: 'failure_cluster', entityId: 1, url: 'javascript:alert(1)' },
        maintainer,
      ),
    ).rejects.toThrow('Must be an http(s) URL');
    await expect(
      tool('link_issue')(db as never, { entityType: 'project', entityId: 1, url: 'https://example.com' }, maintainer),
    ).rejects.toThrow('entityType');
    expect(await db.select().from(schema.entityLinks)).toHaveLength(0);
  });
});

describe('unlink_issue', () => {
  const url = 'https://acme.atlassian.net/browse/SHOP-12';

  test("removes an entity's links to a URL, and only those", async () => {
    await tool('link_issue')(db as never, { entityType: 'failure_cluster', entityId: 1, url }, maintainer);
    await tool('link_issue')(db as never, { entityType: 'failure_cluster', entityId: 2, url }, maintainer);
    expect(
      await tool('unlink_issue')(db as never, { entityType: 'failure_cluster', entityId: 1, url }, maintainer),
    ).toEqual({ entityType: 'failure_cluster', entityId: 1, url, removed: 1 });
    const links = await db.select().from(schema.entityLinks);
    expect(links.map((l) => l.failureClusterId)).toEqual([2]);
  });

  test('removes a link stored with spaces around its URL', async () => {
    await db.insert(schema.entityLinks).values({ failureClusterId: 1, url: `${url} `, provider: 'jira' });
    expect(
      await tool('unlink_issue')(db as never, { entityType: 'failure_cluster', entityId: 1, url }, maintainer),
    ).toMatchObject({ removed: 1 });
    expect(await db.select().from(schema.entityLinks)).toHaveLength(0);
  });

  test('fails when the entity has no link to the URL', async () => {
    await expect(
      tool('unlink_issue')(db as never, { entityType: 'failure_cluster', entityId: 1, url }, maintainer),
    ).rejects.toThrow(`failure_cluster 1 has no link to ${url}`);
  });

  test('refuses a read-only key, and returns null for an entity that does not exist', async () => {
    await tool('link_issue')(db as never, { entityType: 'failure_cluster', entityId: 1, url }, maintainer);
    await expect(
      tool('unlink_issue')(db as never, { entityType: 'failure_cluster', entityId: 1, url }, viewer),
    ).rejects.toThrow(refused('link:write'));
    expect(
      await tool('unlink_issue')(db as never, { entityType: 'failure_cluster', entityId: 99, url }, maintainer),
    ).toBeNull();
    expect(await db.select().from(schema.entityLinks)).toHaveLength(1);
  });
});

describe('set_test_quarantine', () => {
  test('quarantines a test once, then releases it with a reason', async () => {
    expect(
      await tool('set_test_quarantine')(
        db as never,
        { testCaseId: 1, quarantined: true, reason: 'Flaky on CI' },
        maintainer,
      ),
    ).toEqual({ testCaseId: 1, quarantined: true, changed: true, reason: 'Flaky on CI' });
    // A test already in quarantine keeps its reason, and the answer does not claim another.
    expect(
      await tool('set_test_quarantine')(
        db as never,
        { testCaseId: 1, quarantined: true, reason: 'Timeout in checkout' },
        maintainer,
      ),
    ).toEqual({ testCaseId: 1, quarantined: true, changed: false });
    const quarantined = await db.select().from(schema.quarantinedTests);
    expect(quarantined).toEqual([
      expect.objectContaining({ testCaseId: 1, reason: 'Flaky on CI', createdBy: 2, releasedAt: null }),
    ]);

    expect(
      await tool('set_test_quarantine')(
        db as never,
        { testCaseId: 1, quarantined: false, reason: 'Fixed' },
        maintainer,
      ),
    ).toEqual({ testCaseId: 1, quarantined: false, changed: true, reason: 'Fixed' });
    const [released] = await db.select().from(schema.quarantinedTests);
    expect(released!.releasedAt).not.toBeNull();
    expect(released!.releasedReason).toBe('Fixed');
  });

  test('fails to release a test that is not in quarantine', async () => {
    await expect(
      tool('set_test_quarantine')(db as never, { testCaseId: 2, quarantined: false }, maintainer),
    ).rejects.toThrow('Test 2 is not in quarantine');
  });

  test('refuses a read-only key, a test out of scope and a missing flag; null for a test that does not exist', async () => {
    await db.insert(schema.testCases).values({ id: 3, projectId: 2, filePath: 'tests/other.spec.ts', title: 'other' });
    await expect(
      tool('set_test_quarantine')(db as never, { testCaseId: 1, quarantined: true }, viewer),
    ).rejects.toThrow(refused('quarantine:write'));
    await expect(
      tool('set_test_quarantine')(db as never, { testCaseId: 3, quarantined: true }, maintainer),
    ).rejects.toThrow('No access to project 2');
    await expect(tool('set_test_quarantine')(db as never, { testCaseId: 1 }, maintainer)).rejects.toThrow(
      'quarantined must be true or false',
    );
    expect(
      await tool('set_test_quarantine')(db as never, { testCaseId: 99, quarantined: true }, maintainer),
    ).toBeNull();
    expect(await db.select().from(schema.quarantinedTests)).toHaveLength(0);
  });
});

describe('move_tests_to_new_cluster', () => {
  beforeEach(async () => {
    await db
      .insert(schema.testRunsCases)
      .values({ testRunId: 1, testCaseId: 2, status: 'failed', failureClusterId: 1 });
    await db.update(schema.failureClusters).set({ occurrences: 2 }).where(eq(schema.failureClusters.id, 1));
  });

  test('moves a test out of a cluster into a new one, which gets the triage note', async () => {
    const result = (await tool('move_tests_to_new_cluster')(
      db as never,
      { clusterId: 1, testCaseIds: [2], triageNote: 'Removing an item is its own bug' },
      maintainer,
    )) as Record<string, number>;
    expect(result).toMatchObject({ sourceClusterId: 1, movedTests: 1, remainingOccurrences: 1 });
    const [created] = await db
      .select()
      .from(schema.failureClusters)
      .where(eq(schema.failureClusters.id, result.clusterId!));
    expect(created).toMatchObject({ projectId: 1, triageNote: 'Removing an item is its own bug', occurrences: 1 });
    const [source] = await db.select().from(schema.failureClusters).where(eq(schema.failureClusters.id, 1));
    expect(source!.triageNote).toBe(`Moved 1 test to cluster #${result.clusterId}.`);
  });

  test('creates no cluster when none of the tests failed in the cluster', async () => {
    expect(
      await tool('move_tests_to_new_cluster')(db as never, { clusterId: 2, testCaseIds: [1] }, maintainer),
    ).toEqual({ sourceClusterId: 2, movedTests: 0, remainingOccurrences: 1 });
  });

  test('refuses a read-only key and an empty test list; null for a cluster that does not exist', async () => {
    await expect(
      tool('move_tests_to_new_cluster')(db as never, { clusterId: 1, testCaseIds: [2] }, viewer),
    ).rejects.toThrow(refused('triage:write'));
    await expect(
      tool('move_tests_to_new_cluster')(db as never, { clusterId: 1, testCaseIds: [] }, maintainer),
    ).rejects.toThrow('testCaseIds');
    expect(
      await tool('move_tests_to_new_cluster')(db as never, { clusterId: 99, testCaseIds: [2] }, maintainer),
    ).toBeNull();
    expect(await db.select().from(schema.failureClusters)).toHaveLength(3);
  });
});
