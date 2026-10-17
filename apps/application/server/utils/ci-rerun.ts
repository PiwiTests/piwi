/**
 * CI re-run — server-side settings access and the shared dispatch flow.
 *
 * The settings live on the project row (`projects.ciRerun`), the token is the
 * project's SCM token, and the provider is decided by the repository URL of the
 * cluster's most recent run. This module ties those together so the availability
 * check (for the button's enabled/disabled state) and the dispatch route agree.
 */
import { randomBytes } from 'node:crypto';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { failureClusters, projects, testCases, testRuns, testRunsCases } from '../database/schema';
import { createScmProvider, detectScmProvider, resolveScmToken } from './scm';
import { normalizeGitUrl } from './scm/git-url';
import { buildRetryArgs, toPosixPath, type RetryCase } from '#shared/retry-command';
import {
  flakeLabCiArgs,
  flakeLabRerunSettings,
  resolveCiRerunSettings,
  hasRerunTarget,
  matchRerunDispatch,
  RERUN_MATCH_WINDOW_MS,
  type CiRerunSettings,
  type ClusterRerunDispatch,
} from '#shared/ci-rerun';
import { CI_RUN_ORIGINS, RUN_ORIGIN_METADATA_KEY, runCommit, runOrigin, runOriginRef } from '#shared/run-eligibility';
import { resolveRunBranch } from './run-branch';
import type { ScmProviderName } from '#shared/scm-urls';
import type { RunMetadata } from './run-json-types';
import type { DbClient } from '../database';

/** The resolved CI re-run settings for a project (disabled defaults when unset). */
export async function getCiRerunSettings(db: DbClient, projectId: number): Promise<CiRerunSettings> {
  const [project] = await db.select({ ciRerun: projects.ciRerun }).from(projects).where(eq(projects.id, projectId));
  return resolveCiRerunSettings((project?.ciRerun as Partial<CiRerunSettings> | null) ?? null);
}

/** The repository URL from a cluster's most recent run, normalized, or null. */
export async function clusterRepositoryUrl(db: DbClient, lastSeenRunId: number): Promise<string | null> {
  const [run] = await db.select({ metadata: testRuns.metadata }).from(testRuns).where(eq(testRuns.id, lastSeenRunId));
  const meta = (run?.metadata as RunMetadata | null) ?? null;
  return normalizeGitUrl(meta?.scm?.remoteUrl ?? null);
}

/** Why a cluster's "Re-run in CI" button is not available, or null when it is. */
export interface CiRerunAvailability {
  available: boolean;
  /** Human-readable reason the button is disabled, for its tooltip. */
  reason: string | null;
  provider: ScmProviderName | null;
  enabled: boolean;
  hasToken: boolean;
}

/**
 * Decide whether a cluster can be re-run in CI, with a reason when it cannot —
 * the same checks the dispatch route enforces, so the button never offers an
 * action the POST would reject.
 */
export async function ciRerunAvailability(
  db: DbClient,
  projectId: number,
  lastSeenRunId: number,
): Promise<CiRerunAvailability> {
  const settings = await getCiRerunSettings(db, projectId);
  const repositoryUrl = await clusterRepositoryUrl(db, lastSeenRunId);
  const provider = detectScmProvider(repositoryUrl);
  const hasToken = Boolean(await resolveScmToken(db, projectId));

  if (!settings.enabled) {
    return { available: false, reason: 'CI re-run is off for this project.', provider, enabled: false, hasToken };
  }
  if (!provider) {
    return {
      available: false,
      reason: 'This cluster has no supported repository to dispatch to.',
      provider: null,
      enabled: true,
      hasToken,
    };
  }
  if (!hasRerunTarget(settings, provider)) {
    return {
      available: false,
      reason: `No ${provider} re-run target is configured for this project.`,
      provider,
      enabled: true,
      hasToken,
    };
  }
  if (!hasToken) {
    return {
      available: false,
      reason: 'No SCM token is configured to dispatch the re-run.',
      provider,
      enabled: true,
      hasToken: false,
    };
  }
  return { available: true, reason: null, provider, enabled: true, hasToken: true };
}

