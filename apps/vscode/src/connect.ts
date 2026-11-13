/**
 * The instance's side of Piwi: Connect, with no VS Code API so it is tested
 * against a stub: whether the instance asks for a key, its projects, and the
 * browser sign-in (an RFC 8628 device authorization, the one Piwi Picker
 * uses), which hands over an API key created for this editor.
 */

import { connectFailureWords } from '@piwitests/editor/connect-failures';

export class InstanceError extends Error {
  constructor(readonly status: number) {
    super(`the instance answered ${status}`);
    this.name = 'InstanceError';
  }
}

/** The error codes of a certificate signed by an authority Node.js does not trust. */
const UNTRUSTED_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
  'INVALID_CA',
]);

/** A link of an error's chain, as Node.js and undici give them. */
type ErrorLink = { name?: string; code?: string; message?: string };

/** How long Connect waits for an instance, in seconds. */
const CONNECT_TIMEOUT_S = 15;

/**
 * Why Connect could not reach `url`, in the words of the editor service's table (`connectFailureWords`), which the
 * JetBrains plugin says too: a refused key, an address that is not a Piwi instance (a 404, or a page where Piwi's API
 * should answer), another status, a certificate the editor does not trust, one expired or for another name, no answer
 * in time, nothing listening, a name not found; else the deepest cause's own message. `editor` names the editor in the
 * advice (`vscode.env.appName`).
 */
export function connectFailure(e: unknown, url: string | null, editor = 'VS Code'): string {
  let host = 'the instance';
  try {
    if (url) host = new URL(url).hostname || host;
  } catch {
    // An address that is not a URL keeps the generic name.
  }
  if (e instanceof InstanceError) {
    if (e.status === 401 || e.status === 403) return connectFailureWords('refused-key', { status: e.status });
    if (e.status === 404) return connectFailureWords('not-piwi');
    return connectFailureWords('status', { status: e.status });
  }
  if (e instanceof SyntaxError) return connectFailureWords('not-piwi-page');
  const chain: ErrorLink[] = [];
  for (let c: unknown = e; c && typeof c === 'object' && chain.length < 10; c = (c as { cause?: unknown }).cause) {
    chain.push(c as ErrorLink);
  }
  const code = (test: (code: string) => boolean) => chain.some((c) => !!c.code && test(c.code));
  if (code((c) => UNTRUSTED_CODES.has(c))) {
    return connectFailureWords('untrusted', {
      client: editor,
      host,
      trust:
        "Add the authority that signed it, or your company's root certificate, to NODE_EXTRA_CA_CERTS in the " +
        'environment the editor runs extensions in',
    });
  }
  if (code((c) => c === 'CERT_HAS_EXPIRED')) return connectFailureWords('expired', { host });
  if (code((c) => c === 'CERT_NOT_YET_VALID')) return connectFailureWords('not-yet-valid', { host });
  if (code((c) => c === 'ERR_TLS_CERT_ALTNAME_INVALID')) return connectFailureWords('other-name', { host });
  if (code((c) => c === 'ERR_SSL_WRONG_VERSION_NUMBER')) return connectFailureWords('not-https', { host });
  if (
    chain.some((c) => c.name === 'TimeoutError') ||
    code((c) => c === 'UND_ERR_CONNECT_TIMEOUT' || c === 'ETIMEDOUT')
  ) {
    return connectFailureWords('timeout', { seconds: CONNECT_TIMEOUT_S });
  }
  if (code((c) => c === 'ECONNREFUSED')) return connectFailureWords('nothing-listening');
  if (code((c) => c === 'ENOTFOUND')) return connectFailureWords('unknown-host', { host });
  if (code((c) => c === 'EAI_AGAIN')) return connectFailureWords('lookup-failed', { host });
  const deepest = chain[chain.length - 1];
  return deepest?.message || deepest?.code || (e as Error)?.message || String(e);
}

export interface ProjectItem {
  id: number;
  name: string;
}

export interface SignIn {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  /** Seconds between polls. */
  interval: number;
  /** Seconds until the request expires. */
  expiresIn: number;
}

export type SignInResult = { status: 'approved'; apiKey: string } | { status: 'denied' } | { status: 'expired' };

/** An instance URL as it is stored: trimmed, without trailing slashes; null when it is not an http(s) URL. */
export function normalizeServerUrl(input: string | null | undefined): string | null {
  const url = (input ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+\S*$/.test(url) ? url : null;
}

/**
 * The secret-storage entry of an instance's API key. The key is kept per instance: the
 * workspace settings, which a repository may commit, never select another instance's key.
 */
export function apiKeySecret(serverUrl: string): string {
  return `${API_KEY_SECRET_PREFIX}${normalizeServerUrl(serverUrl) ?? serverUrl.trim()}`;
}

export const API_KEY_SECRET_PREFIX = 'piwi.apiKey ';

async function send<T>(base: string, path: string, init: { apiKey?: string | null; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: {
      ...(init.apiKey ? { 'X-API-Key': init.apiKey } : {}),
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_S * 1000),
  });
  if (!response.ok) throw new InstanceError(response.status);
  return (await response.json()) as T;
}

export async function listProjects(base: string, apiKey: string | null): Promise<ProjectItem[]> {
  return (await send<{ items?: ProjectItem[] }>(base, '/api/projects/menu', { apiKey })).items ?? [];
}

/** Whether the instance asks for a key: it lists its projects to anyone when authentication is off. */
export async function needsKey(base: string): Promise<boolean> {
  try {
    await listProjects(base, null);
    return false;
  } catch (e) {
    if (e instanceof InstanceError && (e.status === 401 || e.status === 403)) return true;
    throw e;
  }
}

/** Start a sign-in; `editor` and `os` name the key the instance creates ("Piwi in Visual Studio Code on macOS"). */
export async function startSignIn(base: string, client: { editor: string; os: string }): Promise<SignIn> {
  const started = await send<SignIn>(base, '/api/extension/connect', { body: client });
  if (!normalizeServerUrl(started.verificationUrl)) throw new Error('the instance answered no sign-in page');
  return started;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Poll until the user allows or denies the request in the browser, it expires, or `signal` aborts. */
export async function waitForSignIn(
  base: string,
  started: SignIn,
  signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = sleep,
): Promise<SignInResult> {
  let interval = Math.min(Math.max(started.interval, 1), 60);
  const deadline = Date.now() + started.expiresIn * 1000;
  while (Date.now() < deadline) {
    await wait(interval * 1000, signal);
    const polled = await send<{ status: string; interval?: number; apiKey?: string }>(
      base,
      '/api/extension/connect/token',
      { body: { deviceCode: started.deviceCode } },
    );
    if (polled.status === 'slow_down') interval = Math.min(Math.max(polled.interval ?? interval + 5, 1), 60);
    else if (polled.status === 'approved') return { status: 'approved', apiKey: polled.apiKey ?? '' };
    else if (polled.status === 'denied') return { status: 'denied' };
    else if (polled.status !== 'pending') return { status: 'expired' };
  }
  return { status: 'expired' };
}
