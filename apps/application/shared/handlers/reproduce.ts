/**
 * Gather what a reproduction needs from a run and its history, then hand it to
 * the pure generators in `#shared/reproduce`. Lives in `shared/handlers` so the
 * server (the fix plan, the execution endpoint) and the demo mirror compute it
 * the same way — the generators stay pure and testable, this does the reads.
 *
 * The bisect window's `good` end is the run-level baseline — the last green
 * run before this one in the same environment, on the same branch, else the
 * branch it forked from, else any — and its `bad` end is the failing run's own
 * commit. When either commit is missing the bisect degrades to a plain reason,
 * so a demo with no SCM metadata still renders the recipe.
 */
import { eq } from 'drizzle-orm';
import { failureClusters, testCases, testRuns, testRunsCases } from '../../server/database/schema';
import { normalizeGitUrl } from '../../server/utils/scm/git-url';
import { selectBaselineRun } from '../../server/utils/branch-baseline';
import { resolveRunBranch } from '../../server/utils/run-branch';
import { readProjectDefaultBranch, resolveFallbackBranch } from './baseline-scope';
import { getReproducingArm } from './flake-lab';
import {
  buildBisectScript,
  buildReproRecipe,
  type BisectedCommit,
  type BisectResult,
  type ReproduceDesktopContext,
  type ReproRecipe,
} from '#shared/reproduce';
import { commitUrl } from '#shared/scm-urls';
import { buildRerunCommand, type RetryCase } from '#shared/retry-command';
import type { BrowserConfig } from '#shared/types';
import type { DrizzleDB } from './db';

export interface ReproduceContext {
  reproduce: ReproRecipe;
  bisect: BisectResult;
  /** Everything the desktop shell needs to run this locally and persist a bisect. */
  desktop: ReproduceDesktopContext;
}

export interface ReproduceInput {
  /** The run whose commit, Playwright version and environment describe the failure. */
  runId: number;
  /** The failing tests, for the exact `playwright test` invocation. */
  cases: RetryCase[];
  /** Browser binary to install (`chromium` / `firefox` / `webkit`). */
  browserName: string | null;
  /** The command that verifies a fix — the `bad`/`good` probe for the bisect. */
  verifyCommand: string;
  /** Base URL the run targeted, when known. */
  baseUrl?: string | null;
  /** The failure cluster this reproduction belongs to — where a bisect result is recorded. */
  clusterId?: number | null;
  /** The test cases of the failing tests, to find a Flake Lab arm for the bisect. */
  testCaseIds?: number[];
}

/** Minimal view of the metadata JSON this reader needs. */
type RunScm = { scm?: { commit?: string | null; remoteUrl?: string | null } | null } | null;

/** Read the bisect result recorded on a cluster and attach a commit URL, if any. */
async function readBisectedCommit(
  db: DrizzleDB,
  clusterId: number | null | undefined,
  repositoryUrl: string | null,
): Promise<BisectedCommit | null> {
  if (!clusterId) return null;
  const [row] = await db
    .select({ bisectResult: failureClusters.bisectResult })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  const stored = row?.bisectResult as BisectedCommit | null | undefined;
  if (!stored?.sha) return null;
  return {
    sha: stored.sha,
    subject: stored.subject ?? '',
    author: stored.author ?? null,
    date: stored.date ?? null,
    commitUrl: commitUrl(repositoryUrl, stored.sha),
  };
}

/**
 * Compute the reproduction recipe and the bisect for one run. Always returns a
 * recipe; the bisect is `available: false` when the window cannot be built.
 */
export async function computeReproduceContext(db: DrizzleDB, input: ReproduceInput): Promise<ReproduceContext> {
  const [run] = await db
    .select({
      projectId: testRuns.projectId,
      startTime: testRuns.startTime,
      branch: testRuns.branch,
      environment: testRuns.environment,
      metadata: testRuns.metadata,
      playwrightVersion: testRuns.playwrightVersion,
    })
    .from(testRuns)
    .where(eq(testRuns.id, input.runId));

  const scm = (run?.metadata as RunScm)?.scm ?? null;
  const commit = scm?.commit ?? null;
  const repositoryUrl = normalizeGitUrl(scm?.remoteUrl ?? null);

  let lastGreenCommit: string | null = null;
  if (run) {
    const defaultBranch = await readProjectDefaultBranch(db, run.projectId, run.metadata);
    const baseline = await selectBaselineRun(db, {
      projectId: run.projectId,
      before: run.startTime,
      branch: run.branch ?? resolveRunBranch(run.metadata),
      environment: run.environment ?? null,
      fallbackBranch: resolveFallbackBranch(run.metadata, defaultBranch).branch,
    });
    lastGreenCommit = (baseline?.run.metadata as RunScm)?.scm?.commit ?? null;
  }

  const projectName = input.cases.find((c) => c.projectName)?.projectName ?? null;

  const reproduce = buildReproRecipe({
    commit,
    playwrightVersion: run?.playwrightVersion ?? null,
    browserName: input.browserName,
    projectName,
    environment: run?.environment ?? null,
    baseUrl: input.baseUrl ?? null,
    cases: input.cases,
  });

  const bisect = buildBisectScript({ good: lastGreenCommit, bad: commit, verifyCommand: input.verifyCommand });

  const bisectedCommit = await readBisectedCommit(db, input.clusterId, repositoryUrl);
  const testCaseIds = [...new Set(input.testCaseIds ?? [])];
  const flakeArm = testCaseIds.length === 1 ? await getReproducingArm(db, testCaseIds[0]!) : null;

  const desktop: ReproduceDesktopContext = {
    projectId: run?.projectId ?? null,
    cases: input.cases,
    browserName: input.browserName,
    commit,
    good: lastGreenCommit,
    bad: commit,
    clusterId: input.clusterId ?? null,
    repositoryUrl,
    bisectedCommit,
    flakeArm,
  };

  return { reproduce, bisect, desktop };
}

/**
 * The reproduction recipe and bisect for a single execution — the version the
 * execution page's More ways to fix renders. Returns null when the execution is gone.
 */
export async function buildExecutionReproduce(db: DrizzleDB, executionId: number): Promise<ReproduceContext | null> {
  const [row] = await db
    .select({
      testRunId: testRunsCases.testRunId,
      testCaseId: testRunsCases.testCaseId,
      line: testRunsCases.line,
      browser: testRunsCases.browser,
      failureClusterId: testRunsCases.failureClusterId,
      title: testCases.title,
      filePath: testCases.filePath,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.id, executionId));

  if (!row) return null;

  const browser = row.browser as BrowserConfig | null;
  const cases: RetryCase[] = [
    { filePath: row.filePath, title: row.title, line: row.line, projectName: browser?.projectName ?? null },
  ];
  const verifyCommand = buildRerunCommand(cases);

  return computeReproduceContext(db, {
    runId: row.testRunId,
    cases,
    browserName: browser?.browserName ?? null,
    verifyCommand,
    clusterId: row.failureClusterId ?? null,
    testCaseIds: [row.testCaseId],
  });
}
