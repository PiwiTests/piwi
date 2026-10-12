import { createHash } from 'node:crypto';
import { getRequestHeader, setResponseHeader, setResponseStatus, type H3Event } from 'h3';

/**
 * Answer with `value` as JSON and an `ETag` of that JSON without the `volatile` keys (such as when it was generated);
 * a request whose `If-None-Match` names it gets an empty 304 instead. `Cache-Control: private, no-cache` keeps the
 * answer out of shared caches and revalidated on each use.
 */
export function sendJsonWithEtag(event: H3Event, value: object, volatile: string[] = []): string | null {
  const stable = Object.fromEntries(Object.entries(value).filter(([key]) => !volatile.includes(key)));
  const etag = `"${createHash('sha1').update(JSON.stringify(stable)).digest('base64url')}"`;
  setResponseHeader(event, 'ETag', etag);
  setResponseHeader(event, 'Cache-Control', 'private, no-cache');
  if (getRequestHeader(event, 'if-none-match') === etag) {
    setResponseStatus(event, 304);
    return null;
  }
  setResponseHeader(event, 'Content-Type', 'application/json');
  return JSON.stringify(value);
}
