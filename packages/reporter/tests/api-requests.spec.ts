import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, request, type APIResponse, type Browser, type Page } from '@playwright/test';
import {
  apiCallEntry,
  observeApiRequestContext,
  observeApiRequests,
  type ApiCall,
  type ApiCallRecorder,
} from '../src/internal/capture/api-requests.js';
import { ATTACHMENT_NAMES } from '../src/internal/capture/attachments.js';
import { piwiFixtures } from '../src/internal/capture/capture-fixtures.js';

/** A response as `APIResponse` exposes it, with Playwright's timing when `timing` is given. */
function fakeResponse(
  opts: { url?: string; status?: number; headers?: Record<string, string>; timing?: Record<string, number> } = {},
): APIResponse {
  return {
    url: () => opts.url ?? 'https://shop.test/api/items',
    status: () => opts.status ?? 200,
    headers: () => ({ 'content-type': 'application/json', ...opts.headers }),
    ...(opts.timing
      ? {
          timing: () => ({
            startTime: -1,
            domainLookupStart: -1,
            domainLookupEnd: -1,
            connectStart: -1,
            secureConnectionStart: -1,
            connectEnd: -1,
            requestStart: -1,
            responseStart: -1,
            responseEnd: -1,
            ...opts.timing,
          }),
        }
      : {}),
  } as unknown as APIResponse;
}

const call = (overrides: Partial<ApiCall>): ApiCall => ({
  method: 'GET',
  url: '/api/items',
  baseURL: null,
  startedAt: 1_000,
  endedAt: 1_250,
  response: null,
  ...overrides,
});

describe('apiCallEntry', () => {
  it('takes the URL, status and timing of the response, with no resource type', () => {
    const response = fakeResponse({ timing: { startTime: 5_000, requestStart: 3, responseEnd: 45 } });
    expect(apiCallEntry(call({ response }), null)).toEqual({
      method: 'GET',
      url: 'https://shop.test/api/items',
      status: 200,
      duration: 42,
      startTime: 5_000,
    });
  });

  it('times a response to its end when Playwright names no request start', () => {
    const response = fakeResponse({ timing: { startTime: 5_000, responseEnd: 45 } });
    expect(apiCallEntry(call({ response }), null)).toMatchObject({ duration: 45, startTime: 5_000 });
  });

  it("times a call by the proxy's clock when Playwright gives no timing", () => {
    for (const response of [fakeResponse(), fakeResponse({ timing: { responseEnd: 45 } })]) {
      expect(apiCallEntry(call({ response }), null)).toMatchObject({ duration: 250, startTime: 1_000 });
    }
  });

  it("records a call that threw with status 0 and its error's first line, without Playwright's prefix", () => {
    const error = new Error('apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:9\nCall log:\n  - → POST');
    expect(apiCallEntry(call({ method: 'POST', url: 'https://shop.test/api/orders', error }), null)).toEqual({
      method: 'POST',
      url: 'https://shop.test/api/orders',
      status: 0,
      duration: 250,
      startTime: 1_000,
      failure: 'connect ECONNREFUSED 127.0.0.1:9',
    });
  });

  it('records the status Playwright failed a call for, with failOnStatusCode', () => {
    const error = new Error('apiRequestContext.get: 503 Service Unavailable\nResponse text:\nbusy');
    const entry = apiCallEntry(call({ url: 'https://shop.test/api/items', error }), null);
    expect(entry).toMatchObject({ status: 503 });
    expect(entry).not.toHaveProperty('failure');
  });

  it("resolves a thrown call's URL against its context's base URL, else the test's", () => {
    const error = new Error('apiRequestContext.get: Timeout 1000ms exceeded.');
    expect(
      apiCallEntry(call({ baseURL: 'https://api.shop.test/v1/', url: 'items', error }), 'https://shop.test'),
    ).toMatchObject({ url: 'https://api.shop.test/v1/items', failure: 'Timeout 1000ms exceeded.' });
    expect(apiCallEntry(call({ error }), 'https://shop.test')).toMatchObject({ url: 'https://shop.test/api/items' });
    expect(apiCallEntry(call({ error }), null)).toMatchObject({ url: '/api/items' });
  });

  it('records nothing for a thrown call that named no URL, and caps a long error', () => {
    expect(apiCallEntry(call({ url: null, error: new Error('First argument must be a URL') }), null)).toBeNull();
    const entry = apiCallEntry(call({ url: 'https://shop.test/x', error: 'x'.repeat(1_000) }), null);
    expect((entry!.failure as string).length).toBe(300);
  });
});

