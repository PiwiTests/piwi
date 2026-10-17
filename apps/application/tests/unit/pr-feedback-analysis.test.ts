import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

const fix = { clusterId: 9, title: 'Cart row not found' };
const coverage = { coverage: {}, pr: null, locatorBreaks: null };
const verifyClusterFixes = vi.fn(async (_db: unknown, _runId: number): Promise<unknown[]> => [fix]);
const computeRunChangeCoverage = vi.fn(async (_db: unknown, _runId: number): Promise<unknown> => coverage);
const computeScenarioGaps = vi.fn(async (_db: unknown, _projectId: number, _options: unknown) => ({}));
vi.mock('../../server/utils/fix-verification', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyClusterFixes,
}));
vi.mock('../../server/utils/scm/change-coverage', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  computeRunChangeCoverage,
}));
vi.mock('#shared/handlers/scenario-gaps', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  computeScenarioGaps,
}));

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load. Without a site URL, posting
// stops at its first check and says why.
delete process.env.PIWI_DATABASE_URL;
delete process.env.PIWI_SITE_URL;
const { analyzeFinishedRunInBackground, postRunPrFeedbackInBackground, refreshCommitPrFeedback } =
  await import('../../server/utils/scm/pr-feedback');
const { recordPrFeedbackPost } = await import('../../server/utils/scm/pr-feedback-posts');

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values([{ id: 1, name: 'shop' }]);
  await db
    .insert(schema.testRuns)
    .values([{ id: 1, projectId: 1, status: 'failed', branch: 'main', startTime: new Date(), isFullRun: 0 }]);
  await db.insert(schema.appSettings).values([{ key: 'pr_feedback', value: { enabled: true } }]);
});

beforeEach(() => {
  verifyClusterFixes.mockClear();
  computeRunChangeCoverage.mockClear();
  computeScenarioGaps.mockClear();
});

describe('a finished run’s analysis', () => {
  test('verifies the clusters it fixed, stores its change coverage and recomputes the scenario gaps', async () => {
    const analysis = analyzeFinishedRunInBackground(db as never, 1);
    expect(await analysis.fixed).toEqual([fix]);
    expect(await analysis.coverage).toEqual(coverage);
    expect(verifyClusterFixes).toHaveBeenCalledWith(db, 1);
    expect(computeRunChangeCoverage).toHaveBeenCalledWith(db, 1);
    await vi.waitFor(() => expect(computeScenarioGaps).toHaveBeenCalledWith(db, 1, expect.anything()));
  });

  test('a step that fails is logged, and the other parts still answer', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      verifyClusterFixes.mockRejectedValueOnce(new Error('verification down'));
      computeRunChangeCoverage.mockRejectedValueOnce(new Error('host down'));
      const analysis = analyzeFinishedRunInBackground(db as never, 1);
      expect(await analysis.fixed).toEqual([]);
      expect(await analysis.coverage).toBeNull();
      expect(errors).toHaveBeenCalledWith('[fix-verification] verifyClusterFixes failed', expect.any(Error));
      expect(errors).toHaveBeenCalledWith('[change-coverage] computeRunChangeCoverage failed', expect.any(Error));
    } finally {
      errors.mockRestore();
    }
  });
});

describe('the pull-request feedback of a finished run', () => {
  test('answers once change coverage is stored, and posts once fix verification answered too', async () => {
    let fixed!: (clusters: never[]) => void;
    let stored!: (change: null) => void;
    const analysis = {
      fixed: new Promise<never[]>((resolve) => (fixed = resolve)),
      coverage: new Promise<null>((resolve) => (stored = resolve)),
    };
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let answered = false;
      void postRunPrFeedbackInBackground(db as never, 1, analysis).then(() => {
        answered = true;
      });
      stored(null);
      await vi.waitFor(() => expect(answered).toBe(true));
      // The comment carries the clusters the run fixed: nothing is posted while their verification runs.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(warnings).not.toHaveBeenCalled();
      fixed([]);
      await vi.waitFor(() =>
        expect(warnings).toHaveBeenCalledWith(
          '[pr-feedback] nothing posted for run #1: PIWI_SITE_URL is not set, so comment links would be unusable',
        ),
      );
    } finally {
      warnings.mockRestore();
    }
  });
});

describe('refreshing a commit’s feedback once its coverage changed', () => {
  const REPO = 'https://github.com/acme/shop';
  const OLD = 'a'.repeat(40);
  const NEW = 'b'.repeat(40);

  beforeAll(async () => {
    await db.insert(schema.testRuns).values([
      { id: 2, projectId: 1, status: 'passed', branch: 'feat', commit: OLD, startTime: new Date(), isFullRun: 1 },
      { id: 3, projectId: 1, status: 'passed', branch: 'feat', commit: NEW, startTime: new Date(), isFullRun: 1 },
      {
        id: 4,
        projectId: 1,
        status: 'passed',
        branch: 'other',
        commit: 'c'.repeat(40),
        startTime: new Date(),
        isFullRun: 1,
      },
    ]);
    for (const runId of [2, 3]) {
      await recordPrFeedbackPost(db as never, {
        projectId: 1,
        runId,
        repositoryUrl: REPO,
        prNumber: 5,
        commentId: '77',
      });
    }
  });

  test('re-posts the newest posted run of the pull request, with its change coverage recomputed', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await refreshCommitPrFeedback(db as never, 1, NEW);
      expect(computeRunChangeCoverage).toHaveBeenCalledWith(db, 3);
      expect(verifyClusterFixes).not.toHaveBeenCalled();
    } finally {
      warnings.mockRestore();
    }
  });

  test('leaves alone a run whose pull request a later push commented on', async () => {
    await refreshCommitPrFeedback(db as never, 1, OLD);
    expect(computeRunChangeCoverage).not.toHaveBeenCalled();
  });

  test('refreshes a run whose feedback was being posted once it is', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await recordPrFeedbackPost(db as never, { projectId: 1, runId: 4, repositoryUrl: REPO, prNumber: 6 });
      let fixed!: (clusters: never[]) => void;
      const analysis = {
        fixed: new Promise<never[]>((resolve) => (fixed = resolve)),
        coverage: Promise.resolve(null),
      };
      void postRunPrFeedbackInBackground(db as never, 4, analysis);
      await refreshCommitPrFeedback(db as never, 1, 'c'.repeat(40));
      expect(computeRunChangeCoverage).not.toHaveBeenCalled();
      fixed([]);
      await vi.waitFor(() => expect(computeRunChangeCoverage).toHaveBeenCalledWith(db, 4));
    } finally {
      warnings.mockRestore();
    }
  });
});
