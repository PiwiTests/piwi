import { describe, test, expect } from 'vitest';
import {
  buildManifestGraph,
  createDeclaredMatcher,
  normalizeManifestPattern,
  extractImports,
  buildImportEdges,
} from '#shared/graph';
import { parseOpenApiSpec } from '#shared/openapi';
import { detectDeclaredNeverHit, detectSuccessOnly, type RouteStat } from '#shared/handlers/scenario-gaps';

describe('normalizeManifestPattern', () => {
  test('collapses framework placeholders to :id / :uuid', () => {
    expect(normalizeManifestPattern('/api/orders/:id')).toBe('/api/orders/:id');
    expect(normalizeManifestPattern('/api/orders/{orderId}')).toBe('/api/orders/:id');
    expect(normalizeManifestPattern('/api/orders/[id]')).toBe('/api/orders/:id');
    expect(normalizeManifestPattern('/api/users/{userUuid}')).toBe('/api/users/:uuid');
    expect(normalizeManifestPattern('/api/orders/:id?expand=1')).toBe('/api/orders/:id');
  });

  test('leaves static segments untouched', () => {
    expect(normalizeManifestPattern('api/cart')).toBe('/api/cart');
  });

  test('reads a uuid from a guid constraint or a uuid-like name', () => {
    expect(normalizeManifestPattern('/orders/{id:guid}')).toBe('/orders/:uuid');
    expect(normalizeManifestPattern('/orders/{orderGuid}/{uuidPart}')).toBe('/orders/:uuid/:uuid');
    expect(normalizeManifestPattern('/guides/{guide}/{guidance}')).toBe('/guides/:id/:id');
  });

  test('reads a `?` inside a parameter as optional, not as a query', () => {
    expect(normalizeManifestPattern('/archive/{page?}')).toBe('/archive/:id');
    expect(normalizeManifestPattern('/files/{name}.{ext?}?download=1')).toBe('/files/:id');
  });
});

describe('buildManifestGraph', () => {
  test('builds declared route/handler nodes with documented codes and origin', () => {
    const { nodes, edges } = buildManifestGraph(
      {
        routes: [
          {
            method: 'delete',
            pattern: '/api/orders/{id}',
            handler: 'server/api/orders/[id].delete.ts',
            responses: [200, 404, 409, 200],
          },
        ],
        pages: [{ pattern: '/orders/{id}', name: 'Order detail' }],
      },
      'openapi',
    );
    const route = nodes.find((n) => n.kind === 'route');
    expect(route?.key).toBe('DELETE /api/orders/:id');
    expect(route?.origin).toBe('openapi');
    const routeAttrs = route?.attrs as { responses: number[] } | undefined;
    expect(routeAttrs?.responses).toEqual([200, 404, 409]);
    const page = nodes.find((n) => n.kind === 'page');
    expect(page?.key).toBe('/orders/:id');
    const pageAttrs = page?.attrs as { name?: string } | undefined;
    expect(pageAttrs?.name).toBe('Order detail');
    const handledBy = edges.find((e) => e.kind === 'handled-by');
    expect(handledBy?.toKey).toBe('server/api/orders/[id].delete.ts');
    expect(handledBy?.origin).toBe('openapi');
  });

  test('a committed manifest is origin manifest', () => {
    const { nodes } = buildManifestGraph({ routes: [{ method: 'GET', pattern: '/api/cart' }] }, 'committed');
    expect(nodes[0]?.origin).toBe('manifest');
  });

  test('keeps the declared patterns, every one that folds to the same key', () => {
    const { nodes } = buildManifestGraph(
      {
        routes: [
          { method: 'GET', pattern: '/users/{id:int}', responses: [200, 404] },
          { method: 'GET', pattern: '/users/{name}?tab=1', responses: [200, 410] },
        ],
        pages: [{ pattern: '/blog/{slug}' }],
      },
      'instrumentation',
    );
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      key: 'GET /users/:id',
      attrs: { declared: true, responses: [200, 404, 410], patterns: ['/users/{id:int}', '/users/{name}'] },
    });
    expect(nodes[1]).toMatchObject({ key: '/blog/:id', attrs: { declared: true, patterns: ['/blog/{slug}'] } });
  });
});

