import { describe, expect, test } from 'vitest';
import { getResponseStatus } from 'nitro/h3';
import { etagMatches, sendJsonWithEtag } from '../../server/utils/json-etag';
import { testEvent } from './h3-event';

/** An event with the request headers it reads, and the response status and headers it writes. */
function event(headers: Record<string, string> = {}) {
  const e = testEvent({ headers });
  return { e, status: () => getResponseStatus(e), written: (name: string) => e.res.headers.get(name) };
}

describe('sendJsonWithEtag', () => {
  test('answers the JSON with an ETag of it, kept out of shared caches', () => {
    const { e, status, written } = event();
    expect(sendJsonWithEtag(e, { a: 1 })).toBe('{"a":1}');
    expect(status()).toBe(200);
    expect(written('etag')).toMatch(/^"[\w-]+"$/);
    expect(written('cache-control')).toBe('private, no-cache');
    expect(written('content-type')).toBe('application/json');
  });

  test('leaves the volatile keys out of the ETag', () => {
    const { e: first, written } = event();
    sendJsonWithEtag(first, { a: 1, generatedAt: '10:00' }, ['generatedAt']);
    const { e: later, status } = event({ 'if-none-match': written('etag')! });
    expect(sendJsonWithEtag(later, { a: 1, generatedAt: '10:05' }, ['generatedAt'])).toBeNull();
    expect(status()).toBe(304);
  });

  test('answers 304 without a body when the request names the same ETag, and the JSON when it changed', () => {
    const { e: first, written } = event();
    sendJsonWithEtag(first, { a: 1 });
    const { e: same, status } = event({ 'if-none-match': written('etag')! });
    expect(sendJsonWithEtag(same, { a: 1 })).toBeNull();
    expect(status()).toBe(304);
    const { e: changed, status: changedStatus } = event({ 'if-none-match': written('etag')! });
    expect(sendJsonWithEtag(changed, { a: 2 })).toBe('{"a":2}');
    expect(changedStatus()).toBe(200);
  });
});

describe('etagMatches', () => {
  test('compares weakly, as If-None-Match does, across a list of tags', () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"x", W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('*', '"abc"')).toBe(true);
    expect(etagMatches('"abd"', '"abc"')).toBe(false);
    expect(etagMatches('abc', '"abc"')).toBe(false);
    expect(etagMatches(undefined, '"abc"')).toBe(false);
  });

  test('answers 304 to a tag a proxy made weak', () => {
    const { e: first, written } = event();
    sendJsonWithEtag(first, { a: 1 });
    const { e: weak, status } = event({ 'if-none-match': `W/${written('etag')!}` });
    expect(sendJsonWithEtag(weak, { a: 1 })).toBeNull();
    expect(status()).toBe(304);
  });
});
