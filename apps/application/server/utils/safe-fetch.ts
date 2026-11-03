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
 * The eight 16-bit groups of an IPv6 address `isIP` accepted, or null: the `::`
 * run expanded, a dotted-quad tail read as its two groups, a zone id dropped.
 */
function ipv6Groups(ip: string): number[] | null {
  let host = ip.split('%')[0]!;
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    host = `${host.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const read = (part: string | undefined) => (part ? part.split(':').map((group) => parseInt(group, 16)) : []);
  const head = read(halves[0]);
  const tail = read(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<number>(halves.length === 1 ? 0 : missing).fill(0), ...tail];
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/** The IPv4 address two groups of an IPv6 address carry, high group first. */
function ipv4FromGroups(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * The IPv4 address an IPv6 address stands for, or null: IPv4-compatible
 * (`::/96`, which holds `::` and `::1`), IPv4-mapped (`::ffff:0:0/96`),
 * IPv4-translated (`::ffff:0:0:0/96`), NAT64 well-known (`64:ff9b::/96`) and
 * 6to4 (`2002::/16`).
 */
function embeddedIpv4(groups: number[]): string | null {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const zeroUpTo = (end: number) => groups.slice(0, end).every((group) => group === 0);
  if (zeroUpTo(6)) return ipv4FromGroups(g6, g7);
  if (zeroUpTo(5) && g5 === 0xffff) return ipv4FromGroups(g6, g7);
  if (zeroUpTo(4) && g4 === 0xffff && g5 === 0) return ipv4FromGroups(g6, g7);
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return ipv4FromGroups(g6, g7);
  if (g0 === 0x2002) return ipv4FromGroups(g1, g2);
  return null;
}

function isBlockedIpv6(ip: string): boolean {
  const groups = ipv6Groups(ip.toLowerCase().replace(/^\[|\]$/g, ''));
  if (!groups) return true;
  const [g0, g1, g2] = groups as [number, number, number];
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local (fc00::/7)
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local (fe80::/10)
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local (fec0::/10)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast (ff00::/8)
  // Local-use NAT64 (64:ff9b:1::/48): not globally reachable, and where its IPv4 address sits depends on the network.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  const v4 = embeddedIpv4(groups);
  return v4 !== null && isBlockedIpv4(v4);
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