/** Affected tests a re-run names at most. */
const MAX_RERUN_TESTS = 100;

/**
 * The tests a cluster's re-run runs: each affected test at the line and in the
 * Playwright project of its latest failure in the cluster.
 */
export async function clusterRerunCases(db: DbClient, clusterId: number): Promise<RetryCase[]> {
  const rows = await db
    .select({
      testCaseId: testRunsCases.testCaseId,
      line: testRunsCases.line,
      projectName: testRunsCases.browserName,
      title: testCases.title,
      filePath: testCases.filePath,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.failureClusterId, clusterId))
    .orderBy(desc(testRunsCases.id))
    .limit(MAX_RERUN_TESTS * 10);
  const latest = new Map<number, RetryCase>();
  for (const r of rows) {
    if (r.testCaseId == null || latest.has(r.testCaseId)) continue;
    latest.set(r.testCaseId, { filePath: r.filePath, title: r.title, line: r.line, projectName: r.projectName });
    if (latest.size >= MAX_RERUN_TESTS) break;
  }
  return [...latest.values()];
}

/** The Playwright arguments to re-run exactly a cluster's affected tests (file:line). */
export async function clusterRerunArgs(db: DbClient, clusterId: number): Promise<string> {
  return buildRetryArgs(await clusterRerunCases(db, clusterId));
}

/** The branch a cluster's re-run runs on: the branch of the cluster's latest run, when it has one. */
export async function clusterRerunRef(db: DbClient, lastSeenRunId: number): Promise<string | null> {
  const [run] = await db
    .select({ branch: testRuns.branch, metadata: testRuns.metadata })
    .from(testRuns)
    .where(eq(testRuns.id, lastSeenRunId));
  return run ? (run.branch ?? resolveRunBranch(run.metadata) ?? null) : null;
}

/** A dispatch as `dispatchClusterRerun` sent it. */
export type DispatchedRerun = Omit<ClusterRerunDispatch, 'at' | 'byName' | 'byUserId'>;

/**
 * Dispatch a CI re-run of a cluster's affected tests on the branch of its
 * latest run (the target's configured ref when that run has none). Assumes
 * availability was already checked (the route does). Returns what was sent and
 * what the provider answered. Throws with the provider's message on a dispatch
 * failure.
 */
export async function dispatchClusterRerun(
  db: DbClient,
  cluster: { id: number; projectId: number; lastSeenRunId: number },
): Promise<DispatchedRerun> {
  const settings = await getCiRerunSettings(db, cluster.projectId);
  const repositoryUrl = await clusterRepositoryUrl(db, cluster.lastSeenRunId);
  const provider = detectScmProvider(repositoryUrl);
  if (!repositoryUrl || !provider) throw new Error('No supported repository to dispatch to');

  const scm = await createScmProvider(repositoryUrl, db, cluster.projectId);
  if (!scm) throw new Error('Could not build an SCM client for this repository');

  const cases = await clusterRerunCases(db, cluster.id);
  const args = buildRetryArgs(cases);
  const files = [...new Set(cases.map((c) => toPosixPath(c.filePath)))].sort();
  const id = randomBytes(8).toString('hex');
  const ref = await clusterRerunRef(db, cluster.lastSeenRunId);
  const sent = await scm.dispatchRerun(settings, args, { ref, dispatchId: id });
  return {
    id,
    provider,
    url: sent.url,
    args,
    ref: sent.ref ?? ref,
    files,
    ...(sent.pipelineId ? { pipelineId: sent.pipelineId } : {}),
    ...(sent.buildNumber ? { buildNumber: sent.buildNumber } : {}),
  };
}

/** Who asked for a re-run, as the dispatch record names them. */
export interface CiRerunActor {
  id: number | null;
  name: string | null;
}

export type ClusterRerunOutcome =
  | { ok: true; dispatch: ClusterRerunDispatch }
  | { ok: false; error: 'not-found' | 'unavailable' | 'dispatch-failed'; message: string };

/**
 * Re-run a cluster's affected tests in CI: check availability, dispatch, and
 * store the dispatch on the cluster as `lastRerunDispatch`. The REST route and
 * the MCP tool both call it, after their own access checks.
 */
