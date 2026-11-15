import { describe, expect, test } from 'vitest';
import { cacheVerdict } from '../src/static-cache';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const verdict = (headers: Record<string, string>, method = 'GET', status = 200) =>
  cacheVerdict(method, status, headers, NOW);

describe('cacheVerdict', () => {
  test('calls an immutable or week-long response a static asset', () => {
    expect(verdict({ 'cache-control': 'public, max-age=31536000, immutable' })).toBe('static');
    expect(verdict({ 'cache-control': 'immutable' })).toBe('static');
    expect(verdict({ 'cache-control': 'max-age=604800' })).toBe('static');
    expect(verdict({ 'cache-control': 'max-age=31536000, stale-while-revalidate=60' })).toBe('static');
  });

  test('calls an image, font, stylesheet or script a static asset whatever its lifetime', () => {
    const lastModified = 'Sun, 01 Nov 2026 12:00:00 GMT';
    expect(verdict({ 'content-type': 'image/svg+xml', 'last-modified': lastModified })).toBe('static');
    expect(verdict({ 'content-type': 'font/woff2', 'cache-control': 'max-age=3600' })).toBe('static');
    expect(verdict({ 'content-type': 'text/css; charset=utf-8', 'cache-control': 'max-age=60' })).toBe('static');
    expect(verdict({ 'content-type': 'application/javascript', 'last-modified': lastModified })).toBe('static');
    expect(verdict({ 'content-type': 'image/png', 'cache-control': 'private, max-age=60' })).toBe('reusable');
    expect(verdict({ 'content-type': 'image/png', 'cache-control': 'no-store' })).toBe('revalidated');
    expect(verdict({ 'content-type': 'application/json', 'last-modified': lastModified })).toBe('reusable');
    expect(verdict({ 'content-type': 'text/html', 'cache-control': 'max-age=60' })).toBe('reusable');
  });

  test('keeps a long-lived response tied to the user out of the static assets', () => {
    expect(verdict({ 'cache-control': 'private, max-age=31536000' })).toBe('reusable');
    expect(verdict({ 'cache-control': 'max-age=31536000', 'set-cookie': 'sid=1' })).toBe('reusable');
    expect(verdict({ 'cache-control': 'max-age=31536000', vary: 'Accept-Encoding, Cookie' })).toBe('reusable');
    expect(verdict({ 'cache-control': 'immutable, max-age=600', vary: 'cookie' })).toBe('reusable');
    expect(verdict({ 'cache-control': 'max-age=31536000', vary: 'Accept-Encoding' })).toBe('static');
  });

  test('calls a response the browser may serve again without asking reusable', () => {
    expect(verdict({ 'cache-control': 'max-age=60' })).toBe('reusable');
    expect(verdict({ 'cache-control': 'max-age=0, stale-while-revalidate=30' })).toBe('reusable');
    expect(verdict({ 'cache-control': 'no-cache, stale-if-error=600' })).toBe('reusable');
    expect(verdict({ expires: 'Mon, 16 Nov 2026 12:00:00 GMT' })).toBe('reusable');
    expect(verdict({ 'last-modified': 'Sun, 01 Nov 2026 12:00:00 GMT' })).toBe('reusable');
  });

  test('calls a response the browser keeps only to ask again, or not at all, revalidated', () => {
    expect(verdict({})).toBe('revalidated');
    expect(verdict({ etag: '"v1"' })).toBe('revalidated');
    expect(verdict({ 'cache-control': 'no-store, max-age=600' })).toBe('revalidated');
    expect(verdict({ 'cache-control': 'no-cache' })).toBe('revalidated');
    expect(verdict({ 'cache-control': 'max-age=0, must-revalidate' })).toBe('revalidated');
    expect(verdict({ expires: 'Sat, 14 Nov 2026 12:00:00 GMT' })).toBe('revalidated');
    expect(verdict({ expires: '0' })).toBe('revalidated');
    expect(verdict({ 'last-modified': 'Sun, 01 Nov 2026 12:00:00 GMT' }, 'GET', 302)).toBe('revalidated');
    expect(verdict({ 'cache-control': 'max-age=600' }, 'POST')).toBe('revalidated');
  });
});