/** A context whose methods call each other as Playwright's do: every verb calls `this.fetch`. */
class FakeContext {
  fetched: Array<{ url: unknown; method?: string }> = [];
  disposedAs: unknown[] = [];
  fail: Error | null = null;

  async fetch(url: unknown, options: { method?: string } = {}): Promise<APIResponse> {
    this.fetched.push({ url, method: options.method });
    if (this.fail) throw this.fail;
    return fakeResponse({ url: `https://shop.test${String(url)}` });
  }
  async get(url: string, options: object = {}): Promise<APIResponse> {
    return this.fetch(url, { ...options, method: 'GET' });
  }
  async post(url: string, options: object = {}): Promise<APIResponse> {
    return this.fetch(url, { ...options, method: 'POST' });
  }
  async dispose(): Promise<void> {
    this.disposedAs.push(this);
  }
}

describe('observeApiRequestContext', () => {
  const recorded: ApiCall[] = [];
  let recording = true;
  const recorder = (): ApiCallRecorder | null => (recording ? (c) => recorded.push(c) : null);
  afterEach(() => {
    recorded.length = 0;
    recording = true;
  });

  it('records each call once, although the verbs call fetch, and hands the test the response itself', async () => {
    const context = new FakeContext();
    const api = observeApiRequestContext(context, recorder);
    const response = await api.get('/api/items');
    await api.post('/api/orders');
    await api.fetch('/api/plain', { method: 'put' });
    await api.fetch({ url: () => '/api/request', method: () => 'delete' });
    expect(context.fetched).toHaveLength(4);
    expect(recorded.map((c) => [c.method, c.url])).toEqual([
      ['GET', '/api/items'],
      ['POST', '/api/orders'],
      ['PUT', '/api/plain'],
      ['DELETE', '/api/request'],
    ]);
    expect(recorded[0]!.response).toBe(response);
    expect(recorded[0]!.endedAt).toBeGreaterThanOrEqual(recorded[0]!.startedAt);
  });

  it('rethrows the error the call threw, after recording it', async () => {
    const context = new FakeContext();
    context.fail = new Error('apiRequestContext.get: connect ECONNREFUSED');
    const api = observeApiRequestContext(context, recorder);
    await expect(api.get('/api/items')).rejects.toBe(context.fail);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ response: null, error: context.fail });
  });

  it('leaves a call untouched between tests, and a recorder that throws never reaches the test', async () => {
    const context = new FakeContext();
    const api = observeApiRequestContext(context, recorder);
    recording = false;
    await api.get('/api/items');
    expect(recorded).toHaveLength(0);
    const failing = observeApiRequestContext(new FakeContext(), () => () => {
      throw new Error('recorder failed');
    });
    await expect(failing.get('/api/items')).resolves.toBeDefined();
  });

  it('binds the other methods to the context, and reads every property through', async () => {
    const context = new FakeContext();
    const api = observeApiRequestContext(context, recorder);
    await api.dispose();
    expect(context.disposedAs).toEqual([context]);
    expect(api.fetched).toBe(context.fetched);
    expect(api.get).toBe(api.get);
    expect(api.constructor).toBe(FakeContext);
    expect(api instanceof FakeContext).toBe(true);
  });

  it('hands out one proxy per context, and never wraps a proxy again', async () => {
    const context = new FakeContext();
    const api = observeApiRequestContext(context, recorder);
    expect(observeApiRequestContext(context, recorder)).toBe(api);
    expect(observeApiRequestContext(api, recorder)).toBe(api);
    await api.get('/api/items');
    expect(recorded).toHaveLength(1);
  });
});

describe('observeApiRequests', () => {
  it("hands out the contexts newContext creates behind the proxy, once, with the creation's base URL", async () => {
    const recorded: ApiCall[] = [];
    const apiRequest = { newContext: async (_options?: object) => new FakeContext() };
    const playwright = { request: apiRequest };
    observeApiRequests(playwright, () => (c) => recorded.push(c));
    observeApiRequests(playwright, () => (c) => recorded.push(c));
    const api = (await apiRequest.newContext({ baseURL: 'https://api.shop.test' })) as FakeContext;
    await api.get('/api/items');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.baseURL).toBe('https://api.shop.test');
    expect(() => observeApiRequests({}, () => null)).not.toThrow();
  });
});

