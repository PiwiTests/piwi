import { describe, expect, test } from 'vitest';
import { cacheVerdict } from '../src/static-cache';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const LAST_MODIFIED = 'Sun, 01 Nov 2026 12:00:00 GMT';
const verdict = (
  headers: Record<string, string>,
  { method = 'GET', status = 200, request = {} as Record<string, string> } = {},
) => cacheVerdict(method, status, headers, request, NOW);
const withCookie = { request: { cookie: 'sid=1' } };

describe('cacheVerdict', () => {
  test('calls an immutable response a static asset, credentials or not', () => {
    expect(verdict({ 'cache-control': 'public, max-age=31536000, immutable' })).toBe('static');
    expect(verdict({ 'cache-control': 'max-age=31536000, immutable' }, withCookie)).toBe('static');
    expect(
      verdict({ 'cache-control': 'immutable, max-age=31536000' }, { request: { authorization: 'Bearer x' } }),
    ).toBe('static');
  });

  test('calls a week-long response static only when its request carried no cookie or credentials', () => {
    expect(verdict({ 'cache-control': 'max-age=604800' })).toBe('static');
    expect(verdict({ 'cache-control': 'max-age=31536000, stale-while-revalidate=60' })).toBe('static');
    expect(verdict({ 'cache-control': 'max-age=604800' }, withCookie)).toBe('reusable');
  });

  test('calls an asset with no lifetime of its own, or a week-long one, static, cookie or not', () => {
    expect(verdict({ 'content-type': 'image/svg+xml', 'last-modified': LAST_MODIFIED })).toBe('static');
    expect(verdict({ 'content-type': 'application/javascript', 'last-modified': LAST_MODIFIED })).toBe('static');
    expect(verdict({ 'content-type': 'text/css', 'last-modified': LAST_MODIFIED }, withCookie)).toBe('static');
    expect(verdict({ 'content-type': 'font/woff2', 'cache-control': 'max-age=604800' }, withCookie)).toBe('static');
  });

  test('calls an asset with a short lifetime of its own reusable', () => {
    expect(verdict({ 'content-type': 'image/png', 'cache-control': 'max-age=300' })).toBe('reusable');
    expect(verdict({ 'content-type': 'font/woff2', expires: 'Mon, 16 Nov 2026 12:00:00 GMT' })).toBe('reusable');
  });

  test('keeps a response tied to the user out of the static assets', () => {
    expect(verdict({ 'cache-control': 'private, max-age=31536000' })).toBe('reusable');
    expect(verdict({ 'cache-control': 'max-age=31536000, immutable', 'set-cookie': 'sid=1' })).toBe('reusable');
    expect(verdict({ 'cache-control': 'max-age=31536000', vary: 'Accept-Encoding, Cookie' })).toBe('reusable');
    expect(verdict({ 'cache-control': 'immutable, max-age=600', vary: 'cookie' })).toBe('reusable');
    expect(verdict({ 'cache-control': 'max-age=31536000', vary: 'Accept-Encoding' })).toBe('static');
  });

  test('calls redirects and gone resources reusable, as Chromium keeps them with no lifetime given', () => {
    expect(verdict({}, { status: 301 })).toBe('reusable');
    expect(verdict({ location: '/b' }, { status: 308 })).toBe('reusable');
    expect(verdict({}, { status: 410 })).toBe('reusable');
    expect(verdict({ 'cache-control': 'no-cache' }, { status: 301 })).toBe('revalidated');
    expect(verdict({}, { status: 302 })).toBe('revalidated');
  });

  test('calls a response the browser may serve again without asking reusable', () => {
    expect(verdict({ 'cache-control': 'max-age=60' })).toBe('reusable');
    expect(verdict({ 'cache-control': 'max-age=0, stale-while-revalidate=30' })).toBe('reusable');
    expect(verdict({ 'cache-control': 'no-cache, stale-if-error=600' })).toBe('reusable');
    expect(verdict({ expires: 'Mon, 16 Nov 2026 12:00:00 GMT' })).toBe('reusable');
    expect(verdict({ 'content-type': 'application/json', 'last-modified': LAST_MODIFIED })).toBe('reusable');
  });

  test('calls a response the browser keeps only to ask again, or not at all, revalidated', () => {
    expect(verdict({})).toBe('revalidated');
    expect(verdict({ etag: '"v1"' })).toBe('revalidated');
    expect(verdict({ 'cache-control': 'no-store, max-age=600' })).toBe('revalidated');
    expect(verdict({ 'content-type': 'image/png', 'cache-control': 'no-cache' })).toBe('revalidated');
    expect(verdict({ 'cache-control': 'max-age=0, must-revalidate' })).toBe('revalidated');
    expect(verdict({ expires: 'Sat, 14 Nov 2026 12:00:00 GMT' })).toBe('revalidated');
    expect(verdict({ expires: '0' })).toBe('revalidated');
    expect(verdict({ 'last-modified': LAST_MODIFIED }, { status: 404 })).toBe('revalidated');
    expect(verdict({ 'cache-control': 'max-age=600' }, { method: 'POST' })).toBe('revalidated');
  });
});
