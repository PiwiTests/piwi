import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks PostgreSQL when PIWI_DATABASE_URL is set; clear it so
// the handler modules under test load the SQLite schema.
delete process.env.PIWI_DATABASE_URL;
const { resolveRunBranch, resolveRunPrNumber, resolveRunBaseBranch } = await import('../../server/utils/run-branch');
const { selectBaselineRun, listBaselineBranches } = await import('../../server/utils/branch-baseline');
const { resolveDefaultBranch } = await import('../../server/utils/scm/default-branch');
const { FALLBACK_DEFAULT_BRANCH } = await import('../../server/utils/scm/git-url');

let db: ReturnType<typeof drizzle<typeof schema>>;

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

async function seedProject(id: number, defaultBranch: string | null = null) {
  await db
    .insert(schema.projects)
    .values({ id, name: `project-${id}`, defaultBranch })
    .onConflictDoNothing();
}

async function seedRun(opts: {
  projectId: number;
  status: string;
  branch: string | null;
  daysAgo: number;
  isFullRun?: number;
  environment?: string | null;
}): Promise<number> {
  const [row] = await db
    .insert(schema.testRuns)
    .values({
      projectId: opts.projectId,
      status: opts.status,
      startTime: daysAgo(opts.daysAgo),
      branch: opts.branch,
      environment: opts.environment ?? null,
      isFullRun: opts.isFullRun ?? 1,
    })
    .returning({ id: schema.testRuns.id });
  return row!.id;
}

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
});

describe('resolveRunBranch', () => {
  test('reads scm.branch, trims, and treats HEAD as unknown', () => {
    expect(resolveRunBranch({ scm: { branch: 'feature/x' } })).toBe('feature/x');
    expect(resolveRunBranch({ scm: { branch: '  main  ' } })).toBe('main');
    expect(resolveRunBranch({ scm: { branch: 'HEAD' } })).toBeNull();
    expect(resolveRunBranch({ scm: {} })).toBeNull();
    expect(resolveRunBranch(null)).toBeNull();
  });
});

describe('resolveRunPrNumber', () => {
  test('parses a numeric PR number, rejecting non-numeric', () => {
    expect(resolveRunPrNumber({ scm: { prNumber: '42' } })).toBe(42);
    expect(resolveRunPrNumber({ scm: { prNumber: 7 } })).toBe(7);
    expect(resolveRunPrNumber({ scm: { prNumber: 'x' } })).toBeNull();
    expect(resolveRunPrNumber({ scm: {} })).toBeNull();
  });
});

describe('resolveDefaultBranch', () => {
  test('prefers the explicit project setting', async () => {
    await seedProject(10, 'develop');
    const [project] = await db
      .select({ id: schema.projects.id, defaultBranch: schema.projects.defaultBranch })
      .from(schema.projects)
      .where(eq(schema.projects.id, 10));
    expect(await resolveDefaultBranch(db as any, project!, { defaultBranch: 'ignored' })).toBe('develop');
  });

  test('falls back to the reporter metadata hint, then to main', async () => {
    await seedProject(11, null);
    const [project] = await db
      .select({ id: schema.projects.id, defaultBranch: schema.projects.defaultBranch })
      .from(schema.projects)
      .where(eq(schema.projects.id, 11));
    expect(await resolveDefaultBranch(db as any, project!, { defaultBranch: 'trunk' })).toBe('trunk');
    expect(await resolveDefaultBranch(db as any, project!, {})).toBe(FALLBACK_DEFAULT_BRANCH);
  });
});

