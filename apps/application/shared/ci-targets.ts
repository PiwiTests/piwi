/**
 * The kinds of target a CI action dispatches to, one definition each: a
 * GitHub workflow, a GitLab pipeline, a Bitbucket custom pipeline, a CI server
 * request (a Jenkins job or a Custom request). A definition holds what the
 * dispatch, the settings form and the demo know of a target without reaching
 * it: how a list names it, the names it sends, how a posted target or a
 * listing target is read, and how it takes a branch. What reaches the target
 * (a dispatch, Check, a listing) is the server's provider of the same type
 * (`server/utils/ci-providers/`).
 *
 * A new kind of target adds its type to `CiActionTarget`, a definition here
 * and a provider on the server.
 *
 * Pure and dependency-free, as `shared/ci-actions.ts`.
 */
import type { CiActionTarget, CiListingTarget } from '#shared/ci-actions';
import type { CiBranchMode } from '#shared/ci-dispatch-request';
import { SCM_PROVIDER_LABELS, type ScmProviderName } from '#shared/scm-urls';
import {
  CI_SERVER_PRESET_REGISTRY,
  CI_SERVER_PRESETS,
  ciServerTakesBranch,
  ciServerTargetProblem,
  DEFAULT_ARGS_PARAMETER,
  DEFAULT_DISPATCH_PARAMETER,
  normalizeCiServerBaseUrl,
  resolveCiServerTarget,
  type CiServerPreset,
  type CiServerTarget,
} from '#shared/ci-server';

export type CiTargetType = CiActionTarget['type'];
export type CiTargetOf<K extends CiTargetType> = Extract<CiActionTarget, { type: K }>;
export type CiListingTargetOf<K extends CiTargetType> = Extract<CiListingTarget, { type: K }>;

