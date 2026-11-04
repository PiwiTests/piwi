/**
 * Fix verification — closing the loop on "did my fix work?".
 *
 * Piwi knows a cluster's failing tests, its diagnosis, the files the suggested
 * patch touches, and the last commit it failed at.
 *
 * After every run this asks two questions about each cluster:
 *
 * - **Did it stop failing?** Every test the cluster covers ran in this run and
 *   passed. That records a fix landing, with the commit and the time it took.
 * - **Did the diagnosis predict it?** The commits between the last failing run
 *   and this one touch a file the suggested patch named. That upgrades the
 *   verdict from "stopped failing" (which a flaky test does by accident) to
 *   "the change we pointed at is the change that fixed it".
 *
 * And one more, in the other direction: a cluster that had a fix recorded and
 * is failing again is marked `regressed`, because a fix that did not hold is
 * worth more than no record at all. A cluster a person resolved with no fix on
 * record (or after its fix regressed) that fails again in a run started after
 * they resolved it, and whose failures count as occurrences
 * (`cluster-occurrences`), is reopened the same way, and emits
 * `cluster.regressed` with no fix run; an ignored cluster stays ignored.
 *
 * A quiet run counts as a fix only when it could have carried one: it started
 * after the run the cluster last failed in, its commit differs from the commit
 * the cluster last failed at, and it ran on the branch the cluster last failed
 * on or on the default branch. A pass at the failing commit (a CI retry, a
 * re-run from the dashboard) is stored as flake evidence on the cluster
 * instead; a pass on another branch says nothing about this one. A failing run
 * says a fix did not hold only when it started after the run the fix landed in,
 * on the branch the fix landed on or on the default branch: another branch may
 * not have the fix yet.
 *
 * The verdict moves the triage status only when the evidence is strong:
 * `diagnosis-verified` resolves an open cluster, `regressed` reopens a resolved
 * one, each appending a system line to the triage note. Each move is one
 * conditional write (`transitionClusterStatus`), so a person's triage made
 * while the run was being verified is never overwritten. `stopped-failing`
 * alone changes nothing — a flaky test achieves it by accident. Every recorded
 * fix emits `cluster.fixed` and every regression `cluster.regressed`, with the
 * fix author's email, when the run sends notifications (the `notifications`
 * use): a run from an editor or a partial local run records its verdicts
 * silently.
 *
 * A commit in that range carrying a `Piwi-Heal: <dedupe key>` trailer names the
 * auto-heal pull request that landed the fix: the fix then carries it as
 * `healPr`, whatever its verdict, when one of that PR's edits belongs to the
 * cluster.
 *
 * A `diagnosis-verified` fix also checks the diagnosed patch against the code
 * at the fix's commit and stores the result on the diagnosis
 * (`patchValidationAtFix`): a patch that still applies there, its change not
 * being in that code, means another change fixed the failure, and the cluster
 * state says the diagnosed change may not be in the code yet.
 *
 * Both verdicts are also the cluster diagnosis's hand-back outcome: a
 * `diagnosis-verified` fix records `verified` on the diagnosis version that was
 * current when the fix landed, and a regression of a cluster whose diagnosis was
 * verified records `regressed` on that same version.
 *
 * Fix attempts follow the same verdicts: a fix that lands records `verified`
 * on each reported attempt it carries (by commit, `Piwi-Cluster` trailer or
 * branch), and a regression records `regressed` on the attempts a fix verified
 * (`server/utils/fix-attempts.ts`).
 *
 * A fix whose change names a cause none of the cluster's tests is about raises
 * an *incidental catch* gap (`server/utils/incidental-catch.ts`).
 *
 * Every step is best-effort — the run is already stored, and SCM being
 * unreachable must never turn into an ingest error.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { failureClusters, failureDiagnoses, healActions, projects, testRuns, testRunsCases } from '../database/schema';
import { createScmProvider } from './scm';
import type { ScmChanges, ScmCommit } from './scm/ScmProvider';
import { HEAL_COMMIT_TRAILER, trailerValues } from '#shared/commit-trailers';
import type { HealActionPayload, HealActionResult } from '#shared/auto-heal';
import { normalizeGitUrl } from './scm/git-url';
import { emitNotification } from './notifications/emit';
import { notifyFixAuthor } from './notifications/fix-author';
import { parseUnifiedDiff, patchInCode, stripAbPrefix, validatePatch } from '#shared/patch';
import type { FixAuthor, HealPrRef, NotificationEvent, NotificationPayload } from '#shared/notification-events';
import type { RunMetadata } from './run-json-types';
import { eligibleRunSql, isEligibleRun } from '#shared/run-eligibility';
import { runStartedAfter, type RunPoint } from '#shared/cluster-state';
import { resolveRunBranch } from './run-branch';
import { resolveDefaultBranch } from './scm/default-branch';
import { getClusterKnownIssue } from './integrations/known-issue';
import {
  enqueueFixPolicies,
  enqueueRegressionPolicies,
  enqueueRunDescriptionUpdates,
  enqueueStillFailingPolicy,
} from './integrations/policies';
import { listOutcomes, recordOutcome } from './outcomes';
import { regressFixAttempts, verifyFixAttempts } from './fix-attempts';
import { recordIncidentalCatch } from './incidental-catch';
import { transitionClusterStatus } from '#shared/handlers/failure-cluster-ops';
import type { DbClient } from '../database';
import { testKey, testOutcomes } from '#shared/utils/test-counts';

const FAIL_STATUSES = ['failed', 'timedOut', 'timedout'];

/** How a cluster's fix was corroborated. */
export type FixVerification = 'stopped-failing' | 'diagnosis-verified' | 'regressed';

