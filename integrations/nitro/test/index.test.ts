import { createServer, IncomingMessage, ServerResponse, type Server } from 'node:http';
import { Socket, type AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { consola } from 'consola';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, createRouter, eventHandler, toNodeListener } from 'h3';

/** Decode an X-Piwi-Logs or X-Piwi-Trace header. */
function decodeHeader<T>(header: string | null): T[] {
  return header ? (JSON.parse(gunzipSync(Buffer.from(header, 'base64')).toString('utf8')) as T[]) : [];
}

/** Call the app in process, as Nitro's `localFetch` does for a `$fetch` made during server-side rendering. */
async function localCall(app: ReturnType<typeof createApp>, url: string): Promise<void> {
  const req = new IncomingMessage(new Socket());
  req.url = url;
  req.method = 'GET';
  await toNodeListener(app)(req, new ServerResponse(req));
}

/** Decode the root-span `piwi.probe.applied` attribute from an X-Piwi-Trace header. */
function appliedFaultFromTrace(header: string | null): string | undefined {
  if (!header) return undefined;
  const spans = JSON.parse(gunzipSync(Buffer.from(header, 'base64')).toString('utf8')) as Array<{
    parentId?: string;
    attrs?: Record<string, unknown>;
  }>;
  const root = spans.find((s) => !s.parentId);
  const applied = root?.attrs?.['piwi.probe.applied'];
  return applied != null ? String(applied) : undefined;
}

/**
 * Drive the wrapped h3 handler the way Nitro's node entry does — through
 * `toNodeListener`, which ignores the handler's return value — so a fault that
 * only sets a return value (rather than ending the response) would hang the
 * request. A real HTTP round-trip proves the response actually completes.
 */

const SECRET = 'index-test-probe-secret';

interface LoadedPlugin {
  install: (env: Record<string, string>) => Promise<{ nitroApp: { h3App: ReturnType<typeof createApp> } }>;
}

/** Fresh module load so the env-derived module constants pick up the stubs. */
async function loadWithEnv(env: Record<string, string>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const mod = await import('../src/index');
  return mod;
}

function signHeader(
  mod: Awaited<ReturnType<typeof loadWithEnv>>,
  spec: Record<string, unknown>,
  ts: number,
  nonce: string,
): string {
  const specJson = JSON.stringify(spec);
  const sig = mod.signProbeMessage(SECRET, nonce, ts, specJson);
  return Buffer.from(JSON.stringify({ nonce, ts, specJson, sig })).toString('base64');
}

