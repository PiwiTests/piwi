import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { parseFlakePlan, type FlakeCondition } from '@piwitests/core/flake-plan';
import { flakeContextOptions, installFlakeConditions, markFlakeContext } from '../src/internal/flake/mode.js';
import { installProbeInterception } from '../src/internal/probe/interception.js';
import { startServer, type FakeServer } from './_helpers.js';

/**
 * Flake conditions against a real Chromium and a local fixture server: each
 * route condition acts on its own route only, the ordinal `match` counts
 * requests after the first navigation, the CPU rate reaches the page through
 * a DevTools session, and the page of a context created with the arm sees its
 * time zone and locale.
 */

let server: FakeServer;
let browser: Browser;

const PAGE = `<!doctype html><html><body><script>
  window.timed = async (path, init) => {
    const start = performance.now();
    try {
      const res = await fetch(path, init);
      await res.text();
      return { ms: performance.now() - start, status: res.status, error: null };
    } catch (e) {
      return { ms: performance.now() - start, status: 0, error: String(e) };
    }
  };
</script></body></html>`;

beforeAll(async () => {
  server = await startServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/index')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url }));
  });
  browser = await chromium.launch();
  // A browser launch can take longer than the default hook timeout while other
  // specs (a whole Playwright run among them) share the machine.
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

function planWith(...conditions: FlakeCondition[]) {
  return parseFlakePlan({
    version: 1,
    experimentId: 'exp',
    test: { file: 'tests/a.spec.ts', title: 't', suite: [], project: null },
    arm: { id: 'arm', conditions },
    errorSignatures: [],
  });
}

async function openWith(...conditions: FlakeCondition[]) {
  const page = await browser.newPage();
  const installed = await installFlakeConditions(page, planWith(...conditions));
  await page.goto(`${server.url}/`);
  return { page, installed };
}

type Timed = { ms: number; status: number; error: string | null };
const timed = (page: Page, path: string, method = 'GET'): Promise<Timed> =>
  page.evaluate(
    ([p, m]) =>
      (globalThis as unknown as { timed: (p: string, i: { method: string }) => Promise<Timed> }).timed(p, {
        method: m,
      }),
    [path, method],
  );

