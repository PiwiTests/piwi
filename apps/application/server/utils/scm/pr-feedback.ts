/**
 * Post a finished run's verdict back to the pull request that triggered it.
 *
 * This is the one place a run's analysis reaches a developer without them
 * opening the dashboard, so it carries the things only Piwi knows: which
 * failures are *new* versus already broken, the failure clusters behind them,
 * the locator to use instead of the one that broke, and the CI minutes the run
 * wasted.
 *
 * Every step is best-effort. The run is already stored by the time this runs;
 * a missing token, a closed pull request or an SCM outage must never turn into
 * an ingest error, so failures are logged and swallowed.
 *
 * The analysis the comment reads (the scenario gaps, change coverage and fix
 * verification) runs for every finished run, posted or not
 * (`analyzeFinishedRunInBackground`); the posting reads its result.
 */
import { testTextLabel } from '#shared/utils/test-label';
import { and, desc, eq, inArray, max } from 'drizzle-orm';
import {
  bugReports,
  failureClusters,
  prFeedbackPosts,
  projects,
  testCases,
  testRuns,
  testRunsCases,
} from '../../database/schema';
import { getAppSetting } from '../app-settings';
import { createScmProvider } from './index';
import { normalizeGitUrl } from './git-url';
import { getLocatorHealingBatch } from '../locator-healing';
import { mapHealActionsByCluster } from '../heal/lookup';
import { getClusterKnownIssues } from '../integrations/known-issue';
import { resolveOwners } from './ownership';
import { resolveDefaultBranch } from './default-branch';
import { resolveRunBranch } from '../run-branch';
import { verifyClusterFixes } from '../fix-verification';
import { computeRunInsights } from '#shared/handlers/run-insights';
import { getProjectFlakyTests } from '#shared/handlers/projects';
import { getQuarantinedCaseIds } from '#shared/handlers/quarantine';
import {
  buildChangeCoverageStatus,
  hasChangeCoverage,
  buildCommitStatus,
  buildPrComment,
  DEFAULT_PR_FEEDBACK,
  isQuietRun,
  PR_COMMENT_MARKER,
  PR_EXCERPT_MAX,
  PR_FEEDBACK_KEY,
  resolvePrFeedbackSettings,
  type PrChangeCoverage,
  type PrLocatorBreaks,
  type PrFailureEntry,
  type PrFeedbackSettings,
  type PrSummaryInput,
} from '#shared/pr-feedback';
import { computeRunChangeCoverage, type RunChangeCoverage } from './change-coverage';
import { readPrFeedbackPost, recordPrFeedbackPost, runPrNumber } from './pr-feedback-posts';
import { computeScenarioGaps } from '#shared/handlers/scenario-gaps';
import { resolveProjectStates } from '#shared/handlers/capabilities';
import { resolveRunBranchTagFromStored } from '../graph-ingest';
import { withProjectGraphLock } from '../project-graph-lock';
import type { VerifiedFix } from '../fix-verification';
import type { RunMetadata } from '../run-json-types';
import type { DbClient } from '../../database';
import type { FilterDetails, TestMetadata } from '#shared/types';
import { isExpectedFailurePassed, looksFixedTests } from '#shared/status-classify';
import { errorExcerpt } from '#shared/notification-events';
import { caseHeadline } from '#shared/failure-verdict';
import { locksHeldAcrossShards } from '#shared/lock-overlap';
import { runFindingsNovelty } from '#shared/handlers/resource-findings';
import { isLeak } from '#shared/resource-fingerprint.mjs';

/** Read the resolved settings, falling back to the (disabled) defaults. */
export async function getPrFeedbackSettings(db: DbClient): Promise<PrFeedbackSettings> {
  const stored = await getAppSetting<Partial<PrFeedbackSettings>>(db, PR_FEEDBACK_KEY);
  return stored ? resolvePrFeedbackSettings(stored) : { ...DEFAULT_PR_FEEDBACK };
}

