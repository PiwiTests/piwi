import type { H3Event } from 'h3';
import { apiError } from './api-error';
import { getRequestHeader, getRequestIP, setResponseHeader } from 'h3';

const store = new Map<string, { count: number; resetAt: number }>();

/** The store's size below which no sweep of ended windows runs. */
const SWEEP_FLOOR = 1000;
/** The size at which the next new key sweeps the ended windows: twice what the last sweep kept, at least the floor. */
let sweepAt = SWEEP_FLOOR;

/** Drop every key whose window has ended. */
function sweepEndedWindows(now: number): void {
  for (const [key, entry] of store) {
    if (entry.resetAt < now) store.delete(key);
  }
  sweepAt = Math.max(SWEEP_FLOOR, store.size * 2);
}

/**
 * Simple in-memory rate limiter. Returns true if the request is allowed.
 * A new key first sweeps the ended windows once the store has grown to
 * `sweepAt`, so it never holds more than the floor or twice the keys the last
 * sweep kept.
 * @param key       Unique key (e.g. IP + endpoint)
 * @param limit     Max requests per window
 * @param windowMs  Window duration in ms
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || entry.resetAt < now) {
    if (!entry && store.size >= sweepAt) sweepEndedWindows(now);
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

/**
 * Give back one slot `checkRateLimit` took under `key`, for a request that
 * turned out not to count. A key left holding no slot is removed, so requests
 * that never count leave nothing in the store.
 */
export function releaseRateLimit(key: string): void {
  const entry = store.get(key);
  if (!entry || entry.resetAt < Date.now()) return;
  if (entry.count > 0) entry.count--;
  if (entry.count === 0) store.delete(key);
}

/**
 * Run a lookup under a limit on the lookups that miss (an unknown code or id),
 * with 429 past it. Each request takes a slot before the lookup runs, so
 * concurrent requests cannot all pass the check, and gives it back unless
 * `missed` says the lookup missed; a lookup that throws gives it back too.
 */
export async function limitLookupMisses<T>(
  event: H3Event,
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number },
  lookup: () => Promise<T>,
  missed: (result: T) => boolean,
): Promise<T> {
  if (!checkRateLimit(key, limit, windowMs)) throw rateLimitedError(event, [key]);
  let result: T;
  try {
    result = await lookup();
  } catch (error) {
    releaseRateLimit(key);
    throw error;
  }
  if (!missed(result)) releaseRateLimit(key);
  return result;
}

/** Clear a key's counter (e.g. after a success), so it no longer counts toward a lockout. */
export function resetRateLimit(key: string): void {
  store.delete(key);
}

/** How many keys the limiter holds, ended windows not swept yet included. */
export function rateLimitKeyCount(): number {
  return store.size;
}

/** Seconds until `key`'s current window expires — 0 when no window is active. */
export function rateLimitResetSeconds(key: string): number {
  const entry = store.get(key);
  if (!entry) return 0;
  return Math.max(0, Math.ceil((entry.resetAt - Date.now()) / 1000));
}

/**
 * 429 error carrying a `Retry-After` header derived from the longest-lived
 * window among `keys` (at least 1 second, so clients always get a usable hint).
 */
export function rateLimitedError(
  event: H3Event,
  keys: string[],
  message = 'Too many requests. Please wait before trying again.',
) {
  const retryAfter = Math.max(1, ...keys.map(rateLimitResetSeconds));
  setResponseHeader(event, 'Retry-After', retryAfter);
  return apiError({ statusCode: 429, message });
}

let warnedUntrustedProxy = false;

/**
 * Client address used in rate-limit keys.
 *
 * By default this is the socket peer address, which behind a reverse proxy is
 * the proxy itself — every client then shares one bucket. `PIWI_TRUST_PROXY=true`
 * switches to the last `X-Forwarded-For` entry (the one appended by the proxy in
 * front of Piwi, which clients cannot forge). Only set it when such a proxy is
 * actually in front of the server: trusted, the header is client-controlled on
 * direct connections, which would let a caller pick its own bucket. The first
 * request that carries the header while it is unset logs a warning, once per
 * process.
 */
export function rateLimitClientIp(event: H3Event): string {
  const forwarded = getRequestHeader(event, 'x-forwarded-for');
  if (process.env.PIWI_TRUST_PROXY === 'true') {
    const lastHop = forwarded?.split(',').at(-1)?.trim();
    if (lastHop) return lastHop;
  } else if (forwarded && !warnedUntrustedProxy) {
    warnedUntrustedProxy = true;
    console.warn(
      '[rate-limit] A request carries X-Forwarded-For but PIWI_TRUST_PROXY is not set, so the per-client rate ' +
        "limits (sign-in, password reset, setup) key on the connecting address. Behind a reverse proxy that is the proxy's, " +
        'and every client shares one bucket: set PIWI_TRUST_PROXY=true when a reverse proxy you run is in front of Piwi.',
    );
  }
  return getRequestIP(event) ?? 'unknown';
}
