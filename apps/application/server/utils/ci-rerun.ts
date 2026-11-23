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
import { desc, eq } from 'drizzle-orm';
import { failureClusters, testCases, testRuns, testRunsCases } from '../database/schema';
import { createScmProvider, detectScmProvider, hasScmCredential } from './scm';
import { readProjectRepositoryUrl } from './scm/project-repository';
import { normalizeGitUrl } from './scm/git-url';
import { buildRetryArgs, NO_RETRY_ARGS, withRetryCases, type RetryCase } from '#shared/retry-command';
import { clusterRerunCases } from '#shared/handlers/cluster-rerun-cases';
import { ciServerValues, executionRerunTarget, rerunFiles, rerunRefAndCommit } from '#shared/handlers/ci-rerun-target';
import {
  claimCiDispatch,
  clusterLastDispatch,
  getCiDispatch,
  runDispatchAction,
  settleCiDispatch,
} from '#shared/handlers/ci-dispatches';
import { flakeLabCiArgs, type CiRerunProvider } from '#shared/ci-rerun';
import type { CiDispatchOrigin, CiDispatchView } from '#shared/ci-dispatches';
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
import {
  ciServerBaseUrl,
  ciServerBaseUrlProblem,
  ciServerCredential,
  dispatchToCiServer,
  prepareCiServerRequest,
  type CiServerCredential,
} from './ci-server-dispatch';
import { loadCredentialRecord } from '#shared/handlers/credentials';
import { credentialRefusal } from '#shared/credentials';
import { CredentialRefusedError, credentialEnvRefusal } from './credentials';
import type { RunMetadata } from './run-json-types';
import { apiError } from './api-error';
import type { DbClient } from '../database';

/** The repository URL from a cluster's most recent run, normalized, or null. */
export async function clusterRepositoryUrl(db: DbClient, lastSeenRunId: number): Promise<string | null> {
  const [run] = await db.select({ metadata: testRuns.metadata }).from(testRuns).where(eq(testRuns.id, lastSeenRunId));
  const meta = (run?.metadata as RunMetadata | null) ?? null;
  return normalizeGitUrl(meta?.scm?.remoteUrl ?? null);
}

/** The environment of a cluster's most recent run: the one its label resolved to, and the label; null when none. */
export async function clusterEnvironment(
  db: DbClient,
  lastSeenRunId: number,
): Promise<{ environmentId: number | null; environment: string | null }> {
  const [run] = await db
    .select({ environment: testRuns.environment, environmentId: testRuns.environmentId })
    .from(testRuns)
    .where(eq(testRuns.id, lastSeenRunId));
  return { environmentId: run?.environmentId ?? null, environment: run?.environment?.trim() || null };
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
 * (or http on a listed place), a request its values fill, built as the
 * dispatch builds it, and a credential that allows it. DNS is checked at
 * dispatch.
 */
async function ciServerReadiness(
  db: DbClient,
  projectId: number,
  action: CiAction & { target: { type: 'ci-server' } },
  runId: number | null,
): Promise<{ reason: string | null; hasToken: boolean; credentialRefused?: boolean }> {
  const target = ciServerTargetOf(action.target);
  if (!ciServerRequestTemplate(target, 'rerun')) {
    return { reason: 'No CI server is configured for this project.', hasToken: false };
  }
  let credential: CiServerCredential | null;
  try {
    credential = await ciServerCredential(db, target);
  } catch (e) {
    return { reason: e instanceof Error ? e.message : 'The credential cannot be read.', hasToken: false };
  }
  const baseUrl = ciServerBaseUrl(target, credential);
  const problem = ciServerBaseUrlProblem(baseUrl);
  if (problem || !baseUrl) return { reason: problem, hasToken: false };
  try {
    const request = prepareCiServerRequest({
      target,
      kind: 'rerun',
      baseUrl,
      values: await ciServerValues(db, runId, target, 'args', 'dispatch'),
      inputs: ciActionInputValues(action),
      credential,
    });
    if (request.credential?.source === 'action') {
      const record = await loadCredentialRecord(db, request.credential.id);
      const refusal = record
        ? (credentialRefusal(record, { projectId, url: request.url, custom: request.custom }) ??
          credentialEnvRefusal(record))
        : 'The credential this CI action names does not exist: pick another one.';
      // A dispatch still goes to `withCredential`, which refuses it again and logs the refusal.
      if (refusal) return { reason: refusal, hasToken: false, credentialRefused: Boolean(record) };
    }
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
  /** Unavailable only because the action's credential refuses the request, which a dispatch then logs. */
  credentialRefused?: boolean;
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
  const startedBy = (await runDispatchAction(db, runId))?.actionId ?? null;
  const pick = pickCiAction(settings, kind, { provider: detected, ...environment, actionId, startedBy });
  const action = pick.action;
  const provider = action ? action.target.type : detected;
  const scmCredentialId = action && action.target.type !== 'ci-server' ? (action.target.credentialId ?? null) : null;
  const hasScmToken = await hasScmCredential(
    db,
    projectId,
    await readProjectRepositoryUrl(db, projectId),
    scmCredentialId,
  );
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
      ...(ready.credentialRefused ? { credentialRefused: true } : {}),
    };
  }
  if (!hasScmToken) {
    const reason =
      kind === 'flakeLab'
        ? 'No SCM credential is set to dispatch the experiment: pick one in the project’s Source control settings.'
        : 'No SCM credential is set to dispatch the re-run: pick one in the project’s Source control settings.';
    return { available: false, reason, provider, enabled: true, hasToken: false, action };
  }
  return { available: true, reason: null, provider, enabled: true, hasToken: true, action };
}