export async function rerunClusterInCi(
  db: DbClient,
  clusterId: number,
  actor: CiRerunActor,
): Promise<ClusterRerunOutcome> {
  const [cluster] = await db
    .select({
      id: failureClusters.id,
      projectId: failureClusters.projectId,
      lastSeenRunId: failureClusters.lastSeenRunId,
    })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  if (!cluster) return { ok: false, error: 'not-found', message: 'Failure cluster not found' };

  const availability = await ciRerunAvailability(db, cluster.projectId, cluster.lastSeenRunId);
  if (!availability.available) {
    return {
      ok: false,
      error: 'unavailable',
      message: availability.reason ?? 'CI re-run is not available for this cluster',
    };
  }

  let dispatched: DispatchedRerun;
  try {
    dispatched = await dispatchClusterRerun(db, cluster);
  } catch (e) {
    return {
      ok: false,
      error: 'dispatch-failed',
      message: e instanceof Error ? e.message : 'CI re-run dispatch failed',
    };
  }

  const dispatch: ClusterRerunDispatch = {
    ...dispatched,
    at: Date.now(),
    byName: actor.name,
    byUserId: actor.id,
  };
  await db
    .update(failureClusters)
    .set({ lastRerunDispatch: dispatch, updatedAt: new Date() })
    .where(eq(failureClusters.id, cluster.id));
  return { ok: true, dispatch };
}

/**
 * Recognize a finished CI run as the re-run a cluster dispatched (see
 * `matchRerunDispatch`): stamp its origin `ci-rerun` with the dispatch id, and
 * record the run on the dispatch. Returns the cluster whose dispatch it
 * answered, or null.
 */
export async function matchCiRerunRun(db: DbClient, runId: number): Promise<number | null> {
  const [run] = await db
    .select({
      projectId: testRuns.projectId,
      metadata: testRuns.metadata,
      branch: testRuns.branch,
      startTime: testRuns.startTime,
    })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  if (!run || !(CI_RUN_ORIGINS as readonly string[]).includes(runOrigin(run.metadata))) return null;

  const startedAt = run.startTime instanceof Date ? run.startTime.getTime() : Number(run.startTime);
  const clusters = await db
    .select({ id: failureClusters.id, dispatch: failureClusters.lastRerunDispatch })
    .from(failureClusters)
    .where(and(eq(failureClusters.projectId, run.projectId), isNotNull(failureClusters.lastRerunDispatch)));
  const dispatches = clusters
    .map((c) => ({ ...(c.dispatch as ClusterRerunDispatch), clusterId: c.id }))
    .filter((d) => d.id && startedAt >= d.at - 60_000 && startedAt - d.at <= RERUN_MATCH_WINDOW_MS);
  if (dispatches.length === 0) return null;

  const executed = await db
    .selectDistinct({ filePath: testCases.filePath })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.testRunId, runId));
  const meta = (run.metadata as RunMetadata | null) ?? null;
  const match = matchRerunDispatch(
    {
      originRef: runOriginRef(run.metadata),
      pipelineId: meta?.ci?.pipelineId ?? null,
      buildNumber: meta?.ci?.buildNumber ?? null,
      branch: run.branch ?? resolveRunBranch(run.metadata) ?? null,
      startedAt,
      files: executed.map((r) => toPosixPath(r.filePath)),
    },
    dispatches,
  );
  if (!match) return null;

  const { clusterId, ...dispatch } = match;
  const metadata = {
    ...((run.metadata as Record<string, unknown> | null) ?? {}),
    [RUN_ORIGIN_METADATA_KEY]: { kind: 'ci-rerun', ref: dispatch.id },
  };
  await db
    .update(testRuns)
    .set({ metadata, origin: runOrigin(metadata), commit: runCommit(metadata) })
    .where(eq(testRuns.id, runId));
  await db
    .update(failureClusters)
    .set({ lastRerunDispatch: { ...dispatch, runId } })
    .where(eq(failureClusters.id, clusterId));
  return clusterId;
}

