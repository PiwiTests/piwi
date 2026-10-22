import { createHash } from 'node:crypto';
import { getRequestHeader, setResponseHeader, setResponseStatus, type H3Event } from 'h3';

/** A strong `ETag` of a value: the SHA-1 of its JSON, in base64url. */
export function jsonEtag(value: unknown): string {
  return `"${createHash('sha1').update(JSON.stringify(value)).digest('base64url')}"`;
}

/**
 * Whether an `If-None-Match` header names `etag`: `*`, or one of its comma-separated tags compared weakly (RFC 9110,
 * 13.1.2), so a tag a proxy made weak (`W/"…"`, as nginx does when it compresses the answer) still matches.
 */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  const wanted = opaque(etag);
  return header.split(',').some((tag) => tag.trim() === '*' || opaque(tag) === wanted);
}

/**
 * Give the answer `etag`, with `Cache-Control: private, no-cache`, which keeps it out of shared caches and revalidated
 * on each use. When the request's `If-None-Match` names it (`etagMatches`), the answer is an empty 304 and this
 * returns true.
 */
export function notModified(event: H3Event, etag: string): boolean {
  setResponseHeader(event, 'ETag', etag);
  setResponseHeader(event, 'Cache-Control', 'private, no-cache');
  if (!etagMatches(getRequestHeader(event, 'if-none-match'), etag)) return false;
  setResponseStatus(event, 304);
  return true;
}

/**
 * Answer with `value` as JSON and an `ETag` of that JSON without the `volatile` keys (such as when it was generated);
 * a request whose `If-None-Match` names it gets an empty 304 instead (`notModified`).
 */
export function sendJsonWithEtag(event: H3Event, value: object, volatile: string[] = []): string | null {
  const stable = Object.fromEntries(Object.entries(value).filter(([key]) => !volatile.includes(key)));
  if (notModified(event, jsonEtag(stable))) return null;
  setResponseHeader(event, 'Content-Type', 'application/json');
  return JSON.stringify(value);
}
