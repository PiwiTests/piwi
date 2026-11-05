/**
 * CI re-run in the browser demo. A project that dispatches through a CI server
 * (`ciRerun.via: 'ci-server'`) re-runs as the server does, up to the request:
 * the demo has no CI to reach, so the dispatch is recorded with the link the
 * preset names (the job's page) and nothing is sent. A project that dispatches
 * through its repository's CI answers that the demo cannot re-run it.
 */
import { eq } from 'drizzle-orm';
import { failureClusters, projects, users } from '~~/server/database/schema.sqlite';
import { resolveCiRerunSettings, type CiRerunSettings, type ClusterRerunDispatch } from '#shared/ci-rerun';
import {
  ciServerRequestTemplate,
  ciServerTargetProblem,
  isUnderBaseUrl,
  normalizeCiServerBaseUrl,
  readCiServerAnswer,
  renderCiRequest,
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
}

async function projectCiRerun(db: DemoDB, projectId: number) {
  const [row] = await db
    .select({ ciRerun: projects.ciRerun, ciServerToken: projects.ciServerToken })
    .from(projects)
    .where(eq(projects.id, projectId));
  return {
    settings: resolveCiRerunSettings((row?.ciRerun as Partial<CiRerunSettings> | null) ?? null),
    tokenUrl: demoCiServerTokenUrl(row?.ciServerToken),
  };
}

/**
 * The request URL and the link a dispatch records, or why the request cannot
 * be built: the server's checks, with no instance CI server and no listed hosts.
 */
function prepare(
  settings: CiRerunSettings,
  values: CiTemplateValues,
): { link: string; url: string; sendsCredential: boolean } | { error: string } {
  const target = settings.ciServer;
  const spec = target ? ciServerRequestTemplate(target, 'rerun') : null;
  if (!target || !spec || !target.baseUrl) return { error: NO_TARGET };
  if (!target.baseUrl.startsWith('https:')) {
    return { error: 'The CI server URL must use https, or its host must be listed in PIWI_CI_SERVER_HOSTS.' };
  }
  try {
    const { url } = renderCiRequest(target.baseUrl, spec.template, values);
    const { link } = readCiServerAnswer(target.baseUrl, spec.template, values, { header: () => null, json: null });
    return { link, url, sendsCredential: spec.auth !== 'none' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'The CI server request cannot be built.' };
  }
}

async function availability(db: DemoDB, projectId: number, runId: number): Promise<DemoRerunAvailability> {
  const { settings, tokenUrl } = await projectCiRerun(db, projectId);
  if (settings.via !== 'ci-server') {
    return { available: false, reason: UNAVAILABLE, provider: null, enabled: false, hasToken: false };
  }
  const target = settings.ciServer;
  const prepared = target
    ? prepare(settings, await ciServerValues(db, runId, target, 'args', 'dispatch'))
    : { error: NO_TARGET };
  // As the server: a request whose auth is `none` carries no credential, token or not.
  const hasToken =
    'url' in prepared && prepared.sendsCredential && !!tokenUrl && isUnderBaseUrl(tokenUrl, prepared.url);
  const reason = !settings.enabled ? OFF_REASON : 'error' in prepared ? prepared.error : null;
  return { available: !reason, reason, provider: 'ci-server', enabled: settings.enabled, hasToken };
}

async function clusterTarget(db: DemoDB, clusterId: number) {
  const [row] = await db
    .select({ projectId: failureClusters.projectId, runId: failureClusters.lastSeenRunId })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  return row ?? null;
}

/** `GET /api/failure-clusters/:id/rerun` in the demo. */
export async function demoClusterRerunInfo(db: DemoDB, clusterId: number) {
  const target = await clusterTarget(db, clusterId);
  if (!target) throw demoHttpError(404, 'Failure cluster not found');
  return {
    ...(await availability(db, target.projectId, target.runId)),
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
  input: { projectId: number; runId: number; clusterId: number | null; cases: RetryCase[] },
  userId: number | null,
) {
  const ready = await availability(db, input.projectId, input.runId);
  if (!ready.available) throw demoHttpError(400, ready.reason ?? UNAVAILABLE);
  const { settings } = await projectCiRerun(db, input.projectId);
  const target = settings.ciServer;
  if (!target) throw demoHttpError(400, NO_TARGET);
  const args = buildRetryArgs(input.cases);
  const id = randomId();
  const values = await ciServerValues(db, input.runId, target, args, id);
  const prepared = prepare(settings, values);
  if ('error' in prepared) throw demoHttpError(400, prepared.error);
  const record: ClusterRerunDispatch = {
    id,
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
export async function demoRerunCluster(db: DemoDB, clusterId: number, userId: number | null) {
  const target = await clusterTarget(db, clusterId);
  if (!target) throw demoHttpError(404, 'Failure cluster not found');
  return dispatch(db, { ...target, clusterId, cases: await clusterRerunCases(db, clusterId) }, userId);
}

/** `POST /api/test-run-cases/:id/rerun` in the demo. */
export async function demoRerunExecution(db: DemoDB, executionId: number, userId: number | null) {
  const target = await executionRerunTarget(db, executionId);
  if (!target) throw demoHttpError(404, 'Test run case not found');
  const { projectId, runId, clusterId, rerunCase } = target;
  return dispatch(db, { projectId, runId, clusterId, cases: [rerunCase] }, userId);
}

/** Refuse, as the server does, a CI server target a save sends that cannot dispatch. */
export function assertDemoCiServerTarget(body: { ciRerun?: unknown } | null): void {
  const sent = (body?.ciRerun as { ciServer?: unknown } | null | undefined)?.ciServer;
  if (sent == null) return;
  const problem = ciServerTargetProblem(sent);
  if (problem) throw demoHttpError(400, problem);
}

/**
 * What the demo stores for a CI server token a save sends: never the token,
 * only the base URL a server would bind it to (the request's, else the stored
 * target's). `undefined` keeps the stored value, `null` removes it. Throws the
 * server's 400 answers for an invalid or a missing base URL.
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
  const sent = (body?.ciRerun === undefined ? row?.ciRerun : body.ciRerun) as {
    ciServer?: { baseUrl?: unknown };
  } | null;
  const rawBaseUrl = sent?.ciServer?.baseUrl;
  const baseUrl = normalizeCiServerBaseUrl(rawBaseUrl);
  if (typeof rawBaseUrl === 'string' && rawBaseUrl.trim() && !baseUrl) {
    throw demoHttpError(400, 'The CI server base URL must be an http(s) URL');
  }
  if (!baseUrl) throw demoHttpError(400, 'Set the CI server base URL before saving its token');
  return JSON.stringify({ url: baseUrl });
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
