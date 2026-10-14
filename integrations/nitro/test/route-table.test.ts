import { afterEach, describe, expect, it } from 'vitest';
import { declaredRoutes, declaredRoutesOf, routeTablePlugin } from '../src/route-table';

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__piwiDeclaredRoutes;
});

describe('declaredRoutesOf', () => {
  const root = '/repo';

  it('declares each route once per method, middleware and a fallback catch-all left out, a route without a method as GET', () => {
    const routes = declaredRoutesOf(
      [
        { middleware: true, handler: '/repo/app/middleware/auth.ts' },
        { route: '/api/orders', method: 'get', handler: '/repo/app/routes/api/orders.get.ts' },
        { route: '/api/orders', method: 'post', handler: '/repo/app/routes/api/orders.post.ts' },
        { route: '/api/orders', method: 'get', handler: '/repo/app/routes/api/orders.get.ts' },
        { route: '/shop/products/:slug', handler: '/repo/app/routes/shop/products/[slug].ts' },
        { route: '/**', handler: '/repo/node_modules/nuxt/dist/core/runtime/nitro/renderer.js' },
        { route: '/**:path', handler: '/repo/app/routes/[...path].ts' },
        { route: '/docs/**', handler: '/repo/app/routes/docs/[...slug].ts' },
      ],
      root,
    );
    expect(routes).toEqual([
      { method: 'GET', pattern: '/api/orders', handler: 'app/routes/api/orders.get.ts' },
      { method: 'POST', pattern: '/api/orders', handler: 'app/routes/api/orders.post.ts' },
      { method: 'GET', pattern: '/shop/products/:slug', handler: 'app/routes/shop/products/[slug].ts' },
      { method: 'GET', pattern: '/docs/**', handler: 'app/routes/docs/[...slug].ts' },
    ]);
  });

  it('names a file outside the root by no file, and reads Windows separators', () => {
    const routes = declaredRoutesOf(
      [
        { route: '/a', handler: '/elsewhere/a.ts' },
        { route: '/b', handler: 'C:\\repo\\routes\\b.ts' },
      ],
      'C:\\repo',
    );
    expect(routes).toEqual([
      { method: 'GET', pattern: '/a' },
      { method: 'GET', pattern: '/b', handler: 'routes/b.ts' },
    ]);
  });
});

describe('the generated plugin', () => {
  it('hands its route table to the runtime plugin', async () => {
    expect(declaredRoutes()).toEqual([]);
    const routes = [{ method: 'GET', pattern: '/shop/orders', handler: 'routes/shop/orders.get.ts' }];
    const source = routeTablePlugin(routes);
    const plugin = (await import(`data:text/javascript,${encodeURIComponent(source)}`)) as { default: () => void };
    plugin.default();
    expect(declaredRoutes()).toEqual(routes);
  });
});
