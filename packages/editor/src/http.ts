/**
 * The service's requests to an instance. With a proxy named in its environment (`HTTPS_PROXY`, `HTTP_PROXY`, the
 * lower-case ones too, which the editor clients set from their proxy settings), an instance off this machine is
 * reached through it, `NO_PROXY` read as `curl` reads it (`EnvHttpProxyAgent`); this machine's addresses, where the
 * desktop app and a local instance listen, are reached directly. Without one, the global `fetch`.
 */
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

/** `fetch` for an instance: through the environment's proxy when it names one and the instance is off this machine. */
export function instanceFetch(url: string, init: RequestInit = {}, env = process.env): Promise<Response> {
  const dispatcher = isLoopback(url) ? null : proxyAgent(env);
  if (!dispatcher) return fetch(url, init);
  return proxiedFetch(url, { ...init, dispatcher } as Parameters<
    typeof proxiedFetch
  >[1]) as unknown as Promise<Response>;
}