const FAIL_STATUSES = ['failed', 'timedOut', 'timedout'];

/** Recent default-branch runs scanned to decide whether a failure is already flaky there. */
const DEFAULT_BRANCH_FLAKY_RUNS = 50;

/** What the dashboard is reachable at, for the links inside the comment. */
function resolveSiteUrl(): string | null {
  const configured = process.env.PIWI_SITE_URL?.trim();
  if (!configured) return null;
  return configured.replace(/\/$/, '');
}

interface CaseRow {
  id: number;
  testCaseId: number;
  status: string;
  expectedStatus: string | null;
  testMeta: unknown;
  retries: number | null;
  browserName: string | null;
  duration: number | null;
  wastedTimeMs: number | null;
  error: string | null;
  failureClusterId: number | null;
  title: string;
  externalId: string | null;
  displayTitle: string | null;
  filePath: string;
  tags: unknown;
  owner: string | null;
  locks: unknown;
  shardIndex: number | null;
  startedAt: number | null;
}

/**
 * Turn the run's failing executions into comment entries, split by whether the
 * baseline was already failing them. Locator suggestions are resolved in one
 * batch and only for the failures actually listed.
 */
async function buildFailureEntries(
  db: DbClient,
  projectId: number,
  rows: CaseRow[],
  newRegressionIds: Set<number>,
  defaultBranchFlaky: Map<number, { branch: string; flakinessRate: number }>,
): Promise<{ newRegressions: PrFailureEntry[]; preExisting: PrFailureEntry[] }> {
  const clusterIds = [...new Set(rows.map((r) => r.failureClusterId).filter((id): id is number => id != null))];
  const clusterSignatures = new Map<number, string>();
  if (clusterIds.length > 0) {
    const clusterRows = await db
      .select({ id: failureClusters.id, signature: failureClusters.signature })
      .from(failureClusters)
      .where(inArray(failureClusters.id, clusterIds));
    for (const cluster of clusterRows) clusterSignatures.set(cluster.id, cluster.signature);
  }

  const healing = await getLocatorHealingBatch(
    db,
    rows.map((r) => r.id),
  ).catch(() => new Map());

  // Falls back to CODEOWNERS when a test carries no `piwi:owner`, so a comment
  // can name the owning team on a suite nobody has annotated.
  const owners = await resolveOwners(db, projectId, rows).catch(() => new Map());

  // A locator that broke here may already have an auto-heal PR open (it broke on
  // the default branch too); cross-link it rather than sending someone to fix it
  // twice. Keyed by cluster — stable across the two runs, where execution ids differ.
  const healByCluster = await mapHealActionsByCluster(db, projectId).catch(() => new Map());

  // The tracker issue each failing cluster is already known by, so the comment
  // can say "tracked in PROJ-123" per failure.
  const knownIssues = await getClusterKnownIssues(db, clusterIds).catch(() => new Map());

  const toEntry = (row: CaseRow): PrFailureEntry => {
    const heal = row.failureClusterId != null ? healByCluster.get(row.failureClusterId) : undefined;
    const issue = row.failureClusterId != null ? knownIssues.get(row.failureClusterId) : undefined;
    return {
      title: testTextLabel(row),
      filePath: row.filePath,
      headline: caseHeadline(row)?.headline ?? null,
      errorExcerpt: errorExcerpt(row.error, PR_EXCERPT_MAX) ?? null,
      executionId: row.id,
      clusterId: row.failureClusterId,
      clusterSignature: row.failureClusterId ? (clusterSignatures.get(row.failureClusterId) ?? null) : null,
      suggestedLocator: healing.get(row.id)?.recommendation?.recommended?.locator ?? null,
      healPrNumber: heal?.prNumber ?? null,
      healPrUrl: heal?.prUrl ?? null,
      tags: Array.isArray(row.tags) ? (row.tags as string[]) : null,
      owner: owners.get(row)?.owner ?? row.owner,
      flakyOnDefaultBranch: defaultBranchFlaky.get(row.testCaseId) ?? null,
      issue: issue ? { key: issue.key, url: issue.url } : null,
    };
  };

  const newRegressions: PrFailureEntry[] = [];
  const preExisting: PrFailureEntry[] = [];
  for (const row of rows) {
    (newRegressionIds.has(row.id) ? newRegressions : preExisting).push(toEntry(row));
  }
  return { newRegressions, preExisting };
}