/**
 * Decide whether a cluster can be re-run in CI, with a reason when it cannot —
 * the same checks the dispatch route enforces, so the button never offers an
 * action the POST would reject. `actionId` names the action to use (an id or
 * an exact name); without it the project's default for re-runs applies. With
 * `cases`, read only when the re-run is otherwise available, it is also
 * unavailable when none of them can be named (`withRetryCases`).
 */
export async function ciRerunAvailability(
  db: DbClient,
  projectId: number,
  lastSeenRunId: number,
  actionId?: string | null,
  cases?: () => Promise<RetryCase[]>,
): Promise<CiRerunAvailability> {
  return (await rerunReadiness(db, projectId, lastSeenRunId, actionId, cases)).availability;
}

/**
 * `ciRerunAvailability`, and whether a re-run is unavailable only because the
 * action's credential refuses it: a dispatch then goes on to `withCredential`,
 * which logs the refusal before it answers.
 */
async function rerunReadiness(
  db: DbClient,
  projectId: number,
  lastSeenRunId: number,
  actionId?: string | null,
  cases?: () => Promise<RetryCase[]>,
): Promise<{ availability: CiRerunAvailability; credentialRefused: boolean }> {
  const ready = await dispatchReadiness(db, projectId, lastSeenRunId, 'tests', actionId);
  const availability: CiRerunAvailability = {
    available: ready.available,
    reason: ready.reason,
    provider: ready.provider,
    enabled: ready.enabled,
    hasToken: ready.hasToken,
    action: actionRef(ready.action),
  };
  return {
    availability: cases && availability.available ? withRetryCases(availability, await cases()) : availability,
    credentialRefused: ready.credentialRefused === true,
  };
}

/** The branch a re-run runs on: the branch of the run it re-runs, when that run has one. */
async function rerunRef(db: DbClient, runId: number): Promise<string | null> {
  return (await rerunRefAndCommit(db, runId)).ref;
}

/** A second dispatch of the same action, arguments, branch and inputs within the guard: the earlier one. */
class DuplicateDispatchError extends Error {
  constructor(readonly existing: CiDispatchView) {
    super('The same dispatch was sent a moment ago.');
  }
}

/** Where a dispatch's tests come from, and what started it, as its record names them. */
interface DispatchSource {
  kind: CiActionKind;
  origin: CiDispatchOrigin;
  clusterId?: number | null;
  testCaseId?: number | null;
}

/**
 * Send a dispatch of these arguments through an action, on the repository and
 * branch of the run they come from (the target's configured ref when that run
 * has none). The action's inputs go beside the arguments, never into them: the
 * values `chosen` names for its choices, else their defaults. The dispatch is
 * stored before it is sent ({@link claimCiDispatch}, which refuses the same one
 * twice), then settled with the provider's answer, or as refused with its
 * error, which is thrown again.
 */
