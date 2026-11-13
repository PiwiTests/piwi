/**
 * Sending a CI re-run or Flake Lab dispatch to a CI server: the base URL and
 * credential, the private-host rule, the request and the reading of its answer.
 *
 * Three rules keep a project's own base URL and templates safe:
 * - A credential is sent only to URLs under the base URL it was saved with: the
 *   instance token under `PIWI_CI_SERVER_URL`, a project token under the URL
 *   stored beside it. A template cannot leave its base URL (`renderCiRequest`),
 *   and no redirect is followed.
 * - The instance token goes only with a preset's request, whose shape the preset
 *   fixes (Jenkins: a job's `buildWithParameters`, and the read of the job's
 *   parameters Check sends). A Custom request carries the project's own token or
 *   none.
 * - A private address is reached only on a place the operator named (the host
 *   and port of `PIWI_CI_SERVER_URL`, and the entries of `PIWI_CI_SERVER_HOSTS`),
 *   or on the desktop app. Any other host must resolve to public addresses only, checked when the
 *   connection opens.
 */
import { eq } from 'drizzle-orm';
import type { Agent } from 'undici';
import { projects } from '../database/schema';
import { decryptSecret, encryptSecret, getEncryptionKey } from './crypto';
import { assertPublicHttpUrl, publicOnlyLookup } from './safe-fetch';
import { isDesktopRuntime } from './ai-claude-cli';
import {
  ciAuthHeaderProblem,
  CI_SERVER_HTTPS_PROBLEM,
  ciServerCheckFinding,
  ciServerCheckPlans,
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
import type { DbClient } from '../database';

/** How long a CI server has to answer a dispatch. */
const CI_SERVER_TIMEOUT_MS = 10_000;
/** The most of an answer read: enough for its link, build number or error message. */
const MAX_ANSWER_BYTES = 64 * 1024;
/** The most of a CI server's error message shown. */
const MAX_ERROR_MESSAGE = 200;

/** A credential and the base URL it may be sent under. */
export interface CiServerCredential {
  url: string;
  user: string | null;
  token: string;
}

/** The instance's CI server: `PIWI_CI_SERVER_URL`, and its credential when `PIWI_CI_SERVER_TOKEN` is set. */
export function instanceCiServer(): { url: string | null; credential: CiServerCredential | null } {
  const url = normalizeCiServerBaseUrl(process.env.PIWI_CI_SERVER_URL);
  const token = process.env.PIWI_CI_SERVER_TOKEN?.trim();
  const user = process.env.PIWI_CI_SERVER_USER?.trim() || null;
  return { url, credential: url && token ? { url, user, token } : null };
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
  const instance = instanceCiServer().url;
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

/** The base URL a target dispatches under: the project's, else the instance's. */
export function ciServerBaseUrl(target: CiServerTarget): string | null {
  return target.baseUrl ?? instanceCiServer().url;
}

/** Why a base URL cannot be dispatched to, or null: it must be https, or http on a host a private address may be reached on. */
export function ciServerBaseUrlProblem(baseUrl: string | null): string | null {
  const url = normalizeCiServerBaseUrl(baseUrl);
  if (!url) return 'No CI server is configured for this project.';
  if (url.startsWith('https:') || mayReachPrivateAddress(url)) return null;
  return CI_SERVER_HTTPS_PROBLEM;
}

/** A project's CI server token, sealed with the base URL it may be sent under. */
export function sealCiServerToken(url: string, token: string): string {
  return encryptSecret(JSON.stringify({ url, token }), getEncryptionKey());
}

/** The base URL and token a stored project token holds, or null when it is absent or unreadable. */
export function openCiServerToken(stored: string | null | undefined): { url: string; token: string } | null {
  if (!stored) return null;
  try {
    const value = JSON.parse(decryptSecret(stored, getEncryptionKey())) as { url?: unknown; token?: unknown };
    const url = normalizeCiServerBaseUrl(value.url);
    return url && typeof value.token === 'string' && value.token ? { url, token: value.token } : null;
  } catch {
    return null;
  }
}

/** The project's CI server token and the base URL it is bound to, or null. */
export async function projectCiServerToken(
  db: DbClient,
  projectId: number,
): Promise<{ url: string; token: string } | null> {
  const [row] = await db
    .select({ ciServerToken: projects.ciServerToken })
    .from(projects)
    .where(eq(projects.id, projectId));
  return openCiServerToken(row?.ciServerToken);
}

/** The first credential whose base URL holds the request's URL, or null. */
export function credentialFor(
  requestUrl: string,
  candidates: Array<CiServerCredential | null | undefined>,
): CiServerCredential | null {
  return candidates.find((c): c is CiServerCredential => !!c && isUnderBaseUrl(c.url, requestUrl)) ?? null;
}

function authHeader(auth: CiServerAuth, credential: CiServerCredential | null): [string, string] | null {
  if (!credential || auth === 'none') return null;
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

/** A request ready to send, with its credential, and the one it carries. */
export interface OutgoingCiRequest {
  /** `GET` only for the read Check sends; a dispatch is a `POST` or a `PUT`. */
  method: 'POST' | 'PUT' | 'GET';
  url: string;
  headers: Record<string, string>;
  body: string | null;
  /** Which credential the request carries. */
  credential: 'project' | 'instance' | null;
}

/**
 * Build a dispatch's request: the target's template filled with its values,
 * under the base URL, and the first credential bound to a URL that holds it.
 * Throws when the target has no request for `kind`, or the template cannot be
 * filled.
 */
export function prepareCiServerRequest(input: {
  target: CiServerTarget;
  kind: 'rerun' | 'flakeLab';
  baseUrl: string;
  values: CiTemplateValues;
  /** An action's inputs, sent beside the template's own fields. */
  inputs?: Record<string, string>;
  projectToken: { url: string; token: string } | null;
  instanceCredential: CiServerCredential | null;
}): OutgoingCiRequest {
  const spec = ciServerRequestTemplate(input.target, input.kind);
  if (!spec)
    throw new Error(
      input.kind === 'flakeLab' ? 'No Flake Lab request is configured' : 'No re-run request is configured',
    );
  const rendered = renderCiRequest(input.baseUrl, spec.template, input.values, Object.entries(input.inputs ?? {}));
  const { project, instance } = credentialCandidates(input.target, input.projectToken, input.instanceCredential);
  const credential = credentialFor(rendered.url, [project, instance]);
  const headers: Record<string, string> = {};
  const setHeader = (name: string, value: string) => {
    for (const key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
    headers[name] = value;
  };
  setHeader('Accept', 'application/json');
  if (rendered.body) setHeader('Content-Type', rendered.body.contentType);
  for (const [name, value] of rendered.headers) setHeader(name, value);
  const auth = authHeader(spec.auth, credential);
  if (auth) setHeader(auth[0], auth[1]);
  return {
    method: rendered.method,
    url: rendered.url,
    headers,
    body: rendered.body?.text ?? null,
    credential: !credential || !auth ? null : credential === project ? 'project' : 'instance',
  };
}

/** What a CI server answered. */
export interface CiServerAnswer {
  status: number;
  header: (name: string) => string | null;
  /** The answer's first {@link MAX_ANSWER_BYTES} bytes. */
  text: string;
}

let publicOnlyAgent: Agent | null = null;

async function readLimited(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_ANSWER_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, MAX_ANSWER_BYTES).toString('utf8');
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
  const text = await readLimited(res.body as unknown as ReadableStream<Uint8Array> | null);
  return { status: res.status, header: (name) => res.headers.get(name), text };
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

/**
 * Dispatch a re-run or a Flake Lab experiment to the project's CI server.
 * Throws with a message for the user on any failure.
 */
export async function dispatchToCiServer(
  db: DbClient,
  projectId: number,
  target: CiServerTarget,
  kind: 'rerun' | 'flakeLab',
  values: CiTemplateValues,
  inputs: Record<string, string> = {},
): Promise<CiServerDispatchResult> {
  const baseUrl = ciServerBaseUrl(target);
  const problem = ciServerBaseUrlProblem(baseUrl);
  if (problem || !baseUrl) throw new Error(problem ?? 'No CI server is configured for this project.');
  const request = prepareCiServerRequest({
    target,
    kind,
    baseUrl,
    values,
    inputs,
    projectToken: await projectCiServerToken(db, projectId),
    instanceCredential: instanceCiServer().credential,
  });
  const answer = await sendCiServerRequest(request);
  if (answer.status < 200 || answer.status >= 300) throw ciServerAnswerError(answer);
  const spec = ciServerRequestTemplate(target, kind)!;
  const fields = readCiServerAnswer(baseUrl, spec.template, values, {
    header: answer.header,
    json: parseJson(answer.text),
  });
  return { url: fields.link, buildNumber: fields.buildNumber };
}

/** A credential pair the project and the instance offer, the project's first. */
function credentialCandidates(
  target: CiServerTarget,
  projectToken: { url: string; token: string } | null,
  instanceCredential: CiServerCredential | null,
): { project: CiServerCredential | null; instance: CiServerCredential | null } {
  return {
    project: projectToken ? { url: projectToken.url, user: target.user ?? null, token: projectToken.token } : null,
    instance: target.preset === 'custom' ? null : instanceCredential,
  };
}

/**
 * The read Check sends for a job: a GET of `url`, with the credential a
 * dispatch under the same URL would carry, chosen on the request's URL as
 * `prepareCiServerRequest` chooses it.
 */
export function prepareCiServerCheck(input: {
  target: CiServerTarget;
  url: string;
  projectToken: { url: string; token: string } | null;
  instanceCredential: CiServerCredential | null;
}): OutgoingCiRequest {
  if (input.target.preset === 'custom') throw new Error('A Custom request cannot be checked');
  const { project, instance } = credentialCandidates(input.target, input.projectToken, input.instanceCredential);
  const credential = credentialFor(input.url, [project, instance]);
  const headers: Record<string, string> = { Accept: 'application/json' };
  const auth = authHeader(CI_SERVER_PRESET_REGISTRY[input.target.preset].auth, credential);
  if (auth) headers[auth[0]] = auth[1];
  return {
    method: 'GET',
    url: input.url,
    headers,
    body: null,
    credential: !credential || !auth ? null : credential === project ? 'project' : 'instance',
  };
}

/** What a non-2xx answer to Check means, for the user. */
function checkAnswerMessage(answer: CiServerAnswer, sentCredential: boolean): string {
  if (answer.status === 401) {
    return sentCredential
      ? 'The CI server refused the credential (401): check the user and the API token.'
      : 'The CI server asks for a credential (401): set the user and an API token.';
  }
  if (answer.status === 403) {
    return sentCredential
      ? 'The CI server answered 403: the user cannot read this job.'
      : 'The CI server answered 403 to a request without a credential: set the user and an API token for a URL that holds this job.';
  }
  if (answer.status === 404) {
    return sentCredential
      ? 'No job at this path, or the user cannot see it (404).'
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
  inputNames: string[] = [],
): Promise<CiServerCheckResult[]> {
  const baseUrl = ciServerBaseUrl(target);
  const problem = ciServerBaseUrlProblem(baseUrl);
  if (problem || !baseUrl) {
    return [
      { kind: 'rerun', ok: false, missing: [], message: problem ?? 'No CI server is configured for this project.' },
    ];
  }
  const projectToken = await projectCiServerToken(db, projectId);
  const instanceCredential = instanceCiServer().credential;
  const results: CiServerCheckResult[] = [];
  for (const plan of ciServerCheckPlans(target, baseUrl, inputNames)) {
    if ('error' in plan) {
      results.push({ kind: plan.kind, ok: false, missing: [], message: plan.error });
      continue;
    }
    try {
      const request = prepareCiServerCheck({ target, url: plan.url, projectToken, instanceCredential });
      const answer = await sendCiServerRequest(request);
      if (answer.status < 200 || answer.status >= 300) {
        results.push({
          kind: plan.kind,
          ok: false,
          missing: [],
          message: checkAnswerMessage(answer, !!request.credential),
        });
        continue;
      }
      results.push(ciServerCheckFinding(plan, parseJson(answer.text)));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      results.push({
        kind: plan.kind,
        ok: false,
        missing: [],
        message: `The CI server could not be reached: ${reason}.`,
      });
    }
  }
  return results;
}
