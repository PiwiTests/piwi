/**
 * CI actions in the browser demo. A dispatch through an action that targets a
 * CI server goes as the server's does, up to the request: the demo has no CI
 * to reach, so it is recorded with the link the preset names (the job's page)
 * and nothing is sent. An action that targets a repository host's CI (GitHub,
 * GitLab, Bitbucket) answers that the demo cannot dispatch it. The places,
 * the requests and what a place is offered are read as the server reads them
 * (`#shared/ci-dispatch-request`, `#shared/handlers/ci-rerun-target`).
 */
import { eq } from 'drizzle-orm';
import { projects, users } from '~~/server/database/schema.sqlite';
import {
  ciActionInputValues,
  ciActionsProblem,
  resolveCiListingTarget,
  type CiListingTarget,
  pickCiAction,
  resolveCiActionsSettings,
  type CiAction,
  type CiActionCheckResult,
  type CiActionPick,
  type CiActionsSettings,
} from '#shared/ci-actions';
import { ciServerTargetOf, ciServerTargetOfListing } from '#shared/ci-targets';
import {
  CI_SERVER_HTTPS_PROBLEM,
  ciServerCheckFinding,
  ciServerCheckPlans,
  ciServerListPlan,
  ciServerRequestTemplate,
  DEFAULT_ARGS_PARAMETER,
  DEFAULT_DISPATCH_PARAMETER,
  readCiServerAnswer,
  renderCiRequest,
  type CiServerTarget,
  type CiTemplateValues,
} from '#shared/ci-server';
import { GITLAB_NO_JOBS, jenkinsJobs, type CiJobFieldListing, type CiJobListing } from '#shared/ci-job-fields';
import { NO_RETRY_ARGS } from '#shared/retry-command';
import {
  ciPlaceLastDispatch,
  ciServerTemplateValues,
  projectRunBranches,
  rerunFiles,
  resolveCiDispatchPlace,
  type CiDispatchPlace,
} from '#shared/handlers/ci-rerun-target';
import { claimCiDispatch, getCiDispatch, settleCiDispatch } from '#shared/handlers/ci-dispatches';
import { actionUserTokenReadiness } from '#shared/handlers/credentials';
import type { UserTokenRefusalCode, UserTokenStatus } from '#shared/credentials';
import {
  ciActionTargetDigest,
  ciBranchOptions,
  ciDispatchInputValues,
  ciDispatchRequestProblem,
  offeredCiAction,
  unknownCiActionMessage,
  type CiBranchOption,
  type CiDispatchRequest,
  type CiDispatchSource,
  type CiOffered,
} from '#shared/ci-dispatch-request';
import type { CiDispatchView } from '#shared/ci-dispatches';
import { ciActionsCredentialProblem, loadCredentialRecord, type CredentialRecord } from '#shared/handlers/credentials';
import { credentialRefusal } from '#shared/credentials';
import type { getDemoDb } from '../db.client';
import { demoHttpError } from './http-error';

type DemoDB = Awaited<ReturnType<typeof getDemoDb>>;

const OFF_REASON = 'CI re-run is off for this project.';
const NO_TARGET = 'No CI server is configured for this project.';
/** Why the demo dispatches no repository host's action. */
const HOST_REASON = 'The demo has no repository to dispatch to: it runs only CI server actions.';