/** What the dispatch, the settings form and the demo know of one kind of target. */
export interface CiTargetDefinition<K extends CiTargetType> {
  /** The repository host whose runs it serves; null for a CI server, which serves any run. */
  host: ScmProviderName | null;
  /** Whether the CI reserves the `CI_`, `GITLAB_` and `BITBUCKET_` variables for itself, so an input may not set one. */
  reservesCiVariables: boolean;
  /** How a list of several actions names the CI it dispatches to: the host, or the CI server preset. */
  label(target: CiTargetOf<K>): string;
  /** A short description of the target, for the list. */
  summary(target: CiTargetOf<K>): string;
  /** The input names the target itself sends, which an action input may not reuse. */
  builtInNames(target: CiTargetOf<K>): string[];
  /** The branch the target runs when a dispatch names none; null when the CI picks it. */
  defaultRef(target: CiTargetOf<K>): string | null;
  /** How the target takes a branch ({@link CiBranchMode}). */
  branchMode(target: CiTargetOf<K>): CiBranchMode;
  /** The target from an untrusted payload of its type, or null when it cannot dispatch. */
  resolve(input: Record<string, unknown>): CiTargetOf<K> | null;
  /** Why a posted target of its type that does not resolve cannot dispatch; null for the generic reason. */
  problem(input: Record<string, unknown>): string | null;
  /** A target to list jobs or fields from, from an untrusted payload of its type, or why it cannot be listed from. */
  resolveListing(input: Record<string, unknown>): { target: CiListingTargetOf<K> } | { error: string };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** A posted credential id: a positive integer, else absent. */
function credentialIdOf(raw: unknown): { credentialId?: number } {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? { credentialId: raw } : {};
}

/** The CI server target an action of type `ci-server` sends through, in the shape the CI server code reads. */
export function ciServerTargetOf(target: CiTargetOf<'ci-server'>): CiServerTarget {
  return {
    preset: target.preset,
    ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
    ...(target.credentialId ? { credentialId: target.credentialId } : {}),
    ...(target.user ? { user: target.user } : {}),
    rerun: target.fields,
    ...(target.custom ? { custom: { auth: target.custom.auth, rerun: target.custom.request } } : {}),
  };
}

/** The CI server target a listing target reads through, in the shape the CI server code reads. */
export function ciServerTargetOfListing(target: CiListingTargetOf<'ci-server'>): CiServerTarget {
  return {
    preset: target.preset,
    ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
    ...(target.credentialId ? { credentialId: target.credentialId } : {}),
    ...(target.user ? { user: target.user } : {}),
    rerun: { job: target.job, ...(target.ref ? { ref: target.ref } : {}) },
  };
}

/** A posted `ci-server` action target in the shape `resolveCiServerTarget` reads. */
function rawCiServerTarget(target: Record<string, unknown>): Record<string, unknown> {
  const custom = isRecord(target.custom) ? target.custom : null;
  return {
    preset: target.preset,
    baseUrl: target.baseUrl,
    credentialId: target.credentialId,
    user: target.user,
    rerun: target.fields,
    ...(custom ? { custom: { auth: custom.auth, rerun: custom.request } } : {}),
  };
}

/** A repository host's listing target needs the ref its files are read at. */
function refOf(input: Record<string, unknown>): string | { error: string } {
  return str(input.ref) || { error: 'Fill in the ref the files are read at.' };
}

const github: CiTargetDefinition<'github'> = {
  host: 'github',
  reservesCiVariables: false,
  label: () => SCM_PROVIDER_LABELS.github,
  summary: (target) => `${SCM_PROVIDER_LABELS.github} · ${target.workflow}`,
  builtInNames: (target) => [target.argsInput, ...(target.dispatchIdInput ? [target.dispatchIdInput] : [])],
  defaultRef: (target) => target.ref,
  branchMode: () => 'list',
  resolve(input) {
    const workflow = str(input.workflow);
    const ref = str(input.ref);
    const argsInput = str(input.argsInput);
    const dispatchIdInput = str(input.dispatchIdInput);
    if (!workflow || !ref || !argsInput) return null;
    return {
      type: 'github',
      workflow,
      ref,
      argsInput,
      ...(dispatchIdInput ? { dispatchIdInput } : {}),
      ...credentialIdOf(input.credentialId),
    };
  },
  problem: () => null,
  resolveListing(input) {
    const ref = refOf(input);
    if (typeof ref !== 'string') return ref;
    return { target: { type: 'github', ref, workflow: str(input.workflow), ...credentialIdOf(input.credentialId) } };
  },
};

const gitlab: CiTargetDefinition<'gitlab'> = {
  host: 'gitlab',
  reservesCiVariables: true,
  label: () => SCM_PROVIDER_LABELS.gitlab,
  summary: () => `${SCM_PROVIDER_LABELS.gitlab} pipeline`,
  builtInNames: (target) => [target.argsVariable],
  defaultRef: (target) => target.ref,
  branchMode: () => 'list',
  resolve(input) {
    const ref = str(input.ref);
    const argsVariable = str(input.argsVariable);
    return ref && argsVariable ? { type: 'gitlab', ref, argsVariable, ...credentialIdOf(input.credentialId) } : null;
  },
  problem: () => null,
  resolveListing(input) {
    const ref = refOf(input);
    if (typeof ref !== 'string') return ref;
    return { target: { type: 'gitlab', ref, ...credentialIdOf(input.credentialId) } };
  },
};

const bitbucket: CiTargetDefinition<'bitbucket'> = {
  host: 'bitbucket',
  reservesCiVariables: true,
  label: () => SCM_PROVIDER_LABELS.bitbucket,
  summary: (target) => `${SCM_PROVIDER_LABELS.bitbucket} · custom: ${target.pipeline}`,
  builtInNames: (target) => [target.argsVariable],
  // A custom pipeline runs on the repository's default branch, which Bitbucket names once the dispatch is sent.
  defaultRef: () => null,
  branchMode: () => 'list',
  resolve(input) {
    const pipeline = str(input.pipeline);
    const argsVariable = str(input.argsVariable);
    return pipeline && argsVariable
      ? { type: 'bitbucket', pipeline, argsVariable, ...credentialIdOf(input.credentialId) }
      : null;
  },
  problem: () => null,
  resolveListing: (input) => ({
    target: { type: 'bitbucket', pipeline: str(input.pipeline), ...credentialIdOf(input.credentialId) },
  }),
};

const ciServer: CiTargetDefinition<'ci-server'> = {
  host: null,
  reservesCiVariables: false,
  label: (target) => (target.preset === 'custom' ? 'Custom request' : CI_SERVER_PRESET_REGISTRY[target.preset].label),
  summary: (target) =>
    target.preset === 'custom'
      ? 'Custom request'
      : `${CI_SERVER_PRESET_REGISTRY[target.preset].label} · ${target.fields.job ?? ''}`.trim(),
  builtInNames: (target) =>
    target.preset === 'custom'
      ? []
      : [
          target.fields.argsParameter || DEFAULT_ARGS_PARAMETER,
          target.fields.dispatchParameter || DEFAULT_DISPATCH_PARAMETER,
        ],
  defaultRef: (target) => target.fields.ref?.trim() || null,
  branchMode: (target) => (ciServerTakesBranch(ciServerTargetOf(target)) ? 'typed' : 'fixed'),
  resolve(input) {
    const resolved = resolveCiServerTarget(rawCiServerTarget(input));
    if (!resolved) return null;
    return {
      type: 'ci-server',
      preset: resolved.preset,
      ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
      ...(resolved.credentialId ? { credentialId: resolved.credentialId } : {}),
      ...(resolved.user ? { user: resolved.user } : {}),
      fields: resolved.rerun,
      ...(resolved.custom ? { custom: { auth: resolved.custom.auth, request: resolved.custom.rerun } } : {}),
    };
  },
  problem: (input) => ciServerTargetProblem(rawCiServerTarget(input)),
  resolveListing(input) {
    if (input.preset === 'custom') return { error: 'A Custom request names no job to list.' };
    if (!(CI_SERVER_PRESETS as readonly unknown[]).includes(input.preset)) {
      return { error: 'The CI server preset is not one Piwi knows.' };
    }
    const baseUrl = normalizeCiServerBaseUrl(input.baseUrl);
    if (str(input.baseUrl) && !baseUrl) return { error: 'The CI server base URL must be an http(s) URL.' };
    const fields = isRecord(input.fields) ? input.fields : {};
    const user = str(input.user);
    return {
      target: {
        type: 'ci-server',
        preset: input.preset as Exclude<CiServerPreset, 'custom'>,
        ...(baseUrl ? { baseUrl } : {}),
        ...credentialIdOf(input.credentialId),
        ...(user ? { user } : {}),
        job: str(fields.job),
        ref: str(fields.ref),
      },
    };
  },
};

/** Every kind of target, by its type. */
export const CI_TARGETS: { [K in CiTargetType]: CiTargetDefinition<K> } = {
  github,
  gitlab,
  bitbucket,
  'ci-server': ciServer,
};

/** Whether a posted type is a kind of target Piwi dispatches to. */
export function isCiTargetType(type: unknown): type is CiTargetType {
  return typeof type === 'string' && Object.hasOwn(CI_TARGETS, type);
}

/** The definition of a target's kind. */
export function ciTargetDefinition<K extends CiTargetType>(type: K): CiTargetDefinition<K> {
  return CI_TARGETS[type];
}
