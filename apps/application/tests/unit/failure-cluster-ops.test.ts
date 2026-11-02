import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';
import { migrateToLatest } from './temp-db';

declare global {
  // Exposed when the test process runs with `--expose-gc` (the unit-test scripts set it).
  var gc: (() => void) | undefined;
}

delete process.env.PIWI_DATABASE_URL;

const {
  getOrCreateFailureClusters,
  transitionClusterStatus,
  recomputeClusterOccurrences,
  mergeFailureClusters,
  mergedTriage,
} = await import('../../shared/handlers/failure-cluster-ops');
const { approveMergeSuggestion, recordMergeSuggestion } =
  await import('../../shared/handlers/cluster-merge-suggestions');
const { computeErrorFingerprint } = await import('../../shared/error-fingerprint');

// The call log and the stack are excluded from the fingerprint (extractMessageHead
// stops at them), so these two errors share a fingerprint while differing as
// display exemplars: `richError` carries a Call log, `plainError` does not.
const HEAD = [
  'Error: expect(locator).toBeEnabled() failed',
  "Locator: getByRole('button', { name: 'Pay' })",
  'Expected: enabled',
  'Received: disabled',
].join('\n');
const plainError = `${HEAD}\n    at checkout.spec.ts:42:10`;
const richError = `${HEAD}\n\nCall log:\n  - waiting for the button to be enabled\n  - element is not enabled\n    at checkout.spec.ts:42:10`;

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let tmpDir: string;
let client: ReturnType<typeof createClient>;

async function pendingFor(error: string) {
  const fp = await computeErrorFingerprint(error);
  return { map: new Map([[fp.fingerprint, { fp, sampleError: error, count: 1 }]]), fp };
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-cluster-ops-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrateToLatest(db);
  dbc = db as unknown as DbClient;
  await db.insert(schema.projects).values({ id: 1, name: 'p1' });
});

