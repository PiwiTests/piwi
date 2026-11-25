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
import { SCM_API_DESTINATIONS, scmDestinationHost } from '#shared/scm-urls';

/** What a credential is for: the pickers that list it and the requests that may carry it. */
export const CREDENTIAL_SERVICES = ['ci-server', 'scm', 'ai', 'jira', 'zephyr-scale', 'slack'] as const;
export type CredentialService = (typeof CREDENTIAL_SERVICES)[number];

export const CREDENTIAL_SERVICE_LABELS: Record<CredentialService, string> = {
  'ci-server': 'CI server',
  scm: 'Source control',
  ai: 'AI provider',
  jira: 'Jira Cloud',
  'zephyr-scale': 'Zephyr Scale',
  slack: 'Slack',
};

/** The destination of a Slack credential: the Web API a channel's bot token is sent to. */
export const SLACK_API_ENDPOINT = 'https://slack.com/api/';
/** The method a Slack channel posts with, which a Slack credential's destination must hold. */
export const SLACK_POST_MESSAGE_URL = `${SLACK_API_ENDPOINT}chat.postMessage`;

/** The feature a use comes from. */
export const CREDENTIAL_FEATURES = [
  'ci-dispatch',
  'ci-check',
  'ci-list',
  'scm-read',
  'scm-comment',
  'scm-status',
  'scm-pull-request',
  'ai-call',
  'integration-read',
  'integration-write',
  'notification',
  'credential-test',
] as const;
export type CredentialFeature = (typeof CREDENTIAL_FEATURES)[number];

export const CREDENTIAL_FEATURE_LABELS: Record<CredentialFeature, string> = {
  'ci-dispatch': 'CI dispatch',
  'ci-check': 'CI check',
  'ci-list': 'CI listing',
  'scm-read': 'Repository read',
  'scm-comment': 'Pull request comment',
  'scm-status': 'Commit status',
  'scm-pull-request': 'Branch, commit or pull request',
  'ai-call': 'AI model call',
  'integration-read': 'Integration read',
  'integration-write': 'Integration write',
  notification: 'Notification',
  'credential-test': 'Token test',
};

/**
 * The features whose uses only read: counted in one log row per credential,
 * feature, project, result and hour. Every other use is a row of its own.
 */
export const CREDENTIAL_READ_FEATURES: readonly CredentialFeature[] = [
  'ci-check',
  'ci-list',
  'scm-read',
  'ai-call',
  'integration-read',
  'credential-test',
];

/** The features of an SCM provider's writes, each logged as a row of its own. */
export type ScmWriteFeature = 'scm-comment' | 'scm-status' | 'scm-pull-request' | 'ci-dispatch';

/** How a use ended: `sent` until the request answers, then `ok` or `failed`; `refused` when it was never sent. */
export const CREDENTIAL_USE_RESULTS = ['sent', 'ok', 'failed', 'refused'] as const;
export type CredentialUseResult = (typeof CREDENTIAL_USE_RESULTS)[number];

export const MAX_CREDENTIAL_NAME_LENGTH = 80;
export const MAX_CREDENTIAL_DESCRIPTION_LENGTH = 500;
export const MAX_CREDENTIAL_USER_LENGTH = 200;
export const MAX_CREDENTIAL_SECRET_LENGTH = 8192;
export const MAX_CREDENTIAL_ALLOWED_INPUTS = 50;
export const MAX_CREDENTIAL_PROJECTS = 500;
export const MAX_TOKEN_HELP_URL_LENGTH = 500;

/**
 * The prefix of the variables a credential may read its secret from. The
 * operator names a variable so to offer it: no other variable of the server's
 * environment (`PIWI_SECRET_KEY`, a database URL) can be sent anywhere.
 */
export const CREDENTIAL_SECRET_ENV_PREFIX = 'PIWI_CREDENTIAL_';
const SECRET_ENV_NAME = new RegExp(`^${CREDENTIAL_SECRET_ENV_PREFIX}[A-Z0-9_]{1,100}$`);

/** Whether a credential may read its secret from a variable of this name. */
export function isCredentialSecretEnv(name: string): boolean {
  return SECRET_ENV_NAME.test(name);
}

/** Which projects may use a credential. */
export type CredentialScope = { allProjects: true } | { allProjects: false; projectIds: number[] };

/**
 * What names a credential: a CI action, a project's source control, the
 * instance's source control (Settings → Source control), an AI role
 * (Settings → AI), a Jira or Zephyr Scale connection (Settings →
 * Integrations), or a Slack channel of the instance (Settings → Notifications).
 */
