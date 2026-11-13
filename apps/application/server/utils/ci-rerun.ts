/**
 * CI re-run — the shared dispatch flow, for a cluster's affected tests, for
 * one execution's test, and for a Flake Lab experiment.
 *
 * The project's CI actions (`server/utils/ci-actions.ts`) say where a dispatch
 * goes: each action names a repository host's CI (a GitHub workflow, a GitLab
 * or Bitbucket pipeline, which use the project's SCM token on the repository
 * of the run the tests come from) or a CI server (`server/utils/ci-server-dispatch.ts`),
 * whatever hosts the repository. `pickCiAction` chooses the action for a kind
 * and a run. This module ties those together so the availability check (for
 * the button's enabled/disabled state) and the dispatch route agree.
 */
import { randomBytes } from 'node:crypto';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { failureClusters, testCases, testRuns, testRunsCases } from '../database/schema';
import { createScmProvider, detectScmProvider, resolveScmToken } from './scm';
import { normalizeGitUrl } from './scm/git-url';
import { buildRetryArgs, toPosixPath, type RetryCase } from '#shared/retry-command';
import { clusterRerunCases } from '#shared/handlers/cluster-rerun-cases';
import {
  ciServerValues,
  clusterLastDispatch,
  executionRerunTarget,
  recordClusterDispatch,
  rerunFiles,
  rerunRefAndCommit,
} from '#shared/handlers/ci-rerun-target';
import {
  flakeLabCiArgs,
  matchRerunDispatch,
  RERUN_CLOCK_SLACK_MS,
  RERUN_MATCH_WINDOW_MS,
  type CiRerunProvider,
  type ClusterRerunDispatch,
} from '#shared/ci-rerun';
import {
  ciActionInputValues,
  ciServerTargetOf,
  pickCiAction,
  reservedInputMessage,
  reservedInputName,
  type CiAction,
  type CiActionKind,
  type CiActionsSettings,
} from '#shared/ci-actions';
import { getCiActionsSettings } from './ci-actions';
import { ciServerRequestTemplate } from '#shared/ci-server';
import { safeHttpUrl } from '#shared/utils/safe-url';
import {
  ciServerBaseUrl,
  ciServerBaseUrlProblem,
  dispatchToCiServer,
  instanceCiServer,
  prepareCiServerRequest,
  projectCiServerToken,
} from './ci-server-dispatch';
import { CI_RUN_ORIGINS, RUN_ORIGIN_METADATA_KEY, runCommit, runOrigin, runOriginRef } from '#shared/run-eligibility';
import { resolveRunBranch } from './run-branch';
import type { RunMetadata } from './run-json-types';
import type { DbClient } from '../database';

/** The repository URL from a cluster's most recent run, normalized, or null. */
export async function clusterRepositoryUrl(db: DbClient, lastSeenRunId: number): Promise<string | null> {
  const [run] = await db.select({ metadata: testRuns.metadata }).from(testRuns).where(eq(testRuns.id, lastSeenRunId));
  const meta = (run?.metadata as RunMetadata | null) ?? null;
  return normalizeGitUrl(meta?.scm?.remoteUrl ?? null);
}

/** The environment of a cluster's most recent run, or null when it has none. */
export async function clusterEnvironment(db: DbClient, lastSeenRunId: number): Promise<string | null> {
  const [run] = await db
    .select({ environment: testRuns.environment })
    .from(testRuns)
    .where(eq(testRuns.id, lastSeenRunId));
  return run?.environment?.trim() || null;
}

/** Why a cluster's "Re-run in CI" button is not available, or null when it is. */
export interface CiRerunAvailability {
  available: boolean;
  /** Human-readable reason the button is disabled, for its tooltip. */
  reason: string | null;
  provider: CiRerunProvider | null;
  enabled: boolean;
  hasToken: boolean;
  /** The action a dispatch would use, when one can serve the run. */
  action: { id: string; name: string } | null;
}

const actionRef = (action: CiAction | null) => (action ? { id: action.id, name: action.name } : null);

/**
 * Whether a CI server action can be dispatched for a run, and whether it would
 * carry a credential: a request its target builds, a base URL that is https
 * (or http on a listed place), and a request its values fill, built as the
 * dispatch builds it. DNS is checked at dispatch.
 */
