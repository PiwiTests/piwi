import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { buildSession, normalizeSteps, type RawCaptureEvent, type RecordedStep } from '@piwitests/core/recording';
import { renderSpec, stepLocator } from '@piwitests/core/codegen';
import { toStepsDocument } from '@piwitests/core/steps';
import { test, expect, extensionWorker, launchWithExtension, openOptions } from './fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');
const ORIGIN = 'https://hover-test.local';

/**
 * Elements shown only while another is hovered, in the real extension: the
 * recorder must write the hover before the click, the extension's replay must
 * play it (a CSS `:hover` has no real pointer to follow there), and the spec
 * the converter writes must pass in Playwright. The pages are in `pages/`.
 */
interface HoverCase {
  name: string;
  page: string;
  /** What a person does, with Playwright's trusted input. */
  act: (page: Page) => Promise<void>;
  /** The text `#out` shows once the click has landed. */
  result: string;
  /** How many hover steps come before the click. */
  hovers: number;
}

const CASES: HoverCase[] = [
  {
    name: 'a CSS visibility reveal (row actions)',
    page: 'hover-visibility.html',
    act: async (page) => {
      await page.getByRole('listitem').filter({ hasText: 'Invoice 42' }).hover();
      await page.getByRole('button', { name: 'Delete' }).click();
    },
    result: 'Deleted invoice 42',
    hovers: 1,
  },
  {
    name: 'plain pointer movement',
    page: 'hover-visibility.html',
    act: async (page) => {
      await page.getByRole('listitem').filter({ hasText: 'Invoice 41' }).hover();
      await page.getByRole('listitem').filter({ hasText: 'Invoice 43' }).hover();
      await page.getByRole('button', { name: 'Refresh' }).click();
    },
    result: 'Refreshed',
    hovers: 0,
  },
  {
    name: 'a Tailwind v4 group-hover reveal',
    page: 'hover-tailwind.html',
    act: async (page) => {
      await page.getByRole('article', { name: 'Build 18' }).hover();
      await page.getByRole('button', { name: 'Re-run' }).click();
    },
    result: 'Re-ran build 18',
    hovers: 1,
  },
  {
    name: 'a display submenu, two levels deep',
    page: 'hover-submenu.html',
    act: async (page) => {
      await page.getByText('File', { exact: true }).hover();
      await page.getByText('New', { exact: true }).hover();
      await page.getByRole('button', { name: 'Document' }).click();
    },
    result: 'New document',
    hovers: 2,
  },
  {
    name: 'a hover card a script inserts',
    page: 'hover-card.html',
    act: async (page) => {
      await page.getByRole('link', { name: '@bob' }).hover();
      await page.getByRole('button', { name: 'Follow' }).click();
    },
    result: 'Following bob',
    hovers: 1,
  },
  {
    name: 'a button rendered with a new copy of the element the pointer is on',
    page: 'hover-tile.html',
    act: async (page) => {
      await page.getByRole('img', { name: 'Blue mug' }).hover();
      await page.getByRole('button', { name: 'Quick view' }).click();
    },
    result: 'Quick view of the blue mug',
    hovers: 1,
  },
  {
    name: 'an element swapped for another as the pointer enters it',
    page: 'hover-swap.html',
    act: async (page) => {
      await page.getByText('Click me').hover();
      await page.getByText('Click me').click();
    },
    result: 'Clicked 1 time',
    hovers: 0,
  },
];

async function routePages(context: BrowserContext): Promise<void> {
  await context.route(`${ORIGIN}/**`, async (route) => {
    const file = new URL(route.request().url()).pathname.slice(1) || 'hover-visibility.html';
    const body = /^hover-[a-z]+\.html$/.test(file) ? readFileSync(path.join(here, 'pages', file), 'utf8') : '';
    await route.fulfill({ contentType: 'text/html', body });
  });
}

/** An extension page, whose messages reach the background script as the popup's do. */
async function controlPage(context: BrowserContext, worker: Worker): Promise<Page> {
  const page = await context.newPage();
  await openOptions(page, worker.url().split('/')[2]!);
  return page;
}

function stepLines(steps: RecordedStep[]): string[] {
  return steps.map((s) => `${s.action} ${s.target ? (stepLocator(s.target, { locators: 'stable' }) ?? '?') : ''}`);
}

