import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { BUG_REPORT_VERSION, emptyBugEvidence, parseBugReport, type BugReport } from '@piwitests/core/bug-report';
import { test, expect, extensionWorker, launchWithEditedManifest } from './fixtures.js';
import { stubChromeStorage } from './recording-stub.js';
import { routeShop, SHOP_ORIGIN } from './bug-shop.js';
import { openShadowRoots } from './shadow.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');
const TOKEN = 'b'.repeat(32);
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAf/Z';

const HUD = { mark: 0, missing: 1, wrongPage: 2, finish: 3 } as const;

async function pressHudButton(page: Page, which: keyof typeof HUD): Promise<void> {
  await page.focus('#piwi-record-hud-host');
  for (let i = 0; i < HUD[which]; i++) await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
}

function hostPresent(page: Page, id: string): Promise<boolean> {
  return page.evaluate((hostId) => !!document.getElementById(hostId), id);
}

/**
 * A bug recording on the fixture shop with a stubbed worker: Send to Piwi
 * finds the tab connected to a project, and every message the page sends is
 * kept in `__piwiSent`.
 */
async function recordReport(context: BrowserContext): Promise<Page> {
  await stubChromeStorage(context, {
    session: {
      piwiRecording: {
        active: true,
        events: [],
        startedAt: Date.now(),
        grantedOriginPattern: `${SHOP_ORIGIN}/*`,
        mode: 'bug',
        bugToken: TOKEN,
      },
    },
    responses: {
      'piwi-bug-screenshot': { ok: true, dataUrl: PNG },
      'piwi-bug-send-target': {
        connected: true,
        project: { id: 7, label: 'Shop' },
        instance: 'piwi.acme.test',
        firstSend: true,
        intake: { tracker: 'jira', projectKey: 'SHOP', canCreate: true, fileEvery: false },
      },
      'piwi-send-bug-report': {
        ok: true,
        id: 37,
        url: 'https://piwi.acme.test/bug-reports/37',
        issue: { status: 'done', key: 'SHOP-812' },
      },
    },
  });
  await context.addInitScript(() => {
    const sent: unknown[] = [];
    (globalThis as any).__piwiSent = sent;
    const runtime = (globalThis as any).chrome.runtime;
    const send = runtime.sendMessage;
    runtime.sendMessage = (message: unknown) => {
      sent.push(message);
      return send(message);
    };
  });
  await context.addInitScript({ path: path.join(DIST, 'bug-evidence-main.js') });
  const page = await context.newPage();
  await page.goto(`${SHOP_ORIGIN}/cart`);
  await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
  await expect.poll(() => hostPresent(page, 'piwi-record-hud-host')).toBe(true);

  await page.fill('#coupon', 'SPRING10');
  await page.getByRole('button', { name: 'Apply' }).click();
  await pressHudButton(page, 'mark');
  await page.hover('#total');
  await page.click('#total');
  await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(true);
  await page.keyboard.type('Total: 45');
  await page.keyboard.press('Enter');
  await expect.poll(() => hostPresent(page, 'piwi-bug-dialog-host')).toBe(false);
  // The mark is done once its screenshot is kept: the last thing the flow does.
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          ((await (globalThis as any).chrome.storage.session.get('piwiBugScreenshots')).piwiBugScreenshots ?? [])
            .length,
      ),
    )
    .toBe(1);
  // The HUD renders again as the mark lands; a key pressed while it does can miss the button.
  await expect(async () => {
    if (!(await hostPresent(page, 'piwi-record-review-host'))) await pressHudButton(page, 'finish');
    await expect.poll(() => hostPresent(page, 'piwi-record-review-host'), { timeout: 2000 }).toBe(true);
  }).toPass({ timeout: 15_000 });
  return page;
}

function sentOfType(page: Page, type: string): Promise<any[]> {
  return page.evaluate((t) => ((globalThis as any).__piwiSent as any[]).filter((m) => m?.type === t), type);
}