async function ciServerReadiness(
  db: DbClient,
  projectId: number,
  action: CiAction & { target: { type: 'ci-server' } },
  runId: number | null,
): Promise<{ reason: string | null; hasToken: boolean }> {
  const target = ciServerTargetOf(action.target);
  if (!ciServerRequestTemplate(target, 'rerun')) {
    return { reason: 'No CI server is configured for this project.', hasToken: false };
  }
  const baseUrl = ciServerBaseUrl(target);
  const problem = ciServerBaseUrlProblem(baseUrl);
  if (problem || !baseUrl) return { reason: problem, hasToken: false };
  try {
    const request = prepareCiServerRequest({
      target,
      kind: 'rerun',
      baseUrl,
      values: await ciServerValues(db, runId, target, 'args', 'dispatch'),
      inputs: ciActionInputValues(action),
      projectToken: await projectCiServerToken(db, projectId),
      instanceCredential: instanceCiServer().credential,
    });
    return { reason: null, hasToken: request.credential !== null };
  } catch (e) {
    return { reason: e instanceof Error ? e.message : 'The CI server request cannot be built.', hasToken: false };
  }
}

/** What decides whether a dispatch of a kind can be sent for a run. */
interface DispatchReadiness {
  available: boolean;
  reason: string | null;
  provider: CiRerunProvider | null;
  enabled: boolean;
  hasToken: boolean;
  action: CiAction | null;
}

/**
 * Whether a dispatch of `kind` can be sent for a run: CI actions on, an action
 * that accepts the kind and serves the run's repository (`pickCiAction`), and
 * what that action needs (an SCM token, or a CI server request that builds).
 */
async function dispatchReadiness(
  db: DbClient,
  projectId: number,
  runId: number | null,
  kind: CiActionKind,
  actionId?: string | null,
): Promise<DispatchReadiness> {
  const settings = await getCiActionsSettings(db, projectId);
  const repositoryUrl = runId ? await clusterRepositoryUrl(db, runId) : null;
  const detected = detectScmProvider(repositoryUrl);
  const environment = runId ? await clusterEnvironment(db, runId) : null;
  const pick = pickCiAction(settings, kind, { provider: detected, environment, actionId });
  const action = pick.action;
  const provider = action ? action.target.type : detected;
  const hasScmToken = Boolean(await resolveScmToken(db, projectId));
  if (!settings.enabled) {
    return {
      available: false,
      reason: 'CI re-run is off for this project.',
      provider,
      enabled: false,
      hasToken: hasScmToken,
      action,
    };
  }
  if (!action) {
    return { available: false, reason: pick.reason, provider, enabled: true, hasToken: hasScmToken, action: null };
  }
  const reserved = reservedInputName(action);
  if (reserved) {
    return {
      available: false,
      reason: reservedInputMessage(reserved, action.target.type === 'bitbucket' ? 'bitbucket' : 'gitlab'),
      provider,
      enabled: true,
      hasToken: hasScmToken,
      action,
    };
  }
  if (action.target.type === 'ci-server') {
    const ready = await ciServerReadiness(db, projectId, { ...action, target: action.target }, runId);
    return {
      available: !ready.reason,
      reason: ready.reason,
      provider,
      enabled: true,
      hasToken: ready.hasToken,
      action,
    };
  }
  if (!hasScmToken) {
    const reason =
      kind === 'flakeLab'
        ? 'No SCM token is configured to dispatch the experiment.'
        : 'No SCM token is configured to dispatch the re-run.';
    return { available: false, reason, provider, enabled: true, hasToken: false, action };
  }
  return { available: true, reason: null, provider, enabled: true, hasToken: true, action };
}

/**
 * Decide whether a cluster can be re-run in CI, with a reason when it cannot —
 * the same checks the dispatch route enforces, so the button never offers an
 * action the POST would reject. `actionId` names the action to use (an id or
 * an exact name); without it the project's default for re-runs applies.
 */
export async function ciRerunAvailability(
  db: DbClient,
  projectId: number,
  lastSeenRunId: number,
  actionId?: string | null,
): Promise<CiRerunAvailability> {
  const ready = await dispatchReadiness(db, projectId, lastSeenRunId, 'tests', actionId);
  return {
    available: ready.available,
    reason: ready.reason,
    provider: ready.provider,
    enabled: ready.enabled,
    hasToken: ready.hasToken,
    action: actionRef(ready.action),
  };
}

/** The branch a re-run runs on: the branch of the run it re-runs, when that run has one. */
async function rerunRef(db: DbClient, runId: number): Promise<string | null> {
  return (await rerunRefAndCommit(db, runId)).ref;
}

/** A dispatch as `dispatchClusterRerun` sent it. */
export type DispatchedRerun = Omit<ClusterRerunDispatch, 'at' | 'byName' | 'byUserId'>;

/**
 * Send a dispatch of these arguments through an action, on the repository and
 * branch of the run they come from (the target's configured ref when that run
 * has none). The action's inputs go beside the arguments, never into them.
 * Throws with the provider's message on a failure.
 */
