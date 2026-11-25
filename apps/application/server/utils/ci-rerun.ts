/**
 * CI dispatch: the one flow every place that starts CI goes through, for a
 * cluster's affected tests, an execution's test or its cluster's, a run's
 * failed tests or the whole suite on its branch, a Flake Lab experiment, the
 * project's whole suite, and the project's tests carrying some tags.
 *
 * A request names its source (`#shared/ci-dispatch-request`), which the
 * shared handler reads as a place (`resolveCiDispatchPlace`): its tests, and
 * the run they come from, whose repository, branch, environment and dispatch a
 * dispatch follows. The project's CI actions (`server/utils/ci-actions.ts`) say
 * where a dispatch goes: each action names a repository host's CI (a GitHub
 * workflow, a GitLab or Bitbucket pipeline, which use the project's SCM token
 * on its pinned repository) or a CI server, and the provider of its kind
 * (`server/utils/ci-providers/`) says whether it can go and sends it.
 * `pickCiAction` chooses the action. The availability a place is offered and
 * the dispatch run the same checks, so a page never offers an action the
 * dispatch would refuse.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { failureClusters } from '../database/schema';
import { detectScmProvider } from './scm';
import { NO_RETRY_ARGS } from '#shared/retry-command';
import {
  ciPlaceLastDispatch,
  projectRunBranches,
  rerunFiles,
  resolveCiDispatchPlace,
  type CiDispatchPlace,
} from '#shared/handlers/ci-rerun-target';
import { claimCiDispatch, getCiDispatch, settleCiDispatch } from '#shared/handlers/ci-dispatches';
import type { CiDispatchOrigin, CiDispatchView } from '#shared/ci-dispatches';
import {
  pickCiAction,
  reservedInputMessage,
  reservedInputName,
  type CiAction,
  type CiActionPick,
  type CiActionsSettings,
} from '#shared/ci-actions';
import {
  ciActionTargetDigest,
  ciBranchMode,
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
import { ciTargetDefinition } from '#shared/ci-targets';
import { getCiActionsSettings } from './ci-actions';
import { ciProvider, type CiReadiness } from './ci-providers';
import { CredentialRefusedError, type CredentialActor } from './credentials';
import { actionUserTokenReadiness } from '#shared/handlers/credentials';
import type { UserTokenRefusalCode } from '#shared/credentials';
import { apiError } from './api-error';
import type { DbClient } from '../database';

/** Who asked for a dispatch, as its record names them, and the API key it came through, for the credential log. */
export interface CiRerunActor {
  id: number | null;
  name: string | null;
  apiKeyId?: number | null;
}

/** What a dispatch from a page, the API or a tool came to: the dispatch, or why there is none (the earlier one for a repeat). */
export type CiDispatchOutcome =
  | { ok: true; dispatch: CiDispatchView }
  | {
      ok: false;
      error: 'not-found' | 'invalid' | 'unavailable' | 'dispatch-failed';
      message: string;
      /** Why a per-user credential refused who asked, or that the action changed since the page showed it. */
      code?: UserTokenRefusalCode | 'action-changed';
      credential?: { id: number; name: string };
    }
  | { ok: false; error: 'duplicate'; message: string; dispatch: CiDispatchView };

const STATUS_BY_ERROR = {
  'not-found': 404,
  invalid: 400,
  unavailable: 400,
  'dispatch-failed': 502,
  duplicate: 409,
} as const;

/**
 * The API error of a dispatch that did not go: a repeat answers 409 with the
 * earlier dispatch as `data.dispatch`; a refusal of a per-user credential
 * names its `data.code` and `data.credential`.
 */
export function ciDispatchError(outcome: Extract<CiDispatchOutcome, { ok: false }>) {
  const data =
    outcome.error === 'duplicate'
      ? { dispatch: outcome.dispatch }
      : outcome.code
        ? { code: outcome.code, ...(outcome.credential ? { credential: outcome.credential } : {}) }
        : null;
  return apiError({
    statusCode: STATUS_BY_ERROR[outcome.error],
    message: outcome.message,
    ...(data ? { data } : {}),
  });
}