async function dispatchWithAction(
  db: DbClient,
  input: DispatchSource & {
    projectId: number;
    runId: number | null;
    action: CiAction;
    chosen?: Record<string, string> | null;
    args: string;
    /** The spec files and the number of tests the arguments name, recorded for matching the run it starts. */
    cases?: RetryCase[];
    actor: CiRerunActor;
  },
): Promise<CiDispatchView> {
  const { action, args } = input;
  const id = randomBytes(8).toString('hex');
  const reserved = reservedInputName(action);
  if (reserved)
    throw new Error(reservedInputMessage(reserved, action.target.type === 'bitbucket' ? 'bitbucket' : 'gitlab'));
  const inputs = ciActionInputValues(action, input.chosen);
  const target = action.target;
  // The virtual administrator of an instance without sign-in is id 0, no user row.
  const credentialActor = { userId: input.actor.id || null, apiKeyId: input.actor.apiKeyId ?? null };

  let send: () => Promise<{ url: string; ref: string | null; providerRunId: string | null }>;
  let ref: string | null;
  if (target.type === 'ci-server') {
    const server = ciServerTargetOf(target);
    const values = await ciServerValues(db, input.runId, server, args, id);
    ref = values.ref || null;
    send = async () => {
      const sent = await dispatchToCiServer(db, input.projectId, server, 'rerun', values, inputs, {
        actor: credentialActor,
        actionId: action.id,
      });
      return { url: sent.url, ref, providerRunId: sent.buildNumber ?? null };
    };
  } else {
    const repositoryUrl = input.runId ? await clusterRepositoryUrl(db, input.runId) : null;
    if (!repositoryUrl || detectScmProvider(repositoryUrl) !== target.type) {
      throw new Error('No supported repository to dispatch to');
    }
    const runRef = input.runId ? await rerunRef(db, input.runId) : null;
    // The branch it goes to: the run's, else the target's own; Bitbucket's default branch is known only once sent.
    ref = runRef ?? (target.type === 'bitbucket' ? null : target.ref);
    send = async () => {
      // The credential opens only for a dispatch that goes out, never for a refused repeat.
      const scm = await createScmProvider(repositoryUrl, db, input.projectId, {
        actor: credentialActor,
        credentialId: target.credentialId ?? null,
        strict: true,
      });
      if (!scm?.provider) throw new Error('Could not build an SCM client for this repository');
      const sent = await scm.dispatchRerun(target, args, { ref: runRef, dispatchId: id, inputs, actionId: action.id });
      return {
        url: sent.url,
        ref: sent.ref ?? ref,
        providerRunId: sent.runId ?? sent.pipelineId ?? sent.buildNumber ?? null,
      };
    };
  }

  const claim = await claimCiDispatch(db, {
    id,
    projectId: input.projectId,
    actionId: action.id,
    actionName: action.name,
    origin: input.origin,
    kind: input.kind,
    sourceRunId: input.runId,
    clusterId: input.clusterId ?? null,
    testCaseId: input.testCaseId ?? null,
    provider: target.type,
    preset: target.type === 'ci-server' ? target.preset : null,
    ref,
    inputs,
    args,
    files: input.cases ? rerunFiles(input.cases) : null,
    tests: input.cases ? input.cases.length : null,
    byUserId: input.actor.id || null,
    byName: input.actor.name,
  });
  if (!claim.claimed) throw new DuplicateDispatchError(claim.existing);
  try {
    await settleCiDispatch(db, id, await send());
  } catch (e) {
    await settleCiDispatch(db, id, { refused: e instanceof Error ? e.message : 'Dispatch failed' });
    throw e;
  }
  return (await getCiDispatch(db, id))!;
}

/**
 * The action a dispatch of `kind` for a run uses, or the error a dispatch
 * throws, and the inputs to send it with: those the run's own dispatch sent,
 * when the run was started by this action.
 */
async function actionFor(
  db: DbClient,
  projectId: number,
  runId: number | null,
  kind: CiActionKind,
  actionId?: string | null,
): Promise<{ action: CiAction; chosen: Record<string, string> | null }> {
  const settings: CiActionsSettings = await getCiActionsSettings(db, projectId);
  const provider = detectScmProvider(runId ? await clusterRepositoryUrl(db, runId) : null);
  const environment = runId ? await clusterEnvironment(db, runId) : null;
  const started = await runDispatchAction(db, runId);
  const pick = pickCiAction(settings, kind, { provider, ...environment, actionId, startedBy: started?.actionId });
  if (!pick.action) throw new Error(pick.reason);
  return { action: pick.action, chosen: started?.actionId === pick.action.id ? started.inputs : null };
}