async function dispatchWithAction(
  db: DbClient,
  input: {
    projectId: number;
    runId: number | null;
    action: CiAction;
    args: string;
    id: string;
    /** The spec files and the number of tests the arguments name, recorded for matching the run it starts. */
    cases?: RetryCase[];
  },
): Promise<DispatchedRerun> {
  const { action, args, id } = input;
  const reserved = reservedInputName(action);
  if (reserved)
    throw new Error(reservedInputMessage(reserved, action.target.type === 'bitbucket' ? 'bitbucket' : 'gitlab'));
  const inputs = ciActionInputValues(action);
  const named = input.cases ? { files: rerunFiles(input.cases), tests: input.cases.length } : {};
  const target = action.target;

  if (target.type === 'ci-server') {
    const server = ciServerTargetOf(target);
    const values = await ciServerValues(db, input.runId, server, args, id);
    const sent = await dispatchToCiServer(db, input.projectId, server, 'rerun', values, inputs);
    return {
      id,
      actionId: action.id,
      provider: 'ci-server',
      preset: target.preset,
      url: sent.url,
      args,
      ref: values.ref || null,
      ...named,
      ...(sent.buildNumber ? { buildNumber: sent.buildNumber } : {}),
    };
  }

  const repositoryUrl = input.runId ? await clusterRepositoryUrl(db, input.runId) : null;
  if (!repositoryUrl || detectScmProvider(repositoryUrl) !== target.type) {
    throw new Error('No supported repository to dispatch to');
  }
  const scm = await createScmProvider(repositoryUrl, db, input.projectId);
  if (!scm?.provider) throw new Error('Could not build an SCM client for this repository');

  const ref = input.runId ? await rerunRef(db, input.runId) : null;
  const sent = await scm.dispatchRerun(target, args, { ref, dispatchId: id, inputs });
  return {
    id,
    actionId: action.id,
    provider: target.type,
    url: sent.url,
    args,
    ref: sent.ref ?? ref,
    ...named,
    ...(sent.pipelineId ? { pipelineId: sent.pipelineId } : {}),
    ...(sent.buildNumber ? { buildNumber: sent.buildNumber } : {}),
  };
}

/** The action a dispatch of `kind` for a run uses, or the error a dispatch throws. */
async function actionFor(
  db: DbClient,
  projectId: number,
  runId: number | null,
  kind: CiActionKind,
  actionId?: string | null,
): Promise<CiAction> {
  const settings: CiActionsSettings = await getCiActionsSettings(db, projectId);
  const provider = detectScmProvider(runId ? await clusterRepositoryUrl(db, runId) : null);
  const environment = runId ? await clusterEnvironment(db, runId) : null;
  const pick = pickCiAction(settings, kind, { provider, environment, actionId });
  if (!pick.action) throw new Error(pick.reason);
  return pick.action;
}

/**
 * Dispatch a CI re-run of a cluster's affected tests on the branch of its
 * latest run (the action's configured ref when that run has none). Assumes
 * availability was already checked (the route does). Returns what was sent and
 * what the provider answered. Throws with the provider's message on a dispatch
 * failure.
 */
export async function dispatchClusterRerun(
  db: DbClient,
  cluster: { id: number; projectId: number; lastSeenRunId: number },
  actionId?: string | null,
): Promise<DispatchedRerun> {
  return dispatchRerunOf(db, {
    projectId: cluster.projectId,
    runId: cluster.lastSeenRunId,
    cases: await clusterRerunCases(db, cluster.id),
    actionId,
  });
}

