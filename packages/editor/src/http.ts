/**
 * The service's requests to an instance. With a proxy named in its environment (`HTTPS_PROXY`, `HTTP_PROXY`, the
 * lower-case ones too, which the editor clients set from their proxy settings), an instance off this machine is
 * reached through it, `NO_PROXY` read as `curl` reads it (`EnvHttpProxyAgent`); this machine's addresses, where the
 * desktop app and a local instance listen, are reached directly. Without one, the global `fetch`.
 *
 * The desktop app's token goes out only after the server at its address proves it holds the token.
 */
import { proveDesktopServer, shareInFlight, type DesktopProof } from '@piwitests/core/desktop-proof';
import { EnvHttpProxyAgent, fetch as proxiedFetch, type Dispatcher } from 'undici';

/** Whether an environment names a proxy for http or https. */
export function hasProxy(env: Record<string, string | undefined>): boolean {
  return ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((name) => !!env[name]?.trim());
}

/** Whether a URL's host is this machine: `localhost`, a `127.` address, `::1`. */
export function isLoopback(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'localhost' || host.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(host) || host === '[::1]';
}

/** The agent of the proxy an environment names, made on the first request through it, by the variables it read. */
let agent: { key: string; dispatcher: Dispatcher } | null = null;

function proxyAgent(env: Record<string, string | undefined>): Dispatcher | null {
  if (!hasProxy(env)) return null;
  const read = (name: string) => env[name]?.trim() || env[name.toLowerCase()]?.trim() || undefined;
  const options = { httpProxy: read('HTTP_PROXY'), httpsProxy: read('HTTPS_PROXY'), noProxy: read('NO_PROXY') ?? '' };
  const key = JSON.stringify(options);
  if (agent?.key !== key) agent = { key, dispatcher: new EnvHttpProxyAgent(options) };
  return agent.dispatcher;
}

/** The desktop tokens the service read from the app's discovery file, by `origin\ntoken`. */
const desktopTokens = new Set<string>();

const tokenKey = (serverUrl: string, token: string): string | null => {
  try {
    return `${new URL(serverUrl).origin}\n${token}`;
  } catch {
    return null;
  }
};

/** Mark `token` as the desktop app's at `serverUrl`: a request that carries it waits for the server's proof. */
export function holdDesktopToken(serverUrl: string, token: string): void {
  const key = tokenKey(serverUrl, token);
  if (key) desktopTokens.add(key);
}

/** Forget the desktop tokens held. */
export function forgetDesktopTokens(): void {
  desktopTokens.clear();
}

/** The error of a request that would carry the desktop token to a server that did not prove it holds the token. */
export class DesktopNotProvenError extends Error {
  /** What the proof came to: the server did not answer (`unreachable`), or answered without the proof (`unproven`). */
  readonly proof: Exclude<DesktopProof, 'proven'>;

  constructor(serverUrl: string, proof: Exclude<DesktopProof, 'proven'>) {
    super(
      proof === 'unreachable'
        ? `The desktop app at ${serverUrl} did not answer, so its token is not sent.`
        : `The desktop app's token is not sent to ${serverUrl}: the server there did not prove it holds the token. Restart or update the desktop app.`,
    );
    this.name = 'DesktopNotProvenError';
    this.proof = proof;
  }
}

const proofsInFlight = shareInFlight<DesktopProof>();

/**
 * Resolves `true` when the server at `serverUrl` proved it holds `token`, when `token` is the desktop app's, and `false`
 * for any other token; rejects with {@link DesktopNotProvenError} when it did not. Each request that carries the token asks for its own proof; requests
 * that arrive while a proof is being asked share it, and a proof that has arrived is never used for a later request.
 */
export async function requireDesktopProof(serverUrl: string, token: string): Promise<boolean> {
  const key = tokenKey(serverUrl, token);
  if (!key || !desktopTokens.has(key)) return false;
  const origin = key.slice(0, key.indexOf('\n'));
  const result = await proofsInFlight(key, () => proveDesktopServer(origin, token));
  if (result !== 'proven') throw new DesktopNotProvenError(origin, result);
  return true;
}

/** The keys a request carries, in `X-API-Key` and as a bearer token. */
function carriedKeys(headers: RequestInit['headers'] | undefined): string[] {
  if (!headers) return [];
  const read = new Headers(headers);
  const keys = [read.get('x-api-key'), /^Bearer\s+(.+)$/i.exec(read.get('authorization') ?? '')?.[1]];
  return [...new Set(keys.filter((key): key is string => !!key))];
}

/**
 * `fetch` for an instance: through the environment's proxy when it names one and the instance is off this machine.
 * A request that carries the desktop app's token waits for the server's proof first, and follows no redirect.
 */
export async function instanceFetch(url: string, init: RequestInit = {}, env = process.env): Promise<Response> {
  let carriesDesktopToken = false;
  for (const key of carriedKeys(init.headers)) {
    if (await requireDesktopProof(url, key)) carriesDesktopToken = true;
  }
  return send(url, carriesDesktopToken ? { ...init, redirect: 'error' } : init, env);
}

function send(url: string, init: RequestInit, env: Record<string, string | undefined>): Promise<Response> {
  const dispatcher = isLoopback(url) ? null : proxyAgent(env);
  if (!dispatcher) return fetch(url, init);
  return proxiedFetch(url, { ...init, dispatcher } as Parameters<
    typeof proxiedFetch
  >[1]) as unknown as Promise<Response>;
}
