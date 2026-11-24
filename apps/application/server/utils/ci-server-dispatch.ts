/**
 * Sending a CI re-run or Flake Lab dispatch to a CI server: the base URL and
 * credential, the private-host rule, the request and the reading of its answer.
 *
 * Three rules keep a project's own base URL and templates safe:
 * - A request carries the credential its action names (`credentials`), opened
 *   by `withCredential` for that request alone, which refuses a URL outside
 *   the credential's destination, a project it is not shared with, and a
 *   Custom request it does not allow, and records the use. An action that names
 *   none carries the instance's (`PIWI_CI_SERVER_TOKEN`), with a preset's
 *   request under `PIWI_CI_SERVER_URL` only. A template cannot leave its base
 *   URL (`renderCiRequest`), and no redirect is followed.
 * - A request sends only the action inputs its credential allows
 *   (`allowedInputs`; for the instance's, `PIWI_CI_SERVER_ALLOWED_INPUTS`): a
 *   project admin chooses an input, so one the credential's manager did not
 *   list never rides on it.
 * - A private address is reached only on a place the operator named (the host
 *   and port of `PIWI_CI_SERVER_URL`, and the entries of `PIWI_CI_SERVER_HOSTS`),
 *   or on the desktop app. Any other host must resolve to public addresses only, checked when the
 *   connection opens.
 */
import type { Agent } from 'undici';
import { assertPublicHttpUrl, publicOnlyLookup } from './safe-fetch';
import { isDesktopRuntime } from './ai-claude-cli';
import {
  CredentialRefusedError,
  instanceCredential,
  maskCredentialAnswer,
  withCredential,
  type CredentialActor,
} from './credentials';
import {
  ciAuthHeaderProblem,
  CI_SERVER_HTTPS_PROBLEM,
  ciServerCheckFinding,
  ciServerCheckPlans,
  ciServerListPlan,
  ciServerRequestTemplate,
  CI_SERVER_PRESET_REGISTRY,
  isUnderBaseUrl,
  normalizeCiServerBaseUrl,
  readCiServerAnswer,
  renderCiRequest,
  type CiServerAuth,
  type CiServerCheckResult,
  type CiServerTarget,
  type CiTemplateValues,
} from '#shared/ci-server';
import { loadCredentialRecord, type CredentialRecord } from '#shared/handlers/credentials';
import { MAX_CI_JOBS, type CiJobFieldListing, type CiJobListing } from '#shared/ci-job-fields';
import type { DbClient } from '../database';

/** How long a CI server has to answer a dispatch. */
const CI_SERVER_TIMEOUT_MS = 10_000;
/** The most of an answer read: enough for its link, build number or error message. */
const MAX_ANSWER_BYTES = 64 * 1024;
/** The most of a listing's answer read: a CI server's jobs and folders, or a job's parameters. */
const MAX_LISTING_ANSWER_BYTES = 2 * 1024 * 1024;
/** The most of a CI server's error message shown. */
const MAX_ERROR_MESSAGE = 200;

/** The credential a CI server request may carry: the one its action names, or the instance's. */
export interface CiServerCredential {
  /** `credentials.id`. */
  id: number;
  name: string;
  /** The base URL it may be sent under. */
  url: string;
  user: string | null;
  /** The secret, once `withCredential` opened it for this request; absent while the request is planned. */
  token?: string;
  /** The action inputs a request carrying it may send; null for every input. */
  allowedInputs: string[] | null;
  /** `action` for the credential the action names, `instance` for the one the environment sets. */
  source: 'action' | 'instance';
}

/** The instance's CI server URL, `PIWI_CI_SERVER_URL`, or null when it sets none. */
export function instanceCiServerUrl(): string | null {
  return normalizeCiServerBaseUrl(process.env.PIWI_CI_SERVER_URL);
}

/** A URL's host name, lowercased and without IPv6 brackets, and its port (the scheme's default when absent). */
function hostAndPort(url: URL): { host: string; port: string } {
  return {
    host: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
    port: url.port || (url.protocol === 'https:' ? '443' : '80'),
  };
}

/**
 * The places a CI server dispatch may reach on a private address: the host and
 * port of `PIWI_CI_SERVER_URL`, and each `PIWI_CI_SERVER_HOSTS` entry, a host
 * name (any port) or `host:port` (that port only, `:80` included).
 */