describe('flake conditions in Chromium', () => {
  it('delays only the named route, to at least ms after the request started', async () => {
    const { page, installed } = await openWith({ kind: 'delay', route: 'GET /api/cart/:id', ms: 800, match: 'all' });
    const slow = await timed(page, '/api/cart/42');
    const other = await timed(page, '/api/orders/42');
    const otherMethod = await timed(page, '/api/cart/42', 'POST');
    expect(slow.status).toBe(200);
    expect(slow.ms).toBeGreaterThanOrEqual(780);
    expect(other.ms).toBeLessThan(400);
    expect(otherMethod.ms).toBeLessThan(400);
    expect(installed.reports()).toEqual([{ kind: 'delay', outcome: 'applied' }]);
    await page.close();
  });

  it('delays only the Nth matching request after the first navigation', async () => {
    const { page } = await openWith({ kind: 'delay', route: 'GET /api/cart', ms: 700, match: 2 });
    const first = await timed(page, '/api/cart');
    const second = await timed(page, '/api/cart');
    const third = await timed(page, '/api/cart');
    expect(first.ms).toBeLessThan(400);
    expect(second.ms).toBeGreaterThanOrEqual(680);
    expect(third.ms).toBeLessThan(400);
    await page.close();
  });

  it('reports a route condition whose route was never called as not matched', async () => {
    const { page, installed } = await openWith({ kind: 'delay', route: 'GET /api/never', ms: 100, match: 'all' });
    await timed(page, '/api/cart');
    expect(installed.reports()).toEqual([{ kind: 'delay', outcome: 'not-matched' }]);
    await page.close();
  });

  it('answers a failed route with its status', async () => {
    const { page, installed } = await openWith({ kind: 'fail', route: 'POST /api/orders', status: 503, match: 'all' });
    expect((await timed(page, '/api/orders', 'POST')).status).toBe(503);
    expect((await timed(page, '/api/orders')).status).toBe(200);
    expect(installed.reports()).toEqual([{ kind: 'fail', outcome: 'applied' }]);
    const served = server.requests.filter((r) => r.url === '/api/orders');
    expect(served.map((r) => r.method)).toEqual(['GET']);
    await page.close();
  });

  it('resets the connection of an aborted route', async () => {
    const { page } = await openWith({ kind: 'fail', route: 'GET /api/cart', abort: true, match: 'all' });
    const aborted = await timed(page, '/api/cart');
    expect(aborted.status).toBe(0);
    expect(aborted.error).toMatch(/TypeError/);
    await page.close();
  });

  it('sets the CPU rate through a DevTools session and slows the page', async () => {
    const busy = (page: Page) =>
      page.evaluate(() => {
        const start = performance.now();
        let x = 0;
        for (let i = 0; i < 3e7; i++) x += i % 7;
        return { ms: performance.now() - start, x };
      });
    const plain = await browser.newPage();
    await plain.goto(`${server.url}/`);
    await busy(plain);
    const baseline = (await busy(plain)).ms;
    await plain.close();

    const sent: Array<{ method: string; params: unknown }> = [];
    const page = await browser.newPage();
    const context = page.context();
    const open = context.newCDPSession.bind(context);
    context.newCDPSession = (async (target: Page) => {
      const session = await open(target);
      const send = session.send.bind(session);
      session.send = ((method: string, params?: unknown) => {
        sent.push({ method, params });
        return send(method as never, params as never);
      }) as typeof session.send;
      return session;
    }) as typeof context.newCDPSession;

    const installed = await installFlakeConditions(page, planWith({ kind: 'cpu', rate: 6 }));
    await page.goto(`${server.url}/`);
    await busy(page);
    const throttled = (await busy(page)).ms;
    expect(sent).toEqual([{ method: 'Emulation.setCPUThrottlingRate', params: { rate: 6 } }]);
    expect(installed.reports()).toEqual([{ kind: 'cpu', outcome: 'applied' }]);
    expect(throttled).toBeGreaterThan(baseline * 2);
    await page.close();
  });

  it('sets the time zone and locale of a context created with the arm, and skips them elsewhere', async () => {
    const plan = planWith({ kind: 'timezone', timeZone: 'Asia/Tokyo' }, { kind: 'locale', locale: 'fr-FR' });
    const context = await browser.newContext({ ...flakeContextOptions(plan) });
    markFlakeContext(context);
    const page = await context.newPage();
    const installed = await installFlakeConditions(page, plan);
    await page.goto(`${server.url}/`);
    const seen = await page.evaluate(() => ({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
    }));
    expect(seen).toEqual({ timeZone: 'Asia/Tokyo', language: 'fr-FR' });
    expect(installed.reports()).toEqual([
      { kind: 'timezone', outcome: 'applied' },
      { kind: 'locale', outcome: 'applied' },
    ]);
    await context.close();

    const other = await browser.newPage();
    const skipped = await installFlakeConditions(other, plan);
    expect(skipped.reports().map((r) => r.outcome)).toEqual(['skipped', 'skipped']);
    await other.close();
  });

  it('emulates network conditions through a DevTools session', async () => {
    const { page, installed } = await openWith({ kind: 'network', latencyMs: 600, downKbps: 5000, upKbps: 5000 });
    const res = await timed(page, '/api/cart');
    expect(installed.reports()).toEqual([{ kind: 'network', outcome: 'applied' }]);
    expect(res.ms).toBeGreaterThanOrEqual(550);
    await page.close();
  });

  it('only records the conditions the command line applies', async () => {
    const { page, installed } = await openWith(
      { kind: 'alongside', test: { file: 'tests/b.spec.ts', title: 'b', suite: [] } },
      { kind: 'project', name: 'chromium' },
    );
    expect(installed.reports()).toEqual([
      { kind: 'alongside', outcome: 'by-command' },
      { kind: 'project', outcome: 'by-command' },
    ]);
    await page.close();
  });
});

describe('probe interception through the shared rules', () => {
  const item = (fault: string, nth: number) => ({
    testCaseId: 1,
    testTitle: 't',
    filePath: null,
    suitePath: [],
    routeKey: 'GET /api/orders/:id',
    fault,
    nth,
  });

  it('applies a fault to the Nth match once and leaves the rest alone', async () => {
    const page = await browser.newPage();
    const probe = await installProbeInterception(page, item('status-500', 2));
    await page.goto(`${server.url}/`);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await timed(page, `/api/orders/${i}`)).status);
    expect(statuses).toEqual([200, 500, 200]);
    expect(probe.applied()).toBe(true);
    expect(probe.appliedFault()).toBe('status-500');
    await page.close();
  });

  it('records a no-op fault as not applied', async () => {
    const page = await browser.newPage();
    const probe = await installProbeInterception(page, item('stale-value', 1));
    await page.goto(`${server.url}/`);
    expect((await timed(page, '/api/orders/1')).status).toBe(200);
    expect(probe.applied()).toBe(false);
    await page.close();
  });
});