describe('createDeclaredMatcher', () => {
  /** The declared node serving `key`, from routes declared as `METHOD pattern` the way a manifest upload stores them. */
  const servedBy = (declared: string[], key: string, kind = 'route') => {
    const { nodes } = buildManifestGraph(
      kind === 'route'
        ? {
            routes: declared.map((d) => {
              const [method, pattern] = d.split(' ');
              return { method: method!, pattern: pattern! };
            }),
          }
        : { pages: declared.map((pattern) => ({ pattern })) },
      'instrumentation',
    );
    return createDeclaredMatcher(nodes)(kind, key);
  };

  test('a string parameter serves any one segment', () => {
    expect(servedBy(['GET /blog/{slug}'], 'GET /blog/hello-world')).toEqual(['GET /blog/:id']);
    expect(servedBy(['GET /api/orders/:orderId'], 'GET /api/orders/abc-123')).toEqual(['GET /api/orders/:id']);
    expect(servedBy(['GET /api/orders/[id]'], 'GET /api/orders/abc')).toEqual(['GET /api/orders/:id']);
    expect(servedBy(['GET /blog/{slug}'], 'GET /blog/a/b')).toEqual([]);
  });

  test('a typed parameter serves only its type', () => {
    expect(servedBy(['GET /orders/{id:int}'], 'GET /orders/:id')).toEqual(['GET /orders/:id']);
    expect(servedBy(['GET /orders/{id:int}'], 'GET /orders/export')).toEqual([]);
    expect(servedBy(['GET /orders/{id:guid}'], 'GET /orders/:uuid')).toEqual(['GET /orders/:uuid']);
    expect(servedBy(['GET /orders/{id:guid}'], 'GET /orders/:id')).toEqual([]);
    expect(servedBy(['GET /users/{userUuid}'], 'GET /users/alice')).toEqual([]);
  });

  test('a catch-all serves any depth, none included', () => {
    for (const pattern of [
      '/files/{**path}',
      '/files/{*path}',
      '/files/**',
      '/files/**:path',
      '/files/[...path]',
      '/files/:path*',
    ]) {
      expect(servedBy([`GET ${pattern}`], 'GET /files/reports/2026/q1.pdf')).toHaveLength(1);
      expect(servedBy([`GET ${pattern}`], 'GET /files')).toHaveLength(1);
    }
    expect(servedBy(['GET /files/{**path}'], 'GET /other/a')).toEqual([]);
  });

  test('a segment mixing literals and parameters serves the values it reads', () => {
    expect(servedBy(['GET /api/v{version:apiVersion}/orders'], 'GET /api/v2/orders')).toEqual([
      'GET /api/v{version:apiVersion}/orders',
    ]);
    expect(servedBy(['GET /api/v{version:apiVersion}/orders'], 'GET /api/beta/orders')).toEqual([]);
    expect(servedBy(['GET /assets/{name}.{ext}'], 'GET /assets/logo.svg')).toEqual(['GET /assets/:id']);
    expect(servedBy(['GET /assets/{name}.{ext}'], 'GET /assets/logo')).toEqual([]);
    expect(servedBy(['POST /v1/{name}:cancel'], 'POST /v1/jobs%2F42:cancel')).toEqual(['POST /v1/{name}:cancel']);
  });

  test('an optional parameter serves the path with or without it', () => {
    expect(servedBy(['GET /archive/{page?}'], 'GET /archive')).toEqual(['GET /archive/:id']);
    expect(servedBy(['GET /archive/{page?}'], 'GET /archive/:id')).toEqual(['GET /archive/:id']);
    expect(servedBy(['GET /archive/[[page]]'], 'GET /archive')).toEqual(['GET /archive/:id']);
  });

  test('an optional parameter before a literal never stands in for the literal', () => {
    expect(servedBy(['/[[lang]]/about'], '/fr', 'page')).toEqual([]);
    expect(servedBy(['/[[lang]]/about'], '/about', 'page')).toEqual(['/:id/about']);
    expect(servedBy(['/[[lang]]/about'], '/fr/about', 'page')).toEqual(['/:id/about']);
    expect(servedBy(['GET /{lang?}/about'], 'GET /fr')).toEqual([]);
  });

  test('a one-or-more catch-all needs a segment', () => {
    expect(servedBy(['GET /files/:path+'], 'GET /files')).toEqual([]);
    expect(servedBy(['GET /files/:path+'], 'GET /files/a/b')).toEqual(['GET /files/:id']);
  });

  test('a parameter named like a guide is not a uuid', () => {
    expect(servedBy(['GET /guides/{guide}'], 'GET /guides/install')).toEqual(['GET /guides/:id']);
    expect(servedBy(['GET /help/{guidance}'], 'GET /help/intro')).toEqual(['GET /help/:id']);
  });

  test('numbers match as observed keys hold them', () => {
    expect(servedBy(['GET /reports/2024'], 'GET /reports/:id')).toEqual(['GET /reports/2024']);
    expect(servedBy(['GET /reports/2024'], 'GET /reports/latest')).toEqual([]);
    expect(servedBy(['GET /p/{v:decimal}'], 'GET /p/1.5')).toEqual(['GET /p/:id']);
    expect(servedBy(['GET /t/{delta:long}'], 'GET /t/-5')).toEqual(['GET /t/:id']);
  });

  test('a last optional parameter in a mixed segment may be left out with its separator', () => {
    expect(servedBy(['GET /files/{name}.{ext?}'], 'GET /files/report')).toEqual(['GET /files/:id']);
    expect(servedBy(['GET /files/{name}.{ext?}'], 'GET /files/report.pdf')).toEqual(['GET /files/:id']);
    expect(servedBy(['GET /files/{name}.{ext}'], 'GET /files/report')).toEqual([]);
  });

  test('the closest pattern wins, as in a router', () => {
    expect(servedBy(['GET /orders/new', 'GET /orders/{slug}'], 'GET /orders/new')).toEqual(['GET /orders/new']);
    expect(servedBy(['GET /orders/new', 'GET /orders/{slug}'], 'GET /orders/old')).toEqual(['GET /orders/:id']);

    const docs = ['GET /docs/intro', 'GET /docs/{section}/{page}', 'GET /docs/{id:int}/edit', 'GET /docs/{**path}'];
    expect(servedBy(docs, 'GET /docs/intro')).toEqual(['GET /docs/intro']);
    expect(servedBy(docs, 'GET /docs/guide/install')).toEqual(['GET /docs/:id/:id']);
    expect(servedBy(docs, 'GET /docs/:id/edit')).toEqual(['GET /docs/:id/edit']);
    expect(servedBy(docs, 'GET /docs/guide/install/linux')).toEqual(['GET /docs/:id']);
    expect(servedBy(docs, 'GET /docs')).toEqual(['GET /docs/:id']);

    expect(servedBy(['GET /orders', 'GET /orders/{**rest}'], 'GET /orders')).toEqual(['GET /orders']);
    expect(servedBy(['GET /archive', 'GET /archive/{page?}'], 'GET /archive')).toEqual(['GET /archive']);
  });

  test('matches routes on method, and literals without case or percent-encoding', () => {
    expect(servedBy(['POST /blog/{slug}'], 'GET /blog/hello')).toEqual([]);
    expect(servedBy(['get /Home/Privacy'], 'GET /home/privacy')).toEqual(['GET /Home/Privacy']);
    expect(servedBy(['GET /café/{id}'], 'GET /caf%C3%A9/menu')).toEqual(['GET /café/:id']);
  });

  test('matches pages the same way', () => {
    expect(servedBy(['/blog/{slug}', '/blog/new'], '/blog/hello-world', 'page')).toEqual(['/blog/:id']);
    expect(servedBy(['/blog/{slug}', '/blog/new'], '/blog/new', 'page')).toEqual(['/blog/new']);
  });

  test('reads the key when a node stores no patterns', () => {
    const match = createDeclaredMatcher([
      { kind: 'route', key: 'GET /blog/:id', attrs: null },
      { kind: 'route', key: 'GET /files/**', attrs: { declared: true, responses: [] } },
      {
        kind: 'page',
        key: '/orders/:uuid',
        attrs: { url: 'https://shop.test/orders/0f8fad5b-d9cb-469f-a165-70867728950e' },
      },
    ]);
    expect(match('route', 'GET /blog/hello')).toEqual(['GET /blog/:id']);
    expect(match('route', 'GET /files/a/b')).toEqual(['GET /files/**']);
    expect(match('page', '/orders/:uuid')).toEqual(['/orders/:uuid']);
    expect(match('page', '/orders/latest')).toEqual([]);
  });
});

