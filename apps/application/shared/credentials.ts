/**
 * Credentials — the secrets Piwi sends to other services, saved once on the
 * instance and referenced by id: the shapes the API answers with, the reading
 * of a posted credential, and the rules that refuse a use.
 *
 * Pure + dependency-free (the server, the demo and the settings pages share
 * it). Only `server/utils/credentials.ts` holds a secret: it seals, opens and
 * sends it, and records every use.
 */
import { CI_INPUT_NAME } from '#shared/ci-actions';
import { isUnderBaseUrl, normalizeCiServerBaseUrl, urlPathClimbs } from '#shared/ci-server';

/** What a credential is for: the pickers that list it and the requests that may carry it. */
export const CREDENTIAL_SERVICES = ['ci-server'] as const;
export type CredentialService = (typeof CREDENTIAL_SERVICES)[number];

export const CREDENTIAL_SERVICE_LABELS: Record<CredentialService, string> = {
  'ci-server': 'CI server',
};

/** The feature a use comes from. */
export const CREDENTIAL_FEATURES = ['ci-dispatch', 'ci-check'] as const;
export type CredentialFeature = (typeof CREDENTIAL_FEATURES)[number];

export const CREDENTIAL_FEATURE_LABELS: Record<CredentialFeature, string> = {
  'ci-dispatch': 'CI dispatch',
  'ci-check': 'CI check',
};

/**
 * The features whose uses only read: counted in one log row per credential,
 * feature, project, result and hour. Every other use is a row of its own.
 */
export const CREDENTIAL_READ_FEATURES: readonly CredentialFeature[] = ['ci-check'];

/** How a use ended: `sent` until the request answers, then `ok` or `failed`; `refused` when it was never sent. */
export const CREDENTIAL_USE_RESULTS = ['sent', 'ok', 'failed', 'refused'] as const;
export type CredentialUseResult = (typeof CREDENTIAL_USE_RESULTS)[number];

export const MAX_CREDENTIAL_NAME_LENGTH = 80;
export const MAX_CREDENTIAL_DESCRIPTION_LENGTH = 500;
export const MAX_CREDENTIAL_USER_LENGTH = 200;
export const MAX_CREDENTIAL_SECRET_LENGTH = 8192;
export const MAX_CREDENTIAL_ALLOWED_INPUTS = 50;
export const MAX_CREDENTIAL_PROJECTS = 500;

/** Which projects may use a credential. */
export type CredentialScope = { allProjects: true } | { allProjects: false; projectIds: number[] };

/** A CI action that names a credential. */
export interface CredentialReference {
  projectId: number;
  projectName: string;
  actionId: string;
  actionName: string;
}

/** A credential as its settings page shows it. Never its secret. */
export interface CredentialSummary {
  id: number;
  name: string;
  description: string | null;
  service: CredentialService;
  user: string | null;
  /** The base URL the secret may be sent under. */
  destination: string;
  scope: CredentialScope;
  /** The CI action inputs a request carrying it may send; null for every input. */
  allowedInputs: string[] | null;
  /** Whether a Custom CI server request may carry it. */
  customRequests: boolean;
  disabled: boolean;
  managedBy: 'db' | 'env';
  createdAt: string;
  rotatedAt: string;
  lastUsedAt: string | null;
  usedBy: CredentialReference[];
  /** Whether the caller may change it. */
  canManage: boolean;
}

/** A credential as a project's pickers list it: no scope, no log. */
export type CredentialOption = Omit<CredentialSummary, 'scope' | 'usedBy' | 'description' | 'createdAt'>;

/** One row of a credential's log. */
export interface CredentialUseEntry {
  id: number;
  credentialName: string;
  feature: CredentialFeature;
  projectId: number | null;
  projectName: string | null;
  /** Who started it: a user's name, else null for the instance itself. */
  actor: string | null;
  /** The API key it came through, by name, when it came through one. */
  apiKey: string | null;
  subjectType: string | null;
  subjectId: string | null;
  destination: string | null;
  result: CredentialUseResult;
  reason: string | null;
  /** How many uses the row counts: more than 1 only for a read. */
  count: number;
  createdAt: string;
  lastAt: string;
}