/** The action a place uses: the one `actionId` names, else its default (`pickCiAction`). */
function pickFor(settings: CiActionsSettings, place: CiDispatchPlace, actionId?: string | null): CiActionPick {
  return pickCiAction(settings, place.kind, {
    provider: detectScmProvider(place.repositoryUrl),
    environmentId: place.environmentId,
    environment: place.environment,
    actionId,
    startedBy: place.started?.actionId,
  });
}

/**
 * Whether a place's dispatch can be sent through the action picked for it, on
 * this branch: CI actions on, an action that accepts the kind and serves the
 * place's repository, what that action needs (an SCM credential, or a CI
 * server request that builds and a credential that allows it), and, for tests,
 * one a re-run's arguments can name.
 */
async function readiness(
  db: DbClient,
  settings: CiActionsSettings,
  place: CiDispatchPlace,
  pick: CiActionPick,
  ref: string | null,
  actor: CredentialActor,
): Promise<CiReadiness> {
  if (!settings.enabled) return { available: false, reason: 'CI re-run is off for this project.' };
  const action = pick.action;
  if (!action) return { available: false, reason: pick.reason };
  const reserved = reservedInputName(action);
  if (reserved) {
    return {
      available: false,
      reason: reservedInputMessage(reserved, action.target),
    };
  }
  const ready = await ciProvider(action.target.type).readiness(db, place, action, ref);
  // Empty arguments would run the whole suite.
  if (ready.available && place.kind === 'tests' && !place.args) return { available: false, reason: NO_RETRY_ARGS };
  const perUser = await actionUserTokenReadiness(db, action.target, actor);
  if (!perUser) return ready;
  // A person without a token is asked for it before the dispatch is stored, never refused after.
  if (!ready.available || !perUser.code) return { ...ready, perUser: perUser.perUser };
  return { available: false, reason: perUser.reason, code: perUser.code, perUser: perUser.perUser };
}

/** A second dispatch of the same action, arguments, branch and inputs within the guard: the earlier one. */
class DuplicateDispatchError extends Error {
  constructor(readonly existing: CiDispatchView) {
    super('The same dispatch was sent a moment ago.');
  }
}

/**
 * Send a place's dispatch through an action {@link readiness} found ready
 * (no reserved input name), on `ref` (the target's configured ref when null),
 * with these input values beside the arguments, never in
 * them. A repository host's action dispatches on the place's repository. The
 * dispatch is stored before it is sent ({@link claimCiDispatch}, which refuses
 * the same one twice), then settled with the provider's answer, or as refused
 * with its error, which is thrown again.
 */
async function dispatchWithAction(
  db: DbClient,
  input: {
    place: CiDispatchPlace;
    action: CiAction;
    ref: string | null;
    inputs: Record<string, string>;
    actor: CiRerunActor;
    origin: CiDispatchOrigin;
    /** Whether the action runs in the name of whoever starts it, so a repeat is one of the same person's. */
    perPerson: boolean;
  },
): Promise<CiDispatchView> {
  const { place, action, inputs } = input;
  const id = randomBytes(8).toString('hex');
  const target = action.target;
  // The virtual administrator of an instance without sign-in is id 0, no user row.
  const credentialActor: CredentialActor = { userId: input.actor.id || null, apiKeyId: input.actor.apiKeyId ?? null };

  const { ref, send } = ciProvider(target.type).prepareDispatch(db, {
    place,
    action,
    id,
    ref: input.ref,
    inputs,
    actor: credentialActor,
  });

  const claim = await claimCiDispatch(
    db,
    {
      id,
      projectId: place.projectId,
      actionId: action.id,
      actionName: action.name,
      origin: input.origin,
      kind: place.kind,
      sourceRunId: place.runId,
      clusterId: place.clusterId,
      testCaseId: place.testCaseId,
      provider: target.type,
      preset: ciTargetDefinition(target.type).preset(target),
      ref,
      inputs,
      args: place.args,
      files: place.cases ? rerunFiles(place.cases) : null,
      tests: place.cases ? place.cases.length : null,
      byUserId: input.actor.id || null,
      byName: input.actor.name,
    },
    new Date(),
    { perPerson: input.perPerson },
  );
  if (!claim.claimed) throw new DuplicateDispatchError(claim.existing);
  try {
    await settleCiDispatch(db, id, await send());
  } catch (e) {
    await settleCiDispatch(db, id, { refused: e instanceof Error ? e.message : 'Dispatch failed' });
    throw e;
  }
  return (await getCiDispatch(db, id))!;
}

