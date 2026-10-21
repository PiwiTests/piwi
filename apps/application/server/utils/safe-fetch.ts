import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import type { Agent, RequestInit as UndiciRequestInit } from 'undici';

/**
 * SSRF guards for outbound requests to user-supplied URLs (webhooks, link
 * unfurling). A hostname is resolved and every address it points at is checked,
 * so a public name that resolves to a private/loopback/link-local address (a
 * common SSRF and cloud-metadata vector) is rejected too. The connection itself
 * goes to an address that check passed, so a name answering differently on a
 * second lookup (DNS rebinding) cannot reach an internal host either.
 */

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // "this network", private, loopback
  if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64.0.0/10)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * The IPv4 address embedded in an IPv4-mapped/-compatible IPv6, or null. Handles
 * both the dotted-quad tail (`::ffff:127.0.0.1`) and the hex-hextet form
 * (`::ffff:7f00:1`) — the latter is what a raw `::ffff:7f00:1` literal or a
 * canonicalized address looks like.
 */
function embeddedIpv4(host: string): string | null {
  const dotted = host.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1]!;
  // ::ffff:HHHH:HHHH or the ::ffff:0:HHHH:HHHH ("IPv4-compatible") spelling.
  const hex = host.match(/^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

function isBlockedIpv6(ip: string): boolean {
  const host = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '::1' || host === '::') return true; // loopback / unspecified
  if (host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) return true; // link-local / ULA
  const v4 = embeddedIpv4(host); // IPv4-mapped/-compatible (dotted or hex form)
  if (v4) return isBlockedIpv4(v4);
  return false;
}

/** Whether an IP literal is in a private / loopback / link-local / reserved range. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true; // not a valid IP → refuse
}

/**
 * Validate that `rawUrl` is an `http(s)` URL whose host is public. Resolves the
 * hostname and rejects if any resolved address is blocked. Throws on violation.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    throw new Error('URL host is not allowed');
  }
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('URL host is not allowed');
    return url;
  }
  const resolved = await lookup(host, { all: true });
  if (resolved.length === 0) throw new Error('URL host did not resolve');
  for (const { address } of resolved) {
    if (isBlockedAddress(address)) throw new Error('URL host is not allowed');
  }
  return url;
}

/**
 * The `lookup` of every connection `safeFetch` opens: it resolves the host and
 * fails when any address it resolves to is blocked, so the socket connects only
 * to an address that was checked.
 */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, '', 0);
    if (addresses.length === 0 || addresses.some(({ address }) => isBlockedAddress(address))) {
      const refused: NodeJS.ErrnoException = new Error(`URL host is not allowed: ${hostname}`);
      refused.code = 'EADDRNOTAVAIL';
      return callback(refused, '', 0);
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

let publicOnlyAgent: Agent | null = null;

/**
 * `fetch` for user-supplied URLs: validates the target (and every redirect hop)
 * against `assertPublicHttpUrl`, following redirects manually so a redirect to
 * an internal address cannot slip through, and connects only to addresses
 * `publicOnlyLookup` checked. Enforces a per-request timeout.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  maxRedirects = 3,
  timeoutMs = 5000,
): Promise<Response> {
  const undici = await import('undici');
  publicOnlyAgent ??= new undici.Agent({ connect: { lookup: publicOnlyLookup } });
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHttpUrl(current);
    const res = (await undici.fetch(current, {
      ...(init as UndiciRequestInit),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: publicOnlyAgent,
    })) as unknown as Response;
    if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
      current = new URL(res.headers.get('location')!, current).toString();
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}
