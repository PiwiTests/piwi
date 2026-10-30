import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { locatorSignatureFromExpression } from '#shared/locator-healing';
import { migrateToLatest } from './temp-db';

/**
 * Hand-back outcomes against an in-memory SQLite database: the write path and
 * its idempotency, the daily counters kept when retention prunes rows, the
 * decisions people record, and the outcomes a run shows with no client call.
 */

vi.mock('../../server/utils/scm', () => ({
  createScmProvider: async () => null,
  resolveScmToken: async () => null,
  scmProviderForUrl: () => null,
}));
// The flaky analysis behind the quarantine candidates, when a test sets it.
const flaky = vi.hoisted(() => ({ tests: null as Array<Record<string, unknown>> | null }));
vi.mock('#shared/handlers/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#shared/handlers/projects')>();
  return {
    ...actual,
    getProjectFlakyTests: (async (...args: Parameters<typeof actual.getProjectFlakyTests>) =>
      flaky.tests ?? actual.getProjectFlakyTests(...args)) as typeof actual.getProjectFlakyTests,
  };
});

// The schema barrel picks the PostgreSQL schema at import time when
// PIWI_DATABASE_URL is set, so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { recordOutcome, listOutcomes, readOutcomeCounts, pruneOutcomesOlderThan } =
  await import('../../server/utils/outcomes');
const { inferRunOutcomes, locatorHealKey } = await import('../../server/utils/outcome-inference');
const { getLocatorHealing } = await import('../../server/utils/locator-healing');
const { approveMergeSuggestion, recordMergeSuggestion, rejectMergeSuggestion } =
  await import('#shared/handlers/cluster-merge-suggestions');
const { splitFailureCluster } = await import('#shared/handlers/failure-cluster-ops');
const { addQuarantine, releaseQuarantine, dismissQuarantineProposal, RELEASE_AFTER_CONSECUTIVE_PASSES } =
  await import('#shared/handlers/quarantine');
const { issueScenarioDraft } = await import('#shared/handlers/scenario-gaps');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let tmpDir: string;
let client: ReturnType<typeof createClient>;
let runSeq = 0;

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 5, 1);

async function insertRun(opts: { origin?: string; status?: string; startTime?: Date; commit?: string } = {}) {
  const id = ++runSeq;
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status: opts.status ?? 'passed',
    startTime: opts.startTime ?? new Date(T0 + id * 3_600_000),
    branch: 'main',
    metadata: {
      scm: { commit: opts.commit ?? `c${id}`, branch: 'main' },
      ...(opts.origin ? { piwiOrigin: { kind: opts.origin } } : {}),
    },
  });
  return id;
}

async function insertCase(runId: number, testCaseId: number, status: string, extra: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(schema.testRunsCases)
    .values({ testRunId: runId, testCaseId, status, ...extra })
    .returning({ id: schema.testRunsCases.id });
  return row!.id;
}

const outcomesOf = async (kind?: string) =>
  (await db.select().from(schema.handbackOutcomes).orderBy(schema.handbackOutcomes.id))
    .filter((o) => !kind || o.kind === kind)
    .map((o) => ({ subjectId: o.subjectId, outcome: o.outcome, runId: o.runId, channel: o.channel }));

beforeEach(async () => {
  // A file database: libSQL runs a transaction on its own connection, which an
  // in-memory database does not share.
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-outcomes-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrateToLatest(db);
  runSeq = 0;
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.users).values({ id: 7, username: 'ada', password: 'x', role: 'member' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'refunds' },
  ]);
});

