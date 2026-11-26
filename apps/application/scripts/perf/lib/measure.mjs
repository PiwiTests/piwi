/**
 * One measurement each: a server render or an API call fetched over HTTP, and
 * a page loaded in Chromium until its own requests settle. Every call reads
 * the time and size; the trace id each response names (`Server-Timing`) is
 * kept so the caller can look up the SQL it ran.
 */
import { performance } from 'node:perf_hooks';
import { traceIdFromServerTiming } from './otlp-receiver.mjs';
import { isReplayableApi } from './scenarios.mjs';

/** Fetch `path` the way a signed-in browser would, reading the whole body. */
export async function fetchTimed(server, path, accept) {
  const started = performance.now();
  const res = await fetch(`${server.base}${path}`, {
    headers: { cookie: server.cookie ?? '', accept },
    redirect: 'manual',
  });
  const ttfb = performance.now() - started;
  const body = await res.arrayBuffer();
  const ms = performance.now() - started;
  return {
    status: res.status,
    ms,
    ttfb,
    bytes: body.byteLength,
    traceId: traceIdFromServerTiming(res.headers.get('server-timing')),
  };
}

/** Recorded by the page itself: long tasks (blocking time) and the largest paint. */
const PAGE_OBSERVERS = () => {
  window.__perf = { blockingMs: 0, longTasks: 0, lcpMs: null };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__perf.longTasks++;
        window.__perf.blockingMs += Math.max(0, entry.duration - 50);
      }
    }).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((list) => {
      const last = list.getEntries().at(-1);
      if (last) window.__perf.lcpMs = last.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {
    // an engine without these entry types reports nothing
  }
};

/** A browser context signed in to `server`, warm-cached across the loads it makes. */
export async function signedInContext(browser, server) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const name = server.cookie.slice(0, server.cookie.indexOf('='));
  const value = server.cookie.slice(server.cookie.indexOf('=') + 1);
  // A `__Host-` cookie is taken only Secure, with `Path=/` and its host named, which localhost allows over HTTP.
  await context.addCookies([{ name, value, domain: new URL(server.base).hostname, path: '/', secure: true }]);
  await context.addInitScript(PAGE_OBSERVERS);
  return context;
}

const QUIET_MS = 500;

/**
 * Load `path` in a new tab of `context` and wait until hydration is over and
 * the page's own requests (document, fetch, XHR — not event streams or built
 * assets) have been quiet for half a second. `ms` runs from the navigation to
 * the end of the last of those requests.
 */
export async function loadPage(context, server, path, { timeoutMs = 60_000 } = {}) {
  const page = await context.newPage();
  const inflight = new Set();
  const requests = [];
  let lastEnd = 0;
  const started = performance.now();
  const tracked = (request) =>
    request.url().startsWith(server.base) &&
    ['document', 'fetch', 'xhr'].includes(request.resourceType()) &&
    !request.url().includes('/_nuxt/');

  page.on('request', (request) => {
    if (tracked(request)) inflight.add(request);
  });
  const settle = async (request, failed) => {
    if (!inflight.delete(request)) return;
    lastEnd = performance.now();
    const response = failed ? null : await request.response().catch(() => null);
    requests.push({
      method: request.method(),
      url: request.url().slice(server.base.length),
      status: response?.status() ?? 0,
      ms: request.timing().responseEnd > 0 ? request.timing().responseEnd - request.timing().requestStart : null,
      traceId: response ? traceIdFromServerTiming(await response.headerValue('server-timing').catch(() => null)) : null,
      api: isReplayableApi(request.method(), request.url()),
    });
  };
  page.on('requestfinished', (request) => void settle(request, false));
  page.on('requestfailed', (request) => void settle(request, true));

  try {
    const response = await page.goto(`${server.base}${path}`, { waitUntil: 'load', timeout: timeoutMs });
    if (!response || response.status() >= 400) throw new Error(`${path} answered ${response?.status()}`);
    await page
      .waitForFunction(() => window.useNuxtApp?.().isHydrating === false, undefined, { timeout: timeoutMs })
      .catch(() => {});
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (inflight.size === 0 && performance.now() - lastEnd >= QUIET_MS) break;
      await page.waitForTimeout(50);
    }
    const metrics = await page.evaluate(() => ({
      ...window.__perf,
      domNodes: document.getElementsByTagName('*').length,
      heapBytes: performance.memory?.usedJSHeapSize ?? null,
    }));
    return {
      ms: lastEnd - started,
      requests: requests.filter((r) => r.url !== path),
      apiRequests: requests.filter((r) => r.api).length,
      blockingMs: metrics.blockingMs,
      longTasks: metrics.longTasks,
      lcpMs: metrics.lcpMs,
      domNodes: metrics.domNodes,
      heapBytes: metrics.heapBytes,
      documentTraceId: requests.find((r) => r.url === path)?.traceId ?? null,
    };
  } finally {
    await page.close();
  }
}