/** Dispatch a CI re-run of these cases, through the action the project's settings pick for the run. */
async function dispatchRerunOf(
  db: DbClient,
  input: { projectId: number; runId: number; cases: RetryCase[]; actionId?: string | null },
): Promise<DispatchedRerun> {
  const action = await actionFor(db, input.projectId, input.runId, 'tests', input.actionId);
  return dispatchWithAction(db, {
    projectId: input.projectId,
    runId: input.runId,
    action,
    args: buildRetryArgs(input.cases),
    id: randomBytes(8).toString('hex'),
    cases: input.cases,
  });
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
  options: { actionId?: string | null } = {},
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

  const availability = await ciRerunAvailability(db, cluster.projectId, cluster.lastSeenRunId, options.actionId);
  if (!availability.available) {
    return {
      ok: false,
      error: 'unavailable',
      message: availability.reason ?? 'CI re-run is not available for this cluster',
    };
  }

  let dispatched: DispatchedRerun;
  try {
    dispatched = await dispatchClusterRerun(db, cluster, options.actionId);
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
  await recordClusterDispatch(db, cluster.id, dispatch);
  return { ok: true, dispatch };
}

/** Whether an execution's test can be re-run in CI, and its cluster's last re-run, when it has a cluster. */
export async function executionRerunInfo(db: DbClient, executionId: number) {
  const target = await executionRerunTarget(db, executionId);
  if (!target) return null;
  const availability = await ciRerunAvailability(db, target.projectId, target.runId);
  return { ...availability, lastDispatch: await clusterLastDispatch(db, target.clusterId) };
}

/**
 * Re-run one execution's test in CI: at its line and in its Playwright project,
 * on the branch of its run. The dispatch is recorded on the execution's
 * cluster, when it has one, as that cluster's last re-run, so the run it starts
 * is recognized as the cluster's (`matchCiRerunRun`).
 */
export async function rerunExecutionInCi(
  db: DbClient,
  executionId: number,
  actor: CiRerunActor,
): Promise<ClusterRerunOutcome> {
  const target = await executionRerunTarget(db, executionId);
  if (!target) return { ok: false, error: 'not-found', message: 'Test run case not found' };

  const availability = await ciRerunAvailability(db, target.projectId, target.runId);
  if (!availability.available) {
    return {
      ok: false,
      error: 'unavailable',
      message: availability.reason ?? 'CI re-run is not available for this test',
    };
  }

  let dispatched: DispatchedRerun;
  try {
    dispatched = await dispatchRerunOf(db, {
      projectId: target.projectId,
      runId: target.runId,
      cases: [target.rerunCase],
    });
  } catch (e) {
    return {
      ok: false,
      error: 'dispatch-failed',
      message: e instanceof Error ? e.message : 'CI re-run dispatch failed',
    };
  }

  const dispatch: ClusterRerunDispatch = { ...dispatched, at: Date.now(), byName: actor.name, byUserId: actor.id };
  if (target.clusterId != null) await recordClusterDispatch(db, target.clusterId, dispatch);
  return { ok: true, dispatch };
}

/**
 * Recognize a finished CI run as the re-run a cluster dispatched (see
 * `matchRerunDispatch`): stamp its origin `ci-rerun` with the dispatch id, and
 * record the run on the dispatch, whose link becomes the build the run
 * recorded (`ci.buildUrl`) when it has one. Returns the cluster whose dispatch
 * it answered, or null.
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
    .filter((d) => d.id && startedAt >= d.at - RERUN_CLOCK_SLACK_MS && startedAt - d.at <= RERUN_MATCH_WINDOW_MS);
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
  const buildUrl = safeHttpUrl(meta?.ci?.buildUrl ?? null);
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
    .set({ lastRerunDispatch: { ...dispatch, ...(buildUrl ? { url: buildUrl } : {}), runId } })
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
  provider: CiRerunProvider | null;
  /** The action a dispatch would use, when one can serve the test's newest run. */
  action: { id: string; name: string } | null;
}

/**
 * Decide whether a test's Flake Lab experiment can run in CI: CI actions on,
 * an action that accepts Flake Lab and serves the repository of the test's
 * newest run, and what that action needs. The same checks the dispatch makes.
 */
export async function flakeLabCiAvailability(
  db: DbClient,
  projectId: number,
  testCaseId: number,
): Promise<FlakeLabCiAvailability> {
  const ready = await dispatchReadiness(db, projectId, await latestTestRunId(db, testCaseId), 'flakeLab');
  return {
    available: ready.available,
    reason: ready.reason,
    provider: ready.provider,
    action: actionRef(ready.action),
  };
}

export type FlakeLabCiOutcome =
  | { ok: true; dispatch: ClusterRerunDispatch }
  | { ok: false; error: 'not-found' | 'unavailable' | 'dispatch-failed'; message: string };

/**
 * Run a test's Flake Lab experiment in CI: the Flake Lab action receives the
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
  if (!availability.available) {
    return { ok: false, error: 'unavailable', message: availability.reason ?? 'Flake Lab in CI is not available' };
  }
  try {
    const runId = await latestTestRunId(db, testCaseId);
    const action = await actionFor(db, tc.projectId, runId, 'flakeLab');
    const dispatched = await dispatchWithAction(db, {
      projectId: tc.projectId,
      runId,
      action,
      args: flakeLabCiArgs(testCaseId, kind),
      id: randomBytes(8).toString('hex'),
    });
    return { ok: true, dispatch: { ...dispatched, at: Date.now(), byName: actor.name, byUserId: actor.id } };
  } catch (e) {
    return { ok: false, error: 'dispatch-failed', message: e instanceof Error ? e.message : 'Dispatch failed' };
  }
}