afterEach(() => {
  flaky.tests = null;
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('recordOutcome', () => {
  const input = {
    projectId: 1,
    kind: 'merge-suggestion' as const,
    subjectType: 'cluster' as const,
    subjectId: 5,
    suggestionKey: '5+9',
    outcome: 'rejected' as const,
  };

  test('records once per kind, subject, suggestion, outcome and run', async () => {
    expect(await recordOutcome(db as never, input)).toBe(true);
    expect(await recordOutcome(db as never, input)).toBe(false);
    const run = await insertRun();
    expect(await recordOutcome(db as never, { ...input, runId: run })).toBe(true);
    expect(await recordOutcome(db as never, { ...input, runId: run })).toBe(false);
    expect(await recordOutcome(db as never, { ...input, outcome: 'applied' })).toBe(true);
    expect(await recordOutcome(db as never, { ...input, suggestionKey: '5+10' })).toBe(true);
    expect((await listOutcomes(db as never, { projectId: 1 })).length).toBe(4);
  });

  test('an outcome read from the runs has no actor; a reported one keeps its channel and user', async () => {
    await recordOutcome(db as never, input);
    await recordOutcome(db as never, { ...input, outcome: 'applied', actor: { channel: 'mcp', userId: 7 } });
    // With authentication off the synthetic user has id 0, which no row has.
    await recordOutcome(db as never, { ...input, subjectId: 6, actor: { channel: 'ui', userId: 0 } });
    const rows = await listOutcomes(db as never, { kind: 'merge-suggestion' });
    expect(rows.map((r) => [r.subjectId, r.outcome, r.channel, r.actorUserId])).toEqual([
      [5, 'rejected', 'inferred', null],
      [5, 'applied', 'mcp', 7],
      [6, 'rejected', 'ui', null],
    ]);
  });
});

describe('daily counters and retention', () => {
  const at = (daysAgo: number) => new Date(T0 + 100 * DAY - daysAgo * DAY);
  const now = T0 + 100 * DAY;

  test('rows older than the cutoff are counted into the rollups before they are pruned, once', async () => {
    const keptRun = await insertRun({ startTime: at(60) });
    await db
      .update(schema.testRuns)
      .set({ keptAt: new Date(now) })
      .where(eq(schema.testRuns.id, keptRun));
    const goneRun = await insertRun({ startTime: at(60) });
    const base = {
      projectId: 1,
      kind: 'gap-draft' as const,
      subjectType: 'gap' as const,
      outcome: 'suggested' as const,
    };
    await recordOutcome(db as never, { ...base, subjectId: 1, at: at(50) });
    await recordOutcome(db as never, { ...base, subjectId: 2, at: at(50), actor: { channel: 'ui' } });
    await recordOutcome(db as never, { ...base, subjectId: 3, at: at(50), runId: goneRun });
    // Its run was pruned with no foreign-key action, as on a connection that does not enforce them.
    await db.run(sql`PRAGMA foreign_keys = OFF`);
    await db.delete(schema.testRuns).where(eq(schema.testRuns.id, goneRun));
    await db.run(sql`PRAGMA foreign_keys = ON`);
    // Its run is kept, so it stays.
    await recordOutcome(db as never, { ...base, subjectId: 4, at: at(50), runId: keptRun });
    await recordOutcome(db as never, { ...base, subjectId: 5, at: at(2) });

    const range = { projectIds: [1], fromDay: '2026-01-01', toDay: '2026-12-31' };
    const before = await readOutcomeCounts(db as never, range);

    expect(await pruneOutcomesOlderThan(db as never, 30, now)).toBe(3);
    expect(await pruneOutcomesOlderThan(db as never, 30, now)).toBe(0);

    expect((await listOutcomes(db as never, { kind: 'gap-draft' })).map((r) => r.subjectId)).toEqual([4, 5]);
    expect(await readOutcomeCounts(db as never, range)).toEqual(before);
    const day = at(50).toISOString().slice(0, 10);
    expect(before.filter((c) => c.day === day)).toEqual([
      { projectId: 1, day, kind: 'gap-draft', outcome: 'suggested', channel: 'inferred', count: 3 },
      { projectId: 1, day, kind: 'gap-draft', outcome: 'suggested', channel: 'ui', count: 1 },
    ]);
  });

  test('a deleted run leaves its outcomes with no run pointer', async () => {
    const { deleteRunsByIds } = await import('../../server/utils/retention');
    const run = await insertRun();
    await recordOutcome(db as never, {
      projectId: 1,
      kind: 'bug-spec',
      subjectType: 'bug-report',
      subjectId: 1,
      outcome: 'applied',
      runId: run,
    });
    await deleteRunsByIds(db as never, [run]);
    expect((await listOutcomes(db as never, {})).map((r) => r.runId)).toEqual([null]);
  });
});

describe('merge suggestions', () => {
  beforeEach(async () => {
    const run = await insertRun();
    await db.insert(schema.failureClusters).values(
      [1, 2, 3, 4, 5, 6].map((id) => ({
        id,
        projectId: 1,
        fingerprint: `fp-${id}`,
        signature: `Error ${id}`,
        errorType: 'unknown',
        firstSeenRunId: run,
        lastSeenRunId: run,
      })),
    );
  });

  test('an approval records applied before the merge deletes the suggestion; a rejection records rejected', async () => {
    const [approved] = await db
      .insert(schema.clusterMergeSuggestions)
      .values({ projectId: 1, clusterAId: 1, clusterBId: 2, method: 'embedding', status: 'pending' })
      .returning();
    const [rejected] = await db
      .insert(schema.clusterMergeSuggestions)
      .values({ projectId: 1, clusterAId: 3, clusterBId: 4, method: 'llm', status: 'pending' })
      .returning();

    expect(await approveMergeSuggestion(db as never, approved!.id, { channel: 'ui', userId: 7 })).toEqual({
      survivorId: 1,
    });
    expect(await rejectMergeSuggestion(db as never, rejected!.id, { channel: 'mcp', userId: 7 })).toBe(true);
    // A second decision on the same suggestion finds nothing pending.
    expect(await rejectMergeSuggestion(db as never, rejected!.id, { channel: 'mcp', userId: 7 })).toBe(false);

    const rows = await listOutcomes(db as never, { kind: 'merge-suggestion' });
    expect(rows.map((r) => [r.subjectId, r.suggestionKey, r.outcome, r.channel, r.actorUserId])).toEqual([
      [1, '1+2', 'applied', 'ui', 7],
      [3, '3+4', 'rejected', 'mcp', 7],
    ]);
  });

  test('a model "no" and a hand split are not a person rejecting a suggestion', async () => {
    const run = (await db.select({ id: schema.testRuns.id }).from(schema.testRuns))[0]!.id;
    await insertCase(run, 1, 'failed', { failureClusterId: 3, error: 'Error 3' });
    await insertCase(run, 2, 'failed', { failureClusterId: 3, error: 'Error 3' });
    // The adjudicator's "no" is stored as declined; moving tests to a new cluster stores a rejected pair.
    await recordMergeSuggestion(db as never, {
      projectId: 1,
      clusterAId: 5,
      clusterBId: 6,
      method: 'llm',
      status: 'declined',
    });
    const split = await splitFailureCluster(db as never, 3, [2], 'moved by hand');
    expect(split?.clusterId).not.toBeNull();
    const pairs = await db.select().from(schema.clusterMergeSuggestions);
    expect(pairs.map((p) => p.status).sort()).toEqual(['declined', 'rejected']);
    expect(await outcomesOf('merge-suggestion')).toEqual([]);
  });
});

describe('quarantine proposals', () => {
  test('quarantining a proposed test applies the proposal; a manual quarantine is no hand-back', async () => {
    await insertRun();
    await addQuarantine(db as never, 1, 1, { source: 'proposed', createdBy: 7 });
    await addQuarantine(db as never, 1, 2, { source: 'manual', createdBy: 7 });
    const rows = await listOutcomes(db as never, { kind: 'quarantine-proposal' });
    expect(rows.map((r) => [r.subjectId, r.suggestionKey, r.outcome, r.channel, r.actorUserId])).toEqual([
      [1, 'quarantine', 'applied', 'ui', 7],
    ]);
  });

  test('releasing a test whose streak earned it applies the release proposal; an early release does not', async () => {
    await insertRun();
    await addQuarantine(db as never, 1, 1);
    await addQuarantine(db as never, 1, 2);
    for (let i = 0; i < RELEASE_AFTER_CONSECUTIVE_PASSES; i++) {
      const run = await insertRun();
      await insertCase(run, 1, 'passed');
      await insertCase(run, 2, i === 0 ? 'failed' : 'passed');
    }
    await releaseQuarantine(db as never, 1, 1, null, { channel: 'ui', userId: 7 });
    await releaseQuarantine(db as never, 1, 2, null, { channel: 'ui', userId: 7 });

    const rows = await listOutcomes(db as never, { kind: 'quarantine-proposal' });
    expect(rows.map((r) => [r.subjectId, r.outcome, r.details?.reason])).toEqual([[1, 'applied', 'streak']]);
    expect(rows[0]!.suggestionKey).toMatch(/^release:\d+$/);
  });

  test('a person dismissing a proposal records rejected with the reason, once', async () => {
    flaky.tests = [{ testCaseId: 1, title: 'pays', filePath: 'tests/checkout.spec.ts', score: 60, wastedCiMinutes: 4 }];
    await insertRun();
    await addQuarantine(db as never, 1, 2);
    for (let i = 0; i < RELEASE_AFTER_CONSECUTIVE_PASSES; i++) await insertCase(await insertRun(), 2, 'passed');
    const actor = { channel: 'ui' as const, userId: 7 };
    expect(await dismissQuarantineProposal(db as never, 1, 1, 'quarantine', actor, ' The fix is in review ')).toBe(
      true,
    );
    expect(await dismissQuarantineProposal(db as never, 1, 1, 'quarantine', actor)).toBe(true);
    expect(await dismissQuarantineProposal(db as never, 1, 2, 'release', actor)).toBe(true);
    // Nothing to dismiss: the test is not quarantined, or already is.
    expect(await dismissQuarantineProposal(db as never, 1, 1, 'release', actor)).toBe(false);
    expect(await dismissQuarantineProposal(db as never, 1, 2, 'quarantine', actor)).toBe(false);

    const rows = await listOutcomes(db as never, { kind: 'quarantine-proposal' });
    expect(
      rows.map((r) => [r.subjectId, r.outcome, r.suggestionKey.split(':')[0], r.channel, r.actorUserId, r.details]),
    ).toEqual([
      [1, 'rejected', 'quarantine', 'ui', 7, { reason: 'The fix is in review' }],
      [2, 'rejected', 'release', 'ui', 7, null],
    ]);
    // The candidate was dismissed at the newest run.
    expect(rows[0]!.runId).toBe(runSeq);
  });

  test('only a standing proposal can be dismissed, and only for a test of the project', async () => {
    flaky.tests = [];
    await insertRun();
    await addQuarantine(db as never, 1, 2);
    const actor = { channel: 'mcp' as const, userId: 7 };
    // Test 1 is no candidate; test 2 has no passing streak yet.
    expect(await dismissQuarantineProposal(db as never, 1, 1, 'quarantine', actor)).toBe(false);
    expect(await dismissQuarantineProposal(db as never, 1, 2, 'release', actor)).toBe(false);
    await expect(dismissQuarantineProposal(db as never, 1, 99, 'quarantine', actor)).rejects.toThrow(
      'Test case not found in this project',
    );
    expect(await listOutcomes(db as never, { kind: 'quarantine-proposal' })).toEqual([]);
  });
});

describe('gap drafts', () => {
  test('an issued draft records suggested, once per draft text', async () => {
    const [gap] = await db
      .insert(schema.scenarioGaps)
      .values({
        projectId: 1,
        detector: 'success-only',
        class: 'blind-spot',
        key: 'GET /api/cart',
        title: 'Cart errors are never tested',
        status: 'open',
      })
      .returning({ id: schema.scenarioGaps.id });
    const actor = { channel: 'ui' as const, userId: 7 };
    expect(await issueScenarioDraft(db as never, 1, gap!.id, actor)).not.toBeNull();
    await issueScenarioDraft(db as never, 1, gap!.id, { channel: 'mcp' });
    expect(await issueScenarioDraft(db as never, 1, gap!.id + 1, actor)).toBeNull();

    const rows = await listOutcomes(db as never, { kind: 'gap-draft' });
    expect(rows.map((r) => [r.subjectType, r.subjectId, r.outcome, r.channel])).toEqual([
      ['gap', gap!.id, 'suggested', 'ui'],
    ]);
  });
});

// ── Outcomes a run shows ────────────────────────────────────────────────────

const FAILING = "getByRole('button', { name: 'Pay' })";
const RECOMMENDED = "getByTestId('pay-btn')";
const CALL_SITE = 'tests/checkout.spec.ts:42:5';
const failingError = `TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for ${FAILING}\n    at ${CALL_SITE}`;

/** A snapshot of a call site, as the capture fixtures store it. */
async function upsertSnapshot(o: { location: string; usedArgsFp: string; runId: number; testCaseId?: number }) {
  const values = {
    testCaseId: o.testCaseId ?? 1,
    location: o.location,
    usedMethod: 'getByTestId',
    usedArgs: '[]',
    usedArgsFp: o.usedArgsFp,
    elementTag: 'button',
    elementAttrs: '{}',
    elementText: 'Pay',
    alternatives: JSON.stringify([
      { locator: RECOMMENDED, method: 'getByTestId', args: { testId: 'pay-btn' }, score: 100 },
    ]),
    lastSeenRunId: o.runId,
    lastSeenAt: new Date(),
  };
  await db
    .insert(schema.locatorSnapshots)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.locatorSnapshots.testCaseId, schema.locatorSnapshots.location],
      set: { usedArgsFp: o.usedArgsFp, lastSeenRunId: o.runId },
    });
}

