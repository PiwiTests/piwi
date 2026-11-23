/**
 * CI actions in the browser demo. A project whose re-run action targets a CI
 * server re-runs as the server does, up to the request: the demo has no CI to
 * reach, so the dispatch is recorded with the link the preset names (the job's
 * page) and nothing is sent. An action that targets a repository host's CI
 * (GitHub, GitLab, Bitbucket) answers that the demo cannot dispatch it.
 */
import { eq } from 'drizzle-orm';
import { failureClusters, projects, testRuns, users } from '~~/server/database/schema.sqlite';
import {
  ciActionInputValues,
  ciActionsProblem,
  ciServerTargetOf,
  pickCiAction,
  resolveCiActionsSettings,
  type CiAction,
  type CiActionCheckResult,
  type CiActionsSettings,
} from '#shared/ci-actions';
import {
  CI_SERVER_HTTPS_PROBLEM,
  ciServerCheckFinding,
  ciServerCheckPlans,
  ciServerRequestTemplate,
  DEFAULT_ARGS_PARAMETER,
  DEFAULT_DISPATCH_PARAMETER,
  readCiServerAnswer,
  renderCiRequest,
  type CiServerTarget,
  type CiTemplateValues,
} from '#shared/ci-server';
import { buildRetryArgs, NO_RETRY_ARGS, withRetryCases, type RetryCase } from '#shared/retry-command';
import { clusterRerunCases } from '#shared/handlers/cluster-rerun-cases';
import { ciServerValues, executionRerunTarget, rerunFiles } from '#shared/handlers/ci-rerun-target';
import {
  claimCiDispatch,
  clusterLastDispatch,
  getCiDispatch,
  runDispatchAction,
  settleCiDispatch,
} from '#shared/handlers/ci-dispatches';
import { ciActionsCredentialProblem, loadCredentialRecord, type CredentialRecord } from '#shared/handlers/credentials';
import { credentialRefusal } from '#shared/credentials';
import type { getDemoDb } from '../db.client';
import { demoHttpError } from './http-error';

type DemoDB = Awaited<ReturnType<typeof getDemoDb>>;

const UNAVAILABLE = 'CI re-run is not available in the demo.';
const OFF_REASON = 'CI re-run is off for this project.';
const NO_TARGET = 'No CI server is configured for this project.';

interface DemoRerunAvailability {
  available: boolean;
  reason: string | null;
  provider: 'ci-server' | null;
  enabled: boolean;
  hasToken: boolean;
  action: { id: string; name: string } | null;
}

async function projectCiActions(db: DemoDB, projectId: number) {
  const [row] = await db.select({ ciRerun: projects.ciRerun }).from(projects).where(eq(projects.id, projectId));
  return { settings: resolveCiActionsSettings(row?.ciRerun ?? null) };
}

/**
 * The credential a target names and the base URL it dispatches under (its
 * own, else the credential's destination), as the server reads them; the demo
 * has no instance CI server.
 */
async function targetCredential(
  db: DemoDB,
  target: CiServerTarget,
): Promise<{ credential: CredentialRecord | null; baseUrl: string | null }> {
  const credential = target.credentialId ? await loadCredentialRecord(db as never, target.credentialId) : null;
  return { credential, baseUrl: target.baseUrl ?? credential?.destination ?? null };
}

/** The action a re-run uses: the demo reaches only CI servers, so a repository host's action is not served. */
function pickRerunAction(settings: CiActionsSettings, run: RunEnvironment, actionId?: string | null) {
  return pickCiAction(settings, 'tests', { provider: null, ...run, actionId });
}

interface RunEnvironment {
  environmentId: number | null;
  environment: string | null;
  /** The action whose dispatch started the run, as the server reads it. */
  startedBy: string | null;
}

/** The environment of a run, as the server reads it (the one its label resolved to, and the label), and its dispatch's action. */
async function runEnvironment(db: DemoDB, runId: number): Promise<RunEnvironment> {
  const [run] = await db
    .select({ environment: testRuns.environment, environmentId: testRuns.environmentId })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  return {
    environmentId: run?.environmentId ?? null,
    environment: run?.environment?.trim() || null,
    startedBy: (await runDispatchAction(db, runId))?.actionId ?? null,
  };
}

