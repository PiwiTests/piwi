import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { LocatorHealingResult, RankedLocator } from '#shared/locator-healing.types';
import type { ScmEntityState } from '../../server/utils/scm/ScmProvider';

/**
 * Auto-heal against an in-memory SQLite database, from the run that proposes
 * an edit to what the PR's fate teaches the next run, and the runs reported
 * from the heal branch. The SCM and the locator healing are mocked.
 */

const scm = vi.hoisted(() => ({
  prStates: {} as Record<number, ScmEntityState>,
  comments: [] as Array<{ prNumber: number; marker: string; body: string }>,
}));

const healingState = vi.hoisted(() => ({ recommended: null as RankedLocator | null }));

vi.mock('../../server/utils/scm', () => {
  const provider = {
    provider: 'github',
    async upsertPullRequestComment(prNumber: number, marker: string, body: string) {
      scm.comments.push({ prNumber, marker, body });
      return true;
    },
  };
  return {
    createScmProvider: vi.fn(async () => provider),
    resolveScmToken: vi.fn(async () => 'token'),
    scmProviderForUrl: vi.fn(() => ({
      async fetchPullRequest(number: number) {
        return { title: null, state: scm.prStates[number] ?? 'open', author: null, url: null, updatedAt: null };
      },
    })),
  };
});

vi.mock('../../server/utils/scm/ownership', () => ({ resolveOwners: vi.fn(async () => new Map()) }));

vi.mock('../../server/utils/locator-healing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLocatorHealingBatch: vi.fn(async (_db: unknown, executionIds: number[]) => {
    const recommended = healingState.recommended!;
    return new Map(executionIds.map((id) => [id, healingFor(recommended)]));
  }),
}));

function healingFor(recommended: RankedLocator): LocatorHealingResult {
  return {
    failingLocator: { method: 'getByRole', args: { name: 'Pay' } },
    fromPriorSuccess: [recommended],
    fromElementMatch: null,
    fromAriaSnapshot: null,
    source: 'prior-run',
    recommendation: {
      recommended,
      durable: null,
      preservesConvention: false,
      hasDurableAlternative: false,
      suggestAddTestId: false,
    },
    capturedAt: null,
    edit: {
      filePath: 'tests/pay.spec.ts',
      line: 10,
      oldLine: "  await page.getByRole('button', { name: 'Pay' }).click();",
      newLine: "  await page.getByTestId('pay').click();",
      unifiedDiff: '--- a/tests/pay.spec.ts\n+++ b/tests/pay.spec.ts\n@@ -10,1 +10,1 @@\n-old\n+new',
    },
  };
}

const RECOMMENDED: RankedLocator = { locator: "getByTestId('pay')", method: 'getByTestId', args: {}, score: 95 };
const REMOTE = 'https://github.com/acme/shop.git';
const DAY_MS = 24 * 60 * 60 * 1000;

delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SITE_URL = 'https://piwi.example';
const { maybeEnqueueHealAction } = await import('../../server/utils/heal/policy');
const { refreshOpenHealActions } = await import('../../server/utils/heal/pr-state');
const { recordHealBranchRun } = await import('../../server/utils/heal/branch-runs');
const { pruneHealActions } = await import('../../server/utils/retention');
const { listOutcomes } = await import('../../server/utils/outcomes');
const { setAppSetting } = await import('../../server/utils/app-settings');
const { AUTO_HEAL_KEY } = await import('#shared/auto-heal');
const { HEAL_BRANCH_VERIFIED_MARKER } = await import('#shared/heal-pr');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let runSeq = 0;

/** A finished run with one execution of the pay test. */
async function insertRun(status: 'passed' | 'failed', opts: { branch?: string; commit?: string } = {}) {
  const id = ++runSeq;
  const branch = opts.branch ?? 'main';
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status,
    startTime: new Date(),
    isFullRun: 1,
    branch,
    metadata: { scm: { commit: opts.commit ?? `c${id}`, remoteUrl: REMOTE, branch } },
  });
  await db.insert(schema.testRunsCases).values({ id: 1000 + id, testRunId: id, testCaseId: 1, status });
  return id;
}

async function actions() {
  return db.select().from(schema.healActions);
}

/** What the dispatcher records once the PR is open. */
async function markOpened(id: number, prNumber: number) {
  const [row] = await db.select().from(schema.healActions).where(eq(schema.healActions.id, id));
  await db
    .update(schema.healActions)
    .set({
      status: 'opened',
      result: {
        prNumber,
        prUrl: `https://github.com/acme/shop/pull/${prNumber}`,
        commitSha: 'h1',
        branch: (row!.payload as { branch: string }).branch,
      },
    })
    .where(eq(schema.healActions.id, id));
}

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  await db.insert(schema.projects).values({ id: 1, name: 'shop', defaultBranch: 'main', repositoryUrl: REMOTE });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/pay.spec.ts', title: 'pays' });
  await setAppSetting(db as never, AUTO_HEAL_KEY, { enabled: true, projects: [1], minScore: 80 });
});

beforeEach(async () => {
  await db.delete(schema.healActions);
  await db.delete(schema.handbackOutcomes);
  scm.prStates = {};
  scm.comments = [];
  healingState.recommended = RECOMMENDED;
});