describe('API request contexts through the capture fixtures', () => {
  let server: http.Server;
  let origin = '';
  let browser: Browser | null = null;

  const encoded = (value: unknown) => gzipSync(JSON.stringify(value)).toString('base64');
  const logsOf = (path: string) => [{ level: 'Warning', message: `Handled ${path}`, timestamp: 1 }];
  const span = { name: 'GET /api/items', kind: 'server', start: 1, end: 2 };

  const [resourcesFixture] = piwiFixtures.piwiResources as unknown as [
    (args: { playwright: unknown }, use: () => Promise<void>, info: { workerIndex: number }) => Promise<void>,
  ];
  const [captureFixture] = piwiFixtures.piwiCapture as unknown as [
    (args: { baseURL?: string }, use: () => Promise<void>, info: unknown) => Promise<void>,
  ];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0]!;
      if (path !== '/api/plain') {
        res.setHeader('X-Piwi-Logs', encoded(logsOf(path)));
        res.setHeader('X-Piwi-Coverage', `k1${path.replaceAll('/', '.')}`);
      }
      if (path === '/api/items') res.setHeader('X-Piwi-Trace', encoded([span]));
      res.statusCode = path === '/api/orders' ? 201 : path === '/api/missing' ? 404 : 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ path }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The worker fixture hands out the contexts of the real `playwright.request` from here on.
    await resourcesFixture({ playwright: { request } }, async () => {}, { workerIndex: 0 });
    try {
      browser = await chromium.launch();
    } catch {
      browser = null;
    }
  });

  afterAll(async () => {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const saved = { coverage: process.env.PIWI_COVERAGE_SERVER, traces: process.env.PIWI_CAPTURE_SERVER_TRACES };
  afterEach(() => {
    for (const [key, value] of [
      ['PIWI_COVERAGE_SERVER', saved.coverage],
      ['PIWI_CAPTURE_SERVER_TRACES', saved.traces],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** Run `body` as one test through the capture fixtures; its JSON attachments by name. */
  async function captureTest(body: () => Promise<void>, baseURL?: string): Promise<Map<string, unknown>> {
    const testInfo = {
      status: 'passed',
      attach: vi.fn(async (_name: string, _attachment: { body: Buffer }) => {}),
      annotations: [],
    };
    await captureFixture({ baseURL }, body, testInfo);
    const parse = (body: Buffer): unknown => {
      try {
        return JSON.parse(String(body));
      } catch {
        return String(body);
      }
    };
    return new Map(testInfo.attach.mock.calls.map(([name, attachment]) => [name, parse(attachment.body)]));
  }

  it("records a test's calls with their status, timing, logs, spans and coverage ids", async () => {
    process.env.PIWI_COVERAGE_SERVER = 'lines';
    const attachments = await captureTest(async () => {
      const api = await request.newContext({ baseURL: origin });
      const items = await api.get('/api/items');
      // The body stays the test's to read.
      expect(await items.json()).toEqual({ path: '/api/items' });
      await api.post('/api/orders', { data: { sku: 'A1' } });
      await api.fetch('/api/plain', { method: 'put' });
      await api.dispose();
    });
    const network = attachments.get(ATTACHMENT_NAMES.network) as Array<Record<string, unknown>>;
    expect(network).toEqual([
      {
        method: 'GET',
        url: `${origin}/api/items`,
        status: 200,
        duration: expect.any(Number),
        startTime: expect.any(Number),
        contentType: 'application/json',
        serverLogs: logsOf('/api/items'),
        serverTraces: [span],
      },
      {
        method: 'POST',
        url: `${origin}/api/orders`,
        status: 201,
        duration: expect.any(Number),
        startTime: expect.any(Number),
        contentType: 'application/json',
        serverLogs: logsOf('/api/orders'),
      },
      {
        method: 'PUT',
        url: `${origin}/api/plain`,
        status: 200,
        duration: expect.any(Number),
        startTime: expect.any(Number),
        contentType: 'application/json',
      },
    ]);
    expect(network[0]!.startTime as number).toBeGreaterThan(Date.now() - 60_000);
    expect(attachments.get(ATTACHMENT_NAMES.serverCoverageRequests)).toEqual({
      [origin]: ['k1.api.items', 'k1.api.orders'],
    });
  });

  it('records the calls of a test only, through a context created before it', async () => {
    const api = await request.newContext({ baseURL: origin });
    await api.get('/api/items?before=1');
    const attachments = await captureTest(() => api.get('/api/items?during=1').then(() => undefined));
    await api.get('/api/items?after=1');
    await api.dispose();
    const network = attachments.get(ATTACHMENT_NAMES.network) as Array<Record<string, unknown>>;
    expect(network.map((entry) => entry.url)).toEqual([`${origin}/api/items?during=1`]);
  });

  it('records a failed call and one failed for its status, and the test sees the error Playwright names', async () => {
    const attachments = await captureTest(async () => {
      const down = await request.newContext({ baseURL: 'http://127.0.0.1:1' });
      await expect(down.get('/api/down')).rejects.toThrow(/^apiRequestContext\.get: .*ECONNREFUSED/);
      await down.dispose();
      const api = await request.newContext({ baseURL: origin });
      await expect(api.get('/api/missing', { failOnStatusCode: true })).rejects.toThrow(
        /^apiRequestContext\.get: 404 Not Found/,
      );
      await api.dispose();
    });
    const network = attachments.get(ATTACHMENT_NAMES.network) as Array<Record<string, unknown>>;
    expect(network).toHaveLength(2);
    expect(network[0]).toMatchObject({
      method: 'GET',
      url: 'http://127.0.0.1:1/api/down',
      status: 0,
      failure: expect.stringContaining('ECONNREFUSED'),
    });
    expect(network[1]).toMatchObject({ url: `${origin}/api/missing`, status: 404 });
    expect(network[1]).not.toHaveProperty('failure');
  });

  it('keeps no coverage ids while server coverage is off, and no spans with captureServerTraces off', async () => {
    process.env.PIWI_COVERAGE_SERVER = 'off';
    process.env.PIWI_CAPTURE_SERVER_TRACES = 'false';
    const attachments = await captureTest(async () => {
      const api = await request.newContext({ baseURL: origin });
      await api.get('/api/items');
      await api.dispose();
    });
    expect(attachments.has(ATTACHMENT_NAMES.serverCoverageRequests)).toBe(false);
    const [entry] = attachments.get(ATTACHMENT_NAMES.network) as Array<Record<string, unknown>>;
    expect(entry).toMatchObject({ serverLogs: logsOf('/api/items') });
    expect(entry).not.toHaveProperty('serverTraces');
  });

  it("resolves a failed call's relative URL against the test's baseURL when its context named none", async () => {
    const refused = new Error('apiRequestContext.get: connect ECONNREFUSED 10.0.0.1:443');
    const apiRequest = { newContext: async () => ({ get: async (_url: string) => Promise.reject(refused) }) };
    await resourcesFixture({ playwright: { request: apiRequest } }, async () => {}, { workerIndex: 0 });
    const attachments = await captureTest(async () => {
      const api = await apiRequest.newContext();
      await expect(api.get('/api/orders')).rejects.toBe(refused);
    }, 'https://shop.test');
    expect(attachments.get(ATTACHMENT_NAMES.network)).toEqual([
      expect.objectContaining({
        method: 'GET',
        url: 'https://shop.test/api/orders',
        status: 0,
        failure: 'connect ECONNREFUSED 10.0.0.1:443',
      }),
    ]);
  });

  it("records page.request calls, the browser context's own API request context", async (ctx) => {
    if (!browser) return ctx.skip();
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageFixture = piwiFixtures.page as unknown as (
      args: { page: Page },
      use: (page: Page) => Promise<void>,
    ) => Promise<void>;
    const attachments = await captureTest(async () => {
      await pageFixture({ page }, async () => {
        expect(page.request).toBe(context.request);
        await page.request.get(`${origin}/api/items?via=page`);
      });
      await context.close();
    });
    const network = attachments.get(ATTACHMENT_NAMES.network) as Array<Record<string, unknown>>;
    expect(network).toEqual([
      expect.objectContaining({ method: 'GET', url: `${origin}/api/items?via=page`, status: 200 }),
    ]);
    expect(network[0]).not.toHaveProperty('resourceType');
  });
});