/**
 * Build the summary for a finished run. Exported so the gate endpoint and the
 * tests can read the same numbers the comment shows.
 */
export async function buildRunPrSummary(
  db: DbClient,
  runId: number,
  siteUrl: string,
  fixedClusters: VerifiedFix[] = [],
): Promise<PrSummaryInput | null> {
  const [run] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
  if (!run) return null;

  const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId));
  if (!project) return null;

  const caseRows: CaseRow[] = await db
    .select({
      id: testRunsCases.id,
      testCaseId: testRunsCases.testCaseId,
      status: testRunsCases.status,
      expectedStatus: testRunsCases.expectedStatus,
      testMeta: testRunsCases.testMeta,
      retries: testRunsCases.retries,
      browserName: testRunsCases.browserName,
      duration: testRunsCases.duration,
      wastedTimeMs: testRunsCases.wastedTimeMs,
      error: testRunsCases.error,
      failureClusterId: testRunsCases.failureClusterId,
      title: testCases.title,
      externalId: testCases.externalId,
      displayTitle: testCases.displayTitle,
      filePath: testCases.filePath,
      tags: testCases.tags,
      owner: testCases.owner,
      locks: testRunsCases.locks,
      shardIndex: testRunsCases.shardIndex,
      startedAt: testRunsCases.startedAt,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.testRunId, runId));

  // Each project's last attempt says whether a test's bug still shows there.
  const looksFixedRows = looksFixedTests(caseRows);
  const namedBugs = looksFixedRows.flatMap((row) => {
    const bug = Number((row.testMeta as TestMetadata | null)?.bug);
    return bug ? [bug] : [];
  });
  const knownBugReports = new Set(
    namedBugs.length
      ? (
          await db
            .select({ id: bugReports.id })
            .from(bugReports)
            .where(and(eq(bugReports.projectId, run.projectId), inArray(bugReports.id, namedBugs)))
        ).map((r) => r.id)
      : [],
  );
  const failingRows = caseRows.filter(
    (row) => FAIL_STATUSES.includes(row.status) && !isExpectedFailurePassed(row.status, row.expectedStatus),
  );
  const flakyRows = caseRows.filter((row) => row.status === 'passed' && (row.retries ?? 0) > 0);
  const quarantinedIds = await getQuarantinedCaseIds(db, run.projectId).catch(() => new Set<number>());
  const quarantinedFailures = failingRows.filter((row) => quarantinedIds.has(row.testCaseId)).length;

  // `computeRunInsights` owns the baseline comparison; reuse it rather than
  // re-deriving "new versus pre-existing" with a second, divergent rule.
  const insights = await computeRunInsights(db, runId).catch(() => null);
  const newRegressionIds = new Set<number>((insights?.newRegressions ?? []).map((entry) => entry.executionId));

  // Flake exoneration: on a feature branch, mark a failure that is already flaky
  // on the default branch so the reviewer knows it is likely not this change's
  // doing. Skipped for runs already on the default branch (nothing to compare).
  const runBranch = run.branch ?? resolveRunBranch(run.metadata);
  const defaultBranch = await resolveDefaultBranch(db, project, run.metadata);
  const defaultBranchFlaky = new Map<number, { branch: string; flakinessRate: number }>();
  if (runBranch && runBranch !== defaultBranch) {
    const flaky = await getProjectFlakyTests(
      db,
      run.projectId,
      DEFAULT_BRANCH_FLAKY_RUNS,
      undefined,
      undefined,
      defaultBranch,
    ).catch(() => []);
    for (const test of flaky) {
      defaultBranchFlaky.set(test.testCaseId, { branch: defaultBranch, flakinessRate: Math.min(1, test.score / 100) });
    }
  }

  const { newRegressions, preExisting } = await buildFailureEntries(
    db,
    run.projectId,
    failingRows,
    newRegressionIds,
    defaultBranchFlaky,
  );

  const newClusters = await db
    .select({ id: failureClusters.id, signature: failureClusters.signature })
    .from(failureClusters)
    .where(and(eq(failureClusters.firstSeenRunId, runId), eq(failureClusters.projectId, run.projectId)));

  const clusterCaseCounts = new Map<number, number>();
  for (const row of failingRows) {
    if (row.failureClusterId == null) continue;
    clusterCaseCounts.set(row.failureClusterId, (clusterCaseCounts.get(row.failureClusterId) ?? 0) + 1);
  }

  // Wasted CI time, same definition the analytics widget uses: time inside wait
  // steps, plus the whole duration of any attempt that ended failed.
  const wastedTotalMs = caseRows.reduce((total, row) => {
    const waits = row.wastedTimeMs ?? 0;
    const failedAttempt = FAIL_STATUSES.includes(row.status) ? (row.duration ?? 0) : 0;
    return total + waits + failedAttempt;
  }, 0);

  return {
    runId,
    runUrl: `${siteUrl}/test-runs/${runId}`,
    projectName: project.label || project.name,
    status: run.status,
    totalTests: run.totalTests,
    passedTests: run.passedTests,
    failedTests: run.failedTests,
    flakyTests: run.flakyTests,
    durationMs: run.duration ?? null,
    newRegressions,
    preExisting,
    looksFixed: looksFixedRows.map((row) => {
      const bug = Number((row.testMeta as TestMetadata | null)?.bug) || null;
      return {
        title: testTextLabel(row),
        filePath: row.filePath,
        executionId: row.id,
        bugId: bug,
        bugReportExists: bug != null && knownBugReports.has(bug),
      };
    }),
    flaky: flakyRows.map((row) => ({
      title: testTextLabel(row),
      filePath: row.filePath,
      errorExcerpt: null,
      executionId: row.id,
      tags: Array.isArray(row.tags) ? (row.tags as string[]) : null,
      owner: row.owner,
    })),
    newClusters: newClusters.map((cluster) => ({
      id: cluster.id,
      signature: cluster.signature,
      caseCount: clusterCaseCounts.get(cluster.id) ?? 0,
    })),
    fixedClusters: fixedClusters.map((fix) => ({
      id: fix.clusterId,
      label: fix.title || fix.signature,
      testCount: fix.testCount,
      verification: fix.verification,
      timeToResolutionMs: fix.timeToResolutionMs,
      ...(fix.healPr ? { healPr: { number: fix.healPr.number, url: fix.healPr.url } } : {}),
    })),
    wastedMinutes: wastedTotalMs > 0 ? wastedTotalMs / 60000 : null,
    selection: (() => {
      const stamp = (run.filterDetails as FilterDetails | null)?.selection;
      return stamp ? { key: stamp.key, testCount: stamp.resolvedCount } : null;
    })(),
    splitLocks: (() => {
      const held = locksHeldAcrossShards(
        caseRows.map((row) => ({
          id: row.id,
          shardIndex: row.shardIndex,
          startedAt: row.startedAt,
          duration: row.duration,
          locks: Array.isArray(row.locks) ? (row.locks as string[]) : [],
        })),
      );
      return held.length ? held : null;
    })(),
    hasBaseline: insights?.hasBaseline ?? false,
    quarantinedFailures,
    quarantineFailsStatus: project.quarantineFailsStatus === true,
  };
}