/**
 * Dispatch a CI re-run of a cluster's affected tests on the branch of its
 * latest run (the action's configured ref when that run has none). Assumes
 * availability was already checked (the route does). Returns the dispatch as
 * stored. Throws with the provider's message on a dispatch failure.
 */
export async function dispatchClusterRerun(
  db: DbClient,
  cluster: { id: number; projectId: number; lastSeenRunId: number },
  actor: CiRerunActor,
  actionId?: string | null,
  origin: CiDispatchOrigin = 'page',
): Promise<CiDispatchView> {
  return dispatchRerunOf(db, {
    projectId: cluster.projectId,
    runId: cluster.lastSeenRunId,
    cases: await clusterRerunCases(db, cluster.id),
    actionId,
    actor,
    kind: 'tests',
    origin,
    clusterId: cluster.id,
  });
}

/** No case has a file path a re-run's arguments can name: the re-run is unavailable, not a failed dispatch. */
class NoRetryArgsError extends Error {
  constructor() {
    super(NO_RETRY_ARGS);
  }
}

/** Dispatch a CI re-run of these cases, through the action the project's settings pick for the run. */
async function dispatchRerunOf(
  db: DbClient,
  input: DispatchSource & {
    projectId: number;
    runId: number;
    cases: RetryCase[];
    actionId?: string | null;
    actor: CiRerunActor;
  },
): Promise<CiDispatchView> {
  const { action, chosen } = await actionFor(db, input.projectId, input.runId, 'tests', input.actionId);
  const args = buildRetryArgs(input.cases);
  // Empty arguments would re-run the whole suite.
  if (!args) throw new NoRetryArgsError();
  return dispatchWithAction(db, { ...input, action, chosen, args });
}

/** Who asked for a re-run, as the dispatch record names them, and the API key it came through, for the credential log. */
export interface CiRerunActor {
  id: number | null;
  name: string | null;
  apiKeyId?: number | null;
}

/** What a dispatch from a page or a tool came to: the dispatch, or why there is none (the earlier one for a repeat). */
export type CiDispatchOutcome =
  | { ok: true; dispatch: CiDispatchView }
  | { ok: false; error: 'not-found' | 'unavailable' | 'dispatch-failed'; message: string }
  | { ok: false; error: 'duplicate'; message: string; dispatch: CiDispatchView };

const STATUS_BY_ERROR = { 'not-found': 404, unavailable: 400, 'dispatch-failed': 502, duplicate: 409 } as const;

/** The API error of a dispatch that did not go: a repeat answers 409 with the earlier dispatch as `data.dispatch`. */
export function ciDispatchError(outcome: Extract<CiDispatchOutcome, { ok: false }>) {
  return apiError({
    statusCode: STATUS_BY_ERROR[outcome.error],
    message: outcome.message,
    ...(outcome.error === 'duplicate' ? { data: { dispatch: outcome.dispatch } } : {}),
  });
}

/** The outcome of a dispatch that threw. */
function failedDispatch(e: unknown, fallback: string): CiDispatchOutcome {
  if (e instanceof DuplicateDispatchError) {
    return { ok: false, error: 'duplicate', message: e.message, dispatch: e.existing };
  }
  return {
    ok: false,
    error: e instanceof NoRetryArgsError || e instanceof CredentialRefusedError ? 'unavailable' : 'dispatch-failed',
    message: e instanceof Error ? e.message : fallback,
  };
}

/**
 * Re-run a cluster's affected tests in CI: check availability, then dispatch,
 * which stores the dispatch with the cluster. The REST route and the MCP tool
 * both call it, after their own access checks.
 */