describe('selectBaselineRun', () => {
  test('prefers a same-branch passing run over an older default-branch one', async () => {
    await seedProject(1, 'main');
    await seedRun({ projectId: 1, status: 'passed', branch: 'main', daysAgo: 10 });
    const sameBranch = await seedRun({ projectId: 1, status: 'passed', branch: 'feature/a', daysAgo: 5 });

    const baseline = await selectBaselineRun(db as any, {
      projectId: 1,
      before: daysAgo(0),
      branch: 'feature/a',
      environment: null,
      fallbackBranch: 'main',
    });
    expect(baseline?.run.id).toBe(sameBranch);
    expect(baseline?.match).toEqual({ branch: 'same', environment: null, outcome: 'passed' });
  });

  test('falls back to the fallback branch when the branch has no history', async () => {
    await seedProject(2, 'main');
    const onMain = await seedRun({ projectId: 2, status: 'passed', branch: 'main', daysAgo: 8 });

    const baseline = await selectBaselineRun(db as any, {
      projectId: 2,
      before: daysAgo(0),
      branch: 'feature/fresh',
      environment: null,
      fallbackBranch: 'main',
    });
    expect(baseline?.run.id).toBe(onMain);
    expect(baseline?.match).toEqual({ branch: 'fallback', environment: null, outcome: 'passed' });
  });

  test('an unknown branch keeps branch-blind behavior (most recent passing)', async () => {
    await seedProject(3, 'main');
    await seedRun({ projectId: 3, status: 'passed', branch: 'main', daysAgo: 9 });
    const newest = await seedRun({ projectId: 3, status: 'passed', branch: 'feature/z', daysAgo: 2 });

    const baseline = await selectBaselineRun(db as any, {
      projectId: 3,
      before: daysAgo(0),
      branch: null,
      environment: null,
      fallbackBranch: 'main',
    });
    expect(baseline?.run.id).toBe(newest);
    expect(baseline?.match).toEqual({ branch: null, environment: null, outcome: 'passed' });
  });

  test('returns null when there is no passing run before the target', async () => {
    await seedProject(4, 'main');
    await seedRun({ projectId: 4, status: 'failed', branch: 'main', daysAgo: 3 });
    const baseline = await selectBaselineRun(db as any, {
      projectId: 4,
      before: daysAgo(0),
      branch: 'main',
      environment: null,
      fallbackBranch: 'main',
    });
    expect(baseline).toBeNull();
  });

  test('a same-environment run on the fallback branch beats a same-branch run from another environment', async () => {
    await seedProject(5, 'main');
    await seedRun({ projectId: 5, status: 'passed', branch: 'feature/e', environment: 'production', daysAgo: 1 });
    const mainStaging = await seedRun({
      projectId: 5,
      status: 'passed',
      branch: 'main',
      environment: 'staging',
      daysAgo: 6,
    });

    const baseline = await selectBaselineRun(db as any, {
      projectId: 5,
      before: daysAgo(0),
      branch: 'feature/e',
      environment: 'staging',
      fallbackBranch: 'main',
    });
    expect(baseline?.run.id).toBe(mainStaging);
    expect(baseline?.match).toEqual({ branch: 'fallback', environment: 'same', outcome: 'passed' });
  });

  test('walks the branch ladder again without the environment when it has no passing run', async () => {
    await seedProject(6, 'main');
    await seedRun({ projectId: 6, status: 'passed', branch: 'main', environment: 'production', daysAgo: 2 });
    const sameBranchProd = await seedRun({
      projectId: 6,
      status: 'passed',
      branch: 'feature/f',
      environment: 'production',
      daysAgo: 4,
    });

    const baseline = await selectBaselineRun(db as any, {
      projectId: 6,
      before: daysAgo(0),
      branch: 'feature/f',
      environment: 'staging',
      fallbackBranch: 'main',
    });
    expect(baseline?.run.id).toBe(sameBranchProd);
    expect(baseline?.match).toEqual({ branch: 'same', environment: 'other', outcome: 'passed' });
  });

  test('a run with no environment label ignores the environment axis', async () => {
    await seedProject(7, 'main');
    const labeled = await seedRun({
      projectId: 7,
      status: 'passed',
      branch: 'main',
      environment: 'staging',
      daysAgo: 1,
    });
    await seedRun({ projectId: 7, status: 'passed', branch: 'main', environment: null, daysAgo: 5 });

    const baseline = await selectBaselineRun(db as any, {
      projectId: 7,
      before: daysAgo(0),
      branch: 'main',
      environment: null,
      fallbackBranch: 'main',
    });
    expect(baseline?.run.id).toBe(labeled);
    expect(baseline?.match).toEqual({ branch: 'same', environment: null, outcome: 'passed' });
  });

  test('an explicit base branch restricts the baseline to that branch, same environment first', async () => {
    await seedProject(8, 'main');
    await seedRun({ projectId: 8, status: 'passed', branch: 'feature/g', environment: 'staging', daysAgo: 1 });
    await seedRun({ projectId: 8, status: 'passed', branch: 'main', environment: 'staging', daysAgo: 2 });
    const releaseProd = await seedRun({
      projectId: 8,
      status: 'passed',
      branch: 'release/1',
      environment: 'production',
      daysAgo: 3,
    });
    const releaseStaging = await seedRun({
      projectId: 8,
      status: 'passed',
      branch: 'release/1',
      environment: 'staging',
      daysAgo: 9,
    });

    const query = {
      projectId: 8,
      before: daysAgo(0),
      branch: 'feature/g',
      environment: 'staging',
      fallbackBranch: 'main',
    };
    const chosen = await selectBaselineRun(db as any, { ...query, baseBranch: 'release/1' });
    expect(chosen?.run.id).toBe(releaseStaging);
    expect(chosen?.match).toEqual({ branch: 'chosen', environment: 'same', outcome: 'passed' });

    const otherEnv = await selectBaselineRun(db as any, { ...query, environment: 'qa', baseBranch: 'release/1' });
    expect(otherEnv?.run.id).toBe(releaseProd);
    expect(otherEnv?.match).toEqual({ branch: 'chosen', environment: 'other', outcome: 'passed' });

    const nothing = await selectBaselineRun(db as any, { ...query, baseBranch: 'does-not-exist' });
    expect(nothing).toBeNull();
  });

  test('fullRunOnly skips partial runs on every rung', async () => {
    await seedProject(9, 'main');
    await seedRun({ projectId: 9, status: 'passed', branch: 'feature/h', daysAgo: 1, isFullRun: 0 });
    const full = await seedRun({ projectId: 9, status: 'passed', branch: 'main', daysAgo: 4 });

    const baseline = await selectBaselineRun(db as any, {
      projectId: 9,
      before: daysAgo(0),
      branch: 'feature/h',
      environment: null,
      fallbackBranch: 'main',
      fullRunOnly: true,
    });
    expect(baseline?.run.id).toBe(full);
    expect(baseline?.match).toEqual({ branch: 'fallback', environment: null, outcome: 'passed' });
  });

  test('failedFallback takes the last failed run only when no rung finds a passing one', async () => {
    await seedProject(12, 'main');
    await seedRun({ projectId: 12, status: 'interrupted', branch: 'feature/i', environment: 'staging', daysAgo: 1 });
    await seedRun({ projectId: 12, status: 'timedout', branch: 'feature/i', environment: 'staging', daysAgo: 2 });
    await seedRun({
      projectId: 12,
      status: 'failed',
      branch: 'feature/i',
      environment: 'staging',
      daysAgo: 3,
      isFullRun: 0,
    });
    await seedRun({ projectId: 12, status: 'failed', branch: 'feature/i', environment: 'production', daysAgo: 4 });
    const mainStaging = await seedRun({
      projectId: 12,
      status: 'failed',
      branch: 'main',
      environment: 'staging',
      daysAgo: 5,
    });
    const query = {
      projectId: 12,
      before: daysAgo(0),
      branch: 'feature/i',
      environment: 'staging',
      fallbackBranch: 'main',
      fullRunOnly: true,
    };

    expect(await selectBaselineRun(db as any, query)).toBeNull();

    // Interrupted, timed-out and partial runs never qualify; the environment
    // still comes before the branch, as on the passing ladder.
    const failed = await selectBaselineRun(db as any, { ...query, failedFallback: true });
    expect(failed?.run.id).toBe(mainStaging);
    expect(failed?.match).toEqual({ branch: 'fallback', environment: 'same', outcome: 'failed' });

    // Any passing run, even on another branch and environment, beats a failed one.
    const passing = await seedRun({ projectId: 12, status: 'passed', branch: 'hotfix', environment: 'qa', daysAgo: 9 });
    const preferred = await selectBaselineRun(db as any, { ...query, failedFallback: true });
    expect(preferred?.run.id).toBe(passing);
    expect(preferred?.match).toEqual({ branch: 'any', environment: 'other', outcome: 'passed' });
  });

  test('failedFallback also applies to a chosen base branch', async () => {
    await seedProject(13, 'main');
    await seedRun({ projectId: 13, status: 'passed', branch: 'main', daysAgo: 1 });
    const release = await seedRun({ projectId: 13, status: 'failed', branch: 'release/3', daysAgo: 2 });
    const query = {
      projectId: 13,
      before: daysAgo(0),
      branch: 'feature/j',
      environment: null,
      fallbackBranch: 'main',
      baseBranch: 'release/3',
    };
    expect(await selectBaselineRun(db as any, query)).toBeNull();
    const chosen = await selectBaselineRun(db as any, { ...query, failedFallback: true });
    expect(chosen?.run.id).toBe(release);
    expect(chosen?.match).toEqual({ branch: 'chosen', environment: null, outcome: 'failed' });
  });
});