export interface CredentialReference {
  kind: 'ci-action' | 'project-scm' | 'instance-scm' | 'ai-role' | 'connection' | 'channel';
  /** The project; null for the instance's source control. */
  projectId: number | null;
  projectName: string | null;
  /** The CI action's id, for a `ci-action`. */
  actionId: string | null;
  /** What names it: the CI action's name, `Source control`, the AI role's (`AI · Diagnosis`), the connection's or the channel's. */
  name: string;
}

/**
 * The saved credentials a form serving every project may name (an AI role, a
 * connection, a Slack channel of the instance): of the service, saved in the
 * database, shared with all projects and sent under the form's endpoint.
 */
export function credentialsServingEveryProject<
  T extends { service: CredentialService; managedBy: string; scope: CredentialScope; destination: string },
>(credentials: readonly T[], service: CredentialService, endpoint: string | null): T[] {
  if (endpoint === null) return [];
  return credentials.filter(
    (c) =>
      c.service === service && c.managedBy === 'db' && c.scope.allProjects && isUnderBaseUrl(c.destination, endpoint),
  );
}

/** A reference as a sentence names it: the CI action or `Source control`, then its project or the instance. */
export function credentialReferenceText(reference: CredentialReference): string {
  return `"${reference.name}" (${reference.projectName ?? 'the instance'})`;
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
  /** The `PIWI_CREDENTIAL_*` variable the secret is read from at each use; null for a saved secret. */
  secretEnv: string | null;
  /** Whether that variable is set on the server; null when there is none, or nobody can tell (the demo). */
  secretEnvSet: boolean | null;
  /** Whether each person gives their own token for it (a per-user credential), which a use then carries. */
  perUser: boolean;
  /** Where a person creates their token, for a per-user credential. */
  tokenHelpUrl: string | null;
  /** How many people gave a token for a per-user credential, to a caller who manages it; else null. */
  userTokens: number | null;
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
  /** Who started it: a user's name, else null for the instance itself; for a counted read, the last of its hour. */
  actor: string | null;
  /** The API key it came through, by name, when it came through one. */
  apiKey: string | null;
  /** The person's own account on the service, for a use of a per-user credential. */
  remoteUser: string | null;
  subjectType: string | null;
  subjectId: string | null;
  /** The CI action's name, while its project still has it; for another subject, how the log names it. */
  subjectName: string | null;
  destination: string | null;
  result: CredentialUseResult;
  reason: string | null;
  /** How many uses the row counts: more than 1 only for a read. */
  count: number;
  createdAt: string;
  lastAt: string;
}