async function withServer(
  app: ReturnType<typeof createApp>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(toNodeListener(app));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('piwiTestLogs wrapped handler (through toNodeListener)', () => {
  it('extreme fault ends the response instead of hanging', async () => {
    const mod = await loadWithEnv({
      PIWI_PROBE_SECRET: SECRET,
      PIWI_SERVER_PROBES: 'true',
      PIWI_TEST_LOGS_DISABLED: 'false',
      NODE_ENV: 'test',
    });
    const app = createApp();
    app.use(
      '/api/orders',
      eventHandler(() => ({ ok: true })),
    );
    mod.default({ h3App: app, hooks: { hook: () => {} } } as never);

    await withServer(app, async (base) => {
      const header = signHeader(mod, { route: 'POST /api/orders', fault: 'extreme' }, Date.now(), 'extreme-nonce');
      const res = await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'x-piwi-probe': header } });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
      // The instrumentation still names the honored fault on the response trace.
      expect(res.headers.get('x-piwi-trace')).toBeTruthy();
    });
  });

  it('passes an unprobed request through to the original handler with trace headers', async () => {
    const mod = await loadWithEnv({
      PIWI_TEST_LOGS_DISABLED: 'false',
      NODE_ENV: 'test',
    });
    const app = createApp();
    app.use(
      '/api/cart',
      eventHandler(() => ({ items: 1 })),
    );
    mod.default({ h3App: app, hooks: { hook: () => {} } } as never);

    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/cart`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: 1 });
      expect(res.headers.get('x-piwi-trace')).toBeTruthy();
    });
  });

  it('names the applied fault on the trace when a status fault takes effect', async () => {
    const mod = await loadWithEnv({
      PIWI_PROBE_SECRET: SECRET,
      PIWI_SERVER_PROBES: 'true',
      PIWI_TEST_LOGS_DISABLED: 'false',
      NODE_ENV: 'test',
    });
    const app = createApp();
    app.use(
      '/api/orders',
      eventHandler(() => ({ ok: true })),
    );
    mod.default({ h3App: app, hooks: { hook: () => {} } } as never);

    await withServer(app, async (base) => {
      const header = signHeader(mod, { route: 'POST /api/orders', fault: 'status' }, Date.now(), 'status-nonce');
      const res = await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'x-piwi-probe': header } });
      expect(res.status).toBe(500);
      expect(appliedFaultFromTrace(res.headers.get('x-piwi-trace'))).toBe('status');
    });
  });

  it('does not mark an unimplemented (replay) fault applied', async () => {
    const mod = await loadWithEnv({
      PIWI_PROBE_SECRET: SECRET,
      PIWI_SERVER_PROBES: 'true',
      PIWI_TEST_LOGS_DISABLED: 'false',
      NODE_ENV: 'test',
    });
    const app = createApp();
    app.use(
      '/api/orders',
      eventHandler(() => ({ ok: true })),
    );
    mod.default({ h3App: app, hooks: { hook: () => {} } } as never);

    await withServer(app, async (base) => {
      const header = signHeader(mod, { route: 'POST /api/orders', fault: 'replay' }, Date.now(), 'replay-nonce');
      const res = await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'x-piwi-probe': header } });
      // The route matched but `replay` is not implemented: the request passes
      // through unchanged and the trace carries no applied marker (inconclusive).
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(appliedFaultFromTrace(res.headers.get('x-piwi-trace'))).toBeUndefined();
    });
  });
});

describe('when capture is on', () => {
  async function traceHeader(env: Record<string, string>): Promise<string | null> {
    const mod = await loadWithEnv(env);
    const app = createApp();
    app.use(
      '/api/cart',
      eventHandler(() => ({ items: 1 })),
    );
    mod.default({ h3App: app, hooks: { hook: () => {} } } as never);
    let header: string | null = null;
    await withServer(app, async (base) => {
      header = (await fetch(`${base}/api/cart`)).headers.get('x-piwi-trace');
    });
    return header;
  }

  it('is on in development and test', async () => {
    expect(await traceHeader({ NODE_ENV: 'development' })).toBeTruthy();
    expect(await traceHeader({ NODE_ENV: 'test' })).toBeTruthy();
  });

  it('is off when NODE_ENV is not set, as for a built server started with node, unless opted in', async () => {
    expect(await traceHeader({ NODE_ENV: '' })).toBeNull();
    expect(await traceHeader({ NODE_ENV: 'production' })).toBeNull();
    expect(await traceHeader({ NODE_ENV: '', PIWI_TEST_LOGS_DISABLED: 'false' })).toBeTruthy();
    expect(await traceHeader({ NODE_ENV: 'test', PIWI_TEST_LOGS_DISABLED: 'true' })).toBeNull();
  });
});

describe('the logs of a request', () => {
  const load = async () => {
    const mod = await loadWithEnv({ PIWI_TEST_LOGS_DISABLED: 'false', NODE_ENV: 'test' });
    const app = createApp();
    return { mod, app };
  };

  it('keeps at most 50 entries as they are logged', async () => {
    const { mod, app } = await load();
    app.use(
      '/api/noisy',
      eventHandler((event) => {
        for (let i = 0; i < 120; i++) consola.warn(`retrying ${i}`);
        return { kept: (event.context._piwiLogs as unknown[]).length };
      }),
    );
    mod.default({ h3App: app, hooks: { hook: () => {} } } as never);

    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/noisy`);
      expect(await res.json()).toEqual({ kept: 50 });
      expect(decodeHeader(res.headers.get('x-piwi-logs'))).toHaveLength(50);
    });
  });

  it('records nothing once the response ended', async () => {
    const { mod, app } = await load();
    let logs: Array<{ message: string }> = [];
    let late!: Promise<void>;
    app.use(
      '/api/lazy',
      eventHandler((event) => {
        logs = event.context._piwiLogs as typeof logs;
        late = new Promise((resolve) =>
          setTimeout(() => {
            consola.warn('reconnecting');
            resolve();
          }, 20),
        );
        return { ok: true };
      }),
    );
    mod.default({ h3App: app, hooks: { hook: () => {} } } as never);

    await withServer(app, async (base) => {
      await (await fetch(`${base}/api/lazy`)).json();
      await late;
      expect(logs).toEqual([]);
    });
  });

  it('adds the logs and spans of an internal call to the request it runs in', async () => {
    const { mod, app } = await load();
    const router = createRouter()
      .get(
        '/api/cart',
        eventHandler(() => {
          consola.warn('cart service slow');
          return { items: 1 };
        }),
      )
      .get(
        '/shop',
        eventHandler(async () => {
          await localCall(app, '/api/cart');
          consola.warn('rendered without a price');
          return '<html></html>';
        }),
      );
    app.use(router);
    mod.default({ h3App: app, hooks: { hook: () => {} } } as never);

    await withServer(app, async (base) => {
      const res = await fetch(`${base}/shop`);
      const logs = decodeHeader<{ message: string }>(res.headers.get('x-piwi-logs'));
      expect(logs.map((l) => l.message)).toEqual(['cart service slow', 'rendered without a price']);
      const spans = decodeHeader<{ id: string; name: string; parentId?: string }>(res.headers.get('x-piwi-trace'));
      const root = spans.find((s) => !s.parentId)!;
      expect(root.name).toBe('GET /shop');
      expect(spans.find((s) => s.name === 'GET /api/cart')?.parentId).toBe(root.id);
    });
  });
});

