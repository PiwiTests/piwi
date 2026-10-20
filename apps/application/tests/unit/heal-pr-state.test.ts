import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { ScmEntityState } from '../../server/utils/scm/ScmProvider';

const scm = vi.hoisted(() => ({
  /** Token per project; a project not listed has the default one. */
  tokens: {} as Record<number, string | null>,
  /** What the SCM reports for a PR number: a state, `'throw'` for a failing lookup. */
  prStates: {} as Record<number, ScmEntityState | 'throw'>,
  lookups: [] as number[],
}));

vi.mock('../../server/utils/scm', () => ({
  createScmProvider: vi.fn(),
  resolveScmToken: vi.fn(async (_db: unknown, projectId: number) =>
    projectId in scm.tokens ? scm.tokens[projectId] : 'token',
  ),
  scmProviderForUrl: vi.fn((repositoryUrl: string) => {
    if (repositoryUrl.includes('unsupported')) return null;
    return {
      async fetchPullRequest(number: number) {
        scm.lookups.push(number);
        const state = scm.prStates[number] ?? 'open';
        if (state === 'throw') throw new Error('SCM exploded');
        return { title: null, state, author: null, url: null, updatedAt: null };
      },
    };
  }),
}));

// The schema barrel picks the PostgreSQL schema at import time when
// PIWI_DATABASE_URL is set, so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { refreshOpenHealActions } = await import('../../server/utils/heal/pr-state');
const { hasOpenPrCapacity, queueHealAction } = await import('../../server/utils/heal/policy');
const { findHealActionForCallSite, mapHealActionsByCluster } = await import('../../server/utils/heal/lookup');
const { getAnalyticsProgress } = await import('../../shared/handlers/analytics/progress');
const { parseAnalyticsScope } = await import('../../shared/analytics/scope');
const { pruneHealActions } = await import('../../server/utils/retention');
const { recordOutcome, pruneOutcomesOlderThan } = await import('../../server/utils/outcomes');

/** Run the migration that records a `suggested` outcome for every heal PR opened before outcomes existed. */
async function backfillSuggestedOutcomes() {
  const file = new URL('../../server/database/migrations/0102_heal_pr_suggested_outcomes.sql', import.meta.url);
  await db.run(sql.raw(readFileSync(fileURLToPath(file), 'utf8')));
}

let db: ReturnType<typeof drizzle<typeof schema>>;
let seq = 0;

interface ActionSeed {
  projectId?: number;
  status?: string;
  /** Null seeds an action with no recorded PR. */
  prNumber?: number | null;
  repositoryUrl?: string;
  updatedAt?: Date;
  createdAt?: Date;
  filePath?: string;
  line?: number;
  clusterId?: number | null;
}

/** Insert one heal action and return its id and PR number. */
async function seedAction(seed: ActionSeed = {}): Promise<{ id: number; prNumber: number }> {
  const n = ++seq;
  const projectId = seed.projectId ?? 1;
  const prNumber = seed.prNumber === undefined ? 100 + n : seed.prNumber;
  const [row] = await db
    .insert(schema.healActions)
    .values({
      projectId,
      dedupeKey: `heal:v1:${projectId}:${n}`,
      status: seed.status ?? 'opened',
      payload: {
        repositoryUrl: seed.repositoryUrl ?? 'https://github.com/acme/app',
        provider: 'github',
        branch: `piwi/heal/${n}-abc`,
        edits: [
          {
            filePath: seed.filePath ?? `tests/a${n}.spec.ts`,
            line: seed.line ?? 4,
            clusterId: seed.clusterId ?? null,
          },
        ],
      },
      result: prNumber
        ? { prNumber, prUrl: `https://github.com/acme/app/pull/${prNumber}`, commitSha: 'abc', branch: 'b' }
        : null,
      ...(seed.updatedAt ? { updatedAt: seed.updatedAt } : {}),
      ...(seed.createdAt ? { createdAt: seed.createdAt } : {}),
    })
    .returning({ id: schema.healActions.id });
  return { id: row!.id, prNumber: prNumber ?? 0 };
}

async function statusOf(id: number): Promise<string | undefined> {
  const [row] = await db
    .select({ status: schema.healActions.status })
    .from(schema.healActions)
    .where(eq(schema.healActions.id, id));
  return row?.status;
}

let tmpDir: string;
let client: ReturnType<typeof createClient>;

beforeAll(async () => {
  // A file database: libSQL runs a transaction on its own connection, which an
  // in-memory database does not share.
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-heal-pr-state-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  await db.insert(schema.projects).values([
    { id: 1, name: 'checkout', repositoryUrl: 'https://github.com/acme/app' },
    { id: 2, name: 'search', repositoryUrl: 'https://github.com/acme/app' },
  ]);
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
});

