/**
 * The instance's side of Piwi: Connect, with no VS Code API so it is tested
 * against a stub: whether the instance asks for a key, its projects, and the
 * browser sign-in (an RFC 8628 device authorization, the one Piwi Picker
 * uses), which hands over an API key created for this editor.
 */

export class InstanceError extends Error {
  constructor(readonly status: number) {
    super(`the instance answered ${status}`);
    this.name = 'InstanceError';
  }
}

/** The error codes of a certificate Node.js does not trust. */
const CERTIFICATE_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Why Connect could not reach `url`, in the JetBrains plugin's words (`Glue.connectFailure`): a refused key, a 404 that
 * is not a Piwi instance, another status, a certificate the editor does not trust (naming its host and where to trust
 * it), no answer in time, nothing listening, an unknown host; else the error's own message.
 */
export function connectFailure(e: unknown, url: string | null): string {
  let host = 'the instance';
  try {
    if (url) host = new URL(url).hostname || host;
  } catch {
    // An address that is not a URL keeps the generic name.
  }
  if (e instanceof InstanceError) {
    if (e.status === 401 || e.status === 403) return `the instance refused the key (${e.status})`;
    if (e.status === 404) return "not a Piwi instance: nothing answers Piwi's requests at this address (404)";
    return `the instance answered ${e.status}`;
  }
  const chain: Array<{ name?: string; code?: string; message?: string }> = [];
  for (let c: unknown = e; c && typeof c === 'object' && chain.length < 10; c = (c as { cause?: unknown }).cause) {
    chain.push(c as { name?: string; code?: string; message?: string });
  }
  const has = (test: (c: { name?: string; code?: string; message?: string }) => boolean) => chain.some(test);
  if (has((c) => !!c.code && CERTIFICATE_CODES.has(c.code))) {
    return (
      `VS Code does not trust the certificate of ${host}. Add the authority that signed it, or your company's root ` +
      'certificate, to NODE_EXTRA_CA_CERTS in the environment VS Code starts with'
    );
  }
  if (has((c) => c.name === 'TimeoutError' || c.code === 'UND_ERR_CONNECT_TIMEOUT' || c.code === 'ETIMEDOUT')) {
    return 'no answer within 15 seconds';
  }
  if (has((c) => c.code === 'ECONNREFUSED')) return 'nothing answers there. Is the instance running, on that port?';
  if (has((c) => c.code === 'ENOTFOUND' || c.code === 'EAI_AGAIN')) return `unknown host ${host}`;
  return (e as Error)?.message ?? String(e);
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
    signal: AbortSignal.timeout(15_000),
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