describe('locator heals', () => {
  let failingSig: string;
  let recommendedSig: string;

  beforeEach(async () => {
    failingSig = await locatorSignatureFromExpression(FAILING);
    recommendedSig = await locatorSignatureFromExpression(RECOMMENDED);
  });

  /** A prior pass captured the call site; then run `failing` fails at it. */
  async function failAtCallSite() {
    const green = await insertRun();
    await insertCase(green, 1, 'passed');
    await upsertSnapshot({ location: CALL_SITE, usedArgsFp: failingSig, runId: green });
    const failing = await insertRun({ status: 'failed' });
    const executionId = await insertCase(failing, 1, 'failed', { error: failingError });
    await inferRunOutcomes(db as never, failing);
    return { failing, executionId };
  }

  test('a heal applied by hand and pushed: the next run records applied, the run after it verified', async () => {
    const { failing, executionId } = await failAtCallSite();
    expect(await outcomesOf('locator-heal')).toEqual([
      { subjectId: 1, outcome: 'suggested', runId: failing, channel: 'inferred' },
    ]);
    const [suggested] = await listOutcomes(db as never, { kind: 'locator-heal' });
    expect(suggested!.suggestionKey).toBe(locatorHealKey(CALL_SITE, failingSig, recommendedSig));
    expect(suggested!.details).toMatchObject({ recommendedLocator: RECOMMENDED, failingRunId: failing });

    // The developer edits the line by hand; the next CI run captures the new locator at the same call site.
    const pushed = await insertRun();
    await insertCase(pushed, 1, 'passed');
    await upsertSnapshot({ location: CALL_SITE, usedArgsFp: recommendedSig, runId: pushed });
    await inferRunOutcomes(db as never, pushed);

    const next = await insertRun();
    await insertCase(next, 1, 'passed');
    await inferRunOutcomes(db as never, next);

    // Finalizing again records nothing twice.
    await inferRunOutcomes(db as never, pushed);
    await inferRunOutcomes(db as never, next);

    expect(await outcomesOf('locator-heal')).toEqual([
      { subjectId: 1, outcome: 'suggested', runId: failing, channel: 'inferred' },
      { subjectId: 1, outcome: 'applied', runId: pushed, channel: 'inferred' },
      { subjectId: 1, outcome: 'verified', runId: next, channel: 'inferred' },
    ]);
    const applied = (await listOutcomes(db as never, { kind: 'locator-heal', outcomes: ['applied'] }))[0]!;
    expect(applied.details).toMatchObject({ label: 'matched-recommendation', appliedRunId: pushed });

    // The failure's panel reads the stored run, not a recomputation.
    expect((await getLocatorHealing(db as never, executionId)).healedInRunId).toBe(pushed);
  });

  test('another call site of the same test using the recommendation is not an applied heal', async () => {
    await failAtCallSite();
    const later = await insertRun();
    await insertCase(later, 1, 'passed');
    await upsertSnapshot({ location: 'tests/checkout.spec.ts:80:3', usedArgsFp: recommendedSig, runId: later });
    await inferRunOutcomes(db as never, later);
    expect((await outcomesOf('locator-heal')).map((o) => o.outcome)).toEqual(['suggested']);
  });

  test('an earlier run never counts as the heal', async () => {
    const { failing } = await failAtCallSite();
    // A run with a lower id than the failing one (imported later) carries the recommended locator.
    await db.insert(schema.testRuns).values({ id: 100, projectId: 1, status: 'passed', startTime: new Date(T0) });
    await db
      .update(schema.handbackOutcomes)
      .set({ details: { ...(await listOutcomes(db as never, {}))[0]!.details, failingRunId: 200 } })
      .where(eq(schema.handbackOutcomes.runId, failing));
    await insertCase(100, 1, 'passed');
    await upsertSnapshot({ location: CALL_SITE, usedArgsFp: recommendedSig, runId: 100 });
    await inferRunOutcomes(db as never, 100);
    expect((await outcomesOf('locator-heal')).map((o) => o.outcome)).toEqual(['suggested']);
  });

  test.each(['flake-lab', 'probe', 'bisect', 'reproduce'])('a %s run records no heal outcome', async (origin) => {
    await failAtCallSite();
    const lab = await insertRun({ origin });
    await insertCase(lab, 1, 'passed');
    await upsertSnapshot({ location: CALL_SITE, usedArgsFp: recommendedSig, runId: lab });
    await inferRunOutcomes(db as never, lab);
    const labFailing = await insertRun({ origin, status: 'failed' });
    await insertCase(labFailing, 2, 'failed', { error: failingError });
    await inferRunOutcomes(db as never, labFailing);
    expect((await outcomesOf('locator-heal')).map((o) => o.outcome)).toEqual(['suggested']);
  });
});