beforeEach(async () => {
  await db.delete(schema.healActions);
  await db.delete(schema.handbackOutcomes);
  await db.delete(schema.handbackOutcomeRollups);
  scm.tokens = {};
  scm.prStates = {};
  scm.lookups = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('refreshOpenHealActions', () => {
  test('moves a merged PR to merged and a closed one to closed', async () => {
    const merged = await seedAction();
    const closed = await seedAction();
    scm.prStates[merged.prNumber] = 'merged';
    scm.prStates[closed.prNumber] = 'closed';

    const result = await refreshOpenHealActions(db as never);

    expect(result).toEqual({ checked: 2, merged: 1, closed: 1 });
    expect(await statusOf(merged.id)).toBe('merged');
    expect(await statusOf(closed.id)).toBe('closed');
  });

  test('a merged PR records its heal applied and a closed one rejected, once', async () => {
    await db.delete(schema.handbackOutcomes);
    const merged = await seedAction();
    const closed = await seedAction();
    scm.prStates[merged.prNumber] = 'merged';
    scm.prStates[closed.prNumber] = 'closed';

    await refreshOpenHealActions(db as never);
    await refreshOpenHealActions(db as never);

    const rows = await db.select().from(schema.handbackOutcomes);
    expect(rows.map((r) => [r.kind, r.subjectType, r.subjectId, r.outcome, r.channel, r.commitSha]).sort()).toEqual(
      [
        ['auto-heal-pr', 'heal-action', merged.id, 'applied', 'inferred', 'abc'],
        ['auto-heal-pr', 'heal-action', closed.id, 'rejected', 'inferred', 'abc'],
      ].sort(),
    );
    expect(rows.find((r) => r.subjectId === merged.id)!.details).toMatchObject({ prNumber: merged.prNumber });
  });

  test('leaves open and draft PRs, and a lookup that found nothing, as opened', async () => {
    const open = await seedAction();
    const draft = await seedAction();
    const unknown = await seedAction();
    scm.prStates[open.prNumber] = 'open';
    scm.prStates[draft.prNumber] = 'draft';
    scm.prStates[unknown.prNumber] = null;

    const result = await refreshOpenHealActions(db as never);

    expect(result).toEqual({ checked: 3, merged: 0, closed: 0 });
    for (const action of [open, draft, unknown]) expect(await statusOf(action.id)).toBe('opened');
  });

  test('looks up opened actions only', async () => {
    for (const status of ['pending', 'failed', 'skipped', 'merged', 'closed']) await seedAction({ status });
    const opened = await seedAction();

    await refreshOpenHealActions(db as never);

    expect(scm.lookups).toEqual([opened.prNumber]);
  });

  test('records the change time when a row moves', async () => {
    const stale = new Date('2020-01-01T00:00:00Z');
    const action = await seedAction({ updatedAt: stale });
    scm.prStates[action.prNumber] = 'merged';

    await refreshOpenHealActions(db as never);

    const [row] = await db.select().from(schema.healActions).where(eq(schema.healActions.id, action.id));
    expect(row!.updatedAt.getTime()).toBeGreaterThan(stale.getTime());
  });

  test('a failing lookup does not stop the rest of the batch', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = await seedAction();
    const merged = await seedAction();
    scm.prStates[broken.prNumber] = 'throw';
    scm.prStates[merged.prNumber] = 'merged';

    const result = await refreshOpenHealActions(db as never);

    expect(result.merged).toBe(1);
    expect(await statusOf(broken.id)).toBe('opened');
    expect(await statusOf(merged.id)).toBe('merged');
    expect(error).toHaveBeenCalledTimes(1);
  });

  test('skips a project with no SCM token and still refreshes the others', async () => {
    scm.tokens[1] = null;
    const untokened = await seedAction({ projectId: 1 });
    const tokened = await seedAction({ projectId: 2 });
    scm.prStates[untokened.prNumber] = 'merged';
    scm.prStates[tokened.prNumber] = 'merged';

    await refreshOpenHealActions(db as never);

    expect(scm.lookups).toEqual([tokened.prNumber]);
    expect(await statusOf(untokened.id)).toBe('opened');
    expect(await statusOf(tokened.id)).toBe('merged');
  });

  test('skips an unsupported host and an action with no recorded PR', async () => {
    await seedAction({ repositoryUrl: 'https://unsupported.example/acme/app' });
    await seedAction({ prNumber: null });

    const result = await refreshOpenHealActions(db as never);

    expect(result.checked).toBe(0);
    expect(scm.lookups).toEqual([]);
  });

  test('can be scoped to one project', async () => {
    const one = await seedAction({ projectId: 1 });
    const two = await seedAction({ projectId: 2 });

    await refreshOpenHealActions(db as never, { projectId: 2 });

    expect(scm.lookups).toEqual([two.prNumber]);
    expect(one.prNumber).not.toBe(two.prNumber);
  });

  test('checks the least recently updated actions first, up to the limit', async () => {
    const newest = await seedAction({ updatedAt: new Date('2026-03-03T00:00:00Z') });
    const oldest = await seedAction({ updatedAt: new Date('2026-01-01T00:00:00Z') });
    const middle = await seedAction({ updatedAt: new Date('2026-02-02T00:00:00Z') });

    await refreshOpenHealActions(db as never, { limit: 2 });

    expect(scm.lookups).toEqual([oldest.prNumber, middle.prNumber]);
    expect(scm.lookups).not.toContain(newest.prNumber);
  });

  test('a PR that stays open moves to the back, so the next pass reaches the newer ones', async () => {
    const first = await seedAction({ updatedAt: new Date('2026-01-01T00:00:00Z') });
    const second = await seedAction({ updatedAt: new Date('2026-01-02T00:00:00Z') });
    const third = await seedAction({ updatedAt: new Date('2026-01-03T00:00:00Z') });

    await refreshOpenHealActions(db as never, { limit: 2 });
    await refreshOpenHealActions(db as never, { limit: 2 });

    expect(scm.lookups).toEqual([first.prNumber, second.prNumber, third.prNumber, first.prNumber]);
  });

  test('an action with no token or no PR also moves to the back', async () => {
    const noPr = await seedAction({ prNumber: null, updatedAt: new Date('2026-01-01T00:00:00Z') });
    const later = await seedAction({ updatedAt: new Date('2026-01-02T00:00:00Z') });

    await refreshOpenHealActions(db as never, { limit: 1 });
    await refreshOpenHealActions(db as never, { limit: 1 });

    expect(scm.lookups).toEqual([later.prNumber]);
    expect(await statusOf(noPr.id)).toBe('opened');
  });
});

describe('hasOpenPrCapacity', () => {
  test('is true below the cap without asking the SCM', async () => {
    await seedAction();
    await seedAction();

    expect(await hasOpenPrCapacity(db as never, 1, 3)).toBe(true);
    expect(scm.lookups).toEqual([]);
  });

  test('counts only PRs the SCM still reports open', async () => {
    const stillOpen = await seedAction();
    const merged = await seedAction();
    const closed = await seedAction();
    scm.prStates[stillOpen.prNumber] = 'open';
    scm.prStates[merged.prNumber] = 'merged';
    scm.prStates[closed.prNumber] = 'closed';

    expect(await hasOpenPrCapacity(db as never, 1, 3)).toBe(true);
    expect(await statusOf(merged.id)).toBe('merged');
    expect(await statusOf(closed.id)).toBe('closed');
  });

  test('is false when every PR at the cap is still open', async () => {
    for (let i = 0; i < 3; i++) await seedAction();

    expect(await hasOpenPrCapacity(db as never, 1, 3)).toBe(false);
    expect(scm.lookups).toHaveLength(3);
  });

  test('stays blocked when the SCM cannot be reached', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = await seedAction();
    scm.prStates[a.prNumber] = 'throw';

    expect(await hasOpenPrCapacity(db as never, 1, 1)).toBe(false);
    expect(error).toHaveBeenCalled();
  });

  test('merged, closed, pending, failed and skipped actions do not count', async () => {
    for (const status of ['merged', 'closed', 'pending', 'failed', 'skipped', 'merged']) await seedAction({ status });

    expect(await hasOpenPrCapacity(db as never, 1, 3)).toBe(true);
    expect(scm.lookups).toEqual([]);
  });

  test("another project's open PRs do not count", async () => {
    for (let i = 0; i < 3; i++) await seedAction({ projectId: 2 });

    expect(await hasOpenPrCapacity(db as never, 1, 3)).toBe(true);
    expect(scm.lookups).toEqual([]);
  });

  test('a cap of zero never has room and never asks the SCM', async () => {
    expect(await hasOpenPrCapacity(db as never, 1, 0)).toBe(false);
    expect(scm.lookups).toEqual([]);
  });
});