/** A credential as a create or an update writes it; the secret only when one is typed. */
export interface CredentialInput {
  name: string;
  description: string | null;
  service: CredentialService;
  user: string | null;
  secret: string;
  destination: string;
  scope: CredentialScope;
  allowedInputs: string[] | null;
  customRequests: boolean;
  disabled: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const LINE_BREAK = /[\r\n\0]/;

function scopeOf(raw: unknown): CredentialScope | string {
  if (!isRecord(raw)) return 'The scope must be { allProjects: true } or { allProjects: false, projectIds }.';
  if (raw.allProjects === true) return { allProjects: true };
  if (!Array.isArray(raw.projectIds)) return 'Name the projects that may use the credential, or share it with all.';
  const ids = [...new Set(raw.projectIds)];
  if (ids.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) {
    return 'A project id is a positive whole number.';
  }
  if (ids.length > MAX_CREDENTIAL_PROJECTS) return `A credential names at most ${MAX_CREDENTIAL_PROJECTS} projects.`;
  return { allProjects: false, projectIds: (ids as number[]).sort((a, b) => a - b) };
}

function allowedInputsOf(raw: unknown): string[] | null | string {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return 'The allowed inputs are a list of input names, or null for every input.';
  const names = [...new Set(raw.map(str))].filter(Boolean);
  if (names.length > MAX_CREDENTIAL_ALLOWED_INPUTS) {
    return `A credential lists at most ${MAX_CREDENTIAL_ALLOWED_INPUTS} allowed inputs.`;
  }
  const bad = names.find((name) => !CI_INPUT_NAME.test(name));
  if (bad !== undefined) return `"${bad}" is not an input name: letters, digits and "_", not starting with a digit.`;
  return names;
}

/** Why a destination cannot be saved, or null: an http(s) base URL, without a query, a user or a climbing path. */
export function credentialDestinationProblem(raw: unknown): string | null {
  if (normalizeCiServerBaseUrl(raw)) return null;
  return typeof raw === 'string' && urlPathClimbs(raw)
    ? 'The destination path cannot hold a segment that climbs once decoded, such as ..%2F.'
    : 'The destination must be an http(s) URL, without a user, a query or a fragment.';
}

/**
 * A posted credential, or why it cannot be saved. A create needs every field
 * but the description, the user, the allowed inputs and the two switches; an
 * update (`partial`) reads only the fields it holds. The destination is stored
 * normalized (`https://ci.example.com/`), and a secret holds no line break.
 */
export function parseCredentialInput(
  raw: unknown,
  opts: { partial: boolean },
): { value: Partial<CredentialInput>; error: null } | { value: null; error: string } {
  const fail = (error: string) => ({ value: null, error }) as const;
  if (!isRecord(raw)) return fail('The body must be an object.');
  const has = (key: string) => !opts.partial || raw[key] !== undefined;
  const value: Partial<CredentialInput> = {};

  if (has('name')) {
    const name = str(raw.name);
    if (!name) return fail('A credential needs a name.');
    if (name.length > MAX_CREDENTIAL_NAME_LENGTH)
      return fail(`A name is at most ${MAX_CREDENTIAL_NAME_LENGTH} characters.`);
    value.name = name;
  }
  if (raw.description !== undefined) {
    const description = str(raw.description);
    if (description.length > MAX_CREDENTIAL_DESCRIPTION_LENGTH) {
      return fail(`A description is at most ${MAX_CREDENTIAL_DESCRIPTION_LENGTH} characters.`);
    }
    value.description = description || null;
  }
  if (has('service')) {
    if (!(CREDENTIAL_SERVICES as readonly unknown[]).includes(raw.service)) {
      return fail(`The service is one of ${CREDENTIAL_SERVICES.join(', ')}.`);
    }
    value.service = raw.service as CredentialService;
  }
  if (raw.user !== undefined) {
    const user = str(raw.user);
    if (user.length > MAX_CREDENTIAL_USER_LENGTH)
      return fail(`A user name is at most ${MAX_CREDENTIAL_USER_LENGTH} characters.`);
    if (LINE_BREAK.test(user)) return fail('A user name holds no line break.');
    value.user = user || null;
  }
  if (has('secret')) {
    const secret = typeof raw.secret === 'string' ? raw.secret.trim() : '';
    if (!secret) return fail('A credential needs its secret.');
    if (secret.length > MAX_CREDENTIAL_SECRET_LENGTH)
      return fail(`A secret is at most ${MAX_CREDENTIAL_SECRET_LENGTH} characters.`);
    if (LINE_BREAK.test(secret)) return fail('A secret holds no line break.');
    value.secret = secret;
  }
  if (has('destination')) {
    const problem = credentialDestinationProblem(raw.destination);
    if (problem) return fail(problem);
    value.destination = normalizeCiServerBaseUrl(raw.destination)!;
  }
  if (has('scope')) {
    const scope = scopeOf(raw.scope);
    if (typeof scope === 'string') return fail(scope);
    value.scope = scope;
  }
  if (raw.allowedInputs !== undefined) {
    const inputs = allowedInputsOf(raw.allowedInputs);
    if (typeof inputs === 'string') return fail(inputs);
    value.allowedInputs = inputs;
  }
  for (const key of ['customRequests', 'disabled'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') return fail(`${key} is true or false.`);
    value[key] = raw[key];
  }
  return { value, error: null };
}

/** What the rules of a use read of a credential. */
export interface CredentialRules {
  name: string;
  destination: string;
  allProjects: boolean;
  projectIds: readonly number[];
  customRequests: boolean;
  disabled: boolean;
}

/** Whether a project may use a credential. */
export function credentialServesProject(rules: CredentialRules, projectId: number | null): boolean {
  return rules.allProjects || (projectId != null && rules.projectIds.includes(projectId));
}

/** A request URL as the log keeps it: its origin and path, never its query or a user. */
export function credentialLogDestination(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Why a use of a credential is refused, or null when it may go: the
 * credential is disabled, the project is not in its scope, the request's URL
 * is outside its destination, or the request is a Custom one it does not
 * allow. The checks run in this order, so the first that fails is named.
 */
export function credentialRefusal(
  rules: CredentialRules,
  use: { projectId: number | null; url: string; custom: boolean },
): string | null {
  if (rules.disabled) return `The credential "${rules.name}" is disabled.`;
  if (!credentialServesProject(rules, use.projectId)) {
    return `The credential "${rules.name}" is not shared with this project.`;
  }
  if (!isUnderBaseUrl(rules.destination, use.url)) {
    const where = credentialLogDestination(use.url) ?? 'another address';
    return `The credential "${rules.name}" is sent only under ${rules.destination}, and this request goes to ${where}.`;
  }
  if (use.custom && !rules.customRequests) {
    return `The credential "${rules.name}" does not go with a Custom request: allow it in its settings, or pick another.`;
  }
  return null;
}