/** One cluster whose fix landed in the run just processed. */
export interface VerifiedFix {
  clusterId: number;
  signature: string;
  title: string | null;
  verification: Exclude<FixVerification, 'regressed'>;
  timeToResolutionMs: number | null;
  /** Tests that were failing and now pass. */
  testCount: number;
  /** The auto-heal pull request whose commit landed the fix, read from its `Piwi-Heal` trailer. */
  healPr?: HealPrRef;
}

/** What a run in which every affected test passed says about a cluster. */
export type QuietRunVerdict = 'fix' | 'same-commit' | 'other-branch';

/**
 * Whether a run that passed every test of a cluster records a fix. Unknown
 * commits are not compared; an unknown branch matches only another unknown
 * branch.
 */
export function classifyQuietRun(input: {
  runBranch: string | null;
  runCommit: string | null;
  failedBranch: string | null;
  failedCommit: string | null;
  defaultBranch: string | null;
}): QuietRunVerdict {
  const runCommit = input.runCommit?.trim() || null;
  const failedCommit = input.failedCommit?.trim() || null;
  if (runCommit && failedCommit && runCommit === failedCommit) return 'same-commit';
  const runBranch = input.runBranch?.trim() || null;
  const failedBranch = input.failedBranch?.trim() || null;
  if (runBranch === failedBranch) return 'fix';
  if (runBranch != null && runBranch === input.defaultBranch) return 'fix';
  return 'other-branch';
}

/** What a run that failed a cluster again says about the cluster's fix. */
export type FailingRunVerdict = 'regression' | 'other-branch';

/**
 * Whether a run that failed a cluster again says its fix did not hold: it ran
 * on the branch the fix landed on, or on the default branch. A failure on
 * another branch may come from code that never had the fix. An unknown branch
 * matches only another unknown branch.
 */
export function classifyFailingRun(input: {
  runBranch: string | null;
  fixBranch: string | null;
  defaultBranch: string | null;
}): FailingRunVerdict {
  const runBranch = input.runBranch?.trim() || null;
  const fixBranch = input.fixBranch?.trim() || null;
  if (runBranch === fixBranch) return 'regression';
  if (runBranch != null && runBranch === input.defaultBranch) return 'regression';
  return 'other-branch';
}

/** The files a cluster's completed diagnosis proposed changing, if any. */
async function diagnosedFiles(db: DbClient, clusterId: number): Promise<string[]> {
  const rows = await db
    .select({ details: failureDiagnoses.details })
    .from(failureDiagnoses)
    .where(and(eq(failureDiagnoses.clusterId, clusterId), eq(failureDiagnoses.status, 'completed')))
    .limit(5);

  const files = new Set<string>();
  for (const row of rows) {
    const details = row.details as { suggestedFix?: { patch?: unknown } } | null;
    const patch = details?.suggestedFix?.patch;
    if (typeof patch !== 'string' || !patch.trim()) continue;
    for (const file of parseUnifiedDiff(patch).files) {
      const path = stripAbPrefix(file.newPath) ?? stripAbPrefix(file.oldPath);
      if (path) files.add(path);
    }
  }
  return [...files];
}

/**
 * The suggestion key of one diagnosis version: the diagnosis row and the time
 * the version started (every re-diagnose resets it).
 */
export function diagnosisVersionKey(diagnosisId: number, versionCreatedAt: Date | string | number): string {
  const at = versionCreatedAt instanceof Date ? versionCreatedAt : new Date(versionCreatedAt);
  return `${diagnosisId}@${at.getTime()}`;
}

/** Record the cluster diagnosis current now as `verified` by the fix that landed in `runId`. */
async function recordDiagnosisVerified(
  db: DbClient,
  projectId: number,
  clusterId: number,
  runId: number,
  commit: string | null,
): Promise<void> {
  const [diagnosis] = await db
    .select({
      id: failureDiagnoses.id,
      createdAt: failureDiagnoses.createdAt,
      provider: failureDiagnoses.provider,
      model: failureDiagnoses.model,
    })
    .from(failureDiagnoses)
    .where(
      and(
        eq(failureDiagnoses.clusterId, clusterId),
        eq(failureDiagnoses.scope, 'cluster'),
        eq(failureDiagnoses.status, 'completed'),
      ),
    )
    .limit(1);
  if (!diagnosis) return;
  await recordOutcome(db, {
    projectId,
    kind: 'diagnosis',
    subjectType: 'cluster',
    subjectId: clusterId,
    suggestionKey: diagnosisVersionKey(diagnosis.id, diagnosis.createdAt),
    outcome: 'verified',
    runId,
    commit,
    details: { diagnosisId: diagnosis.id, provider: diagnosis.provider, model: diagnosis.model },
  });
}

