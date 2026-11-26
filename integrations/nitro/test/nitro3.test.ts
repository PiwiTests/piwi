import { gunzipSync } from 'node:zlib';
import { consola } from 'consola';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Decode an X-Piwi-Logs or X-Piwi-Trace header. */
function decodeHeader<T>(header: string | null): T[] {
  return header ? (JSON.parse(gunzipSync(Buffer.from(header, 'base64')).toString('utf8')) as T[]) : [];
}

interface Span {
  name: string;
  parentId?: string;
  status?: string;
  attrs?: Record<string, unknown>;
}

const SECRET = 'nitro3-test-probe-secret';

/** Fresh module load so the env-derived module constants pick up the stubs. */
async function loadWithEnv(env: Record<string, string>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import('../src/index');
}

function signHeader(mod: Awaited<ReturnType<typeof loadWithEnv>>, spec: Record<string, unknown>, nonce: string): string {
  const specJson = JSON.stringify(spec);
  const ts = Date.now();
  const sig = mod.signProbeMessage(SECRET, nonce, ts, specJson);
  return Buffer.from(JSON.stringify({ nonce, ts, specJson, sig })).toString('base64');
}

type Route = (request: Request, app: { fetch: (request: Request) => Promise<Response> }) => Response | Promise<Response>;

/**
 * A Nitro 3 app as its plugins receive it: every request reaches the routes through `fetch`, with the context Nitro
 * hands to the event, which collects the errors it captures.
 */
