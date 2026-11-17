import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { installProbeInterception } from '../src/internal/probe/interception.js';
import type { ProbePlanItem } from '../src/internal/probe/plan.js';

/** A local server that answers every path and keeps the headers of each request to `/api/`. */
async function startServer(): Promise<{ server: Server; origin: string; apiHeaders: IncomingHttpHeaders[] }> {
  const apiHeaders: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/')) {
      apiHeaders.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>page</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiHeaders };
}

const ITEM: ProbePlanItem = {
  testCaseId: 1,
  testTitle: 'orders',
  filePath: null,
  suitePath: [],
  routeKey: 'GET /api/orders/:id',
  fault: 'throw',
  level: 'server',
  nth: 1,
};

describe('installProbeInterception: the origin a signed server fault goes to', () => {
  let browser: Browser;
  let app: Awaited<ReturnType<typeof startServer>>;
  let other: Awaited<ReturnType<typeof startServer>>;
  let page: Page;
  const secret = process.env.PIWI_PROBE_SECRET;

  beforeAll(async () => {
    browser = await chromium.launch();
    app = await startServer();
    other = await startServer();
    process.env.PIWI_PROBE_SECRET = 'test-secret';
  });

  afterAll(async () => {
    await browser.close();
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => other.server.close(resolve));
    if (secret === undefined) delete process.env.PIWI_PROBE_SECRET;
    else process.env.PIWI_PROBE_SECRET = secret;
  });

  beforeEach(async () => {
    app.apiHeaders.length = 0;
    other.apiHeaders.length = 0;
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page.close();
  });

  const fetchOrder = (p: Page) => p.evaluate(() => fetch('/api/orders/7').then((r) => r.status));

  it('signs a request of the application’s origin', async () => {
    await installProbeInterception(page, ITEM, `${app.origin}/`);
    await page.goto(`${app.origin}/`);
    await fetchOrder(page);
    expect(app.apiHeaders.map((h) => typeof h['x-piwi-probe'])).toEqual(['string']);
  });

  it('keeps the first navigation’s origin when the page goes to another site', async () => {
    await installProbeInterception(page, ITEM);
    await page.goto(`${app.origin}/`);
    await page.goto(`${other.origin}/`);
    await fetchOrder(page);
    expect(other.apiHeaders).toHaveLength(1);
    expect(other.apiHeaders[0]!['x-piwi-probe']).toBeUndefined();
  });

  it('takes the base URL’s origin over a first navigation elsewhere', async () => {
    await installProbeInterception(page, ITEM, `${app.origin}/`);
    await page.goto(`${other.origin}/`);
    await fetchOrder(page);
    expect(other.apiHeaders).toHaveLength(1);
    expect(other.apiHeaders[0]!['x-piwi-probe']).toBeUndefined();
  });
});