/**
 * The request URL and the link a dispatch records, or why the request cannot
 * be built: the server's checks, with no instance CI server and no listed hosts.
 */
function prepare(
  target: CiServerTarget,
  baseUrl: string | null,
  values: CiTemplateValues,
  inputs: [string, string][],
): { link: string; url: string; sendsCredential: boolean } | { error: string } {
  const spec = target ? ciServerRequestTemplate(target, 'rerun') : null;
  if (!spec || !baseUrl) return { error: NO_TARGET };
  if (!baseUrl.startsWith('https:')) {
    return { error: CI_SERVER_HTTPS_PROBLEM };
  }
  try {
    const { url } = renderCiRequest(baseUrl, spec.template, values, inputs);
    const { link } = readCiServerAnswer(baseUrl, spec.template, values, { header: () => null, json: null });
    return { link, url, sendsCredential: spec.auth !== 'none' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'The CI server request cannot be built.' };
  }
}

async function availability(
  db: DemoDB,
  projectId: number,
  runId: number,
  actionId?: string | null,
): Promise<DemoRerunAvailability> {
  const { settings } = await projectCiActions(db, projectId);
  const pick = pickRerunAction(settings, await runEnvironment(db, runId), actionId);
  const action = pick.action;
  const ref = action ? { id: action.id, name: action.name } : null;
  if (!settings.enabled) {
    return { available: false, reason: OFF_REASON, provider: null, enabled: false, hasToken: false, action: ref };
  }
  if (!action || action.target.type !== 'ci-server') {
    // Only a repository host's action is left: the demo has no repository to dispatch to.
    const reason = pick.reason ?? UNAVAILABLE;
    const hasHostAction = settings.actions.some((a) => a.accepts.includes('tests') && a.target.type !== 'ci-server');
    return {
      available: false,
      reason: !action && hasHostAction ? UNAVAILABLE : reason,
      provider: null,
      enabled: true,
      hasToken: false,
      action: ref,
    };
  }
  const target = ciServerTargetOf(action.target);
  const { credential, baseUrl } = await targetCredential(db, target);
  const prepared = prepare(
    target,
    baseUrl,
    await ciServerValues(db, runId, target, 'args', 'dispatch'),
    Object.entries(ciActionInputValues(action)),
  );
  // As the server: a request whose auth is `none` carries no credential, and one its credential refuses is unavailable.
  let reason = 'error' in prepared ? prepared.error : null;
  if (!reason && target.credentialId && 'url' in prepared && prepared.sendsCredential) {
    reason = credential
      ? credentialRefusal(credential, { projectId, url: prepared.url, custom: target.preset === 'custom' })
      : 'The credential this CI action names does not exist: pick another one.';
  }
  const hasToken = !reason && !!credential && 'url' in prepared && prepared.sendsCredential;
  return { available: !reason, reason, provider: 'ci-server', enabled: true, hasToken, action: ref };
}

async function clusterTarget(db: DemoDB, clusterId: number) {
  const [row] = await db
    .select({ projectId: failureClusters.projectId, runId: failureClusters.lastSeenRunId })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  return row ?? null;
}

/** `GET /api/failure-clusters/:id/rerun` in the demo. */
export async function demoClusterRerunInfo(db: DemoDB, clusterId: number, actionId?: string | null) {
  const target = await clusterTarget(db, clusterId);
  if (!target) throw demoHttpError(404, 'Failure cluster not found');
  return {
    ...withRetryCases(
      await availability(db, target.projectId, target.runId, actionId),
      await clusterRerunCases(db, clusterId),
    ),
    lastDispatch: await clusterLastDispatch(db, clusterId),
  };
}