function nitro3App(routes: Record<string, Route>) {
  const app = {
    fetch: async (request: Request): Promise<Response> => {
      const context = ((request as Request & { context?: Record<string, any> }).context ??= {});
      context.nitro ??= { errors: [] };
      const route = routes[new URL(request.url).pathname];
      if (!route) return new Response('Not found', { status: 404 });
      return route(request, app);
    },
  };
  return app;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the plugin on Nitro 3', () => {
  it('names the logs and the spans of a request on its response', async () => {
    const mod = await loadWithEnv({ NODE_ENV: 'test' });
    const app = nitro3App({
      '/api/cart': () => {
        consola.warn('cart service slow');
        mod.recordServerSpan({ id: 'aa', name: 'db', startMs: Date.now(), durMs: 1 });
        return Response.json({ items: 1 });
      },
    });
    mod.default(app);

    const res = await app.fetch(new Request('http://localhost/api/cart'));
    expect(await res.json()).toEqual({ items: 1 });
    const logs = decodeHeader<{ level: string; message: string }>(res.headers.get('x-piwi-logs'));
    expect(logs).toEqual([expect.objectContaining({ level: 'Warning', message: 'cart service slow' })]);
    const spans = decodeHeader<Span>(res.headers.get('x-piwi-trace'));
    const root = spans.find((span) => !span.parentId);
    expect(root).toMatchObject({ name: 'GET /api/cart', status: 'ok', attrs: { 'http.status_code': 200 } });
    expect(spans.find((span) => span.name === 'db')?.parentId).toBe((root as { id?: string }).id);
  });

  it('logs the errors Nitro captured and marks an error response on the root span', async () => {
    const mod = await loadWithEnv({ NODE_ENV: 'test' });
    const app = nitro3App({
      '/api/fail': (request) => {
        (request as Request & { context: { nitro: { errors: unknown[] } } }).context.nitro.errors.push({
          error: new Error('database is down'),
        });
        return Response.json({ message: 'Server error' }, { status: 500 });
      },
    });
    mod.default(app);

    const res = await app.fetch(new Request('http://localhost/api/fail'));
    expect(res.status).toBe(500);
    expect(decodeHeader<{ message: string }>(res.headers.get('x-piwi-logs'))).toEqual([
      expect.objectContaining({ level: 'Error', message: 'database is down' }),
    ]);
    expect(decodeHeader<Span>(res.headers.get('x-piwi-trace'))[0]?.status).toBe('error');
  });

  it('adds its headers to a response whose headers cannot change', async () => {
    const mod = await loadWithEnv({ NODE_ENV: 'test' });
    const app = nitro3App({ '/go': () => Response.redirect('http://localhost/elsewhere', 302) });
    mod.default(app);

    const res = await app.fetch(new Request('http://localhost/go'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost/elsewhere');
    expect(res.headers.get('x-piwi-trace')).toBeTruthy();
  });

  it('hands the logs of a request made inside another one to the enclosing request', async () => {
    const mod = await loadWithEnv({ NODE_ENV: 'test' });
    const app = nitro3App({
      '/api/price': () => {
        consola.warn('rendered without a price');
        return Response.json({ price: null });
      },
      '/page': async (_request, self) => {
        await self.fetch(new Request('http://localhost/api/price'));
        return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
      },
    });
    mod.default(app);

    const res = await app.fetch(new Request('http://localhost/page'));
    expect(decodeHeader<{ message: string }>(res.headers.get('x-piwi-logs'))).toEqual([
      expect.objectContaining({ message: 'rendered without a price' }),
    ]);
    const names = decodeHeader<Span>(res.headers.get('x-piwi-trace')).map((span) => span.name);
    expect(names).toEqual(['GET /page', 'GET /api/price']);
  });

  it('serves the manifest and the environment', async () => {
    const mod = await loadWithEnv({ NODE_ENV: 'test' });
    const app = nitro3App({ '/api/cart': () => Response.json({ items: 1 }) });
    mod.default(app);

    const manifest = await app.fetch(new Request('http://localhost/__piwi/manifest'));
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toHaveProperty('routes');
    const environment = await app.fetch(new Request('http://localhost/__piwi/environment'));
    expect(environment.headers.get('cache-control')).toBe('no-store');
    expect(environment.status).toBe(200);
  });

  it('applies a status fault, and names it on the trace', async () => {
    const mod = await loadWithEnv({ PIWI_PROBE_SECRET: SECRET, PIWI_SERVER_PROBES: 'true', NODE_ENV: 'test' });
    const handler = vi.fn(() => Response.json({ ok: true }));
    const app = nitro3App({ '/api/orders': handler });
    mod.default(app);

    const probe = signHeader(mod, { route: 'POST /api/orders', fault: 'status' }, 'status-nonce');
    const res = await app.fetch(
      new Request('http://localhost/api/orders', { method: 'POST', headers: { 'x-piwi-probe': probe } }),
    );
    expect(res.status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
    expect(decodeHeader<Span>(res.headers.get('x-piwi-trace'))[0]?.attrs?.['piwi.probe.applied']).toBe('status');
  });

  it('applies a data fault to a JSON body', async () => {
    const mod = await loadWithEnv({ PIWI_PROBE_SECRET: SECRET, PIWI_SERVER_PROBES: 'true', NODE_ENV: 'test' });
    const app = nitro3App({ '/api/orders': () => Response.json({ total: 12, currency: 'EUR' }) });
    mod.default(app);

    const probe = signHeader(mod, { route: 'GET /api/orders', fault: 'data' }, 'data-nonce');
    const res = await app.fetch(new Request('http://localhost/api/orders', { headers: { 'x-piwi-probe': probe } }));
    expect(await res.json()).not.toEqual({ total: 12, currency: 'EUR' });
    expect(decodeHeader<Span>(res.headers.get('x-piwi-trace'))[0]?.attrs?.['piwi.probe.applied']).toBe('data');
  });

  it('answers an extreme fault with an empty response', async () => {
    const mod = await loadWithEnv({ PIWI_PROBE_SECRET: SECRET, PIWI_SERVER_PROBES: 'true', NODE_ENV: 'test' });
    const app = nitro3App({ '/api/orders': () => Response.json({ ok: true }) });
    mod.default(app);

    const probe = signHeader(mod, { route: 'GET /api/orders', fault: 'extreme' }, 'extreme-nonce');
    const res = await app.fetch(new Request('http://localhost/api/orders', { headers: { 'x-piwi-probe': probe } }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('leaves the app alone while capture is off', async () => {
    const mod = await loadWithEnv({ NODE_ENV: 'production' });
    const app = nitro3App({ '/api/cart': () => Response.json({ items: 1 }) });
    const original = app.fetch;
    mod.default(app);
    expect(app.fetch).toBe(original);
  });
});