/**
 * Check the cluster diagnosis's patch against the code at the commit a
 * diagnosis-verified fix landed in, and store the result on the diagnosis as
 * `patchValidationAtFix`. The range's changed files give the repository path of
 * a patch path written relative to a package root. A file that cannot be read
 * leaves the check `unchecked`, which claims nothing.
 */
async function checkPatchAtFix(
  db: DbClient,
  input: {
    projectId: number;
    clusterId: number;
    runId: number;
    commit: string;
    repositoryUrl: string;
    changedFiles: string[];
  },
): Promise<void> {
  const [diagnosis] = await db
    .select({ id: failureDiagnoses.id, details: failureDiagnoses.details })
    .from(failureDiagnoses)
    .where(
      and(
        eq(failureDiagnoses.clusterId, input.clusterId),
        eq(failureDiagnoses.scope, 'cluster'),
        eq(failureDiagnoses.status, 'completed'),
      ),
    )
    .limit(1);
  const details = (diagnosis?.details ?? null) as { suggestedFix?: { patch?: unknown } | null } | null;
  const patch = details?.suggestedFix?.patch;
  if (!diagnosis || typeof patch !== 'string' || !patch.trim()) return;

  const provider = await createScmProvider(input.repositoryUrl, db, input.projectId);
  if (!provider) return;
  const sources = new Map<string, string>();
  for (const file of parseUnifiedDiff(patch).files) {
    const path = stripAbPrefix(file.newPath) ?? stripAbPrefix(file.oldPath);
    if (!path) continue;
    const repoPath = input.changedFiles.find((changed) => samePath(changed, path)) ?? path;
    const fetched = await provider.fetchFileAtRef(repoPath, input.commit).catch(() => null);
    if (fetched && !fetched.truncated) sources.set(repoPath, fetched.content);
  }

  const patchValidationAtFix = {
    ...validatePatch(patch, sources),
    inCode: patchInCode(patch, sources),
    runId: input.runId,
    commit: input.commit,
  };
  await db
    .update(failureDiagnoses)
    .set({ details: { ...details, patchValidationAtFix } })
    .where(eq(failureDiagnoses.id, diagnosis.id));
}

/** Record a regression against the diagnosis version the cluster's last fix verified, if one did. */
async function recordDiagnosisRegressed(
  db: DbClient,
  projectId: number,
  clusterId: number,
  runId: number,
  commit: string | null,
): Promise<void> {
  const verified = await listOutcomes(db, {
    projectId,
    kind: 'diagnosis',
    subjectType: 'cluster',
    subjectIds: [clusterId],
    outcomes: ['verified'],
  });
  const last = verified.at(-1);
  if (!last) return;
  await recordOutcome(db, {
    projectId,
    kind: 'diagnosis',
    subjectType: 'cluster',
    subjectId: clusterId,
    suggestionKey: last.suggestionKey,
    outcome: 'regressed',
    runId,
    commit,
    details: last.details,
  });
}

/**
 * True when the changed files touch any of `paths`. False when there are no
 * changes to read, which downgrades the verdict to "stopped-failing" rather
 * than claiming a verification we could not make.
 */
export function changesTouchFiles(changes: ScmChanges | null, paths: string[]): boolean {
  if (paths.length === 0 || !changes?.files?.length) return false;
  const changed = new Set(changes.files.map((file) => file.filename));
  return paths.some((path) => {
    for (const candidate of changed) {
      if (samePath(candidate, path)) return true;
    }
    return false;
  });
}

/**
 * Whether two paths name the same file. Compared on suffixes too: the reporter
 * records repo-relative paths, but a monorepo diagnosis may name a path relative
 * to a package root.
 */