/** `GET /api/test-run-cases/:id/rerun` in the demo. */
export async function demoExecutionRerunInfo(db: DemoDB, executionId: number) {
  const target = await executionRerunTarget(db, executionId);
  if (!target) throw demoHttpError(404, 'Test run case not found');
  return {
    ...withRetryCases(await availability(db, target.projectId, target.runId), [target.rerunCase]),
    lastDispatch: await clusterLastDispatch(db, target.clusterId),
  };
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function actorName(db: DemoDB, userId: number | null): Promise<string | null> {
  if (userId == null) return null;
  const [row] = await db.select({ name: users.name, username: users.username }).from(users).where(eq(users.id, userId));
  return row ? row.name || row.username || null : null;
}

/** Record a re-run as the server dispatches it, without sending anything. */
async function dispatch(
  db: DemoDB,
  input: { projectId: number; runId: number; clusterId: number | null; cases: RetryCase[]; actionId?: string | null },
  userId: number | null,
) {
  const ready = withRetryCases(await availability(db, input.projectId, input.runId, input.actionId), input.cases);
  if (!ready.available) throw demoHttpError(400, ready.reason ?? UNAVAILABLE);
  const { settings } = await projectCiActions(db, input.projectId);
  const run = await runEnvironment(db, input.runId);
  const action = pickRerunAction(settings, run, input.actionId).action as
    | (CiAction & { target: { type: 'ci-server' } })
    | null;
  if (!action) throw demoHttpError(400, NO_TARGET);
  const target = ciServerTargetOf(action.target);
  const args = buildRetryArgs(input.cases);
  if (!args) throw demoHttpError(400, NO_RETRY_ARGS);
  const id = randomId();
  const values = await ciServerValues(db, input.runId, target, args, id);
  const { baseUrl } = await targetCredential(db, target);
  const started = run.startedBy === action.id ? await runDispatchAction(db, input.runId) : null;
  const inputs = ciActionInputValues(action, started?.inputs);
  const prepared = prepare(target, baseUrl, values, Object.entries(inputs));
  if ('error' in prepared) throw demoHttpError(400, prepared.error);
  const claim = await claimCiDispatch(db, {
    id,
    projectId: input.projectId,
    actionId: action.id,
    actionName: action.name,
    origin: 'page',
    kind: 'tests',
    sourceRunId: input.runId,
    clusterId: input.clusterId,
    testCaseId: null,
    provider: 'ci-server',
    preset: target.preset,
    ref: values.ref || null,
    inputs,
    args,
    files: rerunFiles(input.cases),
    tests: input.cases.length,
    byUserId: userId,
    byName: await actorName(db, userId),
  });
  if (!claim.claimed) {
    throw demoHttpError(409, 'The same dispatch was sent a moment ago.', undefined, { dispatch: claim.existing });
  }
  await settleCiDispatch(db, id, { url: prepared.link, ref: values.ref || null, providerRunId: null });
  return { ok: true, demo: true, dispatch: await getCiDispatch(db, id) };
}

/** `POST /api/failure-clusters/:id/rerun` in the demo. */
export async function demoRerunCluster(db: DemoDB, clusterId: number, userId: number | null, actionId?: string | null) {
  const target = await clusterTarget(db, clusterId);
  if (!target) throw demoHttpError(404, 'Failure cluster not found');
  return dispatch(db, { ...target, clusterId, cases: await clusterRerunCases(db, clusterId), actionId }, userId);
}

/** `POST /api/test-run-cases/:id/rerun` in the demo. */
export async function demoRerunExecution(db: DemoDB, executionId: number, userId: number | null) {
  const target = await executionRerunTarget(db, executionId);
  if (!target) throw demoHttpError(404, 'Test run case not found');
  const { projectId, runId, clusterId, rerunCase } = target;
  return dispatch(db, { projectId, runId, clusterId, cases: [rerunCase] }, userId);
}

/** Refuse, as the server does, a save whose CI actions cannot dispatch. */
export function assertDemoCiActions(body: { ciRerun?: unknown } | null): void {
  const problem = ciActionsProblem(body?.ciRerun);
  if (problem) throw demoHttpError(400, problem);
}

/** The answer the demo's Jenkins jobs give Check: each declares the reporter's default parameters. */
const DEMO_JOB_JSON = {
  property: [{ parameterDefinitions: [{ name: DEFAULT_ARGS_PARAMETER }, { name: DEFAULT_DISPATCH_PARAMETER }] }],
};

const CANNOT_CHECK = {
  gitlab:
    "GitLab pipelines can't be checked: GitLab reports no variable declarations without starting a pipeline. Dispatch it once to confirm.",
  bitbucket:
    "Bitbucket pipelines can't be checked: Bitbucket reports no variable declarations without starting a pipeline. Dispatch it once to confirm.",
  github: 'The demo has no repository to read the workflow from.',
  custom: "A Custom request can't be checked: it names no job Piwi can read.",
};

/**
 * `POST /api/projects/:id/ci-actions/:actionId/check` in the demo: an action
 * the request carries (else the saved one) is checked as the server checks it,
 * up to the request. A Jenkins job answers as one that declares the default
 * parameters, so a renamed parameter or an input shows as missing. Nothing is
 * sent.
 */
export async function demoCiActionCheck(
  db: DemoDB,
  projectId: number,
  actionId: string,
  body: { action?: unknown } | null,
): Promise<CiActionCheckResult> {
  let action: CiAction | undefined;
  if (body?.action !== undefined) {
    const problem = ciActionsProblem({ actions: [body.action] });
    if (problem) throw demoHttpError(400, problem);
    action = resolveCiActionsSettings({ enabled: true, actions: [body.action], defaults: {} }).actions[0];
    const credentialProblem = action
      ? await ciActionsCredentialProblem(
          db as never,
          projectId,
          { actions: [action] },
          [],
          new Set(),
          (await db.select({ url: projects.repositoryUrl }).from(projects).where(eq(projects.id, projectId)))[0]?.url ??
            null,
        )
      : null;
    if (credentialProblem) throw demoHttpError(400, credentialProblem);
  } else {
    const { settings } = await projectCiActions(db, projectId);
    action = settings.actions.find((a) => a.id === actionId);
  }
  if (!action) throw demoHttpError(404, 'CI action not found');
  const target = action.target;
  if (target.type !== 'ci-server') return { ok: null, missing: [], message: CANNOT_CHECK[target.type] };
  if (target.preset === 'custom') return { ok: null, missing: [], message: CANNOT_CHECK.custom };
  const server = ciServerTargetOf(target);
  const { credential, baseUrl } = await targetCredential(db, server);
  if (!baseUrl) return { ok: false, missing: [], message: NO_TARGET };
  if (!baseUrl.startsWith('https:')) return { ok: false, missing: [], message: CI_SERVER_HTTPS_PROBLEM };
  const inputNames = action.inputs.map((i) => i.name);
  const [plan] = ciServerCheckPlans(server, baseUrl, inputNames);
  if (!plan) return { ok: null, missing: [], message: 'Nothing was checked.' };
  if ('error' in plan) return { ok: false, missing: [], message: plan.error };
  // As the server: the credential's rules refuse the read, and it sends only the inputs it allows.
  if (server.credentialId) {
    const refusal = credential
      ? credentialRefusal(credential, { projectId, url: plan.url, custom: false })
      : 'The credential this CI action names does not exist: pick another one.';
    if (refusal) return { ok: false, missing: [], message: refusal };
  }
  const allowed = credential?.allowedInputs ?? null;
  const notSent = allowed ? inputNames.filter((name) => !allowed.includes(name)) : [];
  const finding = ciServerCheckFinding(
    notSent.length > 0 ? { ...plan, required: plan.required.filter((name) => !notSent.includes(name)) } : plan,
    DEMO_JOB_JSON,
  );
  if (notSent.length === 0) return { ok: finding.ok, missing: finding.missing, message: finding.message };
  return {
    ok: false,
    missing: finding.missing,
    message: `${finding.message} Not sent: ${notSent.join(', ')}, because the credential "${credential!.name}" does not allow these inputs.`,
  };
}
