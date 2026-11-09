import { eq } from 'drizzle-orm';
import { projects, testRunsCases } from '../database/schema';
import type { RunMetadata } from './run-json-types';
import type { DbClient } from '../database';
import { buildCommitRange, computeMetadataDiff, type MetaDiffEntry } from '#shared/utils/run-metadata';
import { loadRunsSnapshots } from '#shared/handlers/environment-snapshots';
import { FAILED_STATUS_KEYS } from '#shared/utils/test-counts';
import { normalizeGitUrl } from './scm/git-url';
import { resolveRunBranch } from './run-branch';
import { resolveDefaultBranch } from './scm/default-branch';
import { FALLBACK_DEFAULT_BRANCH } from './scm/git-url';
import { selectBaselineRun } from './branch-baseline';
import { resolveFallbackBranch } from '#shared/handlers/baseline-scope';
import { describeRunBaseline } from '#shared/run-baseline';

export interface RunForRegression {
  id: number;
  projectId: number;
  status: string;
  startTime: Date;
  environment: string | null;
  branch?: string | null;
  metadata: unknown;
  playwrightVersion?: string | null;
}

export type RegressionContextResult =
  | { hasGreen: false }
  | {
      hasGreen: true;
      lastGreenRunId: number;
      lastGreenRunAt: Date;
      lastGreenCommit: string | null;
      lastGreenBranch: string | null;
      /** Why this run was the baseline — the sentence the Changes tab shows. */
      baselineNote: string;
      currentCommit: string | null;
      currentBranch: string | null;
      commitRange: {
        fromSha: string;
        toSha: string;
        fromShort: string;
        toShort: string;
        repositoryUrl: string | null;
        compareUrl: string | null;
        gitCommand: string;
      } | null;
      metadataDiff: MetaDiffEntry[];
      newFailures: number;
    };

const FAIL_STATUSES = new Set<string>(FAILED_STATUS_KEYS);

export async function computeRegressionContext(db: DbClient, run: RunForRegression): Promise<RegressionContextResult> {
  // The last green run the run-level ladder picks: the same environment first,
  // and within it this run's own branch, then the branch it forked from, then
  // any — so "what changed since last green" is a diff within one line of
  // history, not across unrelated ones.
  const branch = run.branch ?? resolveRunBranch(run.metadata);
  const [project] = await db
    .select({ id: projects.id, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, run.projectId));
  const defaultBranch = project ? await resolveDefaultBranch(db, project, run.metadata) : FALLBACK_DEFAULT_BRANCH;
  const fallback = resolveFallbackBranch(run.metadata, defaultBranch);

  const selection = await selectBaselineRun(db, {
    projectId: run.projectId,
    before: run.startTime,
    branch,
    environment: run.environment ?? null,
    fallbackBranch: fallback.branch,
  });
  if (!selection) return { hasGreen: false };
  const lastGreen = selection.run;
  const baselineNote = describeRunBaseline({
    run: { branch, environment: run.environment ?? null },
    baseline: { branch: lastGreen.branch ?? null, environment: lastGreen.environment ?? null },
    match: selection.match,
    fallback,
  });

  const currMeta = run.metadata as RunMetadata | null;
  const greenMeta = lastGreen.metadata as RunMetadata | null;
  const currentCommit: string | null = currMeta?.scm?.commit ?? null;
  const lastGreenCommit: string | null = greenMeta?.scm?.commit ?? null;
  const remoteUrl: string | null = currMeta?.scm?.remoteUrl ?? greenMeta?.scm?.remoteUrl ?? null;

  const repositoryUrl = normalizeGitUrl(remoteUrl);

  const commitRange = buildCommitRange(repositoryUrl, lastGreenCommit, currentCommit);

  const snapshots = await loadRunsSnapshots(db, [lastGreen.id, run.id]);
  const metadataDiff = computeMetadataDiff(greenMeta, currMeta, lastGreen.environment, run.environment, {
    before: { playwrightVersion: lastGreen.playwrightVersion, snapshots: snapshots.get(lastGreen.id) ?? [] },
    after: { playwrightVersion: run.playwrightVersion, snapshots: snapshots.get(run.id) ?? [] },
  });

  const [greenCases, currentCases] = await Promise.all([
    db
      .select({ testCaseId: testRunsCases.testCaseId, status: testRunsCases.status })
      .from(testRunsCases)
      .where(eq(testRunsCases.testRunId, lastGreen.id)),
    db
      .select({ testCaseId: testRunsCases.testCaseId, status: testRunsCases.status })
      .from(testRunsCases)
      .where(eq(testRunsCases.testRunId, run.id)),
  ]);

  const greenBestStatus = new Map<number, string>();
  for (const c of greenCases) {
    if (!greenBestStatus.has(c.testCaseId) || c.status === 'passed') {
      greenBestStatus.set(c.testCaseId, c.status);
    }
  }

  const currentWorstStatus = new Map<number, string>();
  for (const c of currentCases) {
    const existing = currentWorstStatus.get(c.testCaseId);
    if (!existing || (FAIL_STATUSES.has(c.status) && !FAIL_STATUSES.has(existing))) {
      currentWorstStatus.set(c.testCaseId, c.status);
    }
  }

  let newFailures = 0;
  for (const [tcId, status] of currentWorstStatus) {
    if (FAIL_STATUSES.has(status) && greenBestStatus.get(tcId) === 'passed') newFailures++;
  }

  return {
    hasGreen: true,
    lastGreenRunId: lastGreen.id,
    lastGreenRunAt: lastGreen.startTime,
    lastGreenCommit,
    lastGreenBranch: greenMeta?.scm?.branch ?? null,
    baselineNote,
    currentCommit,
    currentBranch: currMeta?.scm?.branch ?? null,
    commitRange,
    metadataDiff,
    newFailures,
  };
}