async function projectCiActions(db: DemoDB, projectId: number): Promise<CiActionsSettings> {
  const [row] = await db.select({ ciRerun: projects.ciRerun }).from(projects).where(eq(projects.id, projectId));
  return resolveCiActionsSettings(row?.ciRerun ?? null);
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

/**
 * The action a place uses, as the server picks it, among the CI server
 * actions: the demo has no repository, so a repository host's action, named
 * or the only kind of action that accepts the place's kind, answers
 * {@link HOST_REASON}.
 */
function demoPick(settings: CiActionsSettings, place: CiDispatchPlace, actionId?: string | null): CiActionPick {
  const pick = pickCiAction(settings, place.kind, {
    provider: null,
    environmentId: place.environmentId,
    environment: place.environment,
    actionId,
    startedBy: place.started?.actionId,
  });
  if (pick.action) return pick;
  const accepting = settings.actions.filter((a) => a.accepts.includes(place.kind));
  const named = actionId ? accepting.find((a) => a.id === actionId || a.name === actionId) : undefined;
  const hostOnly = actionId ? named != null && named.target.type !== 'ci-server' : accepting.length > 0;
  return hostOnly ? { action: null, reason: HOST_REASON } : pick;
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
  const spec = ciServerRequestTemplate(target, 'rerun');
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

/** Whether a place's dispatch can be recorded through the action picked for it, on this branch, as the server decides. */
async function readiness(
  db: DemoDB,
  settings: CiActionsSettings,
  place: CiDispatchPlace,
  pick: CiActionPick,
  ref: string | null,
  userId: number | null,
): Promise<{
  available: boolean;
  reason: string | null;
  code?: UserTokenRefusalCode;
  perUser?: { credential: { id: number; name: string }; userToken: UserTokenStatus | null } | null;
}> {
  if (!settings.enabled) return { available: false, reason: OFF_REASON };
  const action = pick.action;
  if (!action) return { available: false, reason: pick.reason };
  if (action.target.type !== 'ci-server') return { available: false, reason: HOST_REASON };
  const target = ciServerTargetOf(action.target);
  const { credential, baseUrl } = await targetCredential(db, target);
  const prepared = prepare(
    target,
    baseUrl,
    ciServerTemplateValues(target, 'args', 'dispatch', ref, place.commit),
    Object.entries(ciActionInputValues(action)),
  );
  // As the server: a request whose auth is `none` carries no credential, and one its credential refuses is unavailable.
  let reason = 'error' in prepared ? prepared.error : null;
  if (!reason && target.credentialId && 'url' in prepared && prepared.sendsCredential) {
    reason = credential
      ? credentialRefusal(credential, {
          projectId: place.projectId,
          url: prepared.url,
          custom: target.preset === 'custom',
        })
      : 'The credential this CI action names does not exist: pick another one.';
  }
  if (!reason && place.kind === 'tests' && !place.args) reason = NO_RETRY_ARGS;
  // As the server: a person without a token is asked for it before the dispatch is recorded.
  const perUser = await actionUserTokenReadiness(db as never, target, { userId, apiKeyId: null });
  if (!perUser) return { available: !reason, reason };
  if (reason || !perUser.code) return { available: !reason, reason, perUser: perUser.perUser };
  return { available: false, reason: perUser.reason, code: perUser.code, perUser: perUser.perUser };
}

/** A place in the demo, or the error the server answers for its source. */
async function demoPlace(
  db: DemoDB,
  projectId: number,
  source: CiDispatchSource,
  viewerId: number | null,
): Promise<CiDispatchPlace> {
  const found = await resolveCiDispatchPlace(db, projectId, source, viewerId);
  if (!found.ok) throw demoHttpError(found.error === 'not-found' ? 404 : 400, found.message);
  return found.place;
}

/** A request's query keys as the server reads them: a key given more than once (`tags`) is a list. */
export function demoQueryRecord(q: URLSearchParams | undefined): Record<string, string | string[]> {
  const record: Record<string, string | string[]> = {};
  for (const key of new Set(q?.keys() ?? [])) {
    const values = q!.getAll(key);
    record[key] = values.length > 1 ? values : values[0]!;
  }
  return record;
}

/** `GET /api/projects/:id/ci-actions/offered` in the demo. */
export async function demoCiOffered(
  db: DemoDB,
  projectId: number,
  source: CiDispatchSource,
  viewerId: number | null,
): Promise<CiOffered> {
  const place = await demoPlace(db, projectId, source, viewerId);
  const settings = await projectCiActions(db, projectId);
  const actions = [];
  for (const action of settings.actions.filter((a) => a.accepts.includes(place.kind))) {
    const ready = await readiness(db, settings, place, demoPick(settings, place, action.id), place.branch, viewerId);
    actions.push(offeredCiAction(action, place, ready));
  }
  return {
    enabled: settings.enabled,
    kind: place.kind,
    actions,
    defaultActionId: demoPick(settings, place).action?.id ?? null,
    lastDispatch: await ciPlaceLastDispatch(db, place),
  };
}

/** `GET /api/projects/:id/ci-actions/:actionId/branches` in the demo: the run branches, the demo having no repository. */
export async function demoCiBranches(
  db: DemoDB,
  projectId: number,
  actionId: string,
  q: string | null,
): Promise<{ items: CiBranchOption[] }> {
  const settings = await projectCiActions(db, projectId);
  if (!settings.actions.some((a) => a.id === actionId)) throw demoHttpError(404, 'CI action not found');
  return { items: ciBranchOptions(await projectRunBranches(db, projectId), [], q) };
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

/**
 * `POST /api/projects/:id/ci-dispatches` in the demo: the request is checked
 * as the server checks it, and a CI server action's dispatch is recorded as
 * the server records it, without sending anything.
 */
export async function demoDispatchCi(
  db: DemoDB,
  projectId: number,
  request: CiDispatchRequest,
  userId: number | null,
): Promise<CiDispatchView> {
  const place = await demoPlace(db, projectId, request.source, userId);
  const settings = await projectCiActions(db, projectId);
  const unknown = unknownCiActionMessage(settings, request.action);
  if (unknown) throw demoHttpError(404, unknown);
  const pick = demoPick(settings, place, request.action);
  const problem = ciDispatchRequestProblem(pick, request);
  if (problem) throw demoHttpError(400, problem);
  const ref = request.ref ?? place.branch;
  const ready = await readiness(db, settings, place, pick, ref, userId);
  const action = pick.action as (CiAction & { target: { type: 'ci-server' } }) | null;
  if (!ready.available || !action) {
    const data = ready.code
      ? { code: ready.code, ...(ready.perUser ? { credential: ready.perUser.credential } : {}) }
      : undefined;
    throw demoHttpError(400, ready.reason ?? NO_TARGET, undefined, data);
  }
  if (ready.perUser && request.targetDigest !== ciActionTargetDigest(action)) {
    throw demoHttpError(
      400,
      `The action "${action.name}" runs in your name and changed since this page showed it: look at it again, then start it.`,
      undefined,
      { code: 'action-changed', credential: ready.perUser.credential },
    );
  }
  const target = ciServerTargetOf(action.target);
  const id = randomId();
  const values = ciServerTemplateValues(target, place.args, id, ref, place.commit);
  const { baseUrl } = await targetCredential(db, target);
  const inputs = ciDispatchInputValues(action, request.inputs, place.started);
  const prepared = prepare(target, baseUrl, values, Object.entries(inputs));
  if ('error' in prepared) throw demoHttpError(400, prepared.error);
  const claim = await claimCiDispatch(
    db,
    {
      id,
      projectId,
      actionId: action.id,
      actionName: action.name,
      origin: 'page',
      kind: place.kind,
      sourceRunId: place.runId,
      clusterId: place.clusterId,
      testCaseId: place.testCaseId,
      provider: 'ci-server',
      preset: target.preset,
      ref: values.ref || null,
      inputs,
      args: place.args,
      files: place.cases ? rerunFiles(place.cases) : null,
      tests: place.cases ? place.cases.length : null,
      byUserId: userId,
      byName: await actorName(db, userId),
    },
    new Date(),
    { perPerson: Boolean(ready.perUser) },
  );
  if (!claim.claimed) {
    throw demoHttpError(409, 'The same dispatch was sent a moment ago.', undefined, { dispatch: claim.existing });
  }
  await settleCiDispatch(db, id, { url: prepared.link, ref: values.ref || null, providerRunId: null });
  return (await getCiDispatch(db, id))!;
}

/** Refuse, as the server does, a save whose CI actions cannot dispatch. */
export function assertDemoCiActions(body: { ciRerun?: unknown } | null): void {
  const problem = ciActionsProblem(body?.ciRerun);
  if (problem) throw demoHttpError(400, problem);
}

/** A Jenkins job of the demo's listing. */
const demoJob = (name: string) => ({ _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob', name, buildable: true });
const demoFolder = (name: string, jobs: unknown[]) => ({
  _class: 'com.cloudbees.hudson.plugins.folder.Folder',
  name,
  jobs,
});

/** What the demo's Jenkins answers a job listing: the jobs the seeded CI actions name. */
const DEMO_JENKINS_JOBS = {
  jobs: [
    demoJob('checkout'),
    demoFolder('api', [demoJob('integration'), demoJob('smoke'), demoJob('nightly')]),
    demoFolder('design-system', [demoJob('components')]),
    demoFolder('mobile-web', [demoJob('safari')]),
    demoFolder('admin-dashboard', [demoJob('e2e')]),
  ],
};

const stringParameter = (name: string, description: string) => ({
  name,
  type: 'StringParameterDefinition',
  description,
  defaultParameterValue: { value: '' },
});
const choiceParameter = (name: string, description: string, choices: string[]) => ({
  name,
  type: 'ChoiceParameterDefinition',
  description,
  choices,
  defaultParameterValue: { value: choices[0] },
});

/**
 * The parameters each demo job declares beside the reporter's two, by job
 * path. The nightly job calls its suite `TEST_SUITE`, where the seeded
 * Nightly action sends `SUITE`: its Check and its editor show the mismatch.
 */
const DEMO_JOB_PARAMETERS: Record<string, unknown[]> = {
  'api/smoke': [
    choiceParameter('TARGET_ENV', 'The environment the smoke suite runs against', ['staging', 'production']),
  ],
  'api/nightly': [
    choiceParameter('TEST_SUITE', 'Which suite the nightly build runs', ['regression', 'smoke', 'full']),
    {
      name: 'HEADED',
      type: 'BooleanParameterDefinition',
      description: 'Run the browsers headed',
      defaultParameterValue: { value: false },
    },
  ],
};

/** The job paths the demo's Jenkins holds, as its listing names them. */
const DEMO_JOB_PATHS = new Set(jenkinsJobs(DEMO_JENKINS_JOBS)?.jobs.map((job) => job.id) ?? []);

/** What the demo's Jenkins answers a read of a job it does not hold, as a Jenkins does. */
const DEMO_NO_JOB = 'No job at this path, or the credential’s user cannot see it (404).';

/**
 * What the demo's Jenkins answers a job read: the reporter's default
 * parameters, and the ones {@link DEMO_JOB_PARAMETERS} lists for the job;
 * null for a job it does not hold.
 */
function demoJobJson(job: string | undefined) {
  if (!DEMO_JOB_PATHS.has(job ?? '')) return null;
  return {
    property: [
      {
        parameterDefinitions: [
          stringParameter(DEFAULT_ARGS_PARAMETER, 'Playwright arguments of a re-run'),
          stringParameter(DEFAULT_DISPATCH_PARAMETER, 'The dispatch Piwi matches the run to'),
          ...(DEMO_JOB_PARAMETERS[job ?? ''] ?? []),
        ],
      },
    ],
  };
}

const CANNOT_CHECK = {
  gitlab:
    "GitLab pipelines can't be checked: GitLab reports no variable declarations without starting a pipeline. Dispatch it once to confirm.",
  bitbucket: 'The demo has no repository to read the pipelines file from.',
  github: 'The demo has no repository to read the workflow from.',
  custom: "A Custom request can't be checked: it names no job Piwi can read.",
};

/**
 * `POST /api/projects/:id/ci-actions/:actionId/check` in the demo: an action
 * the request carries (else the saved one) is checked as the server checks it,
 * up to the request. A Jenkins job answers as one that declares the default
 * parameters and those {@link DEMO_JOB_PARAMETERS} lists, so a renamed
 * parameter or another input shows as missing. Nothing is sent.
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
    action = (await projectCiActions(db, projectId)).actions.find((a) => a.id === actionId);
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
  const job = demoJobJson(target.fields.job);
  if (!job) {
    return {
      ok: false,
      missing: [],
      message: credential
        ? DEMO_NO_JOB
        : 'No job at this path, or the CI server hides it from a request without a credential (404).',
    };
  }
  const allowed = credential?.allowedInputs ?? null;
  const notSent = allowed ? inputNames.filter((name) => !allowed.includes(name)) : [];
  const finding = ciServerCheckFinding(
    notSent.length > 0 ? { ...plan, required: plan.required.filter((name) => !notSent.includes(name)) } : plan,
    job,
  );
  if (notSent.length === 0) return { ok: finding.ok, missing: finding.missing, message: finding.message };
  return {
    ok: false,
    missing: finding.missing,
    message: `${finding.message} Not sent: ${notSent.join(', ')}, because the credential "${credential!.name}" does not allow these inputs.`,
  };
}

/** Why the demo lists nothing from a repository host. */
const NO_REPOSITORY = 'The demo has no repository to read: it lists only a Jenkins job’s.';

/**
 * A listing request's target, as the server resolves it: refused with a 400
 * when it names nothing to read, or a credential the project may not name.
 */
async function demoListingTarget(db: DemoDB, projectId: number, body: unknown): Promise<CiListingTarget> {
  const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const resolved = resolveCiListingTarget(raw.target);
  if ('error' in resolved) throw demoHttpError(400, resolved.error);
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'This CI action';
  const problem = await ciActionsCredentialProblem(
    db as never,
    projectId,
    { actions: [{ name, target: resolved.target }] },
    [],
    new Set(),
    (await db.select({ url: projects.repositoryUrl }).from(projects).where(eq(projects.id, projectId)))[0]?.url ?? null,
  );
  if (problem) throw demoHttpError(400, problem);
  return resolved.target;
}

/** The base URL a CI server target reads under, and its credential: the server's checks, with no instance CI server and no listed hosts. */
async function demoCiServerBase(
  db: DemoDB,
  target: CiServerTarget,
): Promise<{ baseUrl: string; credential: CredentialRecord | null } | { message: string }> {
  const { credential, baseUrl } = await targetCredential(db, target);
  if (!baseUrl) return { message: NO_TARGET };
  if (!baseUrl.startsWith('https:')) return { message: CI_SERVER_HTTPS_PROBLEM };
  return { baseUrl, credential };
}

/** Why the credential a target names refuses a read of `url`, as the server's credential rules refuse it. */
function demoReadRefusal(
  target: CiServerTarget,
  credential: CredentialRecord | null,
  projectId: number,
  url: string,
): string | null {
  if (!target.credentialId) return null;
  return credential
    ? credentialRefusal(credential, { projectId, url, custom: false })
    : 'The credential this CI action names does not exist: pick another one.';
}

/**
 * `POST /api/projects/:id/ci-actions/jobs` in the demo: a Jenkins target lists
 * the jobs the seeded CI actions name, read as the server reads a listing; a
 * repository host has nothing to read. Nothing is sent.
 */
export async function demoCiJobs(db: DemoDB, projectId: number, body: unknown): Promise<CiJobListing> {
  const target = await demoListingTarget(db, projectId, body);
  const none = (message: string): CiJobListing => ({ jobs: null, truncated: false, message });
  if (target.type === 'gitlab') return none(GITLAB_NO_JOBS);
  if (target.type !== 'ci-server') return none(NO_REPOSITORY);
  const server = ciServerTargetOfListing(target);
  const base = await demoCiServerBase(db, server);
  if ('message' in base) return none(base.message);
  const plan = ciServerListPlan(server, base.baseUrl);
  if ('error' in plan) return none(plan.error);
  const refusal = demoReadRefusal(server, base.credential, projectId, plan.url);
  if (refusal) return none(refusal);
  const found = plan.jobs(DEMO_JENKINS_JOBS);
  return found ? { jobs: found.jobs, truncated: found.truncated, message: null } : none('The answer lists no jobs.');
}

/**
 * `POST /api/projects/:id/ci-actions/fields` in the demo: a Jenkins job's
 * parameters as Check reads them; a repository host has nothing to read.
 * Nothing is sent.
 */
export async function demoCiJobFields(db: DemoDB, projectId: number, body: unknown): Promise<CiJobFieldListing> {
  const target = await demoListingTarget(db, projectId, body);
  if (target.type !== 'ci-server') return { fields: null, message: NO_REPOSITORY };
  if (!target.job) return { fields: null, message: 'Pick a job first.' };
  const server = ciServerTargetOfListing(target);
  const base = await demoCiServerBase(db, server);
  if ('message' in base) return { fields: null, message: base.message };
  const [plan] = ciServerCheckPlans(server, base.baseUrl);
  if (!plan) return { fields: null, message: 'This target names no job to read.' };
  if ('error' in plan) return { fields: null, message: plan.error };
  const refusal = demoReadRefusal(server, base.credential, projectId, plan.url);
  if (refusal) return { fields: null, message: refusal };
  const job = demoJobJson(target.job);
  return job ? { fields: plan.fields(job), message: null } : { fields: null, message: DEMO_NO_JOB };
}