describe('heal action lookups', () => {
  test('a merged or closed action no longer covers its call site', async () => {
    await seedAction({ status: 'merged', filePath: 'tests/pay.spec.ts', line: 10 });
    await seedAction({ status: 'closed', filePath: 'tests/pay.spec.ts', line: 10 });

    expect(await findHealActionForCallSite(db as never, 1, 'tests/pay.spec.ts', 10)).toBeNull();
  });

  test('an opened action covers its call site until it is refreshed', async () => {
    const action = await seedAction({ filePath: 'tests/pay.spec.ts', line: 10 });

    expect((await findHealActionForCallSite(db as never, 1, 'tests/pay.spec.ts', 10))?.status).toBe('opened');

    scm.prStates[action.prNumber] = 'merged';
    await refreshOpenHealActions(db as never);

    expect(await findHealActionForCallSite(db as never, 1, 'tests/pay.spec.ts', 10)).toBeNull();
  });

  test('a cluster maps to an opened action only', async () => {
    await seedAction({ status: 'opened', clusterId: 7 });
    await seedAction({ status: 'merged', clusterId: 8 });
    await seedAction({ status: 'closed', clusterId: 9 });

    const byCluster = await mapHealActionsByCluster(db as never, 1);

    expect([...byCluster.keys()]).toEqual([7]);
  });
});