describe('the route manifest', () => {
  it('records a route by the pattern h3 1.x matched it with, not by the requested path', async () => {
    const mod = await loadWithEnv({ PIWI_TEST_LOGS_DISABLED: 'false', NODE_ENV: 'test' });
    const app = createApp();
    const router = createRouter().get(
      '/api/products/:slug',
      eventHandler(() => ({ ok: true })),
    );
    app.use(router);
    mod.default({ h3App: app, hooks: { hook: () => {} } } as never);

    await withServer(app, async (base) => {
      expect((await fetch(`${base}/api/products/trail-shoes`)).status).toBe(200);
      const manifest = (await (await fetch(`${base}/__piwi/manifest`)).json()) as {
        routes: Array<{ method: string; pattern: string }>;
      };
      expect(manifest.routes.map((r) => `${r.method} ${r.pattern}`)).toContain('GET /api/products/:slug');
      expect(manifest.routes.map((r) => r.pattern)).not.toContain('/api/products/trail-shoes');
    });
  });

  it('records only the routes a router handler matched: no 404, no asset served before the router', async () => {
    const mod = await loadWithEnv({ PIWI_TEST_LOGS_DISABLED: 'false', NODE_ENV: 'test' });
    const app = createApp();
    // Nitro serves public assets in a handler that runs before the router.
    app.use(
      '/_nuxt',
      eventHandler(() => 'asset'),
    );
    app.use(
      createRouter().get(
        '/api/cart',
        eventHandler(() => ({ items: 1 })),
      ),
    );
    mod.default({ h3App: app, hooks: { hook: () => {} } } as never);

    await withServer(app, async (base) => {
      expect((await fetch(`${base}/_nuxt/entry.js`)).status).toBe(200);
      expect((await fetch(`${base}/api/missing/42`)).status).toBe(404);
      expect((await fetch(`${base}/api/cart`)).status).toBe(200);
      const manifest = (await (await fetch(`${base}/__piwi/manifest`)).json()) as {
        routes: Array<{ method: string; pattern: string }>;
      };
      expect(manifest.routes.map((r) => `${r.method} ${r.pattern}`)).toEqual(['GET /api/cart']);
    });
  });

  it('lists the routes the module declared, reached or not, before the observed ones', async () => {
    const mod = await loadWithEnv({ PIWI_TEST_LOGS_DISABLED: 'false', NODE_ENV: 'test' });
    (globalThis as Record<string, unknown>).__piwiDeclaredRoutes = [
      { method: 'GET', pattern: '/shop/orders', handler: 'routes/shop/orders.get.ts' },
      { method: 'GET', pattern: '/api/cart', handler: 'routes/api/cart.get.ts' },
    ];
    try {
      const app = createApp();
      app.use(
        '/api/cart',
        eventHandler(() => ({ items: 1 })),
      );
      mod.default({ h3App: app, hooks: { hook: () => {} } } as never);

      await withServer(app, async (base) => {
        await fetch(`${base}/api/cart`);
        const manifest = (await (await fetch(`${base}/__piwi/manifest`)).json()) as {
          routes: Array<{ method: string; pattern: string; handler?: string }>;
        };
        expect(manifest.routes).toContainEqual({
          method: 'GET',
          pattern: '/shop/orders',
          handler: 'routes/shop/orders.get.ts',
        });
        // The route a request reached is listed once, with the file the module named.
        expect(manifest.routes.filter((r) => r.pattern === '/api/cart')).toEqual([
          { method: 'GET', pattern: '/api/cart', handler: 'routes/api/cart.get.ts' },
        ]);
      });
    } finally {
      delete (globalThis as Record<string, unknown>).__piwiDeclaredRoutes;
    }
  });
});
