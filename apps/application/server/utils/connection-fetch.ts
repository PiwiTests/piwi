/**
 * Requests to an address an administrator sets in Settings: a Jira site, an AI base URL. Such an address reaches a
 * private address (a loopback, private, link-local or reserved one) only where the operator allows it:
 * - the host and port of an address the environment sets (`PIWI_JIRA_BASE_URL`, the AI roles' base URLs of the
 *   runtime config, `ANTHROPIC_BASE_URL`);
 * - a host or `host:port` of `PIWI_PRIVATE_HOSTS`;
 * - anywhere, on the desktop app.
 * Any other address must resolve to public addresses only, checked when each connection opens. Redirects are followed
 * as `fetch` follows them, each hop checked on its own: a hop to another site loses the request's credentials, and a
 * hop from https to http is refused.
 */
import type { Agent, RequestInit as UndiciRequestInit } from 'undici';
import { isDesktopRuntime } from './ai-claude-cli';
import { hostPlace, hostPlaces, isBlockedAddress, placesAllow, publicOnlyLookup, type HostPlace } from './safe-fetch';
import { normalizeJiraSiteUrl } from '#shared/integrations/jira-setup';

/** The keys of the runtime config's `ai` block that hold an AI role's base URL from the environment. */
const AI_BASE_URL_KEYS = ['baseUrl', 'researchBaseUrl', 'embeddingBaseUrl', 'assistantBaseUrl'] as const;

/** The most redirects a request follows. */
const MAX_REDIRECTS = 3;

/** The headers that carry a credential, which a redirect to another site does not take along. */
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'x-api-key'];

/** The headers that describe a request's body, dropped when a redirect turns the request into a GET. */
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location'];

/** Why a request is refused, for the person who set the address. */
export class PrivateAddressError extends Error {
  constructor(host: string) {
    super(
      `${host} is a private address, which an address set in Settings may not reach. The operator allows it by listing the host in PIWI_PRIVATE_HOSTS.`,
    );
    this.name = 'PrivateAddressError';
  }
}

/** The refusal behind an error, however deep a client library wrapped it, or null. */
export function privateAddressRefusal(error: unknown): PrivateAddressError | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof PrivateAddressError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** The addresses the environment sets for a Jira site or an AI role. */
function environmentAddresses(): Array<string | undefined> {
  const ai = (useRuntimeConfig().ai ?? {}) as Partial<Record<(typeof AI_BASE_URL_KEYS)[number], unknown>>;
  return [
    normalizeJiraSiteUrl(process.env.PIWI_JIRA_BASE_URL ?? '')?.url,
    ...AI_BASE_URL_KEYS.map((key) => (typeof ai[key] === 'string' ? ai[key].trim() : undefined)),
    process.env.ANTHROPIC_BASE_URL?.trim(),
  ];
}

/** The places an address set in Settings may reach on a private address. */
export function connectionPrivatePlaces(): HostPlace[] {
  const places: HostPlace[] = [];
  for (const address of environmentAddresses()) {
    if (!address) continue;
    try {
      const url = new URL(address);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) places.push(hostPlace(url));
    } catch {
      // not a URL: it allows nothing
    }
  }
  return [...places, ...hostPlaces(process.env.PIWI_PRIVATE_HOSTS)];
}

/** Whether a request to this address may reach a private address: a place the operator allows, or the desktop app. */
export function connectionMayReachPrivateAddress(url: string): boolean {
  return isDesktopRuntime() || placesAllow(connectionPrivatePlaces(), url);
}

/**
 * Refuse an address whose name alone says it is private: `localhost` and the names under `.localhost`, `.local` and
 * `.internal`, and an IP address in a private range. A connection opens to an IP address without a lookup, so this is
 * its only check; a name is checked again by the lookup of each connection.
 */
function refuseNamedPrivateHost(url: URL): void {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const named =
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal');
  const literal = /^[\d.]+$/.test(host) || host.includes(':');
  if (named || (literal && isBlockedAddress(host))) throw new PrivateAddressError(url.host);
}

let publicOnlyAgent: Agent | null = null;

/**
 * Send one request to one address, following no redirect: as is to a place the operator allows, else through a
 * connection that reaches public addresses only.
 */
async function sendOnce(url: URL, init: RequestInit): Promise<Response> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) addresses are allowed');
  if (connectionMayReachPrivateAddress(url.href)) return fetch(url, { ...init, redirect: 'manual' });
  refuseNamedPrivateHost(url);
  const undici = await import('undici');
  publicOnlyAgent ??= new undici.Agent({ connect: { lookup: publicOnlyLookup } });
  try {
    return (await undici.fetch(url, {
      ...(init as UndiciRequestInit),
      redirect: 'manual',
      dispatcher: publicOnlyAgent,
    })) as unknown as Response;
  } catch (error) {
    // The lookup of the connection refused an address the name resolves to.
    if ((error as { cause?: { code?: string } }).cause?.code === 'EADDRNOTAVAIL') {
      throw new PrivateAddressError(url.host);
    }
    throw error;
  }
}

/**
 * A form's body as bytes and its `content-type`: the connection that reaches public addresses only comes from the
 * `undici` package, which sends no `FormData` but its own.
 */
async function encodeForm(init: RequestInit): Promise<RequestInit> {
  if (!(init.body instanceof FormData)) return init;
  const encoded = new Response(init.body);
  const headers = new Headers(init.headers);
  headers.set('content-type', encoded.headers.get('content-type') ?? 'multipart/form-data');
  return { ...init, headers, body: new Uint8Array(await encoded.arrayBuffer()) };
}

/**
 * `fetch` for an address set in Settings: each hop goes to a place the operator allows as is, and anywhere else only
 * to a public address. A redirect is followed as `fetch` follows it (a 303, or a 301 or 302 after a POST, as a GET),
 * except a 307 or 308 whose body cannot be sent again, which is answered as is.
 */
export async function connectionFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const address = String(input);
  let current = new URL(address);
  let request = await encodeForm(init);
  for (let hop = 0; ; hop++) {
    const response = await sendOnce(current, request);
    const location = response.headers.get('location');
    const redirected = [301, 302, 303, 307, 308].includes(response.status) && location;
    if (!redirected || init.redirect === 'manual' || init.redirect === 'error') return response;
    const method = (request.method ?? 'GET').toUpperCase();
    const asGet = response.status === 303 ? method !== 'HEAD' : response.status <= 302 && method === 'POST';
    if (!asGet && request.body instanceof ReadableStream) return response;
    if (hop >= MAX_REDIRECTS) throw new Error(`${address} redirected more than ${MAX_REDIRECTS} times`);

    const next = new URL(location, current);
    if (current.protocol === 'https:' && next.protocol === 'http:') {
      throw new Error(`${address} redirected from https to http, which is not followed`);
    }
    const headers = new Headers(request.headers);
    if (next.origin !== current.origin) for (const name of CREDENTIAL_HEADERS) headers.delete(name);
    if (asGet) for (const name of BODY_HEADERS) headers.delete(name);
    request = asGet ? { ...request, method: 'GET', body: undefined, headers } : { ...request, headers };
    await response.body?.cancel();
    current = next;
  }
}