/**
 * Resolve the pull request for a finished run and post the comment and/or the
 * commit status. Returns what it managed to do, for logs and tests.
 */
export async function postRunPrFeedback(
  db: DbClient,
  runId: number,
  fixedClusters: VerifiedFix[] = [],
  changeCoverage: PrChangeCoverage | null = null,
  locatorBreaks: PrLocatorBreaks | null = null,
): Promise<{ posted: boolean; comment: boolean; status: boolean; reason?: string }> {
  const none = (reason: string) => ({ posted: false, comment: false, status: false, reason });

  const settings = await getPrFeedbackSettings(db);
  if (!settings.enabled) return none('disabled');

  const siteUrl = resolveSiteUrl();
  if (!siteUrl) return none('PIWI_SITE_URL is not set, so comment links would be unusable');

  const [run] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
  if (!run) return none('run not found');

  const meta = (run.metadata as RunMetadata | null) ?? null;
  const branch = meta?.scm?.branch?.trim() || null;
  const commit = meta?.scm?.commit?.trim() || null;
  const repositoryUrl = normalizeGitUrl(meta?.scm?.remoteUrl ?? null);
  if (!repositoryUrl) return none('run has no repository URL in its SCM metadata');
  if (!branch && !commit) return none('run has neither a branch nor a commit');

  const provider = await createScmProvider(repositoryUrl, db, run.projectId);
  if (!provider) return none(`unsupported SCM host for ${repositoryUrl}`);

  const summary = await buildRunPrSummary(db, runId, siteUrl, fixedClusters);
  if (!summary) return none('could not build the run summary');

  // The Test Map's surfaces (the files no test reached in the "Uncovered
  // changes" section, and the locators the change breaks) are dropped when the
  // project declined `test-map`; the changed lines are coverage's and stay. The
  // graph and its `changes` edges are still written on ingest — a declined
  // capability that receives data reads active — this only withholds the PR
  // surfaces.
  const states = await resolveProjectStates(db, run.projectId);
  const testMapDeclined = states['test-map'] === 'declined';
  const effectiveChangeCoverage =
    changeCoverage && testMapDeclined ? { ...changeCoverage, fileReach: false } : changeCoverage;
  summary.changeCoverage = effectiveChangeCoverage;
  summary.locatorBreaks = testMapDeclined ? null : locatorBreaks;
  summary.newLeaks = states.resources === 'declined' ? null : await readNewLeaks(db, runId);

  // `onlyOnFailure` silences routine green runs, but a run that closed a
  // cluster or opened a new leak is news. Quarantined failures follow the
  // commit status's rule.
  const quiet = isQuietRun(settings, summary);

  let commentPosted = false;
  let prNumber = runPrNumber(run.metadata);
  let commentId: string | null = null;
  if (settings.comment && branch && !quiet) {
    const pullRequest = await provider.findPullRequestForBranch(branch);
    if (pullRequest) {
      prNumber = pullRequest.number;
      const comment = await provider.postPullRequestComment(
        pullRequest.number,
        PR_COMMENT_MARKER,
        buildPrComment(summary),
      );
      commentPosted = comment !== null;
      commentId = comment?.id ?? null;
    }
  }

  // A commit status is a state rather than a message, so it is still worth
  // setting on a green run that `onlyOnFailure` silences the comment for.
  let statusPosted = false;
  const statuses: string[] = [];
  if (settings.status && commit) {
    statusPosted = await provider.postCommitStatus(commit, buildCommitStatus(summary, settings.statusContext));
    if (statusPosted) statuses.push(settings.statusContext);
    // A second, informational status for change coverage — warn-only.
    if (effectiveChangeCoverage && hasChangeCoverage(effectiveChangeCoverage)) {
      const coverageContext = `${settings.statusContext}/change-coverage`;
      const coveragePosted = await provider
        .postCommitStatus(commit, buildChangeCoverageStatus(effectiveChangeCoverage, summary.runUrl, coverageContext))
        .catch(() => false);
      if (coveragePosted) statuses.push(coverageContext);
    }
  }

  if (commentPosted || statuses.length > 0) {
    await recordPrFeedbackPost(db, {
      projectId: run.projectId,
      runId,
      repositoryUrl,
      prNumber,
      commentId,
      statuses,
      fixes: fixedClusters,
    }).catch((e) => console.error(`[pr-feedback] could not record the feedback of run #${runId}`, e));
  }

  return { posted: commentPosted || statusPosted, comment: commentPosted, status: statusPosted };
}