/** The outcome of a dispatch that threw. */
function failedDispatch(e: unknown): CiDispatchOutcome {
  if (e instanceof DuplicateDispatchError) {
    return { ok: false, error: 'duplicate', message: e.message, dispatch: e.existing };
  }
  return {
    ok: false,
    error: e instanceof CredentialRefusedError ? 'unavailable' : 'dispatch-failed',
    message: e instanceof Error ? e.message : 'Dispatch failed',
    ...(e instanceof CredentialRefusedError && e.code ? { code: e.code } : {}),
    ...(e instanceof CredentialRefusedError && e.code && e.credential ? { credential: e.credential } : {}),
  };
}

/**
 * Dispatch a place's tests to CI: read the source in the project (an id of
 * another project, or a run `viewerId` does not see, is not found), pick the
 * action the request names or the place's default, check the branch and the
 * inputs against it, check that it can be sent, then send it. Without a
 * branch it runs on the place's (`CiDispatchPlace.branch`), else the target's;
 * a choice the request does not set takes the value the source's run was sent
 * with through this action, else its default. Every route and tool that
 * starts CI calls it, after its own access checks.
 */
export async function dispatchCi(
  db: DbClient,
  projectId: number,
  request: CiDispatchRequest,
  actor: CiRerunActor,
  options: { origin: CiDispatchOrigin; viewerId: number | null },
): Promise<CiDispatchOutcome> {
  const found = await resolveCiDispatchPlace(db, projectId, request.source, options.viewerId);
  if (!found.ok) return found;
  const place = found.place;
  const settings = await getCiActionsSettings(db, projectId);
  const unknown = unknownCiActionMessage(settings, request.action);
  if (unknown) return { ok: false, error: 'not-found', message: unknown };
  const pick = pickFor(settings, place, request.action);
  const problem = ciDispatchRequestProblem(pick, request);
  if (problem) return { ok: false, error: 'invalid', message: problem };
  const ref = request.ref ?? place.branch;
  const credentialActor: CredentialActor = { userId: actor.id || null, apiKeyId: actor.apiKeyId ?? null };
  const ready = await readiness(db, settings, place, pick, ref, credentialActor);
  if (!pick.action || (!ready.available && !ready.credentialRefused)) {
    return {
      ok: false,
      error: 'unavailable',
      message: ready.reason ?? pick.reason ?? 'CI dispatch is not available',
      ...(ready.code ? { code: ready.code } : {}),
      ...(ready.perUser ? { credential: ready.perUser.credential } : {}),
    };
  }
  // A dispatch in a person's name goes only to the action the page showed them.
  if (ready.perUser && request.targetDigest !== ciActionTargetDigest(pick.action)) {
    return {
      ok: false,
      error: 'unavailable',
      code: 'action-changed',
      credential: ready.perUser.credential,
      message: `The action "${pick.action.name}" runs in your name and changed since this page showed it: look at it again, then start it.`,
    };
  }
  if (place.kind === 'tests' && !place.args) return { ok: false, error: 'unavailable', message: NO_RETRY_ARGS };
  try {
    const dispatch = await dispatchWithAction(db, {
      place,
      action: pick.action,
      ref,
      inputs: ciDispatchInputValues(pick.action, request.inputs, place.started),
      actor,
      origin: options.origin,
      perPerson: Boolean(ready.perUser),
    });
    return { ok: true, dispatch };
  } catch (e) {
    return failedDispatch(e);
  }
}

/**
 * Re-run a cluster's affected tests in CI, as {@link dispatchCi} does for a
 * `{ clusterId }` source. The MCP tool calls it, after its own access checks.
 */
