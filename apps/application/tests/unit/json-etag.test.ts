import { describe, expect, test } from 'vitest';
import type { H3Event } from 'h3';
import { sendJsonWithEtag } from '../../server/utils/json-etag';

/** A minimal H3Event: the request headers it reads, and the response status and headers it writes. */
function event(headers: Record<string, string> = {}) {
  const written: Record<string, string> = {};
  const res = {
    statusCode: 200,
    statusMessage: '',
    headersSent: false,
    setHeader: (name: string, value: string) => (written[name.toLowerCase()] = value),
    getHeader: (name: string) => written[name.toLowerCase()],
  };
  const e = { context: {}, node: { req: { headers }, res } } as unknown as H3Event;
  return { e, res, written };
}

describe('sendJsonWithEtag', () => {
  test('answers the JSON with an ETag of it, kept out of shared caches', () => {
    const { e, res, written } = event();
    expect(sendJsonWithEtag(e, { a: 1 })).toBe('{"a":1}');
    expect(res.statusCode).toBe(200);
    expect(written['etag']).toMatch(/^"[\w-]+"$/);
    expect(written['cache-control']).toBe('private, no-cache');
    expect(written['content-type']).toBe('application/json');
  });

  test('leaves the volatile keys out of the ETag', () => {
    const { e: first, written } = event();
    sendJsonWithEtag(first, { a: 1, generatedAt: '10:00' }, ['generatedAt']);
    const { e: later, res } = event({ 'if-none-match': written['etag']! });
    expect(sendJsonWithEtag(later, { a: 1, generatedAt: '10:05' }, ['generatedAt'])).toBeNull();
    expect(res.statusCode).toBe(304);
  });

  test('answers 304 without a body when the request names the same ETag, and the JSON when it changed', () => {
    const { e: first, written } = event();
    sendJsonWithEtag(first, { a: 1 });
    const { e: same, res } = event({ 'if-none-match': written['etag']! });
    expect(sendJsonWithEtag(same, { a: 1 })).toBeNull();
    expect(res.statusCode).toBe(304);
    const { e: changed, res: changedRes } = event({ 'if-none-match': written['etag']! });
    expect(sendJsonWithEtag(changed, { a: 2 })).toBe('{"a":2}');
    expect(changedRes.statusCode).toBe(200);
  });
});