export async function rerunClusterInCi(
  db: DbClient,
  clusterId: number,
  actor: CiRerunActor,
  options: { actionId?: string | null; origin?: CiDispatchOrigin } = {},
): Promise<CiDispatchOutcome> {
  const [cluster] = await db
    .select({
      id: failureClusters.id,
      projectId: failureClusters.projectId,
      lastSeenRunId: failureClusters.lastSeenRunId,
    })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  if (!cluster) return { ok: false, error: 'not-found', message: 'Failure cluster not found' };

  const { availability, credentialRefused } = await rerunReadiness(
    db,
    cluster.projectId,
    cluster.lastSeenRunId,
    options.actionId,
    () => clusterRerunCases(db, cluster.id),
  );
  if (!availability.available && !credentialRefused) {
    return {
      ok: false,
      error: 'unavailable',
      message: availability.reason ?? 'CI re-run is not available for this cluster',
    };
  }

  try {
    return {
      ok: true,
      dispatch: await dispatchClusterRerun(db, cluster, actor, options.actionId, options.origin ?? 'page'),
    };
  } catch (e) {
    return failedDispatch(e, 'CI re-run dispatch failed');
  }
}

/** Whether an execution's test can be re-run in CI, and its cluster's last re-run, when it has a cluster. */
export async function executionRerunInfo(db: DbClient, executionId: number) {
  const target = await executionRerunTarget(db, executionId);
  if (!target) return null;
  const availability = await ciRerunAvailability(db, target.projectId, target.runId, null, async () => [
    target.rerunCase,
  ]);
  return { ...availability, lastDispatch: await clusterLastDispatch(db, target.clusterId) };
}

/**
 * Re-run one execution's test in CI: at its line and in its Playwright project,
 * on the branch of its run. The dispatch names the execution's cluster, when
 * it has one, so it shows as that cluster's last re-run.
 */
export async function rerunExecutionInCi(
  db: DbClient,
  executionId: number,
  actor: CiRerunActor,
  options: { origin?: CiDispatchOrigin } = {},
): Promise<CiDispatchOutcome> {
  const target = await executionRerunTarget(db, executionId);
  if (!target) return { ok: false, error: 'not-found', message: 'Test run case not found' };

  const { availability, credentialRefused } = await rerunReadiness(
    db,
    target.projectId,
    target.runId,
    null,
    async () => [target.rerunCase],
  );
  if (!availability.available && !credentialRefused) {
    return {
      ok: false,
      error: 'unavailable',
      message: availability.reason ?? 'CI re-run is not available for this test',
    };
  }

  try {
    const dispatch = await dispatchRerunOf(db, {
      projectId: target.projectId,
      runId: target.runId,
      cases: [target.rerunCase],
      actor,
      kind: 'tests',
      origin: options.origin ?? 'page',
      clusterId: target.clusterId,
    });
    return { ok: true, dispatch };
  } catch (e) {
    return failedDispatch(e, 'CI re-run dispatch failed');
  }
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

/**
 * Run a test's Flake Lab experiment in CI: the Flake Lab action receives the
 * `piwi flake` arguments, through the same dispatch as a cluster's re-run, on
 * the branch of the test's newest run. The dispatch is stored with the test,
 * and the experiment the command records is matched to it by that test.
 */
export async function runFlakeLabInCi(
  db: DbClient,
  testCaseId: number,
  kind: 'reproduce' | 'verify',
  actor: CiRerunActor,
  options: { origin?: CiDispatchOrigin } = {},
): Promise<CiDispatchOutcome> {
  const [tc] = await db.select({ projectId: testCases.projectId }).from(testCases).where(eq(testCases.id, testCaseId));
  if (!tc) return { ok: false, error: 'not-found', message: 'Test case not found' };
  const ready = await dispatchReadiness(db, tc.projectId, await latestTestRunId(db, testCaseId), 'flakeLab');
  if (!ready.available && !ready.credentialRefused) {
    return { ok: false, error: 'unavailable', message: ready.reason ?? 'Flake Lab in CI is not available' };
  }
  try {
    const runId = await latestTestRunId(db, testCaseId);
    const { action, chosen } = await actionFor(db, tc.projectId, runId, 'flakeLab');
    const dispatch = await dispatchWithAction(db, {
      projectId: tc.projectId,
      runId,
      action,
      chosen,
      args: flakeLabCiArgs(testCaseId, kind),
      actor,
      kind: 'flakeLab',
      origin: options.origin ?? 'page',
      testCaseId,
    });
    return { ok: true, dispatch };
  } catch (e) {
    return failedDispatch(e, 'Dispatch failed');
  }
}