describe('auto-heal pull requests', () => {
  test('the first run after the merge that passes every healed test verifies the PR', async () => {
    const mergedAt = new Date(T0 + 10 * 3_600_000);
    await recordOutcome(db as never, {
      projectId: 1,
      kind: 'auto-heal-pr',
      subjectType: 'heal-action',
      subjectId: 3,
      suggestionKey: 'heal:v1:1:abc',
      outcome: 'applied',
      details: { prNumber: 41, testCaseIds: [1, 2] },
      at: mergedAt,
    });
    // Started before the merge was seen.
    const before = await insertRun({ startTime: new Date(mergedAt.getTime() - 60_000) });
    await insertCase(before, 1, 'passed');
    await insertCase(before, 2, 'passed');
    // One healed test still fails.
    const partly = await insertRun({ startTime: new Date(mergedAt.getTime() + 60_000) });
    await insertCase(partly, 1, 'passed');
    await insertCase(partly, 2, 'failed');
    const lab = await insertRun({ origin: 'flake-lab', startTime: new Date(mergedAt.getTime() + 90_000) });
    await insertCase(lab, 1, 'passed');
    await insertCase(lab, 2, 'passed');
    const green = await insertRun({ startTime: new Date(mergedAt.getTime() + 120_000) });
    await insertCase(green, 1, 'passed');
    await insertCase(green, 2, 'passed');
    const later = await insertRun({ startTime: new Date(mergedAt.getTime() + 180_000) });
    await insertCase(later, 1, 'passed');
    await insertCase(later, 2, 'passed');

    for (const run of [before, partly, lab, green, later, green]) await inferRunOutcomes(db as never, run);

    expect(await outcomesOf('auto-heal-pr')).toEqual([
      { subjectId: 3, outcome: 'applied', runId: null, channel: 'inferred' },
      { subjectId: 3, outcome: 'verified', runId: green, channel: 'inferred' },
    ]);
  });
});