test.describe('Send to Piwi', () => {
  test('shows exactly what is sent, sends only what is ticked, and nothing before Send', async ({ context }) => {
    test.setTimeout(90_000);
    await openShadowRoots(context);
    await routeShop(context, { fixed: false });
    const page = await recordReport(context);
    const review = page.locator('#piwi-record-review-host');
    await expect(review.getByText('Everything here stays in this browser until you send it.')).toBeVisible();

    await review.getByRole('button', { name: 'Send to Piwi…' }).click();
    const preview = page.locator('#__piwi_bug_send_host');
    await expect(preview.getByRole('dialog', { name: 'Send to Shop' })).toBeVisible();
    await expect(preview.getByText('A bug report of Shop on piwi.acme.test.')).toBeVisible();
    await expect(preview.getByText(/^This is the first report sent from this browser\./)).toBeVisible();
    await expect(preview.getByText('The title and 4 steps, with the pages they were on')).toBeVisible();
    await expect(preview.locator('ol.sent-steps li').nth(1)).toContainText('SPRING10');
    for (const name of [
      'Screenshots: 2',
      'Console errors and warnings: 1',
      'Failed requests (method, path, status; never a body): 1',
      'The outline of the page',
    ])
      await expect(preview.getByRole('checkbox', { name })).toBeChecked();
    expect(await sentOfType(page, 'piwi-send-bug-report')).toEqual([]);

    // Leave the console out and the typed values; the preview follows.
    await preview.getByRole('checkbox', { name: 'Console errors and warnings: 1' }).uncheck();
    await preview.getByRole('checkbox', { name: /^Leave out the values I typed/ }).check();
    await expect(preview.locator('ol.sent-steps li').nth(1)).not.toContainText('SPRING10');
    await preview.getByText('Show the exact data').click();
    await expect(preview.locator('pre')).not.toContainText('SPRING10');
    await expect(preview.locator('pre')).not.toContainText('Coupon failed');

    // The project files into Jira and this role may create issues: offered, unticked.
    const alsoFile = preview.getByRole('checkbox', { name: 'Also create a Jira issue in SHOP' });
    await expect(alsoFile).not.toBeChecked();
    await alsoFile.check();

    await preview.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(preview.getByText('Sent as bug report #37.')).toBeVisible();
    await expect(preview.getByText('Jira issue SHOP-812 created.')).toBeVisible();
    await expect(preview.getByRole('link', { name: 'Open it in Piwi' })).toHaveAttribute(
      'href',
      'https://piwi.acme.test/bug-reports/37',
    );

    const [message] = await sentOfType(page, 'piwi-send-bug-report');
    const parsed = parseBugReport(message.report);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.report.evidence.console).toEqual([]);
    expect(parsed.report.evidence.requests).toHaveLength(1);
    expect(parsed.report.steps.steps.find((s) => s.action === 'fill')).toMatchObject({ value: null, redacted: true });
    expect(message.language).toBe('en');
    expect(message.createIssue).toBe(true);
    // The screenshot of the mark and the one taken at Finish.
    expect(message.screenshots).toEqual([
      { name: '1-marked.png', dataUrl: PNG },
      { name: '2-finish.png', dataUrl: PNG },
    ]);
    expect(message).not.toHaveProperty('projectId');
  });

  test('is not offered when no instance is connected', async ({ context }) => {
    await openShadowRoots(context);
    await routeShop(context, { fixed: false });
    await stubChromeStorage(context, {
      session: {
        piwiRecording: {
          active: true,
          events: [],
          startedAt: Date.now(),
          grantedOriginPattern: `${SHOP_ORIGIN}/*`,
          mode: 'bug',
          bugToken: TOKEN,
        },
      },
    });
    const page = await context.newPage();
    await page.goto(`${SHOP_ORIGIN}/cart`);
    await page.addScriptTag({ path: path.join(DIST, 'record-panel.js') });
    await expect.poll(() => hostPresent(page, 'piwi-record-hud-host')).toBe(true);
    await pressHudButton(page, 'finish');
    const review = page.locator('#piwi-record-review-host');
    await expect(review.getByText('Everything here stays in this browser: nothing is sent anywhere.')).toBeVisible();
    await expect(review.getByRole('button', { name: 'Send to Piwi…' })).toBeHidden();
  });
});