/** A credential as a create or an update writes it: the secret when one is typed, or the variable it is read from. */
export interface CredentialInput {
  name: string;
  description: string | null;
  service: CredentialService;
  user: string | null;
  secret?: string;
  secretEnv?: string;
  destination: string;
  scope: CredentialScope;
  allowedInputs: string[] | null;
  customRequests: boolean;
  disabled: boolean;
  /** A per-user credential, set at creation: no user and no secret, each person gives their own token. */
  perUser?: boolean;
  tokenHelpUrl?: string | null;
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
 * Why an SCM credential's fields cannot be saved, or null: its destination is
 * a repository host's API ({@link scmDestinationHost}), and it names no user,
 * since its token is sent as a bearer token.
 */
export function scmCredentialProblem(
  fields: { destination: string; user: string | null },
  gitlabHosts: ReadonlySet<string> = new Set(),
): string | null {
  if (fields.user) return 'An SCM credential names no user: its token is sent as a bearer token.';
  if (scmDestinationHost(fields.destination, gitlabHosts)) return null;
  const { github, bitbucket, gitlab } = SCM_API_DESTINATIONS;
  return `An SCM credential is sent to ${github}, ${bitbucket}, ${gitlab} or a GitLab host of PIWI_SCM_GITLAB_HOSTS, over https, or to a path under its repositories.`;
}

/** The API every Anthropic role calls unless it names a base URL of its own. */
export const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/';

/**
 * The endpoint an AI role's key is sent to, which its credential's destination
 * must hold: the role's base URL, else Anthropic's API for an Anthropic role.
 * Null for a local CLI, which takes no key.
 */
export function aiEndpoint(provider: string | null | undefined, baseUrl: string | null | undefined): string | null {
  if (provider === 'anthropic') return normalizeCiServerBaseUrl(baseUrl) ?? ANTHROPIC_ENDPOINT;
  if (provider === 'openai') return normalizeCiServerBaseUrl(baseUrl);
  return null;
}

/**
 * Why the fields of a credential cannot be saved for its service, or null: an
 * SCM credential follows {@link scmCredentialProblem}; an AI key names no user,
 * since it is sent alone. A CI server credential takes any of them.
 */
export function credentialServiceProblem(
  service: CredentialService,
  fields: { destination: string; user: string | null },
  gitlabHosts: ReadonlySet<string> = new Set(),
): string | null {
  if (service === 'scm') return scmCredentialProblem(fields, gitlabHosts);
  if (service === 'ai' && fields.user) return 'An AI credential names no user: its key is sent alone.';
  if (service === 'zephyr-scale' && fields.user)
    return 'A Zephyr Scale credential names no user: its token is sent alone.';
  if (service === 'jira' && !fields.user) return 'A Jira credential names the account’s e-mail as its user.';
  if (service === 'slack' && fields.user) return 'A Slack credential names no user: its bot token is sent alone.';
  return null;
}

/**
 * A posted credential, or why it cannot be saved. A create needs every field
 * but the description, the user, the allowed inputs and the two switches, and
 * either a secret or the `PIWI_CREDENTIAL_*` variable it is read from
 * (`secretEnv`), not both; an update (`partial`) reads only the fields it
 * holds. A per-user credential (`perUser`, given at creation only) is a CI
 * server credential that holds neither a user nor a secret and never goes with
 * a Custom request. The destination is stored normalized
 * (`https://ci.example.com/`), and a secret holds no line break.
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
  if (raw.perUser !== undefined && typeof raw.perUser !== 'boolean') return fail('perUser is true or false.');
  if (raw.perUser === true) {
    if (opts.partial) return fail('A credential is shared or per user from its creation: create another one.');
    if (raw.service !== 'ci-server') return fail('Only a CI server credential is per user.');
    if (str(raw.user) || str(raw.secret) || str(raw.secretEnv)) {
      return fail('A per-user credential holds no user and no secret: each person gives their own token.');
    }
    if (raw.customRequests === true) return fail('A per-user credential never goes with a Custom request.');
    value.perUser = true;
  }
  if (raw.tokenHelpUrl !== undefined) {
    const help = str(raw.tokenHelpUrl);
    if (help && (!/^https?:\/\//i.test(help) || help.length > MAX_TOKEN_HELP_URL_LENGTH || LINE_BREAK.test(help))) {
      return fail(`The token help link is an http(s) URL of at most ${MAX_TOKEN_HELP_URL_LENGTH} characters.`);
    }
    value.tokenHelpUrl = help || null;
  }
  const secretEnv = str(raw.secretEnv);
  if (secretEnv && typeof raw.secret === 'string' && raw.secret.trim()) {
    return fail('Give the secret or the variable it is read from, not both.');
  }
  if (secretEnv) {
    if (!isCredentialSecretEnv(secretEnv)) {
      return fail(
        `A secret is read only from a variable named ${CREDENTIAL_SECRET_ENV_PREFIX}…, in capitals, digits and "_".`,
      );
    }
    value.secretEnv = secretEnv;
  } else if (has('secret') && !value.perUser) {
    const secret = typeof raw.secret === 'string' ? raw.secret.trim() : '';
    if (!secret) return fail('A credential needs its secret, or the variable it is read from.');
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

/** The state of a person's token for a per-user credential: only a `ready` one is sent. */
export const USER_TOKEN_STATES = ['ready', 'invalid'] as const;
export type UserTokenState = (typeof USER_TOKEN_STATES)[number];

/** A person's token as an offered CI action reports it: `missing` when they gave none; null for a shared credential. */
export type UserTokenStatus = UserTokenState | 'missing';

/**
 * Why a use of a per-user credential is refused for who asked: a request
 * through an API key (`session-required`), an instance without sign-in
 * (`sign-in-required`), or a person with no `ready` token (`user-token-required`).
 */
export type UserTokenRefusalCode = 'session-required' | 'sign-in-required' | 'user-token-required';

/** A person's own token for a per-user credential, as its owner and the credential's managers see it. Never the secret. */
export interface UserTokenView {
  userId: number;
  /** The person's name in Piwi. */
  userName: string;
  /** Their account on the service, as the test named it. */
  remoteUser: string;
  state: UserTokenState;
  createdAt: string;
  testedAt: string;
  lastUsedAt: string | null;
}

/** A per-user credential as its Account page lists it for one person, with their token. */
export interface MyCredentialEntry {
  id: number;
  name: string;
  service: CredentialService;
  destination: string;
  tokenHelpUrl: string | null;
  disabled: boolean;
  /** Who created it, by name, so a person knows whom they give their token to. */
  createdByName: string | null;
  /** Whether a project where the person holds `run:control` may use it; false for a token they still hold. */
  usable: boolean;
  token: Omit<UserTokenView, 'userId' | 'userName'> | null;
}

/** What a token test answers: the account it names, or why it failed, never the service's own text. */
export type UserTokenTestResult =
  | { ok: true; remoteUser: string }
  | { ok: false; reason: 'refused' | 'unreachable' | 'anonymous' };

/** How many tests one person may run on one credential in {@link USER_TOKEN_TEST_WINDOW_MS}. */
export const USER_TOKEN_TEST_LIMIT = 10;
export const USER_TOKEN_TEST_WINDOW_MS = 10 * 60 * 1000;

/**
 * A Jenkins API token: 32 hexadecimal characters, or 34 for one made since
 * Jenkins 2.129 (`11` and 32). A per-user credential takes nothing else, so an
 * account password, which Jenkins also takes in a Basic header, is never stored.
 */
const JENKINS_API_TOKEN = /^(?:[0-9a-f]{32}|11[0-9a-f]{32})$/i;

/** Why a posted user token cannot be tested, or null: a user name, and a token of an API token's form. */
export function userTokenInputProblem(user: string, secret: string): string | null {
  if (!user) return 'Give your user name on the CI server.';
  if (user.length > MAX_CREDENTIAL_USER_LENGTH)
    return `A user name is at most ${MAX_CREDENTIAL_USER_LENGTH} characters.`;
  if (LINE_BREAK.test(user)) return 'A user name holds no line break.';
  if (!JENKINS_API_TOKEN.test(secret)) {
    return 'Give an API token, not a password: create one on your user page of the CI server (32 or 34 hexadecimal characters).';
  }
  return null;
}

/**
 * The root of the Jenkins a destination is under: the destination cut before
 * its first `job/` segment, so a credential narrowed to a folder
 * (`https://ci.example.com/job/tests/`) is tested at the server's root.
 */
export function jenkinsRoot(destination: string): string {
  const url = new URL(destination);
  const at = url.pathname.split('/').indexOf('job');
  if (at > 0) url.pathname = `${url.pathname.split('/').slice(0, at).join('/')}/`;
  return url.toString();
}

/** The one URL a per-user CI server credential's token is tested at: Jenkins' `whoAmI` under its root. */
export function userTokenTestUrl(destination: string): string {
  return `${jenkinsRoot(destination)}whoAmI/api/json`;
}

/** The account a Jenkins `whoAmI` answer names, or why it does not name one. */
export function readWhoAmI(json: unknown): UserTokenTestResult {
  const who = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const name = typeof who.name === 'string' ? who.name.trim() : '';
  if (who.anonymous === true || who.authenticated !== true || !name || name === 'anonymous') {
    return { ok: false, reason: 'anonymous' };
  }
  return { ok: true, remoteUser: name.slice(0, MAX_CREDENTIAL_USER_LENGTH) };
}

/** What a failed token test tells the person. */
export const USER_TOKEN_TEST_REASONS: Record<Exclude<UserTokenTestResult, { ok: true }>['reason'], string> = {
  refused: 'The CI server refused this user name and token.',
  unreachable: 'The CI server could not be reached.',
  anonymous: 'The CI server did not recognize this token as a signed-in user.',
};

/** Why a use of a per-user credential is refused for who asked, or null when it may go: a person in a session. */
export function userTokenActorRefusal(
  name: string,
  actor: { userId: number | null; apiKeyId: number | null },
): { code: UserTokenRefusalCode; message: string } | null {
  if (actor.apiKeyId != null) {
    return {
      code: 'session-required',
      message: `The credential "${name}" acts in the name of whoever starts it: start it from Piwi's page, not with an API key.`,
    };
  }
  if (!actor.userId) {
    return {
      code: 'sign-in-required',
      message: `The credential "${name}" acts in the name of whoever starts it, which needs sign-in.`,
    };
  }
  return null;
}

/** What a person is told when they have no usable token for a per-user credential. */
export function userTokenMissingMessage(name: string, state: 'missing' | 'invalid'): string {
  return state === 'invalid'
    ? `Your token for "${name}" was refused: give it again in your account's Credentials.`
    : `"${name}" runs in your name: give your token for it first.`;
}
