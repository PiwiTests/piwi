import { describe, it, expect } from 'vitest';
import {
  buildRouteManifest,
  recordObservedRoute,
  collapsePathPattern,
  matchedRoutePattern,
  type ManifestRouteEntry,
} from '../src/manifest';

describe('collapsePathPattern', () => {
  it('collapses numeric and uuid segments', () => {
    expect(collapsePathPattern('/api/orders/42')).toBe('/api/orders/:id');
    expect(collapsePathPattern('/api/users/1b4e28ba-2fa1-11d2-883f-0016d3cca427')).toBe('/api/users/:uuid');
    expect(collapsePathPattern('/api/cart?x=1')).toBe('/api/cart');
  });
});

describe('matchedRoutePattern', () => {
  it('reads the pattern of the route the router matched, in either h3 shape, and nothing without one', () => {
    expect(matchedRoutePattern({ path: '/api/orders/:id' })).toBe('/api/orders/:id');
    expect(matchedRoutePattern({ route: '/api/orders/:id' })).toBe('/api/orders/:id');
    expect(matchedRoutePattern(undefined)).toBeNull();
    expect(matchedRoutePattern({ path: '' })).toBeNull();
  });
});

describe('recordObservedRoute / buildRouteManifest', () => {
  it('dedupes by method+pattern and keeps the first handler seen', () => {
    const map = new Map<string, ManifestRouteEntry>();
    recordObservedRoute(map, { method: 'get', pattern: '/api/cart', handler: 'server/api/cart.get.ts' });
    recordObservedRoute(map, { method: 'GET', pattern: '/api/cart' });
    recordObservedRoute(map, { method: 'POST', pattern: '/api/orders' });
    const manifest = buildRouteManifest(map);
    expect(manifest.routes).toHaveLength(2);
    const cart = manifest.routes.find((r) => r.pattern === '/api/cart');
    expect(cart?.method).toBe('GET');
    expect(cart?.handler).toBe('server/api/cart.get.ts');
  });

  it('ignores entries without a method or pattern and sorts output', () => {
    const map = new Map<string, ManifestRouteEntry>();
    recordObservedRoute(map, { method: '', pattern: '/x' });
    recordObservedRoute(map, { method: 'POST', pattern: '/b' });
    recordObservedRoute(map, { method: 'GET', pattern: '/a' });
    const routes = buildRouteManifest(map).routes;
    expect(routes.map((r) => r.pattern)).toEqual(['/a', '/b']);
  });

  it('bounds the accumulator', () => {
    const map = new Map<string, ManifestRouteEntry>();
    for (let i = 0; i < 5; i++) recordObservedRoute(map, { method: 'GET', pattern: `/r${i}` }, 3);
    expect(map.size).toBe(3);
  });
});