export async function rerunClusterInCi(
  db: DbClient,
  clusterId: number,
  actor: CiRerunActor,
  options: {
    actionId?: string | null;
    origin?: CiDispatchOrigin;
    ref?: string | null;
    inputs?: Record<string, string> | null;
  } = {},
): Promise<CiDispatchOutcome> {
  const [cluster] = await db
    .select({ projectId: failureClusters.projectId })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  if (!cluster) return { ok: false, error: 'not-found', message: 'Failure cluster not found' };
  return dispatchCi(
    db,
    cluster.projectId,
    {
      source: { from: 'cluster', clusterId },
      action: options.actionId ?? null,
      ref: options.ref ?? null,
      inputs: options.inputs ?? null,
    },
    actor,
    { origin: options.origin ?? 'page', viewerId: actor.id },
  );
}

/** Whether a place's default dispatch can be sent, and the action it would use; null when the source is not found. */
export async function ciDispatchAvailability(
  db: DbClient,
  projectId: number,
  source: CiDispatchSource,
  viewerId: number | null,
  actor: CredentialActor = { userId: viewerId || null, apiKeyId: null },
): Promise<{ available: boolean; reason: string | null; action: { id: string; name: string } | null } | null> {
  const found = await resolveCiDispatchPlace(db, projectId, source, viewerId);
  if (!found.ok) return null;
  const settings = await getCiActionsSettings(db, projectId);
  const pick = pickFor(settings, found.place);
  const ready = await readiness(db, settings, found.place, pick, found.place.branch, actor);
  return {
    // A person without a token can still start it: the run dialog asks for the token first.
    available: ready.available || ready.code === 'user-token-required',
    reason: ready.reason,
    action: pick.action ? { id: pick.action.id, name: pick.action.name } : null,
  };
}

/**
 * What a place is offered: each action that accepts its kind, with its target,
 * environment, branch mode and default, inputs and whether it can be sent
 * there, the action a dispatch that names none uses, and the place's last
 * dispatch. Not found, like a dispatch, for a source outside the project.
 */
export async function ciOffered(
  db: DbClient,
  projectId: number,
  source: CiDispatchSource,
  viewerId: number | null,
  actor: CredentialActor = { userId: viewerId || null, apiKeyId: null },
): Promise<{ ok: true; offered: CiOffered } | { ok: false; error: 'not-found' | 'invalid'; message: string }> {
  const found = await resolveCiDispatchPlace(db, projectId, source, viewerId);
  if (!found.ok) return found;
  const place = found.place;
  const settings = await getCiActionsSettings(db, projectId);
  const actions = [];
  for (const action of settings.actions.filter((a) => a.accepts.includes(place.kind))) {
    const ready = await readiness(db, settings, place, pickFor(settings, place, action.id), place.branch, actor);
    actions.push(offeredCiAction(action, place, ready));
  }
  return {
    ok: true,
    offered: {
      enabled: settings.enabled,
      kind: place.kind,
      actions,
      defaultActionId: pickFor(settings, place).action?.id ?? null,
      lastDispatch: await ciPlaceLastDispatch(db, place),
    },
  };
}

/**
 * The branches an action may run on in a project: the branches its runs
 * reported, most recent first, then, for a repository host's action while CI
 * actions are on, the live branches of the project's pinned repository, read
 * with the action's SCM credential. A CI server action, whose branch is typed
 * or fixed, gets the run branches only. Null when the project has no such
 * action.
 */
export async function ciActionBranches(
  db: DbClient,
  projectId: number,
  actionId: string,
  q: string | null,
  actor: CredentialActor,
): Promise<CiBranchOption[] | null> {
  const settings = await getCiActionsSettings(db, projectId);
  const action = settings.actions.find((a) => a.id === actionId);
  if (!action) return null;
  const runBranches = await projectRunBranches(db, projectId);
  const target = action.target;
  const repositoryBranches =
    settings.enabled && ciBranchMode(target) === 'list'
      ? await ciProvider(target.type).repositoryBranches(db, projectId, action, actor)
      : [];
  return ciBranchOptions(runBranches, repositoryBranches, q);
}
