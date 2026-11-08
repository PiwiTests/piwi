/**
 * The service's requests to an instance. With a proxy named in its environment (`HTTPS_PROXY`, `HTTP_PROXY`, the
 * lower-case ones too, which the editor clients set from their proxy settings), an instance off this machine is
 * reached through it, `NO_PROXY` read as `curl` reads it (`EnvHttpProxyAgent`); this machine's addresses, where the
 * desktop app and a local instance listen, are reached directly. Without one, the global `fetch`.
 *
 * The desktop app's token goes out only after the server at its address proves it holds the token.
 */
import { proveDesktopServer, type DesktopProof } from '@piwitests/core/desktop-proof';
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

/** The desktop token the service read from the app's discovery file, by `origin\ntoken`, and what its server proved. */
const desktopTokens = new Map<string, Promise<DesktopProof> | null>();

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
  if (key && !desktopTokens.has(key)) desktopTokens.set(key, null);
}

/** Forget the desktop tokens held and their proofs. */
export function forgetDesktopTokens(): void {
  desktopTokens.clear();
}

/** The error of a request that would carry the desktop token to a server that did not prove it holds the token. */
export class DesktopNotProvenError extends Error {
  constructor(serverUrl: string, proof: DesktopProof) {
    super(
      proof === 'unreachable'
        ? `The desktop app at ${serverUrl} did not answer, so its token is not sent.`
        : `The desktop app's token is not sent to ${serverUrl}: the server there did not prove it holds the token. Restart the desktop app.`,
    );
    this.name = 'DesktopNotProvenError';
  }
}

/**
 * Resolves when the server at `serverUrl` proved it holds `token`, when `token` is the desktop app's; rejects with
 * {@link DesktopNotProvenError} when it did not. A proof is asked once, an unreachable server again on the next request.
 */
export async function requireDesktopProof(serverUrl: string, token: string): Promise<void> {
  const key = tokenKey(serverUrl, token);
  if (!key || !desktopTokens.has(key)) return;
  const origin = key.slice(0, key.indexOf('\n'));
  let proof = desktopTokens.get(key) ?? null;
  if (!proof) {
    proof = proveDesktopServer(origin, token);
    desktopTokens.set(key, proof);
  }
  const result = await proof;
  if (result === 'proven') return;
  if (result === 'unreachable') desktopTokens.set(key, null);
  throw new DesktopNotProvenError(origin, result);
}

/** The key a request carries in `X-API-Key` or as a bearer token; null with neither. */
function carriedKey(headers: RequestInit['headers'] | undefined): string | null {
  if (!headers) return null;
  const read = new Headers(headers);
  return read.get('x-api-key') ?? /^Bearer\s+(.+)$/i.exec(read.get('authorization') ?? '')?.[1] ?? null;
}

/**
 * `fetch` for an instance: through the environment's proxy when it names one and the instance is off this machine.
 * A request that carries the desktop app's token waits for the server's proof first.
 */
export async function instanceFetch(url: string, init: RequestInit = {}, env = process.env): Promise<Response> {
  const key = carriedKey(init.headers);
  if (key) await requireDesktopProof(url, key);
  const dispatcher = isLoopback(url) ? null : proxyAgent(env);
  if (!dispatcher) return fetch(url, init);
  return proxiedFetch(url, { ...init, dispatcher } as Parameters<
    typeof proxiedFetch
  >[1]) as unknown as Promise<Response>;
}