function samePath(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** The commits and files between two commits, or null on any failure. */
async function fetchRangeChanges(
  db: DbClient,
  projectId: number,
  repositoryUrl: string,
  fromSha: string,
  toSha: string,
): Promise<ScmChanges | null> {
  if (fromSha === toSha) return null;
  try {
    const provider = await createScmProvider(repositoryUrl, db, projectId);
    if (!provider) return null;
    return await provider.fetchChanges(fromSha, toSha);
  } catch {
    return null;
  }
}

/** The heal-action dedupe keys the commits name in their `Piwi-Heal` trailers. */
export function healKeysFromCommits(commits: ScmCommit[]): string[] {
  const keys = new Set<string>();
  for (const commit of commits) {
    for (const key of trailerValues(commit.fullMessage ?? commit.message, HEAL_COMMIT_TRAILER)) keys.add(key);
  }
  return [...keys];
}

/**
 * The auto-heal pull request among `keys` whose edits cover the cluster, if
 * one recorded a PR.
 */
async function findHealPr(
  db: DbClient,
  projectId: number,
  clusterId: number,
  keys: string[],
): Promise<HealPrRef | undefined> {
  if (keys.length === 0) return undefined;
  const rows = await db
    .select({ id: healActions.id, payload: healActions.payload, result: healActions.result })
    .from(healActions)
    .where(and(eq(healActions.projectId, projectId), inArray(healActions.dedupeKey, keys)));
  for (const row of rows) {
    const payload = row.payload as HealActionPayload | null;
    const result = row.result as HealActionResult | null;
    if (!result?.prNumber || !payload?.edits.some((edit) => edit.clusterId === clusterId)) continue;
    return { number: result.prNumber, url: result.prUrl, actionId: row.id };
  }
  return undefined;
}

/**
 * The author (name + email) of a commit, via the SCM provider when a token
 * resolves one. Best-effort: no repo, no commit, no provider, or a failed
 * lookup all yield undefined, and the notification then carries no author.
 */
async function resolveFixAuthor(
  db: DbClient,
  projectId: number,
  repositoryUrl: string | null,
  sha: string | null,
): Promise<FixAuthor | undefined> {
  if (!repositoryUrl || !sha) return undefined;
  try {
    const provider = await createScmProvider(repositoryUrl, db, projectId);
    if (!provider) return undefined;
    const author = await provider.getCommitAuthor(sha);
    return author ? { name: author.name, email: author.email } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Emit a cluster.fixed / cluster.regressed event, delivering it to the fix
 * author directly (email + targeted browser notification) on top of the normal
 * subscription routing.
 */
async function emitClusterOutcome(db: DbClient, event: NotificationEvent, payload: NotificationPayload): Promise<void> {
  const { targetUserId } = await notifyFixAuthor(db, event, payload);
  await emitNotification(db, event, payload, targetUserId != null ? { targetUserId } : undefined);
}

/**
 * The Playwright projects a cluster's test failed in at its latest failing run
 * (`run`), a run fix verification reads when the test failed in one
 * (`eligible`); `anyProject` when a failure there named none.
 */
interface FailedIn {
  run: RunPoint;
  eligible: boolean;
  projects: Set<string>;
  anyProject: boolean;
}

/**
 * Record fixes and regressions for one finished run. Returns the fixes that
 * landed, so the pull-request comment can report them.
 */
export async function verifyClusterFixes(db: DbClient, runId: number): Promise<VerifiedFix[]> {
  const [run] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
  // A lab arm, a bisect step or a reproduction ran at a commit chosen to
  // investigate a failure: its passes prove no fix and its failures no regression.
  if (!run || !isEligibleRun(run, 'fix-verification')) return [];
  // The verdicts are recorded for every run fix verification reads; their events
  // and the fix author's email go out only for a run that sends notifications.
  const notify = isEligibleRun(run, 'notifications');

  // A partial run can still verify a cluster — but only by the same rule a full
  // run is held to below: every test the cluster covers ran in this run and
  // passed in each Playwright project it last failed in that the run ran, and
  // at least one of them ran in one of those projects. A `--grep` that re-ran
  // exactly the affected tests then closes the cluster; one that skipped even
  // one of them, or a `--project` run of a project none of them failed in,
  // still does not, because a test that did not execute has not been shown to
  // pass. There is no separate `isFullRun` gate: the per-cluster check is the
  // honest one either way.

  const meta = (run.metadata as RunMetadata | null) ?? null;
  const currentCommit = meta?.scm?.commit ?? null;
  const repositoryUrl = normalizeGitUrl(meta?.scm?.remoteUrl ?? null);
  const runScope = {
    branch: run.branch ?? resolveRunBranch(run.metadata) ?? undefined,
    environment: run.environment ?? undefined,
  };
  // This run in the project's run order: it proves a fix only after the
  // failure, and a regression only after the fix.
  const thisRun: RunPoint = { id: runId, startTime: run.startTime };

  // What this run saw: each test's outcome in each Playwright project, and the
  // clusters that failed.
  const caseRows = await db
    .select({
      testCaseId: testRunsCases.testCaseId,
      browserName: testRunsCases.browserName,
      repeatEachIndex: testRunsCases.repeatEachIndex,
      retries: testRunsCases.retries,
      passedAfterFailure: testRunsCases.passedAfterFailure,
      status: testRunsCases.status,
      clusterId: testRunsCases.failureClusterId,
    })
    .from(testRunsCases)
    .where(eq(testRunsCases.testRunId, runId));

  // A skipped or unrun outcome is no outcome: the test was not shown to pass or fail.
  const outcomeByTest = new Map<string, string>();
  const passedCaseIds = new Set<number>();
  const ranCaseIds = new Set<number>();
  for (const outcome of testOutcomes(caseRows)) {
    if (outcome.status !== 'passed' && !FAIL_STATUSES.includes(outcome.status)) continue;
    outcomeByTest.set(testKey(outcome), outcome.status);
    ranCaseIds.add(outcome.testCaseId);
    if (outcome.status === 'passed') passedCaseIds.add(outcome.testCaseId);
  }
  const clustersSeenNow = new Set<number>();
  for (const row of caseRows) {
    if (row.clusterId != null && FAIL_STATUSES.includes(row.status)) clustersSeenNow.add(row.clusterId);
  }

  // What this run shows about one affected test: it `holds` when it passed in
  // each project it last failed in that this run ran, it is `unproven` when
  // this run did not run it at all or it did not pass in one of those
  // projects, and it is `silent` when this run ran it only in other projects
  // (another CI job's, or one the test never failed in). A failure whose
  // project is unknown is answered by a pass in any project.
  const verdictHere = (testCaseId: number, failedIn: FailedIn): 'holds' | 'unproven' | 'silent' => {
    if (!ranCaseIds.has(testCaseId)) return 'unproven';
    const ran = [...failedIn.projects].filter((browserName) => outcomeByTest.has(testKey({ testCaseId, browserName })));
    if (ran.some((browserName) => outcomeByTest.get(testKey({ testCaseId, browserName })) !== 'passed')) {
      return 'unproven';
    }
    if (failedIn.anyProject) return passedCaseIds.has(testCaseId) ? 'holds' : 'unproven';
    return ran.length > 0 ? 'holds' : 'silent';
  };

  const [project] = await db
    .select({ name: projects.name, label: projects.label, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, run.projectId));
  const projectName = project?.label || project?.name || `Project #${run.projectId}`;
  const runBranch = runScope.branch ?? null;

  // Resolved once, and only when a run on another branch than the cluster's
  // needs it.
  let defaultBranch: string | null | undefined;
  const resolveProjectDefaultBranch = async (): Promise<string | null> => {
    if (defaultBranch === undefined) {
      defaultBranch = await resolveDefaultBranch(
        db,
        { id: run.projectId, defaultBranch: project?.defaultBranch ?? null },
        run.metadata,
      ).catch(() => null);
    }
    return defaultBranch;
  };

  // Clusters that regressed this run, so the still-failing policy below does not
  // also comment "still failing" on a ticket it just told about the regression.
  const regressedIds = new Set<number>();

  // ── Regressions: a recorded fix that did not hold ─────────────────────────
  if (clustersSeenNow.size > 0) {
    const regressing = await db
      .select({
        id: failureClusters.id,
        signature: failureClusters.signature,
        title: failureClusters.title,
        fixLandedRunId: failureClusters.fixLandedRunId,
        fixLandedAt: failureClusters.fixLandedAt,
        fixCommit: failureClusters.fixCommit,
      })
      .from(failureClusters)
      .where(
        and(
          inArray(failureClusters.id, [...clustersSeenNow]),
          isNotNull(failureClusters.fixLandedRunId),
          ne(failureClusters.fixVerification, 'regressed'),
        ),
      );
    // The branch each fix landed on; null once its run is gone.
    const fixRunIds = [...new Set(regressing.map((cluster) => cluster.fixLandedRunId!))];
    const fixRuns = fixRunIds.length
      ? await db
          .select({ id: testRuns.id, branch: testRuns.branch, metadata: testRuns.metadata })
          .from(testRuns)
          .where(inArray(testRuns.id, fixRunIds))
      : [];
    const fixBranchByRunId = new Map(fixRuns.map((row) => [row.id, row.branch ?? resolveRunBranch(row.metadata)]));

    for (const cluster of regressing) {
      // A run that started before the fix landed ran the code without it.
      if (!runStartedAfter(thisRun, { id: cluster.fixLandedRunId!, startTime: cluster.fixLandedAt })) continue;
      const fixBranch = fixBranchByRunId.get(cluster.fixLandedRunId!) ?? null;
      const verdict = classifyFailingRun({
        runBranch,
        fixBranch,
        defaultBranch: runBranch && runBranch !== fixBranch ? await resolveProjectDefaultBranch() : null,
      });
      if (verdict === 'other-branch') continue;
      try {
        // Recorded once: a run verified at the same time may have recorded it.
        const marked = await db
          .update(failureClusters)
          .set({ fixVerification: 'regressed', updatedAt: new Date() })
          .where(and(eq(failureClusters.id, cluster.id), ne(failureClusters.fixVerification, 'regressed')))
          .returning({ id: failureClusters.id });
        if (marked.length === 0) continue;
        // A person's "resolved" was contradicted by the runs, so the cluster goes
        // back to open with the reason on record; "ignored" is left alone.
        const reopened = await transitionClusterStatus(db, cluster.id, {
          from: 'resolved',
          to: 'open',
          line: `Reopened automatically: regressed in run #${runId}`,
        });

        // The regression reaches the author of the fix that did not hold.
        if (notify) {
          const fixAuthor = await resolveFixAuthor(db, run.projectId, repositoryUrl, cluster.fixCommit);
          const knownIssue = (await getClusterKnownIssue(db, cluster.id).catch(() => null)) ?? undefined;
          await emitClusterOutcome(db, 'cluster.regressed', {
            clusterId: cluster.id,
            projectId: run.projectId,
            projectName,
            signature: cluster.signature,
            title: cluster.title,
            runId,
            ...runScope,
            fixLandedRunId: cluster.fixLandedRunId,
            reopened,
            fixAuthor,
            knownIssue: knownIssue ? { key: knownIssue.key, url: knownIssue.url } : undefined,
          });
        }

        await recordDiagnosisRegressed(db, run.projectId, cluster.id, runId, currentCommit).catch((e) =>
          console.error('[outcomes] diagnosis regression failed', e),
        );
        await regressFixAttempts(db, {
          projectId: run.projectId,
          clusterId: cluster.id,
          runId,
          commit: currentCommit,
        }).catch((e) => console.error('[outcomes] fix attempt regression failed', e));

        // Comment on (and optionally reopen) the ticket per the binding's policy.
        await enqueueRegressionPolicies(db, {
          clusterId: cluster.id,
          projectId: run.projectId,
          runId,
        }).catch((e) => console.error('[integrations] regression policy failed', e));
        regressedIds.add(cluster.id);
      } catch (error) {
        console.error(`[fix-verification] marking cluster #${cluster.id} regressed in run #${runId} failed`, error);
      }
    }

    // ── Failing again after a person resolved it ─────────────────────────────
    // No fix on record (or the recorded one already regressed): the person's
    // "resolved" is contradicted by a new occurrence, from a run that started
    // after they resolved it. A resolved cluster's `updatedAt` is the moment it
    // was resolved, since a new occurrence leaves it alone.
    const resolvedByHand = !isEligibleRun(run, 'cluster-occurrences')
      ? []
      : await db
          .select({
            id: failureClusters.id,
            signature: failureClusters.signature,
            title: failureClusters.title,
            updatedAt: failureClusters.updatedAt,
          })
          .from(failureClusters)
          .where(
            and(
              inArray(failureClusters.id, [...clustersSeenNow]),
              eq(failureClusters.status, 'resolved'),
              or(isNull(failureClusters.fixLandedRunId), eq(failureClusters.fixVerification, 'regressed')),
            ),
          );
    for (const cluster of resolvedByHand) {
      if (regressedIds.has(cluster.id) || run.startTime.getTime() <= cluster.updatedAt.getTime()) continue;
      try {
        // The branch it failed on before it was resolved stands for the branch of a fix.
        const [failedBefore] = await db
          .select({ branch: testRuns.branch, metadata: testRuns.metadata })
          .from(testRunsCases)
          .innerJoin(testRuns, eq(testRuns.id, testRunsCases.testRunId))
          .where(and(eq(testRunsCases.failureClusterId, cluster.id), lt(testRuns.startTime, cluster.updatedAt)))
          .orderBy(desc(testRuns.startTime), desc(testRuns.id))
          .limit(1);
        const failedBranch = failedBefore ? (failedBefore.branch ?? resolveRunBranch(failedBefore.metadata)) : null;
        const verdict = classifyFailingRun({
          runBranch,
          fixBranch: failedBranch,
          defaultBranch: runBranch && runBranch !== failedBranch ? await resolveProjectDefaultBranch() : null,
        });
        if (verdict === 'other-branch') continue;
        const reopened = await transitionClusterStatus(db, cluster.id, {
          from: 'resolved',
          to: 'open',
          line: `Reopened automatically: failed again in run #${runId}`,
        });
        if (!reopened) continue;

        if (notify) {
          const knownIssue = (await getClusterKnownIssue(db, cluster.id).catch(() => null)) ?? undefined;
          await emitClusterOutcome(db, 'cluster.regressed', {
            clusterId: cluster.id,
            projectId: run.projectId,
            projectName,
            signature: cluster.signature,
            title: cluster.title,
            runId,
            ...runScope,
            fixLandedRunId: null,
            reopened,
            knownIssue: knownIssue ? { key: knownIssue.key, url: knownIssue.url } : undefined,
          });
        }
        // Comment on (and optionally reopen) the ticket per the binding's policy.
        await enqueueRegressionPolicies(db, {
          clusterId: cluster.id,
          projectId: run.projectId,
          runId,
        }).catch((e) => console.error('[integrations] regression policy failed', e));
        regressedIds.add(cluster.id);
      } catch (error) {
        console.error(`[fix-verification] reopening cluster #${cluster.id} in run #${runId} failed`, error);
      }
    }
  }

  // ── Candidates: clusters that were failing and are quiet in this run ──────
  const candidates = await db
    .select({
      id: failureClusters.id,
      signature: failureClusters.signature,
      title: failureClusters.title,
      createdAt: failureClusters.createdAt,
      firstSeenRunId: failureClusters.firstSeenRunId,
      lastSeenRunId: failureClusters.lastSeenRunId,
    })
    .from(failureClusters)
    .where(
      and(
        eq(failureClusters.projectId, run.projectId),
        ne(failureClusters.lastSeenRunId, runId),
        or(isNull(failureClusters.fixLandedRunId), eq(failureClusters.fixVerification, 'regressed')),
      ),
    );

  // ── Still failing: what a ticket hears about failures this run saw ─────────
  // A cluster that failed again this run (and did not regress) may earn a
  // "still failing" note on its ticket, and the issue Piwi filed for it a
  // refreshed description.
  const followTrackedFailures = async (): Promise<void> => {
    const stillFailingIds = [...clustersSeenNow].filter((id) => !regressedIds.has(id));
    if (stillFailingIds.length > 0) {
      const openWithCounts = await db
        .select({ id: failureClusters.id, occurrences: failureClusters.occurrences })
        .from(failureClusters)
        .where(and(inArray(failureClusters.id, stillFailingIds), eq(failureClusters.status, 'open')));
      for (const cluster of openWithCounts) {
        await enqueueStillFailingPolicy(db, {
          clusterId: cluster.id,
          projectId: run.projectId,
          latestRunId: runId,
          occurrences: cluster.occurrences ?? 0,
        }).catch((e) => console.error('[integrations] still-failing policy failed', e));
      }
    }
    await enqueueRunDescriptionUpdates(db, { projectId: run.projectId, runId, clusterIds: [...clustersSeenNow] }).catch(
      (e) => console.error('[integrations] description updates failed', e),
    );
  };

  if (candidates.length === 0) {
    await followTrackedFailures();
    return [];
  }

  const candidateIds = candidates.map((cluster) => cluster.id);
  const affected = await db
    .select({
      clusterId: testRunsCases.failureClusterId,
      testCaseId: testRunsCases.testCaseId,
      browserName: testRunsCases.browserName,
      runId: testRunsCases.testRunId,
      runStartTime: testRuns.startTime,
      runEligible: sql<number>`CASE WHEN ${eligibleRunSql('fix-verification')} THEN 1 ELSE 0 END`,
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(inArray(testRunsCases.failureClusterId, candidateIds));

  // Per cluster, its tests and the Playwright projects each one failed in at
  // its latest failing run. A reproduction, a lab arm or a bisect step runs the
  // projects it was asked to, so its failures name the projects only of a test
  // that failed in no other run.
  const casesByCluster = new Map<number, Map<number, FailedIn>>();
  for (const row of affected) {
    if (row.clusterId == null) continue;
    let tests = casesByCluster.get(row.clusterId);
    if (!tests) casesByCluster.set(row.clusterId, (tests = new Map()));
    const failedRun: RunPoint = { id: row.runId, startTime: row.runStartTime };
    const eligible = Number(row.runEligible) === 1;
    let failedIn = tests.get(row.testCaseId);
    if (
      !failedIn ||
      (eligible && !failedIn.eligible) ||
      (eligible === failedIn.eligible && runStartedAfter(failedRun, failedIn.run))
    ) {
      tests.set(row.testCaseId, (failedIn = { run: failedRun, eligible, projects: new Set(), anyProject: false }));
    } else if (failedIn.run.id !== failedRun.id) {
      continue;
    }
    if (row.browserName) failedIn.projects.add(row.browserName);
    else failedIn.anyProject = true;
  }

  // The commit the cluster last failed at — the "from" end of the diff that
  // supposedly fixed it.
  const referencedRunIds = [...new Set(candidates.flatMap((c) => [c.lastSeenRunId, c.firstSeenRunId]))];
  const referencedRuns = referencedRunIds.length
    ? await db
        .select({
          id: testRuns.id,
          branch: testRuns.branch,
          metadata: testRuns.metadata,
          startTime: testRuns.startTime,
        })
        .from(testRuns)
        .where(inArray(testRuns.id, referencedRunIds))
    : [];
  const commitByRunId = new Map<number, string | null>(
    referencedRuns.map((row) => [row.id, ((row.metadata as RunMetadata | null)?.scm?.commit ?? null) as string | null]),
  );
  const branchByRunId = new Map<number, string | null>(
    referencedRuns.map((row) => [row.id, row.branch ?? resolveRunBranch(row.metadata)]),
  );
  const startTimeByRunId = new Map<number, Date | null>(
    referencedRuns.map((row) => [row.id, row.startTime instanceof Date ? row.startTime : null]),
  );

  const fixed: VerifiedFix[] = [];

  // Read once per run: the range's commits and files per starting commit, and
  // whether the project has auto-heal PRs whose trailers are worth reading.
  const changesByFromCommit = new Map<string, ScmChanges | null>();
  let hasHealPrs: boolean | undefined;
  const projectHasHealPrs = async (): Promise<boolean> => {
    if (hasHealPrs === undefined) {
      const [row] = await db
        .select({ id: healActions.id })
        .from(healActions)
        .where(and(eq(healActions.projectId, run.projectId), inArray(healActions.status, ['opened', 'merged'])))
        .limit(1);
      hasHealPrs = row != null;
    }
    return hasHealPrs;
  };

  for (const cluster of candidates) {
    // One cluster that cannot be verified (a storage error, a failed write)
    // leaves the others to their own verification.
    try {
      const clusterCases = casesByCluster.get(cluster.id);
      if (!clusterCases || clusterCases.size === 0) continue;

      // No affected test may be unproven here, and at least one must hold.
      // One test that did not run is enough to say nothing.
      const verdicts = [...clusterCases].map(([caseId, failedIn]) => verdictHere(caseId, failedIn));
      if (verdicts.includes('unproven') || !verdicts.includes('holds')) continue;

      // A run that started before the cluster's last failure ran before it: its
      // passes say nothing about whether the failure stopped. A deleted last
      // failing run orders nothing.
      if (
        startTimeByRunId.has(cluster.lastSeenRunId) &&
        !runStartedAfter(thisRun, {
          id: cluster.lastSeenRunId,
          startTime: startTimeByRunId.get(cluster.lastSeenRunId) ?? null,
        })
      ) {
        continue;
      }

      const fromCommit = commitByRunId.get(cluster.lastSeenRunId) ?? null;
      const failedBranch = branchByRunId.get(cluster.lastSeenRunId) ?? null;
      const quiet = classifyQuietRun({
        runBranch,
        runCommit: currentCommit,
        failedBranch,
        failedCommit: fromCommit,
        defaultBranch: runBranch && runBranch !== failedBranch ? await resolveProjectDefaultBranch() : null,
      });
      if (quiet === 'same-commit') {
        await db.update(failureClusters).set({ flakeEvidenceRunId: runId }).where(eq(failureClusters.id, cluster.id));
        continue;
      }
      if (quiet === 'other-branch') continue;

      let verification: VerifiedFix['verification'] = 'stopped-failing';
      let healPr: HealPrRef | undefined;
      let changes: ScmChanges | null | undefined;
      let files: string[] = [];
      if (repositoryUrl && fromCommit && currentCommit) {
        files = await diagnosedFiles(db, cluster.id);
        changes = changesByFromCommit.get(fromCommit);
        if (changes === undefined) {
          changes = await fetchRangeChanges(db, run.projectId, repositoryUrl, fromCommit, currentCommit);
          changesByFromCommit.set(fromCommit, changes);
        }
        if (changesTouchFiles(changes, files)) verification = 'diagnosis-verified';
        if (files.length > 0 || (await projectHasHealPrs())) {
          healPr = await findHealPr(db, run.projectId, cluster.id, healKeysFromCommits(changes?.commits ?? [])).catch(
            () => undefined,
          );
        }
      }

      // Both ends are run start times, so the number means "how long the suite
      // was broken" rather than mixing a wall-clock row timestamp with a reported
      // run time — which goes negative the moment runs are backfilled or imported.
      // The cluster's own createdAt is the fallback, since runs are deleted
      // independently and clusters outlive them.
      const landedAt = run.startTime instanceof Date ? run.startTime : new Date();
      const brokeAt =
        startTimeByRunId.get(cluster.firstSeenRunId) ?? (cluster.createdAt instanceof Date ? cluster.createdAt : null);
      const timeToResolutionMs = brokeAt ? Math.max(0, landedAt.getTime() - brokeAt.getTime()) : null;

      // Recorded once: a run verified at the same time may have recorded a fix.
      const landed = await db
        .update(failureClusters)
        .set({
          fixLandedRunId: runId,
          fixLandedAt: landedAt,
          fixCommit: currentCommit,
          timeToResolutionMs,
          fixVerification: verification,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(failureClusters.id, cluster.id),
            or(isNull(failureClusters.fixLandedRunId), eq(failureClusters.fixVerification, 'regressed')),
          ),
        )
        .returning({ id: failureClusters.id });
      if (landed.length === 0) continue;

      // The diagnosis pointing at the change that fixed it is strong enough to
      // close the triage; "stopped failing" alone is not.
      const resolved =
        verification === 'diagnosis-verified' &&
        (await transitionClusterStatus(db, cluster.id, {
          from: 'open',
          to: 'resolved',
          line: `Resolved automatically: diagnosis verified in run #${runId}`,
        }));

      if (verification === 'diagnosis-verified') {
        await recordDiagnosisVerified(db, run.projectId, cluster.id, runId, currentCommit).catch((e) =>
          console.error('[outcomes] diagnosis verification failed', e),
        );
      }
      // The verdict read the range's changes, so the repository and commit are known.
      if (verification === 'diagnosis-verified' && repositoryUrl && currentCommit) {
        await checkPatchAtFix(db, {
          projectId: run.projectId,
          clusterId: cluster.id,
          runId,
          commit: currentCommit,
          repositoryUrl,
          changedFiles: (changes?.files ?? []).map((file) => file.filename),
        }).catch((e) => console.error('[fix-verification] patch check at the fix failed', e));
      }
      await verifyFixAttempts(db, {
        projectId: run.projectId,
        clusterId: cluster.id,
        runId,
        commit: currentCommit,
        branch: runBranch,
        fromCommit,
        repositoryUrl,
      }).catch((e) => console.error('[outcomes] fix attempt verification failed', e));
      // The fixing change names the cause: tests not about it caught it by accident.
      await recordIncidentalCatch(db, {
        projectId: run.projectId,
        runId,
        clusterId: cluster.id,
        caseIds: [...clusterCases.keys()],
        diagnosedFiles: verification === 'diagnosis-verified' ? files : [],
        changedFiles: changes && !changes.filesTruncated ? changes.files.map((file) => file.filename) : null,
      }).catch((e) => console.error('[fix-verification] incidental catch failed', e));

      fixed.push({
        clusterId: cluster.id,
        signature: cluster.signature,
        title: cluster.title,
        verification,
        timeToResolutionMs,
        testCount: clusterCases.size,
        ...(healPr ? { healPr } : {}),
      });

      // The fix reaches the person whose commit landed it.
      if (notify) {
        const fixAuthor = await resolveFixAuthor(db, run.projectId, repositoryUrl, currentCommit);
        const knownIssue = (await getClusterKnownIssue(db, cluster.id).catch(() => null)) ?? undefined;
        await emitClusterOutcome(db, 'cluster.fixed', {
          clusterId: cluster.id,
          projectId: run.projectId,
          projectName,
          signature: cluster.signature,
          title: cluster.title,
          runId,
          ...runScope,
          verification,
          commit: currentCommit,
          timeToResolutionMs,
          testCount: clusterCases.size,
          resolved,
          fixAuthor,
          knownIssue: knownIssue ? { key: knownIssue.key, url: knownIssue.url } : undefined,
          healPr,
        });
      }

      // Comment on (and optionally transition) the ticket per the binding's policy.
      await enqueueFixPolicies(db, {
        clusterId: cluster.id,
        projectId: run.projectId,
        runId,
        commit: currentCommit,
        verification,
      }).catch((e) => console.error('[integrations] fix policy failed', e));
    } catch (error) {
      console.error(`[fix-verification] verifying cluster #${cluster.id} in run #${runId} failed`, error);
    }
  }

  await followTrackedFailures();
  return fixed;
}