test.describe('hover reveals', () => {
  let context: BrowserContext;
  let worker: Worker;

  test.beforeAll(async () => {
    // A copy of the build granted the test origin: what the popup's per-origin request grants.
    const dir = mkdtempSync(path.join(tmpdir(), 'piwi-picker-hover-'));
    cpSync(DIST, dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    manifest.host_permissions = [`${ORIGIN}/*`];
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    context = await launchWithExtension(dir);
    await routePages(context);
    worker = await extensionWorker(context);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  for (const c of CASES) {
    test(`${c.name}: recorded with its hover, replayed by the extension, passed by the spec`, async () => {
      test.setTimeout(90_000);
      const url = `${ORIGIN}/${c.page}`;
      const page = await context.newPage();
      await page.goto(url);
      const ctl = await controlPage(context, worker);

      // Record.
      const tabId = await worker.evaluate(async (target) => (await chrome.tabs.query({ url: target }))[0]!.id!, url);
      const started = await ctl.evaluate(
        ({ origin, tab }) =>
          chrome.runtime.sendMessage({
            type: 'piwi-start-recording',
            originPattern: `${origin}/*`,
            tabId: tab,
            mode: 'actions',
          }),
        { origin: ORIGIN, tab: tabId },
      );
      expect(started).toEqual({ ok: true });
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);
      await c.act(page);
      await expect(page.locator('#out')).toHaveText(c.result);
      const readEvents = async () =>
        (await worker.evaluate(async () => (await chrome.storage.session.get('piwiRecording')).piwiRecording)) as {
          events: RawCaptureEvent[];
        };
      await expect
        .poll(async () => normalizeSteps((await readEvents()).events).some((s) => s.action === 'click'))
        .toBe(true);
      const { events } = await readEvents();
      await ctl.evaluate(async () => {
        await chrome.storage.session.remove('piwiRecording');
        await chrome.runtime.sendMessage({ type: 'piwi-recording-stopped' });
      });

      const steps = normalizeSteps(events);
      const lines = stepLines(steps);
      expect(
        steps.map((s) => s.action),
        lines.join('\n'),
      ).toEqual(['goto', ...Array.from({ length: c.hovers }, () => 'hover'), 'click']);
      for (const hover of steps.filter((s) => s.action === 'hover')) {
        expect(stepLocator(hover.target, { locators: 'stable' }), lines.join('\n')).not.toBeNull();
      }
      const session = buildSession(steps, events[0]!.timestamp);
      const doc = toStepsDocument(session, { title: c.name });

      // Replay with the extension, the real pointer out of the way.
      await page.mouse.move(0, 0);
      await page.goto(url);
      const replayStarted = await ctl.evaluate(
        ({ steps, origin }) =>
          chrome.runtime.sendMessage({ type: 'piwi-start-replay', steps, origin, stepMode: false, inject: false }),
        { steps: doc, origin: ORIGIN },
      );
      expect(replayStarted).toEqual({ ok: true });
      await page.bringToFront();
      await page.reload();
      type Stored = { status: string; results: Array<{ status: string; detail: string | null }> } | undefined;
      const replayState = async () =>
        (await worker.evaluate(async () => (await chrome.storage.session.get('piwiReplay')).piwiReplay)) as Stored;
      await expect
        .poll(async () => (await replayState())?.status, { timeout: 60_000, intervals: [500] })
        .not.toMatch(/running|paused/);
      const replayed = await replayState();
      expect(
        replayed?.results.every((r) => r.status === 'done'),
        JSON.stringify(replayed?.results),
      ).toBe(true);
      expect(replayed?.status).toBe('done');
      await expect(page.locator('#out')).toHaveText(c.result);
      // The emulated hover leaves nothing behind.
      await expect.poll(() => page.evaluate(() => document.querySelectorAll('[data-piwi-hover]').length)).toBe(0);
      await ctl.close();

      // The spec the converter writes, run by Playwright.
      const body = renderSpec(session, { locators: 'stable', urlChecks: true, format: 'body' }).code;
      expect(body.includes('.hover();')).toBe(c.hovers > 0);
      const specPage = await context.newPage();
      const run = new Function('page', 'expect', `return (async () => {\n${body}\n})();`) as (
        page: Page,
        e: typeof expect,
      ) => Promise<void>;
      await run(specPage, expect);
      await expect(specPage.locator('#out'), body).toHaveText(c.result);
      await specPage.close();
      await page.close();
    });
  }
});