/** The leaks of a run that its base branch never showed, or null when the run sent no resource report. */
async function readNewLeaks(db: DbClient, runId: number): Promise<PrSummaryInput['newLeaks']> {
  const novelty = await runFindingsNovelty(db, runId).catch(() => null);
  if (!novelty) return null;
  return {
    baseBranch: novelty.baseBranch,
    leaks: novelty.findings.filter((f) => f.isNew && isLeak(f.finding)).map((f) => f.finding),
  };
}

/** A finished run's analysis, as the pull-request feedback reads it: each part settles on its own and never rejects. */
export interface FinishedRunAnalysis {
  /** The clusters the run verified as fixed; empty when the verification failed. */
  fixed: Promise<VerifiedFix[]>;
  /** The run's change coverage once stored; null when there is none, or it failed. */
  coverage: Promise<RunChangeCoverage | null>;
}

/**
 * Start a finished run's analysis in the background, whether or not its
 * verdict is posted: the project's scenario gaps, the run's change coverage
 * and the verification of the clusters it fixed, each under its own use. Each
 * step logs its own failure.
 */
export function analyzeFinishedRunInBackground(db: DbClient, runId: number): FinishedRunAnalysis {
  // Recompute the project-wide scenario gaps off the request path, so success-
  // only, single-covering-test and surface-drift gaps and their self-closing
  // stay live on every finished run — not only from the manual recompute.
  computeScenarioGapsForRun(db, runId).catch((e) => console.error('[scenario-gaps] computeScenarioGaps failed', e));

  // Change coverage runs regardless of the comment opt-in: it writes the graph's
  // `changes` edges and the changed-unreached gaps every instance with history
  // and an SCM token gets for free. Its result also feeds the comment section.
  const coverage = computeRunChangeCoverage(db, runId).catch((e) => {
    console.error('[change-coverage] computeRunChangeCoverage failed', e);
    return null;
  });
  const fixed = verifyClusterFixes(db, runId).catch((e) => {
    console.error('[fix-verification] verifyClusterFixes failed', e);
    return [] as VerifiedFix[];
  });
  return { fixed, coverage };
}

