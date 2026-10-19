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
 * worth more than no record at all.
 *
 * A quiet run counts as a fix only when it could have carried one: its commit
 * differs from the commit the cluster last failed at, and it ran on the branch
 * the cluster last failed on or on the default branch. A pass at the failing
 * commit (a CI retry, a re-run from the dashboard) is stored as flake evidence
 * on the cluster instead; a pass on another branch says nothing about this one.
 *
 * The verdict moves the triage status only when the evidence is strong:
 * `diagnosis-verified` resolves an open cluster, `regressed` reopens a resolved
 * one, each appending a system line to the triage note. `stopped-failing`
 * alone changes nothing — a flaky test achieves it by accident. Every recorded
 * fix emits `cluster.fixed`; every regression emits `cluster.regressed`.
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
 * Every step is best-effort — the run is already stored, and SCM being
 * unreachable must never turn into an ingest error.
 */
import { and, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
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
import { isEligibleRun } from '#shared/run-eligibility';
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
import type { DbClient } from '../database';

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

/** Append a system-written line to a triage note, keeping what a person wrote. */
export function appendTriageNote(existing: string | null | undefined, line: string): string {
  const current = existing?.trim();
  return current ? `${current}\n${line}` : line;
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
 * Record fixes and regressions for one finished run. Returns the fixes that
 * landed, so the pull-request comment can report them.
 */
export async function verifyClusterFixes(db: DbClient, runId: number): Promise<VerifiedFix[]> {
  const [run] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
  // A lab arm, a bisect step or a reproduction ran at a commit chosen to
  // investigate a failure: its passes prove no fix and its failures no regression.
  if (!run || !isEligibleRun(run, 'fix-verification')) return [];

  // A partial run can still verify a cluster — but only by the same rule a full
  // run is held to below: every test the cluster covers ran in this run and
  // passed. A `--grep` that re-ran exactly the affected tests then closes the
  // cluster; one that skipped even one of them still does not, because a test
  // that did not execute has not been shown to pass. There is no separate
  // `isFullRun` gate: the per-cluster check is the honest one either way.

  const meta = (run.metadata as RunMetadata | null) ?? null;
  const currentCommit = meta?.scm?.commit ?? null;
  const repositoryUrl = normalizeGitUrl(meta?.scm?.remoteUrl ?? null);
  const runScope = {
    branch: run.branch ?? resolveRunBranch(run.metadata) ?? undefined,
    environment: run.environment ?? undefined,
  };

  // What this run saw, per test case: any pass, and any failure.
  const caseRows = await db
    .select({
      testCaseId: testRunsCases.testCaseId,
      status: testRunsCases.status,
      clusterId: testRunsCases.failureClusterId,
    })
    .from(testRunsCases)
    .where(eq(testRunsCases.testRunId, runId));

  const passedCaseIds = new Set<number>();
  const executedCaseIds = new Set<number>();
  const clustersSeenNow = new Set<number>();
  for (const row of caseRows) {
    executedCaseIds.add(row.testCaseId);
    if (row.status === 'passed') passedCaseIds.add(row.testCaseId);
    if (row.clusterId != null && FAIL_STATUSES.includes(row.status)) clustersSeenNow.add(row.clusterId);
  }

  const [project] = await db
    .select({ name: projects.name, label: projects.label, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, run.projectId));
  const projectName = project?.label || project?.name || `Project #${run.projectId}`;

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
        status: failureClusters.status,
        triageNote: failureClusters.triageNote,
        fixLandedRunId: failureClusters.fixLandedRunId,
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

    for (const cluster of regressing) {
      try {
        // A person's "resolved" was contradicted by the runs, so the cluster goes
        // back to open with the reason on record; "ignored" is left alone.
        const reopened = cluster.status === 'resolved';
        await db
          .update(failureClusters)
          .set({
            fixVerification: 'regressed',
            updatedAt: new Date(),
            ...(reopened
              ? {
                  status: 'open',
                  triageNote: appendTriageNote(
                    cluster.triageNote,
                    `Reopened automatically: regressed in run #${runId}`,
                  ),
                }
              : {}),
          })
          .where(eq(failureClusters.id, cluster.id));

        // The regression reaches the author of the fix that did not hold.
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
      status: failureClusters.status,
      triageNote: failureClusters.triageNote,
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
    .select({ clusterId: testRunsCases.failureClusterId, testCaseId: testRunsCases.testCaseId })
    .from(testRunsCases)
    .where(inArray(testRunsCases.failureClusterId, candidateIds));

  const casesByCluster = new Map<number, Set<number>>();
  for (const row of affected) {
    if (row.clusterId == null) continue;
    let set = casesByCluster.get(row.clusterId);
    if (!set) casesByCluster.set(row.clusterId, (set = new Set()));
    set.add(row.testCaseId);
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

      // Every affected test must have run here and passed. One unexecuted test
      // is enough to say nothing.
      let allGreen = true;
      for (const caseId of clusterCases) {
        if (!executedCaseIds.has(caseId) || !passedCaseIds.has(caseId)) {
          allGreen = false;
          break;
        }
      }
      if (!allGreen) continue;

      const fromCommit = commitByRunId.get(cluster.lastSeenRunId) ?? null;
      const failedBranch = branchByRunId.get(cluster.lastSeenRunId) ?? null;
      const runBranch = runScope.branch ?? null;
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
      if (repositoryUrl && fromCommit && currentCommit) {
        const files = await diagnosedFiles(db, cluster.id);
        if (files.length > 0 || (await projectHasHealPrs())) {
          changes = changesByFromCommit.get(fromCommit);
          if (changes === undefined) {
            changes = await fetchRangeChanges(db, run.projectId, repositoryUrl, fromCommit, currentCommit);
            changesByFromCommit.set(fromCommit, changes);
          }
          if (changesTouchFiles(changes, files)) verification = 'diagnosis-verified';
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

      // The diagnosis pointing at the change that fixed it is strong enough to
      // close the triage; "stopped failing" alone is not.
      const resolved = verification === 'diagnosis-verified' && cluster.status === 'open';
      await db
        .update(failureClusters)
        .set({
          fixLandedRunId: runId,
          fixLandedAt: landedAt,
          fixCommit: currentCommit,
          timeToResolutionMs,
          fixVerification: verification,
          updatedAt: new Date(),
          ...(resolved
            ? {
                status: 'resolved',
                triageNote: appendTriageNote(
                  cluster.triageNote,
                  `Resolved automatically: diagnosis verified in run #${runId}`,
                ),
              }
            : {}),
        })
        .where(eq(failureClusters.id, cluster.id));

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