describe('parseOpenApiSpec', () => {
  test('one route per path × method with documented codes', () => {
    const manifest = parseOpenApiSpec({
      paths: {
        '/orders/{id}': {
          get: { responses: { '200': {}, '404': {} } },
          delete: { responses: { '204': {}, '409': {}, default: {} } },
          parameters: [],
        },
      },
    });
    const routes = manifest.routes ?? [];
    expect(routes).toHaveLength(2);
    const del = routes.find((r) => r.method === 'DELETE');
    expect(del?.pattern).toBe('/orders/{id}');
    expect(del?.responses).toEqual([204, 409]);
  });

  test('malformed input yields an empty manifest', () => {
    expect(parseOpenApiSpec(null).routes).toEqual([]);
    expect(parseOpenApiSpec({ paths: 'nope' }).routes).toEqual([]);
  });

  test('caps the route count so a huge spec cannot mint unbounded nodes', async () => {
    const { MAX_OPENAPI_ROUTES } = await import('#shared/openapi');
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < MAX_OPENAPI_ROUTES + 50; i++) paths[`/r${i}`] = { get: { responses: { '200': {} } } };
    const manifest = parseOpenApiSpec({ paths });
    expect(manifest.routes).toHaveLength(MAX_OPENAPI_ROUTES);
  });
});