/**
 * Fire-and-forget posting for the run-finalize paths, from the run's
 * analysis. Returns once change coverage is stored, with the run's locator
 * breaks that locator healing reads; the comment is posted after that, in the
 * background.
 *
 * Fix verification runs first and its result is handed to the comment, so the
 * two stay in one order rather than racing: a comment that omitted the cluster
 * this run just closed would be reporting the wrong news.
 */
export function postRunPrFeedbackInBackground(
  db: DbClient,
  runId: number,
  analysis: FinishedRunAnalysis,
): Promise<void> {
  const inFlight = { stale: false };
  feedbackInFlight.set(runId, inFlight);
  Promise.all([analysis.fixed, analysis.coverage])
    .then(([fixed, change]) => postRunPrFeedback(db, runId, fixed, change?.pr ?? null, change?.locatorBreaks ?? null))
    .then((result) => {
      if (!result.posted && result.reason && result.reason !== 'disabled') {
        console.warn(`[pr-feedback] nothing posted for run #${runId}: ${result.reason}`);
      }
    })
    .catch((e) => console.error('[pr-feedback] postRunPrFeedback failed', e))
    .finally(() => {
      feedbackInFlight.delete(runId);
      if (inFlight.stale) void refreshRunPrFeedback(db, runId);
    });
  return analysis.coverage.then(() => undefined);
}