describe('heal action history', () => {
  test('progress counts the pull requests opened in the period, from their suggested outcomes', async () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    for (const status of ['opened', 'merged', 'closed', 'pending', 'failed', 'skipped']) await seedAction({ status });
    await seedAction({ status: 'merged', createdAt: old });
    const scope = parseAnalyticsScope({ days: '30' });

    expect((await getAnalyticsProgress(db as never, scope, 'all')).healPullRequests).toBe(0);
    await backfillSuggestedOutcomes();
    await backfillSuggestedOutcomes();

    expect((await getAnalyticsProgress(db as never, scope, 'all')).healPullRequests).toBe(3);
    expect((await getAnalyticsProgress(db as never, parseAnalyticsScope({ days: '90' }), 'all')).healPullRequests).toBe(
      4,
    );
  });

  test('a merge does not move a pull request out of the period it was opened in', async () => {
    const opened = await seedAction({ createdAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) });
    await backfillSuggestedOutcomes();
    scm.prStates[opened.prNumber] = 'merged';
    await refreshOpenHealActions(db as never);

    expect((await getAnalyticsProgress(db as never, parseAnalyticsScope({ days: '30' }), 'all')).healPullRequests).toBe(
      0,
    );
    expect((await getAnalyticsProgress(db as never, parseAnalyticsScope({ days: '60' }), 'all')).healPullRequests).toBe(
      1,
    );
  });

  test('retention prunes a settled action and its outcomes, and the pull request still counts', async () => {
    const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const merged = await seedAction({ status: 'merged', createdAt: stale, updatedAt: stale });
    await recordOutcome(db as never, {
      projectId: 1,
      kind: 'auto-heal-pr',
      subjectType: 'heal-action',
      subjectId: merged.id,
      suggestionKey: 'heal:v1:1:x',
      outcome: 'suggested',
      at: stale,
    });

    expect(await pruneHealActions(db as never, 30)).toBe(1);
    expect(await pruneOutcomesOlderThan(db as never, 30)).toBe(1);
    expect(await db.select().from(schema.handbackOutcomes)).toHaveLength(0);

    const progress = await getAnalyticsProgress(db as never, parseAnalyticsScope({ days: '90' }), 'all');
    expect(progress.healPullRequests).toBe(1);
  });

  test('retention prunes settled merged and closed actions but keeps pending ones', async () => {
    const stale = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const merged = await seedAction({ status: 'merged', updatedAt: stale });
    const closed = await seedAction({ status: 'closed', updatedAt: stale });
    const pending = await seedAction({ status: 'pending', updatedAt: stale });

    expect(await pruneHealActions(db as never, 30)).toBe(2);

    expect(await statusOf(merged.id)).toBeUndefined();
    expect(await statusOf(closed.id)).toBeUndefined();
    expect(await statusOf(pending.id)).toBe('pending');
  });

  test('retention keeps a PR left open for 31 days, and its key keeps a duplicate from being queued', async () => {
    const stale = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const opened = await seedAction({ status: 'opened', updatedAt: stale });
    const [row] = await db.select().from(schema.healActions).where(eq(schema.healActions.id, opened.id));

    expect(await pruneHealActions(db as never, 30)).toBe(0);
    expect(await statusOf(opened.id)).toBe('opened');

    const queued = await queueHealAction(db as never, {
      projectId: 1,
      runId: 1,
      dedupeKey: row!.dedupeKey,
      payload: row!.payload as never,
    });
    expect(queued).toBe(false);
    expect(await db.select().from(schema.healActions)).toHaveLength(1);
  });

  test('a failed or skipped action frees its key: the same edit is queued again on the same row', async () => {
    for (const status of ['failed', 'skipped']) {
      await db.delete(schema.healActions);
      const settled = await seedAction({ status });
      const [row] = await db.select().from(schema.healActions).where(eq(schema.healActions.id, settled.id));

      const queued = await queueHealAction(db as never, {
        projectId: 1,
        runId: 1,
        dedupeKey: row!.dedupeKey,
        payload: row!.payload as never,
      });

      expect(queued).toBe(true);
      const rows = await db.select().from(schema.healActions);
      expect(rows.map((r) => [r.id, r.status, r.attempts, r.result, r.runId])).toEqual([
        [settled.id, 'pending', 0, null, 1],
      ]);
    }
  });
});