/** The run of a test's newest execution, whose repository and branch a Flake Lab dispatch uses. */
async function latestTestRunId(db: DbClient, testCaseId: number): Promise<number | null> {
  const [row] = await db
    .select({ testRunId: testRunsCases.testRunId })
    .from(testRunsCases)
    .where(eq(testRunsCases.testCaseId, testCaseId))
    .orderBy(desc(testRunsCases.id))
    .limit(1);
  return row?.testRunId ?? null;
}

/** Whether `piwi flake` can be dispatched to CI for a test, with a reason when it cannot. */
export interface FlakeLabCiAvailability {
  available: boolean;
  reason: string | null;
  provider: ScmProviderName | null;
}

/**
 * Decide whether a test's Flake Lab experiment can run in CI: CI re-run on, a
 * Flake Lab target for the provider of the repository of the test's newest run,
 * and a token. The same checks the dispatch makes.
 */
export async function flakeLabCiAvailability(
  db: DbClient,
  projectId: number,
  testCaseId: number,
): Promise<FlakeLabCiAvailability> {
  const settings = await getCiRerunSettings(db, projectId);
  if (!settings.enabled || !settings.flakeLab) {
    return { available: false, reason: 'No Flake Lab target is configured for CI re-run.', provider: null };
  }
  const runId = await latestTestRunId(db, testCaseId);
  const provider = detectScmProvider(runId ? await clusterRepositoryUrl(db, runId) : null);
  if (!provider) {
    return { available: false, reason: 'This test has no supported repository to dispatch to.', provider: null };
  }
  if (!flakeLabRerunSettings(settings, provider)) {
    return { available: false, reason: `No ${provider} Flake Lab target is configured.`, provider };
  }
  if (!(await resolveScmToken(db, projectId))) {
    return { available: false, reason: 'No SCM token is configured to dispatch the experiment.', provider };
  }
  return { available: true, reason: null, provider };
}

export type FlakeLabCiOutcome =
  | { ok: true; dispatch: ClusterRerunDispatch }
  | { ok: false; error: 'not-found' | 'unavailable' | 'dispatch-failed'; message: string };

/**
 * Run a test's Flake Lab experiment in CI: the Flake Lab target receives the
 * `piwi flake` arguments, through the same dispatch as a cluster's re-run, on
 * the branch of the test's newest run. The experiment the command records is
 * the trace; nothing else is stored.
 */
export async function runFlakeLabInCi(
  db: DbClient,
  testCaseId: number,
  kind: 'reproduce' | 'verify',
  actor: CiRerunActor,
): Promise<FlakeLabCiOutcome> {
  const [tc] = await db.select({ projectId: testCases.projectId }).from(testCases).where(eq(testCases.id, testCaseId));
  if (!tc) return { ok: false, error: 'not-found', message: 'Test case not found' };
  const availability = await flakeLabCiAvailability(db, tc.projectId, testCaseId);
  if (!availability.available || !availability.provider) {
    return { ok: false, error: 'unavailable', message: availability.reason ?? 'Flake Lab in CI is not available' };
  }
  const runId = (await latestTestRunId(db, testCaseId))!;
  const repositoryUrl = await clusterRepositoryUrl(db, runId);
  const settings = flakeLabRerunSettings(await getCiRerunSettings(db, tc.projectId), availability.provider)!;
  try {
    const scm = await createScmProvider(repositoryUrl!, db, tc.projectId);
    if (!scm) throw new Error('Could not build an SCM client for this repository');
    const args = flakeLabCiArgs(testCaseId, kind);
    const id = randomBytes(8).toString('hex');
    const ref = await clusterRerunRef(db, runId);
    const sent = await scm.dispatchRerun(settings, args, { ref, dispatchId: id });
    return {
      ok: true,
      dispatch: {
        id,
        provider: availability.provider,
        url: sent.url,
        args,
        ref: sent.ref ?? ref,
        ...(sent.pipelineId ? { pipelineId: sent.pipelineId } : {}),
        ...(sent.buildNumber ? { buildNumber: sent.buildNumber } : {}),
        at: Date.now(),
        byName: actor.name,
        byUserId: actor.id,
      },
    };
  } catch (e) {
    return { ok: false, error: 'dispatch-failed', message: e instanceof Error ? e.message : 'Dispatch failed' };
  }
}