describe('Flake Lab verified fixes', () => {
  test("the test's next retry-pass after the verified fix regresses it, once", async () => {
    const verifiedAt = new Date(T0 + 5 * 3_600_000);
    await recordOutcome(db as never, {
      projectId: 1,
      kind: 'flake-verify',
      subjectType: 'test-case',
      subjectId: 1,
      suggestionKey: 'experiment:9',
      outcome: 'verified',
      actor: { channel: 'cli' },
      at: verifiedAt,
    });
    const retryPass = async (opts: { origin?: string; startTime: Date }) => {
      const run = await insertRun(opts);
      await insertCase(run, 1, 'failed', { browser: { projectName: 'chromium' } });
      await insertCase(run, 1, 'passed', { browser: { projectName: 'chromium' } });
      return run;
    };
    const before = await retryPass({ startTime: new Date(verifiedAt.getTime() - 60_000) });
    const lab = await retryPass({ origin: 'flake-lab', startTime: new Date(verifiedAt.getTime() + 30_000) });
    // A failure in one browser and a pass in another is not a retry-pass.
    const split = await insertRun({ startTime: new Date(verifiedAt.getTime() + 45_000) });
    await insertCase(split, 1, 'failed', { browser: { projectName: 'chromium' } });
    await insertCase(split, 1, 'passed', { browser: { projectName: 'firefox' } });
    const flaked = await retryPass({ startTime: new Date(verifiedAt.getTime() + 60_000) });
    const again = await retryPass({ startTime: new Date(verifiedAt.getTime() + 120_000) });

    for (const run of [before, lab, split, flaked, again, flaked]) await inferRunOutcomes(db as never, run);

    expect(await outcomesOf('flake-verify')).toEqual([
      { subjectId: 1, outcome: 'verified', runId: null, channel: 'cli' },
      { subjectId: 1, outcome: 'regressed', runId: flaked, channel: 'inferred' },
    ]);
  });
});
