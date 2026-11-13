/**
 * CI actions in the browser demo. A project whose re-run action targets a CI
 * server re-runs as the server does, up to the request: the demo has no CI to
 * reach, so the dispatch is recorded with the link the preset names (the job's
 * page) and nothing is sent. An action that targets a repository host's CI
 * (GitHub, GitLab, Bitbucket) answers that the demo cannot dispatch it.
 */
import { eq } from 'drizzle-orm';
import { failureClusters, projects, testRuns, users } from '~~/server/database/schema.sqlite';
import type { ClusterRerunDispatch } from '#shared/ci-rerun';
import {
  ciActionInputValues,
  ciActionsProblem,
  ciServerTargetOf,
  ciServerTokenBinding,
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
  isUnderBaseUrl,
  normalizeCiServerBaseUrl,
  readCiServerAnswer,
  renderCiRequest,
  type CiServerTarget,
  type CiTemplateValues,
} from '#shared/ci-server';
import { buildRetryArgs, type RetryCase } from '#shared/retry-command';
import { clusterRerunCases } from '#shared/handlers/cluster-rerun-cases';
import {
  ciServerValues,
  clusterLastDispatch,
  executionRerunTarget,
  recordClusterDispatch,
  rerunFiles,
} from '#shared/handlers/ci-rerun-target';
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
  const [row] = await db
    .select({ ciRerun: projects.ciRerun, ciServerToken: projects.ciServerToken })
    .from(projects)
    .where(eq(projects.id, projectId));
  return {
    settings: resolveCiActionsSettings(row?.ciRerun ?? null),
    tokenUrl: demoCiServerTokenUrl(row?.ciServerToken),
  };
}

/** The action a re-run uses: the demo reaches only CI servers, so a repository host's action is not served. */
function pickRerunAction(settings: CiActionsSettings, environment: string | null, actionId?: string | null) {
  return pickCiAction(settings, 'tests', { provider: null, environment, actionId });
}

/** The environment of a run, as the server reads it. */
async function runEnvironment(db: DemoDB, runId: number): Promise<string | null> {
  const [run] = await db.select({ environment: testRuns.environment }).from(testRuns).where(eq(testRuns.id, runId));
  return run?.environment?.trim() || null;
}

/**
 * The request URL and the link a dispatch records, or why the request cannot
 * be built: the server's checks, with no instance CI server and no listed hosts.
 */
function prepare(
  target: CiServerTarget,
  values: CiTemplateValues,
  inputs: [string, string][],
): { link: string; url: string; sendsCredential: boolean } | { error: string } {
  const spec = target ? ciServerRequestTemplate(target, 'rerun') : null;
  if (!spec || !target.baseUrl) return { error: NO_TARGET };
  if (!target.baseUrl.startsWith('https:')) {
    return { error: CI_SERVER_HTTPS_PROBLEM };
  }
  try {
    const { url } = renderCiRequest(target.baseUrl, spec.template, values, inputs);
    const { link } = readCiServerAnswer(target.baseUrl, spec.template, values, { header: () => null, json: null });
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
  const { settings, tokenUrl } = await projectCiActions(db, projectId);
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
  const prepared = prepare(
    target,
    await ciServerValues(db, runId, target, 'args', 'dispatch'),
    Object.entries(ciActionInputValues(action)),
  );
  // As the server: a request whose auth is `none` carries no credential, token or not.
  const hasToken =
    'url' in prepared && prepared.sendsCredential && !!tokenUrl && isUnderBaseUrl(tokenUrl, prepared.url);
  const reason = 'error' in prepared ? prepared.error : null;
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
    ...(await availability(db, target.projectId, target.runId, actionId)),
    lastDispatch: await clusterLastDispatch(db, clusterId),
  };
}

