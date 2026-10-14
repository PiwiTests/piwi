import { readFileSync } from 'node:fs';
import { backend, unsupported } from '../backends';
import { test, expect } from './fixtures';

/** A route pattern with every parameter written `:param`, whatever the backend's syntax (`{slug}`, `:slug`, `[slug]`). */
const normalized = (pattern: string) =>
  pattern
    .split('/')
    .map((segment) => (/^(?:\{.+\}|:.+|\[.+\])$/.test(segment) ? ':param' : segment))
    .join('/');

const declaredPages: { pattern: string }[] = JSON.parse(
  readFileSync(new URL('../piwi.manifest.json', import.meta.url), 'utf8'),
).pages;

// The integration declares the backend's routes at /__piwi/manifest, read from the backend itself. The reporter
// uploads it when the run starts, so a route no test reaches is named in the Test Map as declared and never hit:
// /shop/orders, the order history, which no test opens, and the GET /api/orders it calls.
test('the route manifest declares every page and the API', async ({ request }) => {
  test.skip(!backend.features.routeManifest, unsupported('routeManifest'));
  const response = await request.get('/__piwi/manifest');
  expect(response.ok()).toBe(true);
  const { routes } = (await response.json()) as { routes: { method: string; pattern: string }[] };
  const declared = routes.map((route) => `${route.method} ${normalized(route.pattern)}`);

  for (const page of declaredPages) expect(declared).toContain(`GET ${normalized(page.pattern)}`);
  expect(declared).toEqual(
    expect.arrayContaining([
      'GET /api/items',
      'POST /api/submit',
      'GET /api/users/:param',
      'GET /api/products',
      'GET /api/products/:param',
      'POST /api/orders',
      'GET /api/orders',
    ]),
  );
});