function sampleReport(): BugReport {
  return {
    v: BUG_REPORT_VERSION,
    steps: {
      v: 1,
      title: 'Coupon not applied',
      origin: SHOP_ORIGIN,
      recordedAt: 1,
      note: null,
      steps: [{ action: 'goto', target: null, value: '/cart', redacted: false, pageUrl: '/cart', timestamp: 1 }],
    },
    evidence: {
      ...emptyBugEvidence(),
      screenshots: [{ file: 'screenshots/1-marked.png', step: 0, moment: 'marked', takenAt: 1 }],
    },
    context: {
      origin: SHOP_ORIGIN,
      pageKey: '/cart',
      path: '/cart',
      browser: null,
      userAgent: null,
      viewport: null,
      time: 1,
      extensionVersion: null,
    },
  };
}

interface Received {
  url: string;
  apiKey: string | undefined;
  contentType: string;
  body: Buffer;
}

function readRequest(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

test.describe('Send to Piwi, in the real extension', () => {
  let server: Server;
  let instance: string;
  const received: Received[] = [];

  test.beforeAll(async () => {
    server = createServer(async (req, res) => {
      const body = await readRequest(req);
      received.push({
        url: req.url ?? '',
        apiKey: req.headers['x-api-key'] as string | undefined,
        contentType: req.headers['content-type'] ?? '',
        body,
      });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/projects/7/bug-reports') {
        res.statusCode = 201;
        const filed = body.toString('latin1').includes('name="createIssue"');
        res.end(JSON.stringify({ id: 37, url: '/bug-reports/37', issue: filed ? { status: 'pending' } : null }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/projects/7/bug-reports/intake') {
        res.end(
          JSON.stringify({
            tracker: 'jira',
            projectKey: 'SHOP',
            locale: 'fr',
            canCreate: true,
            fileEvery: false,
            stepShots: 100,
          }),
        );
        return;
      }
      if (req.method === 'GET' && req.url === '/api/projects/7/bug-reports') {
        res.end(
          JSON.stringify({
            items: [
              { id: 37, title: 'Coupon not applied', status: 'open', path: '/cart' },
              { id: 12, title: 'Old one', status: 'closed', path: '/' },
            ],
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/api/bug-reports/37/reproductions') {
        res.statusCode = 201;
        res.end('{}');
        return;
      }
      if (req.method === 'GET' && req.url === '/api/bug-reports/37') {
        res.end(JSON.stringify({ projectId: 7, title: 'Coupon not applied', steps: sampleReport().steps }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    instance = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('the worker sends the confirmed report to the project the tab maps to, and lists its reports for Replay', async () => {
    // A copy of the build whose manifest grants the shop and the instance: the
    // grants the popup and the settings page request in a click, which a test cannot make.
    const context = await launchWithEditedManifest((manifest) => ({
      ...manifest,
      host_permissions: [`${SHOP_ORIGIN}/*`, `${instance}/*`],
    }));
    try {
      await routeShop(context, { fixed: false });
      const worker = await extensionWorker(context);
      await worker.evaluate(
        async ({ url, origin }) =>
          chrome.storage.local.set({
            piwiConnection: {
              instanceUrl: url,
              apiKey: 'pd_test',
              projectMappings: [{ urlPattern: `${origin}/**`, projectId: 7, projectLabel: 'Shop' }],
              serverMappings: [],
              serverProjects: [],
              serverSyncedAt: 0,
              connectedAs: '',
            },
          }),
        { url: instance, origin: SHOP_ORIGIN },
      );
      const page = await context.newPage();
      await page.goto(`${SHOP_ORIGIN}/cart`);
      const tabId = await worker.evaluate(
        async (origin) => (await chrome.tabs.query({ url: `${origin}/*` }))[0]!.id!,
        SHOP_ORIGIN,
      );
      // Messages sent from the tab's isolated world, as the finish panel and Replay send them.
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

      expect(await fromTab({ type: 'piwi-bug-send-target' })).toEqual({
        connected: true,
        project: { id: 7, label: 'Shop' },
        instance: new URL(instance).host,
        firstSend: true,
        intake: {
          tracker: 'jira',
          projectKey: 'SHOP',
          canCreate: true,
          fileEvery: false,
          stepShots: 100,
        },
        stepShots: 100,
      });
      // Only the intake was asked; nothing is sent before Send.
      expect(received.map((r) => r.url)).toEqual(['/api/projects/7/bug-reports/intake']);

      const withStepShot = sampleReport();
      withStepShot.evidence.stepShots = [
        { step: 0, file: 'steps/001.jpg', box: null, viewport: { width: 800, height: 600 }, takenAt: 1 },
      ];
      const answer = await fromTab({
        type: 'piwi-send-bug-report',
        report: withStepShot,
        language: 'fr',
        createIssue: true,
        screenshots: [{ name: '1-marked.png', dataUrl: PNG }],
        stepShots: [
          { name: '001.jpg', dataUrl: JPEG },
          { name: '../001.jpg', dataUrl: JPEG },
        ],
      });
      expect(answer).toEqual({
        ok: true,
        id: 37,
        url: `${instance}/bug-reports/37`,
        issue: { status: 'pending', key: null },
      });
      const post = received.find((r) => r.url === '/api/projects/7/bug-reports')!;
      expect(post.apiKey).toBe('pd_test');
      expect(post.contentType).toMatch(/^multipart\/form-data; boundary=/);
      const text = post.body.toString('latin1');
      expect(text).toContain('name="report"');
      expect(text).toContain('"title":"Coupon not applied"');
      expect(text).toContain('name="language"\r\n\r\nfr');
      expect(text).toContain('name="createIssue"\r\n\r\ntrue');
      expect(text).toContain('name="screenshot"; filename="1-marked.png"');
      expect(text).toContain('Content-Type: image/png');
      // The step screenshot, by the name the report gives it; a name that is not a step's file is not sent.
      expect(text).toContain('name="stepShot"; filename="001.jpg"');
      expect(text).toContain('Content-Type: image/jpeg');
      expect(text.match(/name="stepShot"/g)).toHaveLength(1);
      expect(post.body.includes(Buffer.from(PNG.split(',')[1]!, 'base64'))).toBe(true);

      // The explanation is shown once per profile.
      expect(((await fromTab({ type: 'piwi-bug-send-target' })) as { firstSend: boolean }).firstSend).toBe(false);

      // Replay's list: the project's reports still to fix, then one report's steps.
      expect(await fromTab({ type: 'piwi-list-bug-reports' })).toEqual({
        ok: true,
        project: { id: 7, label: 'Shop' },
        items: [{ id: 37, title: 'Coupon not applied', status: 'open', path: '/cart' }],
      });
      const steps = (await fromTab({ type: 'piwi-get-bug-report', id: 37 })) as { ok: boolean; steps: unknown };
      expect(steps.ok).toBe(true);
      expect(steps.steps).toMatchObject({ title: 'Coupon not applied', steps: [{ action: 'goto', value: '/cart' }] });

      // Share result: the verdict, where it ran and the browser, on the report the replay played.
      expect(
        await fromTab({ type: 'piwi-start-replay', steps: steps.steps, origin: SHOP_ORIGIN, bugReportId: 37 }),
      ).toEqual({ ok: true });
      expect(await fromTab({ type: 'piwi-share-target' })).toEqual({ instance: new URL(instance).host });
      expect(
        await fromTab({
          type: 'piwi-share-reproduction',
          bugReportId: 37,
          source: 'replay',
          verdict: 'diverged',
          divergedAt: 2,
          origin: 'http://localhost:3000',
        }),
      ).toEqual({ ok: true });
      const shared = received.find((r) => r.url === '/api/bug-reports/37/reproductions')!;
      expect(shared.apiKey).toBe('pd_test');
      expect(JSON.parse(shared.body.toString('utf8'))).toMatchObject({
        source: 'replay',
        verdict: 'diverged',
        divergedAt: 2,
        origin: 'http://localhost:3000',
      });
      expect(JSON.parse(shared.body.toString('utf8')).userAgent).toMatch(/Chrome/);
    } finally {
      await context.close();
    }
  });
});
