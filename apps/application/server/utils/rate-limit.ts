import type { H3Event } from 'h3';
import { apiError } from './api-error';
import { getRequestHeader, getRequestIP, setResponseHeader } from 'h3';

const store = new Map<string, { count: number; resetAt: number }>();

/**
 * Simple in-memory rate limiter. Returns true if the request is allowed.
 * @param key       Unique key (e.g. IP + endpoint)
 * @param limit     Max requests per window
 * @param windowMs  Window duration in ms
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || entry.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

/** Give back one slot `checkRateLimit` took under `key`, for a request that turned out not to count. */
export function releaseRateLimit(key: string): void {
  const entry = store.get(key);
  if (entry && entry.resetAt >= Date.now() && entry.count > 0) entry.count--;
}

/** Whether `key` has reached `limit` within its current window, without counting this call. */
export function isRateLimited(key: string, limit: number): boolean {
  const entry = store.get(key);
  if (!entry || entry.resetAt < Date.now()) return false;
  return entry.count >= limit;
}

/** Record one hit against `key`, starting a fresh window if none is active. Used to count failures. */
export function recordRateLimitHit(key: string, windowMs: number): void {
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || entry.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
  } else {
    entry.count++;
  }
}

/** Clear a key's counter (e.g. after a success), so it no longer counts toward a lockout. */
export function resetRateLimit(key: string): void {
  store.delete(key);
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

/**
 * Client address used in rate-limit keys.
 *
 * By default this is the socket peer address, which behind a reverse proxy is
 * the proxy itself — every client then shares one bucket. `PIWI_TRUST_PROXY=true`
 * switches to the last `X-Forwarded-For` entry (the one appended by the proxy in
 * front of Piwi, which clients cannot forge). Only set it when such a proxy is
 * actually in front of the server: trusted, the header is client-controlled on
 * direct connections, which would let a caller pick its own bucket.
 */
export function rateLimitClientIp(event: H3Event): string {
  if (process.env.PIWI_TRUST_PROXY === 'true') {
    const forwarded = getRequestHeader(event, 'x-forwarded-for');
    const lastHop = forwarded?.split(',').at(-1)?.trim();
    if (lastHop) return lastHop;
  }
  return getRequestIP(event) ?? 'unknown';
}