describe('an auto-heal PR closed without merging', () => {
  test('the next default-branch run opens no PR for the same edit, even once the closed action is pruned', async () => {
    const first = await maybeEnqueueHealAction(db as never, await insertRun('failed'));
    expect(first.enqueued).toBe(true);
    const [action] = await actions();
    await markOpened(action!.id, 7);

    scm.prStates[7] = 'closed';
    await refreshOpenHealActions(db as never);
    const [rejected] = await listOutcomes(db as never, { projectId: 1, kind: 'auto-heal-pr', outcomes: ['rejected'] });
    expect(rejected?.details?.editKeys).toHaveLength(1);

    const second = await maybeEnqueueHealAction(db as never, await insertRun('failed'));
    expect(second).toEqual({
      enqueued: false,
      reason: 'every qualifying edit was in a heal PR closed without merging',
    });

    // Retention prunes the closed action; the rejected outcome still holds the edit back.
    await db
      .update(schema.healActions)
      .set({ updatedAt: new Date(Date.now() - 60 * DAY_MS) })
      .where(eq(schema.healActions.id, action!.id));
    expect(await pruneHealActions(db as never, 30)).toBe(1);

    const third = await maybeEnqueueHealAction(db as never, await insertRun('failed'));
    expect(third.enqueued).toBe(false);
    expect(await actions()).toHaveLength(0);
  });

  test('a person picking the same locator in the snapshot picker after the PR closed lets it be proposed again', async () => {
    await maybeEnqueueHealAction(db as never, await insertRun('failed'));
    const [action] = await actions();
    await markOpened(action!.id, 8);
    scm.prStates[8] = 'closed';
    await refreshOpenHealActions(db as never);

    healingState.recommended = {
      ...RECOMMENDED,
      pickedByUser: true,
      pickedAt: new Date(Date.now() + 1000).toISOString(),
    };
    const again = await maybeEnqueueHealAction(db as never, await insertRun('failed'));

    expect(again.enqueued).toBe(true);
    const [requeued, ...others] = await actions();
    expect(others).toEqual([]);
    expect(requeued!.id).toBe(action!.id);
    expect(requeued!.status).toBe('pending');
    expect((requeued!.payload as { edits: Array<{ pickedAt: string | null }> }).edits[0]!.pickedAt).toBe(
      healingState.recommended.pickedAt,
    );
  });

  test('a merged PR does not hold its edit back', async () => {
    await maybeEnqueueHealAction(db as never, await insertRun('failed'));
    const [action] = await actions();
    await markOpened(action!.id, 9);
    scm.prStates[9] = 'merged';
    await refreshOpenHealActions(db as never);
    await db.delete(schema.healActions);

    expect((await maybeEnqueueHealAction(db as never, await insertRun('failed'))).enqueued).toBe(true);
  });
});

describe('runs on a heal branch', () => {
  async function openedAction(prNumber: number) {
    await maybeEnqueueHealAction(db as never, await insertRun('failed'));
    const [action] = await actions();
    await markOpened(action!.id, prNumber);
    return { id: action!.id, branch: (action!.payload as { branch: string }).branch };
  }

  async function resultOf(id: number) {
    const [row] = await db.select().from(schema.healActions).where(eq(schema.healActions.id, id));
    return row!.result as Record<string, any>;
  }

  test('a green run is recorded as verified on the branch and comments on the PR once', async () => {
    const action = await openedAction(21);

    const green = await insertRun('passed', { branch: action.branch, commit: 'abcdef1234' });
    expect(await recordHealBranchRun(db as never, green)).toEqual({
      recorded: true,
      actionId: action.id,
      passed: true,
      commented: true,
    });
    expect((await resultOf(action.id)).verifiedOnBranch).toMatchObject({
      runId: green,
      commit: 'abcdef1234',
      passed: true,
    });
    expect(scm.comments).toHaveLength(1);
    expect(scm.comments[0]).toMatchObject({ prNumber: 21, marker: HEAL_BRANCH_VERIFIED_MARKER });
    expect(scm.comments[0]!.body).toContain(`[run #${green}](https://piwi.example/test-runs/${green})`);
    expect(scm.comments[0]!.body).toContain('Mark the pull request ready for review');

    const later = await insertRun('passed', { branch: action.branch });
    expect((await recordHealBranchRun(db as never, later)).recorded).toBe(true);
    const result = await resultOf(action.id);
    expect(result.verifiedOnBranch.runId).toBe(green);
    expect(result.branchRun.runId).toBe(later);
    expect(result.prNumber).toBe(21);
    expect(scm.comments).toHaveLength(1);
  });

  test('a failing run is linked but verifies nothing and posts nothing', async () => {
    const action = await openedAction(22);

    const red = await insertRun('failed', { branch: action.branch });
    expect(await recordHealBranchRun(db as never, red)).toMatchObject({
      recorded: true,
      passed: false,
      commented: false,
    });
    const result = await resultOf(action.id);
    expect(result.branchRun).toMatchObject({ runId: red, passed: false });
    expect(result.verifiedOnBranch).toBeUndefined();
    expect(scm.comments).toHaveLength(0);
  });

  test('a run on a branch auto-heal did not name, or on a heal branch with no action, is left alone', async () => {
    await openedAction(23);

    expect(await recordHealBranchRun(db as never, await insertRun('passed', { branch: 'main' }))).toEqual({
      recorded: false,
      reason: 'not a heal branch',
    });
    expect(
      await recordHealBranchRun(db as never, await insertRun('passed', { branch: 'piwi/heal/1-00000000' })),
    ).toEqual({
      recorded: false,
      reason: 'no heal PR for this branch',
    });
  });

  test('a green run on the branch of a closed PR records the verification without a comment', async () => {
    const action = await openedAction(24);
    await db.update(schema.healActions).set({ status: 'closed' }).where(eq(schema.healActions.id, action.id));

    const green = await insertRun('passed', { branch: action.branch });
    expect(await recordHealBranchRun(db as never, green)).toMatchObject({ passed: true, commented: false });
    expect(scm.comments).toHaveLength(0);
  });
});