export function ciServerHosts(): Array<{ host: string; port: string | null }> {
  const places: Array<{ host: string; port: string | null }> = [];
  const instance = instanceCiServerUrl();
  if (instance) places.push(hostAndPort(new URL(instance)));
  for (const entry of (process.env.PIWI_CI_SERVER_HOSTS ?? '').split(',')) {
    const name = entry.trim();
    // A host or `host:port` alone: an entry with a path, query, fragment, user or empty port allows nothing.
    if (!name || /[/?#\\@\s]/.test(name) || name.endsWith(':')) continue;
    try {
      // `URL` drops a port equal to the scheme's default, so `host:80` reads its port from the entry.
      const place = hostAndPort(new URL(`http://${name}`));
      places.push({ host: place.host, port: /:\d+$/.test(name) ? place.port : null });
    } catch {
      // An entry that is not a host name allows nothing.
    }
  }
  return places;
}

/** Whether a dispatch to this URL may reach a private address: a listed place, or the desktop app. */
export function mayReachPrivateAddress(url: string): boolean {
  if (isDesktopRuntime()) return true;
  let target: { host: string; port: string };
  try {
    target = hostAndPort(new URL(url));
  } catch {
    return false;
  }
  return ciServerHosts().some((place) => place.host === target.host && (place.port ?? target.port) === target.port);
}

function toCiServerCredential(record: CredentialRecord, source: CiServerCredential['source']): CiServerCredential {
  return {
    id: record.id,
    name: record.name,
    url: record.destination,
    user: record.user,
    allowedInputs: record.allowedInputs,
    source,
  };
}

/**
 * The credential a target's requests may carry, without its secret: the one
 * its action names, else the instance's when the environment sets one. Throws
 * when the action names a credential that does not exist.
 */
export async function ciServerCredential(db: DbClient, target: CiServerTarget): Promise<CiServerCredential | null> {
  if (target.credentialId != null) {
    const record = await loadCredentialRecord(db, target.credentialId);
    if (!record) throw new Error('The credential this CI action names does not exist: pick another one.');
    return toCiServerCredential(record, 'action');
  }
  const instance = await instanceCredential(db, 'ci-server');
  return instance ? toCiServerCredential(instance, 'instance') : null;
}

/** The base URL a target dispatches under: its own, else its credential's destination, else the instance's. */
export function ciServerBaseUrl(target: CiServerTarget, credential: CiServerCredential | null): string | null {
  return target.baseUrl ?? (credential?.source === 'action' ? credential.url : null) ?? instanceCiServerUrl();
}

/** Why a base URL cannot be dispatched to, or null: it must be https, or http on a host a private address may be reached on. */
export function ciServerBaseUrlProblem(baseUrl: string | null): string | null {
  const url = normalizeCiServerBaseUrl(baseUrl);
  if (!url) return 'No CI server is configured for this project.';
  if (url.startsWith('https:') || mayReachPrivateAddress(url)) return null;
  return CI_SERVER_HTTPS_PROBLEM;
}

function authHeader(auth: CiServerAuth, credential: CiServerCredential): [string, string] | null {
  if (auth === 'none' || credential.token === undefined) return null;
  if (/[\r\n\0]/.test(credential.token) || /[\r\n\0]/.test(credential.user ?? '')) {
    throw new Error('The CI server credential holds a line break');
  }
  if (auth === 'basic') {
    const pair = `${credential.user ?? ''}:${credential.token}`;
    return ['Authorization', `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`];
  }
  if (auth === 'bearer') return ['Authorization', `Bearer ${credential.token}`];
  const problem = ciAuthHeaderProblem(auth);
  if (problem) throw new Error(problem);
  return [auth.header, credential.token];
}

/** A request ready to send, and the credential it carries. */
export interface OutgoingCiRequest {
  /** `GET` only for the read Check sends; a dispatch is a `POST` or a `PUT`. */
  method: 'POST' | 'PUT' | 'GET';
  url: string;
  headers: Record<string, string>;
  body: string | null;
  /** The credential the request carries, whose secret `withCredential` adds; null for none. */
  credential: CiServerCredential | null;
  /** Whether the request is a Custom one, which its credential must allow. */
  custom: boolean;
  /** The action inputs left off because the credential it carries does not allow them. */
  droppedInputs: string[];
  /** The most of the answer read; absent, {@link MAX_ANSWER_BYTES}. */
  maxAnswerBytes?: number;
}

/**
 * Whether a request carries the credential: never when its auth is none; the
 * action's own always (`withCredential` then refuses a URL outside its
 * destination); the instance's only with a preset's request under its URL.
 */
function carries(
  credential: CiServerCredential | null,
  auth: CiServerAuth,
  custom: boolean,
  url: string,
): credential is CiServerCredential {
  if (!credential || auth === 'none') return false;
  if (credential.source === 'action') return true;
  return !custom && isUnderBaseUrl(credential.url, url);
}

/**
 * Build a dispatch's request: the target's template filled with its values,
 * under the base URL, the inputs its credential allows, and the credential's
 * auth header once its secret is given (`credential.token`). Throws when the
 * target has no request for `kind`, or the template cannot be filled.
 */
export function prepareCiServerRequest(input: {
  target: CiServerTarget;
  kind: 'rerun' | 'flakeLab';
  baseUrl: string;
  values: CiTemplateValues;
  /** An action's inputs, sent beside the template's own fields. */
  inputs?: Record<string, string>;
  credential: CiServerCredential | null;
}): OutgoingCiRequest {
  const spec = ciServerRequestTemplate(input.target, input.kind);
  if (!spec)
    throw new Error(
      input.kind === 'flakeLab' ? 'No Flake Lab request is configured' : 'No re-run request is configured',
    );
  const custom = input.target.preset === 'custom';
  const inputs = Object.entries(input.inputs ?? {});
  let rendered = renderCiRequest(input.baseUrl, spec.template, input.values, inputs);
  const credential = carries(input.credential, spec.auth, custom, rendered.url) ? input.credential : null;
  let droppedInputs: string[] = [];
  const allowed = credential?.allowedInputs ? new Set(credential.allowedInputs) : null;
  if (allowed && inputs.some(([name]) => !allowed.has(name))) {
    droppedInputs = inputs.filter(([name]) => !allowed.has(name)).map(([name]) => name);
    rendered = renderCiRequest(
      input.baseUrl,
      spec.template,
      input.values,
      inputs.filter(([name]) => allowed.has(name)),
    );
  }
  const headers: Record<string, string> = {};
  const setHeader = (name: string, value: string) => {
    for (const key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
    headers[name] = value;
  };
  setHeader('Accept', 'application/json');
  if (rendered.body) setHeader('Content-Type', rendered.body.contentType);
  for (const [name, value] of rendered.headers) setHeader(name, value);
  const auth = credential ? authHeader(spec.auth, credential) : null;
  if (auth) setHeader(auth[0], auth[1]);
  return {
    method: rendered.method,
    url: rendered.url,
    headers,
    body: rendered.body?.text ?? null,
    credential,
    custom,
    droppedInputs,
  };
}

/** What a CI server answered. */
export interface CiServerAnswer {
  status: number;
  header: (name: string) => string | null;
  /** The answer's first bytes, up to the request's limit. */
  text: string;
  /** Whether the answer was longer than the request's limit. */
  truncated: boolean;
}

let publicOnlyAgent: Agent | null = null;

async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: '', truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  while (size <= limit) {
    const chunk = await reader.read();
    if (chunk.done) {
      done = true;
      break;
    }
    chunks.push(chunk.value);
    size += chunk.value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return { text: Buffer.concat(chunks).subarray(0, limit).toString('utf8'), truncated: !done && size > limit };
}

/**
 * Send a request, without following a redirect. A URL whose host may not reach
 * a private address must resolve to public addresses only, checked before the
 * request and again when the connection opens.
 */
export async function sendCiServerRequest(request: OutgoingCiRequest): Promise<CiServerAnswer> {
  const undici = await import('undici');
  let dispatcher: Agent | undefined;
  if (!mayReachPrivateAddress(request.url)) {
    await assertPublicHttpUrl(request.url);
    publicOnlyAgent ??= new undici.Agent({ connect: { lookup: publicOnlyLookup } });
    dispatcher = publicOnlyAgent;
  }
  const res = await undici.fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body ?? undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(CI_SERVER_TIMEOUT_MS),
    ...(dispatcher ? { dispatcher } : {}),
  });
  const { text, truncated } = await readLimited(
    res.body as unknown as ReadableStream<Uint8Array> | null,
    request.maxAnswerBytes ?? MAX_ANSWER_BYTES,
  );
  return { status: res.status, header: (name) => res.headers.get(name), text, truncated };
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The error a non-2xx answer becomes: its status and, for a JSON answer, its `message`, cut short. */
export function ciServerAnswerError(answer: CiServerAnswer): Error {
  if (answer.status >= 300 && answer.status < 400) {
    return new Error(
      `The CI server answered ${answer.status}, a redirect, which is not followed: use the server's API URL and an API token`,
    );
  }
  const json = parseJson(answer.text) as { message?: unknown } | null;
  const message = typeof json?.message === 'string' ? json.message.trim().slice(0, MAX_ERROR_MESSAGE) : '';
  return new Error(`The CI server answered ${answer.status}${message ? `: ${message}` : ''}`);
}

/** What a CI server dispatch returns: the link to watch and the build number it answered. */
export interface CiServerDispatchResult {
  url: string;
  buildNumber: string | null;
}

/** Who started a dispatch or a Check, and what it is about, as the credential log records it. */
export interface CiServerUse {
  actor: CredentialActor;
  /** The CI action, by id. */
  actionId?: string;
}

/**
 * Send a prepared request: through `withCredential` when it carries a
 * credential, which opens the secret for it, refuses a use the credential does
 * not allow and records the use, else as it is. The answer comes back with the
 * secret masked in its text, and a status outside 2xx is a failed use.
 */
async function sendWithCredential(
  db: DbClient,
  request: OutgoingCiRequest,
  rebuild: (credential: CiServerCredential) => OutgoingCiRequest,
  use: { projectId: number; feature: 'ci-dispatch' | 'ci-check' | 'ci-list' } & CiServerUse,
): Promise<CiServerAnswer> {
  const credential = request.credential;
  if (!credential) return sendCiServerRequest(request);
  return withCredential(
    db,
    {
      credentialId: credential.id,
      feature: use.feature,
      projectId: use.projectId,
      url: request.url,
      custom: request.custom,
      actor: use.actor,
      ...(use.actionId ? { subject: { type: 'ci-action', id: use.actionId } } : {}),
    },
    async (opened) => {
      const answer = await sendCiServerRequest(rebuild({ ...credential, user: opened.user, token: opened.secret }));
      // A CI server may repeat the credential in its answer (an error message): nothing past here reads it.
      return { ...answer, text: maskCredentialAnswer(answer.text, opened) };
    },
    (answer) => (answer.status >= 200 && answer.status < 300 ? null : `The CI server answered ${answer.status}`),
  );
}

/**
 * Dispatch a re-run or a Flake Lab experiment to the project's CI server.
 * Throws with a message for the user on any failure, a refused credential
 * included.
 */
export async function dispatchToCiServer(
  db: DbClient,
  projectId: number,
  target: CiServerTarget,
  kind: 'rerun' | 'flakeLab',
  values: CiTemplateValues,
  inputs: Record<string, string>,
  use: CiServerUse,
): Promise<CiServerDispatchResult> {
  const credential = await ciServerCredential(db, target);
  const baseUrl = ciServerBaseUrl(target, credential);
  const problem = ciServerBaseUrlProblem(baseUrl);
  if (problem || !baseUrl) throw new Error(problem ?? 'No CI server is configured for this project.');
  const prepare = (withSecret: CiServerCredential | null) =>
    prepareCiServerRequest({ target, kind, baseUrl, values, inputs, credential: withSecret });
  const answer = await sendWithCredential(db, prepare(credential), prepare, {
    projectId,
    feature: 'ci-dispatch',
    ...use,
  });
  if (answer.status < 200 || answer.status >= 300) throw ciServerAnswerError(answer);
  const spec = ciServerRequestTemplate(target, kind)!;
  const fields = readCiServerAnswer(baseUrl, spec.template, values, {
    header: answer.header,
    json: parseJson(answer.text),
  });
  return { url: fields.link, buildNumber: fields.buildNumber };
}

/**
 * The read Check sends for a job: a GET of `url`, with the credential a
 * dispatch under the same URL would carry and its auth header once its secret
 * is given.
 */
export function prepareCiServerCheck(input: {
  target: CiServerTarget;
  url: string;
  credential: CiServerCredential | null;
}): OutgoingCiRequest {
  if (input.target.preset === 'custom') throw new Error('A Custom request cannot be checked');
  const auth = CI_SERVER_PRESET_REGISTRY[input.target.preset].auth;
  const credential = carries(input.credential, auth, false, input.url) ? input.credential : null;
  const headers: Record<string, string> = { Accept: 'application/json' };
  const header = credential ? authHeader(auth, credential) : null;
  if (header) headers[header[0]] = header[1];
  return { method: 'GET', url: input.url, headers, body: null, credential, custom: false, droppedInputs: [] };
}

/** What a non-2xx answer to Check means, for the user. */
function checkAnswerMessage(answer: CiServerAnswer, sentCredential: boolean): string {
  if (answer.status === 401) {
    return sentCredential
      ? 'The CI server refused the credential (401): check its user and secret.'
      : 'The CI server asks for a credential (401): pick one for this action.';
  }
  if (answer.status === 403) {
    return sentCredential
      ? 'The CI server answered 403: the credential’s user cannot read this job.'
      : 'The CI server answered 403 to a request without a credential: pick one whose destination holds this job.';
  }
  if (answer.status === 404) {
    return sentCredential
      ? 'No job at this path, or the credential’s user cannot see it (404).'
      : 'No job at this path, or the CI server hides it from a request without a credential (404).';
  }
  return `${ciServerAnswerError(answer).message}.`;
}

/**
 * Check a target before its first dispatch: read each of its jobs (the
 * re-run's, and Flake Lab's when set) and say whether it declares the
 * parameters a dispatch sends, since Jenkins drops one a job does not declare.
 * Nothing is started, and only what was found is returned, never the answer.
 */
export async function checkCiServerTarget(
  db: DbClient,
  projectId: number,
  target: CiServerTarget,
  inputNames: string[],
  use: CiServerUse,
): Promise<CiServerCheckResult[]> {
  let credential: CiServerCredential | null;
  try {
    credential = await ciServerCredential(db, target);
  } catch (e) {
    return [{ kind: 'rerun', ok: false, missing: [], message: e instanceof Error ? e.message : String(e) }];
  }
  const baseUrl = ciServerBaseUrl(target, credential);
  const problem = ciServerBaseUrlProblem(baseUrl);
  if (problem || !baseUrl) {
    return [
      { kind: 'rerun', ok: false, missing: [], message: problem ?? 'No CI server is configured for this project.' },
    ];
  }
  const results: CiServerCheckResult[] = [];
  for (const plan of ciServerCheckPlans(target, baseUrl, inputNames)) {
    if ('error' in plan) {
      results.push({ kind: plan.kind, ok: false, missing: [], message: plan.error });
      continue;
    }
    try {
      const prepare = (withSecret: CiServerCredential | null) =>
        prepareCiServerCheck({ target, url: plan.url, credential: withSecret });
      const request = prepare(credential);
      // A request sends only the inputs its credential allows, so the job need declare only those.
      const allowed = request.credential?.allowedInputs ? new Set(request.credential.allowedInputs) : null;
      const notSent = allowed ? inputNames.filter((name) => !allowed.has(name)) : [];
      const answer = await sendWithCredential(db, request, prepare, { projectId, feature: 'ci-check', ...use });
      if (answer.status < 200 || answer.status >= 300) {
        results.push({
          kind: plan.kind,
          ok: false,
          missing: [],
          message: checkAnswerMessage(answer, !!request.credential),
        });
        continue;
      }
      const finding = ciServerCheckFinding(
        notSent.length > 0 ? { ...plan, required: plan.required.filter((name) => !notSent.includes(name)) } : plan,
        parseJson(answer.text),
      );
      results.push(
        notSent.length === 0
          ? finding
          : {
              ...finding,
              ok: false,
              message:
                `${finding.message} Not sent: ${notSent.join(', ')}, because the credential "${request.credential!.name}" ` +
                'does not allow these inputs.',
            },
      );
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      results.push({
        kind: plan.kind,
        ok: false,
        missing: [],
        message: e instanceof CredentialRefusedError ? reason : `The CI server could not be reached: ${reason}.`,
      });
    }
  }
  return results;
}

/** The base URL and credential a target's requests use, or why it has none, for the user. */
async function ciServerReadContext(
  db: DbClient,
  target: CiServerTarget,
): Promise<{ credential: CiServerCredential | null; baseUrl: string } | { message: string }> {
  let credential: CiServerCredential | null;
  try {
    credential = await ciServerCredential(db, target);
  } catch (e) {
    return { message: e instanceof Error ? e.message : String(e) };
  }
  const baseUrl = ciServerBaseUrl(target, credential);
  const problem = ciServerBaseUrlProblem(baseUrl);
  if (problem || !baseUrl) return { message: problem ?? 'No CI server is configured for this project.' };
  return { credential, baseUrl };
}

/** What a non-2xx answer to a listing read means, for the user; `notFound` for a 404. */
function listingAnswerMessage(answer: CiServerAnswer, sentCredential: boolean, notFound: string): string {
  if (answer.status === 404) return notFound;
  if (answer.status === 401) {
    return sentCredential
      ? 'The CI server refused the credential (401): check its user and secret.'
      : 'The CI server asks for a credential (401): pick one for this action.';
  }
  if (answer.status === 403) {
    return sentCredential
      ? 'The CI server answered 403: the credential’s user cannot read it.'
      : 'The CI server answered 403 to a request without a credential: pick a credential.';
  }
  return `${ciServerAnswerError(answer).message}.`;
}

/**
 * Read `url` under a target's base URL with the credential a dispatch under it
 * would carry, logged as a listing use: the answer's JSON, or why it could not
 * be read, for the user. Nothing is started.
 */
async function readForListing(
  db: DbClient,
  projectId: number,
  target: CiServerTarget,
  credential: CiServerCredential | null,
  url: string,
  use: CiServerUse,
  notFound: string,
): Promise<{ json: unknown } | { message: string }> {
  try {
    const prepare = (withSecret: CiServerCredential | null): OutgoingCiRequest => ({
      ...prepareCiServerCheck({ target, url, credential: withSecret }),
      maxAnswerBytes: MAX_LISTING_ANSWER_BYTES,
    });
    const request = prepare(credential);
    const answer = await sendWithCredential(db, request, prepare, { projectId, feature: 'ci-list', ...use });
    if (answer.status < 200 || answer.status >= 300) {
      return { message: listingAnswerMessage(answer, !!request.credential, notFound) };
    }
    if (answer.truncated) {
      return {
        message: `The CI server's answer is larger than ${MAX_LISTING_ANSWER_BYTES / 1024 / 1024} MB: type the job instead.`,
      };
    }
    const json = parseJson(answer.text);
    return json === null ? { message: 'The CI server did not answer JSON.' } : { json };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { message: e instanceof CredentialRefusedError ? reason : `The CI server could not be reached: ${reason}.` };
  }
}

/**
 * The jobs under a CI server target's base URL, for the action editor: read
 * with the credential a dispatch would carry, and logged. Nothing is started.
 */
export async function listCiServerJobs(
  db: DbClient,
  projectId: number,
  target: CiServerTarget,
  use: CiServerUse,
): Promise<CiJobListing> {
  const none = (message: string): CiJobListing => ({ jobs: null, truncated: false, message });
  const context = await ciServerReadContext(db, target);
  if ('message' in context) return none(context.message);
  const plan = ciServerListPlan(target, context.baseUrl);
  if ('error' in plan) return none(plan.error);
  const read = await readForListing(
    db,
    projectId,
    target,
    context.credential,
    plan.url,
    use,
    'Nothing at the base URL lists jobs (404): use the CI server’s root, such as https://ci.example.com/.',
  );
  if ('message' in read) return none(read.message);
  const found = plan.jobs(read.json);
  if (!found) return none('The answer lists no jobs: is the base URL the CI server’s root?');
  return {
    jobs: found.jobs,
    truncated: found.truncated,
    message: found.truncated
      ? `Folders more than three levels deep, and jobs past the first ${MAX_CI_JOBS}, are not listed: type the job’s path.`
      : null,
  };
}

/**
 * The parameters a CI server target's job declares, for the action editor: the
 * job Check reads (a multibranch job on its default branch), with the same
 * credential, logged as a listing. Nothing is started.
 */
export async function readCiServerJobFields(
  db: DbClient,
  projectId: number,
  target: CiServerTarget,
  use: CiServerUse,
): Promise<CiJobFieldListing> {
  const context = await ciServerReadContext(db, target);
  if ('message' in context) return { fields: null, message: context.message };
  const [plan] = ciServerCheckPlans(target, context.baseUrl);
  if (!plan) return { fields: null, message: 'This target names no job to read.' };
  if ('error' in plan) return { fields: null, message: plan.error };
  const read = await readForListing(
    db,
    projectId,
    target,
    context.credential,
    plan.url,
    use,
    'No job at this path, or the credential’s user cannot see it (404).',
  );
  if ('message' in read) return { fields: null, message: read.message };
  const fields = plan.fields(read.json);
  if (!fields) {
    return {
      fields: null,
      message: 'The answer does not describe a job: is the path a folder, or a multibranch pipeline without /{branch}?',
    };
  }
  return {
    fields,
    message:
      fields.length === 0
        ? 'The job declares no parameters. A Pipeline job declares those of its Jenkinsfile on its first build: run it once.'
        : null,
  };
}