afterEach(async () => {
  await client.close();
  globalThis.gc?.();
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' || attempt >= 40) throw error;
      if (!globalThis.gc) {
        const junk: Buffer[] = [];
        for (let i = 0; i < 60; i++) junk.push(Buffer.alloc(1 << 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
});

function readCluster(id: number) {
  return db
    .select({
      fingerprint: schema.failureClusters.fingerprint,
      fingerprintSample: schema.failureClusters.fingerprintSample,
      sampleError: schema.failureClusters.sampleError,
      signature: schema.failureClusters.signature,
      occurrences: schema.failureClusters.occurrences,
      lastSeenRunId: schema.failureClusters.lastSeenRunId,
      firstSeenRunId: schema.failureClusters.firstSeenRunId,
    })
    .from(schema.failureClusters)
    .where(eq(schema.failureClusters.id, id))
    .then((r) => r[0]!);
}

describe('getOrCreateFailureClusters exemplar refresh', () => {
  test('seeds fingerprintSample from the creation error', async () => {
    const { map, fp } = await pendingFor(plainError);
    const ids = await getOrCreateFailureClusters(dbc, 1, 100, map);
    const row = await readCluster(ids.get(fp.fingerprint)!);
    expect(row.sampleError).toBe(plainError);
    expect(row.fingerprintSample).toBe(plainError);
    expect(row.occurrences).toBe(1);
  });

  test('refreshes the display exemplar when a better occurrence recurs, leaving the fingerprint source frozen', async () => {
    const created = await pendingFor(plainError);
    const ids = await getOrCreateFailureClusters(dbc, 1, 100, created.map);
    const clusterId = ids.get(created.fp.fingerprint)!;

    const better = await pendingFor(richError);
    // Same root cause ⇒ same fingerprint ⇒ same cluster.
    expect(better.fp.fingerprint).toBe(created.fp.fingerprint);

    await getOrCreateFailureClusters(dbc, 1, 200, better.map);
    const row = await readCluster(clusterId);

    // Display sample moved to the richer occurrence…
    expect(row.sampleError).toBe(richError);
    // …but the fingerprint source and the fingerprint itself did not.
    expect(row.fingerprintSample).toBe(plainError);
    expect(row.fingerprint).toBe(created.fp.fingerprint);
    expect(row.occurrences).toBe(2);
    expect(row.lastSeenRunId).toBe(200);
  });

  test('keeps the current exemplar for an equal-or-worse occurrence (stability), still counting it', async () => {
    const created = await pendingFor(richError);
    const ids = await getOrCreateFailureClusters(dbc, 1, 100, created.map);
    const clusterId = ids.get(created.fp.fingerprint)!;

    const worse = await pendingFor(plainError);
    await getOrCreateFailureClusters(dbc, 1, 200, worse.map);
    const row = await readCluster(clusterId);

    expect(row.sampleError).toBe(richError); // unchanged — the current one is better
    expect(row.fingerprintSample).toBe(richError);
    expect(row.occurrences).toBe(2); // still counted
    expect(row.lastSeenRunId).toBe(200);
  });
});

describe('getOrCreateFailureClusters first and last seen runs', () => {
  const run = (id: number, startTime: string) => ({
    id,
    projectId: 1,
    status: 'failed',
    startTime: new Date(startTime),
  });

  test('a run imported from the past moves the first seen run back and leaves the last seen run', async () => {
    await db
      .insert(schema.testRuns)
      .values([run(10, '2026-10-01T10:00:00Z'), run(11, '2026-10-17T10:00:00Z'), run(12, '2026-08-01T10:00:00Z')]);
    const { map, fp } = await pendingFor(plainError);
    const ids = await getOrCreateFailureClusters(dbc, 1, 10, map);
    const clusterId = ids.get(fp.fingerprint)!;

    await getOrCreateFailureClusters(dbc, 1, 11, (await pendingFor(plainError)).map);
    expect(await readCluster(clusterId)).toMatchObject({ firstSeenRunId: 10, lastSeenRunId: 11 });

    // Run 12 has a higher id but started two months earlier.
    await getOrCreateFailureClusters(dbc, 1, 12, (await pendingFor(plainError)).map);
    expect(await readCluster(clusterId)).toMatchObject({ firstSeenRunId: 12, lastSeenRunId: 11, occurrences: 3 });
  });
});

describe('getOrCreateFailureClusters and runs that do not make a cluster recur', () => {
  async function insertRun(id: number, origin: string, startTime: string) {
    await db.insert(schema.testRuns).values({
      id,
      projectId: 1,
      status: 'failed',
      startTime: new Date(startTime),
      origin,
      metadata: { piwiOrigin: { kind: origin } },
    });
  }

  test.each(['editor', 'bisect', 'reproduce'])(
    'a %s run joins the cluster without counting, moving it or waking its snooze',
    async (origin) => {
      await insertRun(10, 'ci', '2026-10-01T10:00:00Z');
      await insertRun(11, origin, '2026-10-02T10:00:00Z');
      await insertRun(12, 'ci', '2026-10-03T10:00:00Z');
      const { map, fp } = await pendingFor(plainError);
      const clusterId = (await getOrCreateFailureClusters(dbc, 1, 10, map)).get(fp.fingerprint)!;
      const snoozedUntil = new Date('9999-01-01T00:00:00Z');
      await db
        .update(schema.failureClusters)
        .set({ snoozedUntil, snoozeMode: 'until-recurs' })
        .where(eq(schema.failureClusters.id, clusterId));
      const snooze = async () =>
        (
          await db
            .select({ snoozedUntil: schema.failureClusters.snoozedUntil })
            .from(schema.failureClusters)
            .where(eq(schema.failureClusters.id, clusterId))
        )[0]!.snoozedUntil;

      const joined = await getOrCreateFailureClusters(dbc, 1, 11, (await pendingFor(plainError)).map);
      expect(joined.get(fp.fingerprint)).toBe(clusterId);
      expect(await readCluster(clusterId)).toMatchObject({ occurrences: 1, lastSeenRunId: 10 });
      expect(await snooze()).toEqual(snoozedUntil);

      await getOrCreateFailureClusters(dbc, 1, 12, (await pendingFor(plainError)).map);
      expect(await readCluster(clusterId)).toMatchObject({ occurrences: 2, lastSeenRunId: 12 });
      expect(await snooze()).toBeNull();
    },
  );

  test('recounting the occurrences leaves out the runs that do not count', async () => {
    await insertRun(10, 'ci', '2026-10-01T10:00:00Z');
    await insertRun(11, 'editor', '2026-10-02T10:00:00Z');
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, title: 'pays', filePath: 'a.spec.ts' });
    const { map, fp } = await pendingFor(plainError);
    const clusterId = (await getOrCreateFailureClusters(dbc, 1, 10, map)).get(fp.fingerprint)!;
    await db.insert(schema.testRunsCases).values([
      { testRunId: 10, testCaseId: 1, status: 'failed', failureClusterId: clusterId },
      { testRunId: 11, testCaseId: 1, status: 'failed', failureClusterId: clusterId },
    ]);
    expect(await recomputeClusterOccurrences(dbc, clusterId)).toBe(1);
  });
});

describe('getOrCreateFailureClusters on a triaged cluster', () => {
  test('a new occurrence leaves the moment a resolved cluster was resolved, and touches an open one', async () => {
    const { map, fp } = await pendingFor(plainError);
    const clusterId = (await getOrCreateFailureClusters(dbc, 1, 100, map)).get(fp.fingerprint)!;
    const resolvedAt = new Date('2026-10-01T10:00:00Z');
    await db
      .update(schema.failureClusters)
      .set({ status: 'resolved', updatedAt: resolvedAt })
      .where(eq(schema.failureClusters.id, clusterId));
    const updatedAt = async () =>
      (
        await db
          .select({ updatedAt: schema.failureClusters.updatedAt })
          .from(schema.failureClusters)
          .where(eq(schema.failureClusters.id, clusterId))
      )[0]!.updatedAt;

    await getOrCreateFailureClusters(dbc, 1, 200, (await pendingFor(plainError)).map);
    expect(await updatedAt()).toEqual(resolvedAt);
    expect((await readCluster(clusterId)).occurrences).toBe(2);

    await db.update(schema.failureClusters).set({ status: 'open' }).where(eq(schema.failureClusters.id, clusterId));
    await getOrCreateFailureClusters(dbc, 1, 300, (await pendingFor(plainError)).map);
    expect((await updatedAt()).getTime()).toBeGreaterThan(resolvedAt.getTime());
  });
});

describe('transitionClusterStatus', () => {
  async function insertCluster(status: string, triageNote: string | null) {
    const [row] = await db
      .insert(schema.failureClusters)
      .values({
        projectId: 1,
        fingerprint: `fp-${status}-${triageNote}`,
        signature: 'Error: broken',
        firstSeenRunId: 1,
        lastSeenRunId: 1,
        status,
        triageNote,
      })
      .returning({ id: schema.failureClusters.id });
    return row!.id;
  }
  async function triage(id: number) {
    const [row] = await db
      .select({ status: schema.failureClusters.status, triageNote: schema.failureClusters.triageNote })
      .from(schema.failureClusters)
      .where(eq(schema.failureClusters.id, id));
    return row;
  }
  const resolve = { from: 'open', to: 'resolved', line: 'Resolved automatically: PROJ-1 is Done' };

  test('moves a cluster still in the status it expects, the line below what a person wrote', async () => {
    const id = await insertCluster('open', '  Looking into it  ');
    expect(await transitionClusterStatus(dbc, id, resolve)).toBe(true);
    expect(await triage(id)).toEqual({
      status: 'resolved',
      triageNote: 'Looking into it\nResolved automatically: PROJ-1 is Done',
    });

    const blank = await insertCluster('open', '   ');
    await transitionClusterStatus(dbc, blank, resolve);
    expect((await triage(blank))?.triageNote).toBe('Resolved automatically: PROJ-1 is Done');
  });

  test('leaves a cluster a person moved to another status', async () => {
    const id = await insertCluster('ignored', 'Known, ignore');
    expect(await transitionClusterStatus(dbc, id, resolve)).toBe(false);
    expect(await triage(id)).toEqual({ status: 'ignored', triageNote: 'Known, ignore' });
  });

  test('moves only when the extra condition holds', async () => {
    const id = await insertCluster('open', null);
    expect(await transitionClusterStatus(dbc, id, { ...resolve, where: sql`1 = 0` })).toBe(false);
    expect(await triage(id)).toEqual({ status: 'open', triageNote: null });
  });
});

describe('merging two clusters keeps their triage and history', () => {
  const now = new Date('2026-10-01T10:00:00Z');
  const later = new Date('2026-10-08T10:00:00Z');
  const triage = (status: string, more: Record<string, unknown> = {}) => ({
    status,
    assignee: null,
    triageNote: null,
    snoozedUntil: null,
    snoozeMode: null,
    ...more,
  });

  test('a live victim leaves the survivor open: its resolved or ignored status, or its snooze, cleared', () => {
    expect(mergedTriage(triage('resolved'), triage('open'), now)).toMatchObject({ status: 'open' });
    expect(mergedTriage(triage('ignored'), triage('open'), now)).toMatchObject({ status: 'open' });
    expect(
      mergedTriage(triage('open', { snoozedUntil: later, snoozeMode: 'until' }), triage('open'), now),
    ).toMatchObject({ status: 'open', snoozedUntil: null, snoozeMode: null });
  });

  test('a survivor stays as it is when the victim is not a live failure, or when it is one itself', () => {
    expect(mergedTriage(triage('ignored'), triage('resolved'), now).status).toBeUndefined();
    const snoozedVictim = triage('open', { snoozedUntil: later, snoozeMode: 'until' });
    expect(mergedTriage(triage('resolved'), snoozedVictim, now).status).toBeUndefined();
    expect(mergedTriage(triage('open'), triage('resolved'), now).status).toBeUndefined();
  });

  async function insertCluster(id: number, values: Record<string, unknown> = {}) {
    await db.insert(schema.failureClusters).values({
      id,
      projectId: 1,
      fingerprint: `fp-${id}`,
      signature: `Error: broken ${id}`,
      firstSeenRunId: 1,
      lastSeenRunId: 1,
      ...values,
    });
  }

  async function survivorTriage(id: number) {
    const [row] = await db
      .select({ assignee: schema.failureClusters.assignee, triageNote: schema.failureClusters.triageNote })
      .from(schema.failureClusters)
      .where(eq(schema.failureClusters.id, id));
    return row;
  }

  test("the survivor's assignee wins, else the victim's; a victim's note it lacks is appended", async () => {
    await insertCluster(1, { assignee: 'ada', triageNote: 'Cart API' });
    await insertCluster(2, { assignee: 'bob', triageNote: 'Flaky on CI' });
    await mergeFailureClusters(dbc, 1, 2);
    expect(await survivorTriage(1)).toEqual({ assignee: 'ada', triageNote: 'Cart API\nFlaky on CI' });

    await insertCluster(3, { triageNote: 'Cart API\nFlaky on CI' });
    await insertCluster(4, { assignee: 'bob', triageNote: 'Flaky on CI' });
    await mergeFailureClusters(dbc, 3, 4);
    expect(await survivorTriage(3)).toEqual({ assignee: 'bob', triageNote: 'Cart API\nFlaky on CI' });
  });

  test("the alias a merge records keeps the victim's fingerprint sample, else its display sample", async () => {
    await insertCluster(1);
    await insertCluster(2, { fingerprintSample: plainError, sampleError: richError });
    // A cluster stored before clusters kept their fingerprint sample, and one made by moving tests.
    await insertCluster(3, { sampleError: richError });
    await insertCluster(4, { fingerprint: 'split:moved', sampleError: plainError });

    for (const victim of [2, 3, 4]) await mergeFailureClusters(dbc, 1, victim);

    const aliases = await db
      .select({
        fingerprint: schema.failureClusterAliases.fingerprint,
        fingerprintSample: schema.failureClusterAliases.fingerprintSample,
        clusterId: schema.failureClusterAliases.clusterId,
      })
      .from(schema.failureClusterAliases)
      .orderBy(schema.failureClusterAliases.id);
    expect(aliases).toEqual([
      { fingerprint: 'fp-2', fingerprintSample: plainError, clusterId: 1 },
      { fingerprint: 'fp-3', fingerprintSample: richError, clusterId: 1 },
      { fingerprint: 'split:moved', fingerprintSample: null, clusterId: 1 },
    ]);
  });

  test('an assignee or a note line written to the survivor while the merge runs is kept', async () => {
    await insertCluster(1, { triageNote: 'Cart API' });
    await insertCluster(2, { assignee: 'bob', triageNote: 'Flaky on CI' });
    // Another connection's write committed between the merge's read of the survivor and its update, as PostgreSQL's
    // read committed isolation lets it: a trigger on the alias the merge records in between stands in for it.
    await client.execute(`CREATE TRIGGER concurrent_triage AFTER INSERT ON failure_cluster_aliases BEGIN
      UPDATE failure_clusters SET assignee = 'ada', triage_note = triage_note || char(10) || 'Reopened automatically: failed again in run #9'
      WHERE id = NEW.cluster_id;
    END`);
    await mergeFailureClusters(dbc, 1, 2);
    expect(await survivorTriage(1)).toEqual({
      assignee: 'ada',
      triageNote: 'Cart API\nReopened automatically: failed again in run #9\nFlaky on CI',
    });
  });

  test('the survivor takes the triage, fix attempts, tracker writes, agent calls and rejections of the victim', async () => {
    await insertCluster(1, { status: 'resolved', triageNote: 'Fixed by the cart refactor' });
    await insertCluster(2, { status: 'open', assignee: 'ada', triageNote: 'Still failing on staging' });
    await insertCluster(3);
    await db.insert(schema.handbackOutcomes).values({
      projectId: 1,
      kind: 'fix-attempt',
      subjectType: 'cluster',
      subjectId: 2,
      suggestionKey: 'patch:abc',
      outcome: 'applied',
      channel: 'mcp',
      dedupeKey: 'fix-attempt:2:patch:abc:applied',
    });
    const [connection] = await db
      .insert(schema.integrationConnections)
      .values({ provider: 'jira', name: 'Jira', baseUrl: 'https://example.atlassian.net' })
      .returning({ id: schema.integrationConnections.id });
    await db.insert(schema.integrationActions).values({
      connectionId: connection!.id,
      projectId: 1,
      kind: 'comment',
      entityType: 'failure_cluster',
      entityId: 2,
      dedupeKey: 'comment:failure_cluster:2:fixed:9',
      status: 'done',
      payload: { issueKey: 'PROJ-1' },
    });
    await db
      .insert(schema.mcpToolCalls)
      .values({ projectId: 1, tool: 'triage_cluster', subjectType: 'cluster', subjectId: 2, result: 'ok' });
    await db
      .insert(schema.clusterMergeSuggestions)
      .values({ projectId: 1, clusterAId: 2, clusterBId: 3, method: 'split', status: 'rejected' });

    await mergeFailureClusters(dbc, 1, 2);

    const [survivor] = await db.select().from(schema.failureClusters).where(eq(schema.failureClusters.id, 1));
    expect(survivor).toMatchObject({
      status: 'open',
      assignee: 'ada',
      triageNote: 'Fixed by the cart refactor\nStill failing on staging',
    });
    expect((await db.select().from(schema.handbackOutcomes)).map((o) => o.subjectId)).toEqual([1]);
    expect((await db.select().from(schema.integrationActions)).map((a) => a.entityId)).toEqual([1]);
    expect((await db.select().from(schema.mcpToolCalls)).map((c) => c.subjectId)).toEqual([1]);
    expect(
      (await db.select().from(schema.clusterMergeSuggestions)).map((p) => [p.clusterAId, p.clusterBId, p.status]),
    ).toEqual([[1, 3, 'rejected']]);
  });

  test('approving a suggestion applies the rule to the triage the clusters have when it is approved', async () => {
    await insertCluster(1, { status: 'resolved' });
    await insertCluster(2, { status: 'resolved' });
    await recordMergeSuggestion(dbc, { projectId: 1, clusterAId: 1, clusterBId: 2, method: 'embedding' });
    // The victim fails again after the suggestion was made.
    await db.update(schema.failureClusters).set({ status: 'open' }).where(eq(schema.failureClusters.id, 2));
    const [suggestion] = await db.select().from(schema.clusterMergeSuggestions);

    await approveMergeSuggestion(dbc, suggestion!.id);

    const [survivor] = await db.select().from(schema.failureClusters).where(eq(schema.failureClusters.id, 1));
    expect(survivor?.status).toBe('open');
  });
});