describe('extractImports / buildImportEdges', () => {
  const known = new Set(['src/api/orders.post.ts', 'src/lib/pricing.ts', 'src/lib/db/index.ts']);

  test('resolves relative imports to known files, drops aliases and bare specifiers', () => {
    const content = [
      "import { price } from '../lib/pricing';",
      "import { db } from '../lib/db';",
      "import { z } from 'zod';",
      "import cfg from '#shared/config';",
      "const x = require('../outside/thing');",
    ].join('\n');
    const imports = extractImports('src/api/orders.post.ts', content, known);
    expect(imports).toContain('src/lib/pricing.ts');
    expect(imports).toContain('src/lib/db/index.ts');
    expect(imports).not.toContain('zod');
  });

  test('buildImportEdges makes file nodes and imports edges with origin import', () => {
    const { nodes, edges } = buildImportEdges([{ from: 'src/a.ts', to: 'src/b.ts' }]);
    expect(nodes.every((n) => n.kind === 'file' && n.origin === 'import')).toBe(true);
    expect(edges[0]).toMatchObject({ fromKey: 'src/a.ts', toKey: 'src/b.ts', kind: 'imports', origin: 'import' });
  });
});

describe('detectDeclaredNeverHit', () => {
  test('flags an unreached declared route and names its documented codes', () => {
    const gaps = detectDeclaredNeverHit([
      {
        nodeKind: 'route',
        nodeKey: 'DELETE /api/orders/:id',
        origin: 'openapi',
        reachCount: 0,
        documentedCodes: [200, 404, 409],
      },
      { nodeKind: 'route', nodeKey: 'GET /api/cart', origin: 'manifest', reachCount: 3 },
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.detector).toBe('declared-never-hit');
    expect(gaps[0]!.class).toBe('blind-spot');
    expect(gaps[0]!.evidence[0]).toContain('Declared in OpenAPI');
    expect(gaps[0]!.evidence[0]).toContain('200, 404, 409');
  });
});

describe('detectSuccessOnly with documented codes', () => {
  const base: RouteStat = { key: 'GET /api/cart', method: 'GET', pattern: '/api/cart', count: 412, statuses: [200] };

  test('names documented error codes never returned under test', () => {
    const gaps = detectSuccessOnly([{ ...base, documentedCodes: [200, 401, 409] }]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.title).toContain('401/409');
    expect(gaps[0]!.evidence.some((e) => e.includes('Documents 401, 409'))).toBe(true);
  });

  test('a route with no documented error codes reads as the plain success-only gap', () => {
    const gaps = detectSuccessOnly([base]);
    expect(gaps[0]!.title).toBe('GET /api/cart: no error path under test');
    expect(gaps[0]!.evidence).toHaveLength(1);
  });
});
