import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP_CHALLENGE_HEADER, DESKTOP_PROOF_HEADER, desktopTokenProof } from '@piwitests/core/desktop-proof';
import { test, expect, extensionWorker, launchWithExtension } from './fixtures.js';
import { routeShop, SHOP_ORIGIN } from './bug-shop.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');

const STEPS = {
  v: 1,
  title: 'Coupon not applied',
  origin: SHOP_ORIGIN,
  recordedAt: 1,
  note: null,
  steps: [{ action: 'goto', target: null, value: '/cart', redacted: false, pageUrl: '/cart', timestamp: 1 }],
};

interface Received {
  method: string;
  url: string;
  token: string | undefined;
  contentType: string;
  body: string;
}

/**
 * Run with Playwright in the real extension: the worker sends the steps the
 * panel confirmed to the paired desktop app, as JSON with its token, and reads
 * the request's verdict back. A local server stands in for the desktop app; it
 * proves it holds `proofToken` when `/api/health` asks.
 */
test.describe('Run with Playwright, in the real extension', () => {
  let server: Server;
  let desktop: string;
  const received: Received[] = [];
  let proofToken = 'pd_desktop';

  test.beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', async () => {
        if (req.url === '/api/health') {
          const challenge = String(req.headers[DESKTOP_CHALLENGE_HEADER] ?? '');
          const port = (server.address() as AddressInfo).port;
          res.setHeader(DESKTOP_PROOF_HEADER, await desktopTokenProof(proofToken, port, challenge));
          res.end('{"status":"ok"}');
          return;
        }
        received.push({
          method: req.method ?? '',
          url: req.url ?? '',
          token: req.headers['x-piwi-token'] as string | undefined,
          contentType: req.headers['content-type'] ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.setHeader('Content-Type', 'application/json');
        if (req.headers['x-piwi-token'] !== 'pd_desktop') {
          res.statusCode = 401;
          res.end('{}');
        } else if (req.method === 'POST' && req.url === '/api/desktop/repro-requests') {
          res.statusCode = 201;
          res.end(JSON.stringify({ id: 'a1b2c3', status: 'waiting', windowOpen: true }));
        } else if (req.method === 'GET' && req.url === '/api/desktop/repro-requests/a1b2c3') {
          res.end(JSON.stringify({ status: 'done', verdict: { kind: 'not-reproduced' } }));
        } else {
          res.statusCode = 404;
          res.end('{}');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    desktop = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('sends the steps as JSON with the token, and reads the verdict back', async () => {
    // The grants the options page requests in a click, which a test cannot make.
    const dir = mkdtempSync(path.join(tmpdir(), 'piwi-picker-desktop-'));
    cpSync(DIST, dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    manifest.host_permissions = [`${SHOP_ORIGIN}/*`, `${desktop}/*`];
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));

    const context = await launchWithExtension(dir);
    try {
      await routeShop(context, { fixed: false });
      const worker = await extensionWorker(context);
      const page = await context.newPage();
      await page.goto(`${SHOP_ORIGIN}/cart`);
      const tabId = await worker.evaluate(
        async (origin) => (await chrome.tabs.query({ url: `${origin}/*` }))[0]!.id!,
        SHOP_ORIGIN,
      );
      const fromTab = (message: Record<string, unknown>) =>
        worker.evaluate(
          async ({ tab, msg }) =>
            (
              await chrome.scripting.executeScript({
                target: { tabId: tab },
                func: (m: unknown) => chrome.runtime.sendMessage(m),
                args: [msg],
              })
            )[0]!.result,
          { tab: tabId, msg: message },
        );

      // Not paired: nothing leaves the browser.
      expect(await fromTab({ type: 'piwi-desktop-target' })).toEqual({ paired: false, url: null });
      expect(await fromTab({ type: 'piwi-desktop-repro', steps: STEPS })).toMatchObject({ ok: false });
      expect(received).toEqual([]);

      await worker.evaluate(
        async (url) => chrome.storage.local.set({ piwiDesktop: { url, token: 'pd_desktop' } }),
        desktop,
      );
      expect(await fromTab({ type: 'piwi-desktop-target' })).toEqual({ paired: true, url: desktop });
      expect(await fromTab({ type: 'piwi-desktop-repro', steps: STEPS, bugReportId: null })).toEqual({
        ok: true,
        id: 'a1b2c3',
        windowOpen: true,
      });
      const post = received.find((r) => r.method === 'POST')!;
      expect(post.token).toBe('pd_desktop');
      expect(post.contentType).toBe('application/json');
      expect(JSON.parse(post.body)).toEqual({
        steps: STEPS,
        title: 'Coupon not applied',
        options: { headed: true, trace: true },
        bugReportId: null,
        instanceUrl: null,
      });

      expect(await fromTab({ type: 'piwi-desktop-repro-status', id: 'a1b2c3' })).toEqual({
        ok: true,
        status: 'done',
        verdict: { kind: 'not-reproduced' },
      });
      // An id that is not one the app mints is never sent.
      expect(await fromTab({ type: 'piwi-desktop-repro-status', id: '../../api/x' })).toMatchObject({ ok: false });
      expect(received.map((r) => `${r.method} ${r.url}`)).toEqual([
        'POST /api/desktop/repro-requests',
        'GET /api/desktop/repro-requests/a1b2c3',
      ]);

      // A program that cannot prove it holds the token, on the paired address, never receives it.
      proofToken = 'pd_other';
      expect(await fromTab({ type: 'piwi-desktop-repro', steps: STEPS, bugReportId: null })).toMatchObject({
        ok: false,
        error: expect.stringContaining('did not prove'),
      });
      expect(await fromTab({ type: 'piwi-desktop-repro-status', id: 'a1b2c3' })).toMatchObject({ ok: false });
      expect(received).toHaveLength(2);
    } finally {
      await context.close();
    }
  });
});