describe('listBaselineBranches', () => {
  test('lists the branches of earlier eligible runs, failed ones only with failedFallback', async () => {
    await seedProject(14, 'main');
    await seedRun({ projectId: 14, status: 'passed', branch: 'main', daysAgo: 3 });
    await seedRun({ projectId: 14, status: 'failed', branch: 'release/4', daysAgo: 3 });
    await seedRun({ projectId: 14, status: 'interrupted', branch: 'feature/k', daysAgo: 3 });
    await seedRun({ projectId: 14, status: 'passed', branch: 'feature/partial', daysAgo: 3, isFullRun: 0 });
    await seedRun({ projectId: 14, status: 'passed', branch: 'feature/later', daysAgo: 0 });
    await seedRun({ projectId: 14, status: 'passed', branch: null, daysAgo: 3 });

    const query = { projectId: 14, before: daysAgo(1), fullRunOnly: true };
    expect(await listBaselineBranches(db as any, query)).toEqual(['main']);
    expect(await listBaselineBranches(db as any, { ...query, failedFallback: true })).toEqual(['main', 'release/4']);
  });
});

describe('resolveRunBaseBranch', () => {
  test("reads scm.baseBranch, ignoring HEAD and the run's own branch", () => {
    expect(resolveRunBaseBranch({ scm: { branch: 'feature/x', baseBranch: 'main' } })).toBe('main');
    expect(resolveRunBaseBranch({ scm: { branch: 'main', baseBranch: 'main' } })).toBeNull();
    expect(resolveRunBaseBranch({ scm: { baseBranch: 'HEAD' } })).toBeNull();
    expect(resolveRunBaseBranch({ scm: {} })).toBeNull();
    expect(resolveRunBaseBranch(null)).toBeNull();
  });
});
