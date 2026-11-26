/**
 * Requests to an address an administrator sets in Settings: a Jira site, an AI base URL. Such an address reaches a
 * private address (a loopback, private, link-local or reserved one) only where the operator allows it:
 * - the host and port of an address the environment sets (`PIWI_JIRA_BASE_URL`, `PIWI_AI_BASE_URL` and the AI roles'
 *   `PIWI_AI_*_BASE_URL`);
 * - a host or `host:port` of `PIWI_PRIVATE_HOSTS`;
 * - anywhere, on the desktop app.
 * Any other address must resolve to public addresses only, checked when each connection opens, and a redirect is
 * followed only for a GET or a HEAD, each hop checked again.
 */
import type { Agent, RequestInit as UndiciRequestInit } from 'undici';
import { isDesktopRuntime } from './ai-claude-cli';
import { hostPlace, hostPlaces, isBlockedAddress, placesAllow, publicOnlyLookup, type HostPlace } from './safe-fetch';
import { normalizeJiraSiteUrl } from '#shared/integrations/jira-setup';

/** The variables an operator sets an address in, whose host may be private. */
const OPERATOR_ADDRESS_VARIABLES = [
  'PIWI_AI_BASE_URL',
  'PIWI_AI_RESEARCH_BASE_URL',
  'PIWI_AI_EMBEDDING_BASE_URL',
  'PIWI_AI_ASSISTANT_BASE_URL',
] as const;

/** The most redirects a GET or a HEAD follows. */
const MAX_REDIRECTS = 3;

/** Why a request is refused, for the person who set the address. */
export class PrivateAddressError extends Error {
  constructor(host: string) {
    super(
      `${host} is a private address, which an address set in Settings may not reach. The operator allows it by listing the host in PIWI_PRIVATE_HOSTS.`,
    );
    this.name = 'PrivateAddressError';
  }
}

/** The places an address set in Settings may reach on a private address. */
export function connectionPrivatePlaces(): HostPlace[] {
  const places: HostPlace[] = [];
  const addresses = [
    normalizeJiraSiteUrl(process.env.PIWI_JIRA_BASE_URL ?? '')?.url,
    ...OPERATOR_ADDRESS_VARIABLES.map((name) => process.env[name]?.trim()),
  ];
  for (const address of addresses) {
    if (!address) continue;
    try {
      places.push(hostPlace(new URL(address)));
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
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) addresses are allowed');
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
 * `fetch` for an address set in Settings. An address the operator allows is fetched as is; any other one connects
 * only to public addresses, with no redirect followed but a GET's or a HEAD's, each hop checked again.
 */
export async function connectionFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const address = String(input);
  if (connectionMayReachPrivateAddress(address)) return fetch(address, init);

  const undici = await import('undici');
  publicOnlyAgent ??= new undici.Agent({ connect: { lookup: publicOnlyLookup } });
  const method = (init.method ?? 'GET').toUpperCase();
  const follows = init.redirect !== 'manual' && init.redirect !== 'error' && (method === 'GET' || method === 'HEAD');
  let current = new URL(address);
  for (let hop = 0; ; hop++) {
    refuseNamedPrivateHost(current);
    let response: Response;
    try {
      response = (await undici.fetch(current, {
        ...(init as UndiciRequestInit),
        redirect: 'manual',
        dispatcher: publicOnlyAgent,
      })) as unknown as Response;
    } catch (error) {
      // The lookup of the connection refused an address the name resolves to.
      if ((error as { cause?: { code?: string } }).cause?.code === 'EADDRNOTAVAIL') {
        throw new PrivateAddressError(current.host);
      }
      throw error;
    }
    const location = response.headers.get('location');
    if (!follows || response.status < 300 || response.status >= 400 || !location) return response;
    if (hop >= MAX_REDIRECTS) throw new Error(`${address} redirected more than ${MAX_REDIRECTS} times`);
    await response.body?.cancel();
    current = new URL(location, current);
  }
}