/** Runs whose feedback is being posted, and whether their commit's coverage changed meanwhile. */
const feedbackInFlight = new Map<number, { stale: boolean }>();

/** Runs of a commit a coverage change refreshes the feedback of, the newest first. */
const REFRESHED_RUNS_SCANNED = 20;

/**
 * Post a run's feedback again with its change coverage recomputed, keeping the
 * fixes its comment reported: a coverage upload or a run coverage of its
 * commit changes the patch coverage and the files a suite ran. Only the
 * newest posted run of its pull request is refreshed, so an older commit
 * never overwrites the comment a later push wrote. A failure is logged.
 */
export async function refreshRunPrFeedback(db: DbClient, runId: number): Promise<void> {
  try {
    const post = await readPrFeedbackPost(db, runId);
    if (!post) return;
    if (post.prNumber != null) {
      const [newest] = await db
        .select({ runId: max(prFeedbackPosts.runId) })
        .from(prFeedbackPosts)
        .where(and(eq(prFeedbackPosts.repositoryUrl, post.repositoryUrl), eq(prFeedbackPosts.prNumber, post.prNumber)));
      if (newest?.runId != null && newest.runId > runId) return;
    }
    const change = await computeRunChangeCoverage(db, runId);
    await postRunPrFeedback(db, runId, post.fixes, change?.pr ?? null, change?.locatorBreaks ?? null);
  } catch (e) {
    console.error(`[pr-feedback] could not refresh the feedback of run #${runId}`, e);
  }
}

/**
 * Refresh the feedback of a commit's newest posted run, once its coverage
 * changed. A run whose feedback is still being posted is refreshed when it is.
 */
export async function refreshCommitPrFeedback(db: DbClient, projectId: number, commit: string): Promise<void> {
  const runs = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(eq(testRuns.projectId, projectId), eq(testRuns.commit, commit)))
    .orderBy(desc(testRuns.id))
    .limit(REFRESHED_RUNS_SCANNED);
  if (runs.length === 0) return;
  let pending = false;
  for (const run of runs) {
    const inFlight = feedbackInFlight.get(run.id);
    if (inFlight) {
      inFlight.stale = true;
      pending = true;
    }
  }
  if (pending) return;
  const [posted] = await db
    .select({ runId: prFeedbackPosts.runId })
    .from(prFeedbackPosts)
    .where(
      and(
        eq(prFeedbackPosts.projectId, projectId),
        inArray(
          prFeedbackPosts.runId,
          runs.map((r) => r.id),
        ),
      ),
    )
    .orderBy(desc(prFeedbackPosts.runId))
    .limit(1);
  if (posted) await refreshRunPrFeedback(db, posted.runId);
}

/**
 * Recompute a finished run's project-wide scenario gaps, scoped to the run's
 * branch. The branch tag is resolved from stored project fields only, so this
 * makes no SCM call; the nightly sweep re-resolves an unknown default branch.
 */
async function computeScenarioGapsForRun(db: DbClient, runId: number): Promise<void> {
  const [run] = await db
    .select({ projectId: testRuns.projectId, branch: testRuns.branch, metadata: testRuns.metadata })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  if (!run) return;
  const [project] = await db
    .select({ id: projects.id, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, run.projectId));
  const branch = project ? await resolveRunBranchTagFromStored(db, project, run.metadata, run.branch) : null;
  // Serialize per project so a run finishing while a manual recompute (or another
  // run) is mid-flight does not race its graph and gap writes.
  await withProjectGraphLock(run.projectId, () => computeScenarioGaps(db, run.projectId, { branch }));
}