/** `GET /api/test-run-cases/:id/rerun` in the demo. */
export async function demoExecutionRerunInfo(db: DemoDB, executionId: number) {
  const target = await executionRerunTarget(db, executionId);
  if (!target) throw demoHttpError(404, 'Test run case not found');
  return {
    ...(await availability(db, target.projectId, target.runId)),
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
  const ready = await availability(db, input.projectId, input.runId, input.actionId);
  if (!ready.available) throw demoHttpError(400, ready.reason ?? UNAVAILABLE);
  const { settings } = await projectCiActions(db, input.projectId);
  const action = pickRerunAction(settings, await runEnvironment(db, input.runId), input.actionId).action as
    | (CiAction & { target: { type: 'ci-server' } })
    | null;
  if (!action) throw demoHttpError(400, NO_TARGET);
  const target = ciServerTargetOf(action.target);
  const args = buildRetryArgs(input.cases);
  const id = randomId();
  const values = await ciServerValues(db, input.runId, target, args, id);
  const prepared = prepare(target, values, Object.entries(ciActionInputValues(action)));
  if ('error' in prepared) throw demoHttpError(400, prepared.error);
  const record: ClusterRerunDispatch = {
    id,
    actionId: action.id,
    provider: 'ci-server',
    preset: target.preset,
    url: prepared.link,
    args,
    ref: values.ref || null,
    files: rerunFiles(input.cases),
    tests: input.cases.length,
    at: Date.now(),
    byName: await actorName(db, userId),
    byUserId: userId,
  };
  if (input.clusterId != null) await recordClusterDispatch(db, input.clusterId, record);
  return { ok: true, demo: true, dispatch: record };
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
  } else {
    const { settings } = await projectCiActions(db, projectId);
    action = settings.actions.find((a) => a.id === actionId);
  }
  if (!action) throw demoHttpError(404, 'CI action not found');
  const target = action.target;
  if (target.type !== 'ci-server') return { ok: null, missing: [], message: CANNOT_CHECK[target.type] };
  if (target.preset === 'custom') return { ok: null, missing: [], message: CANNOT_CHECK.custom };
  const server = ciServerTargetOf(target);
  if (!server.baseUrl) return { ok: false, missing: [], message: NO_TARGET };
  if (!server.baseUrl.startsWith('https:')) return { ok: false, missing: [], message: CI_SERVER_HTTPS_PROBLEM };
  const [plan] = ciServerCheckPlans(
    server,
    server.baseUrl,
    action.inputs.map((i) => i.name),
  );
  if (!plan) return { ok: null, missing: [], message: 'Nothing was checked.' };
  if ('error' in plan) return { ok: false, missing: [], message: plan.error };
  const finding = ciServerCheckFinding(plan, DEMO_JOB_JSON);
  return { ok: finding.ok, missing: finding.missing, message: finding.message };
}

/**
 * What the demo stores for a CI server token a save sends: never the token,
 * only the base URL a server would bind it to (the one every CI server action
 * sends under, in the request else the stored settings; the demo has no
 * instance CI server). `undefined` keeps the stored value, `null` removes it.
 * Throws the server's 400 answers when no base URL is set or the actions use
 * more than one.
 */
export async function demoCiServerTokenMarker(
  db: DemoDB,
  projectId: number,
  body: { ciServerToken?: unknown; ciRerun?: unknown } | null,
): Promise<string | null | undefined> {
  const token = body?.ciServerToken;
  if (token === undefined) return undefined;
  if (typeof token !== 'string' || !token.trim()) return null;
  const [row] = await db.select({ ciRerun: projects.ciRerun }).from(projects).where(eq(projects.id, projectId));
  const settings = resolveCiActionsSettings(body?.ciRerun === undefined ? row?.ciRerun : body.ciRerun);
  const binding = ciServerTokenBinding(settings, null);
  if (binding.error) throw demoHttpError(400, binding.error);
  return JSON.stringify({ url: binding.url });
}

/** The base URL a demo project's stored CI server token is bound to, as `ciServerTokenUrl` answers. */
export function demoCiServerTokenUrl(stored: string | null | undefined): string | null {
  if (!stored) return null;
  try {
    return normalizeCiServerBaseUrl((JSON.parse(stored) as { url?: unknown }).url);
  } catch {
    return null;
  }
}
