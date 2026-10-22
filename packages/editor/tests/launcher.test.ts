/**
 * The recorder end to end: a recording session started through the sessions module forks the built launcher
 * (`dist/`), which opens Chromium with this repository's Playwright and loads the recorder's IDE bundle; the test
 * plays a person's clicks and typing with trusted input, through a second Playwright client attached over the
 * DevTools protocol, and reads the block the session writes. Needs `npm run editor:build` and Playwright's
 * Chromium.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { IDE_CHROME_GLOBAL, IDE_RECORDER_BINDING } from '@piwitests/core/ide-recorder';
import type { RecordingUpdate } from '../src/protocol';
import { BUNDLE_FILE, LAUNCHER_FILE, MESSAGES_FILE, RecordingSessions } from '../src/recorder/sessions';

const DIST = path.join(__dirname, '..', 'dist');
const PROJECT = path.join(__dirname, 'fixtures', 'record-project');
const CONFIG = path.join(PROJECT, 'playwright.config.ts');
const SPEC_FILE = path.join(PROJECT, 'specs', 'sign-in.spec.ts');
const SPEC = [
  "import { test } from '@playwright/test';",
  '',
  "test('signs in', async ({ page }) => {",
  '',
  '});',
  '',
].join('\n');
/** The element the recorder adds to a page once it captures there. */
const RECORDER = '#piwi-record-hud-host';

const PAGES: Record<string, string> = {
  '/login': `<!doctype html><html lang="en"><head><title>Sign in</title></head><body>
    <h1>Sign in</h1>
    <form onsubmit="event.preventDefault(); location.href = '/account';">
      <label>Email <input name="email" type="email"></label>
      <label>Password <input name="password" type="password"></label>
      <button type="submit">Sign in</button>
    </form>
  </body></html>`,
  '/account': `<!doctype html><html lang="en"><head><title>Account</title></head><body>
    <h1>Your account</h1>
    <a href="/help" target="_blank">Help</a>
    <button data-test="add-to-cart" data-testid="library-button">Add to cart</button>
  </body></html>`,
  '/help': `<!doctype html><html lang="en"><head><title>Help</title></head><body>
    <h1>Help</h1>
    <button>Contact us</button>
  </body></html>`,
};

let server: http.Server;
let baseURL = '';
let ready: string | null = null;

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, ms = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Whether something answers on a port. */
function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body = PAGES[new URL(req.url ?? '/', 'http://x').pathname];
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const missing = [LAUNCHER_FILE, BUNDLE_FILE, MESSAGES_FILE].filter((f) => !fs.existsSync(path.join(DIST, f)));
  if (missing.length) {
    ready = `run npm run editor:build first (${missing.join(', ')} missing)`;
    return;
  }
  const probe = await chromium.launch({ headless: true }).catch((e: Error) => e);
  if (probe instanceof Error) ready = `Playwright's Chromium is not installed: ${probe.message.split('\n')[0]}`;
  else await probe.close();
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the launcher', () => {
  test('records a sign-in across two pages into a test’s body, not what a new tab does, then stops and closes the browser', async (ctx) => {
    if (ready) return ctx.skip(ready);
    const debugPort = await freePort();
    const updates: RecordingUpdate[] = [];
    const sessions = new RecordingSessions({
      distDir: DIST,
      notify: (update) => updates.push(update),
      readOptions: async (configFile) => ({
        configFile,
        rootDir: PROJECT,
        projects: [
          {
            name: 'desktop',
            testDir: path.join(PROJECT, 'specs'),
            use: {
              baseURL,
              testIdAttribute: 'data-test',
              viewport: { width: 1024, height: 700 },
              launchOptions: { args: [`--remote-debugging-port=${debugPort}`] },
            },
          },
        ],
      }),
      env: { PIWI_RECORDER_HEADLESS: '1' },
    });
    const last = () => updates[updates.length - 1];
    let attached: Browser | null = null;
    try {
      const result = await sessions.start(
        { uri: pathToFileURL(SPEC_FILE).href, line: 3, character: 0, into: 'steps', startUrl: '/login' },
        { file: SPEC_FILE, text: SPEC, configFile: CONFIG, catalog: [], preferLocators: new Set() },
      );
      expect(result).toMatchObject({ ok: true, placement: { line: 3, newLine: false, indent: '  ' } });
      await waitFor(() => (last()?.steps.length ? true : undefined));
      expect(last()).toMatchObject({ state: 'recording', code: "await page.goto('/login');" });

      // A person's input: trusted events, played from another client of the same browser.
      attached = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      const page: Page = await waitFor(() =>
        attached!
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => p.url().endsWith('/login')),
      );
      await page.locator(RECORDER).waitFor({ state: 'attached' });
      await page.getByLabel('Email').fill('dev@example.com');
      await page.getByLabel('Password').fill('s3cret');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL('**/account');
      await page.locator(RECORDER).waitFor({ state: 'attached' });

      // A tab the page opens loads the recorder too, which records nothing there.
      await page.getByRole('link', { name: 'Help' }).click();
      const tab: Page = await waitFor(() =>
        attached!
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => p.url().endsWith('/help')),
      );
      await tab.waitForFunction((name) => name in globalThis, IDE_CHROME_GLOBAL);
      await new Promise((r) => setTimeout(r, 500));
      await tab.getByRole('button', { name: 'Contact us' }).click();
      await new Promise((r) => setTimeout(r, 500));
      expect(await tab.locator(RECORDER).count()).toBe(0);
      // The person hears once that the tab is not recorded.
      await waitFor(() => (updates.some((u) => u.message?.startsWith('A new tab opened')) ? true : undefined));
      expect(updates.filter((u) => u.message?.startsWith('A new tab opened'))).toHaveLength(1);

      // Paused from the editor, then from the recorder's bar: what is done meanwhile is not recorded.
      sessions.command(result.sessionId!, 'pause');
      expect(last()).toMatchObject({ state: 'paused' });
      await page.locator('[data-test="add-to-cart"]').click();
      await new Promise((r) => setTimeout(r, 500));
      sessions.command(result.sessionId!, 'resume');
      expect(last()).toMatchObject({ state: 'recording' });
      const pauseInBrowser = (paused: boolean) =>
        page.evaluate(
          ([binding, value]) =>
            (globalThis as unknown as Record<string, (r: unknown) => Promise<unknown>>)[binding]!({
              kind: 'message',
              message: { type: 'piwi-recording-paused', paused: value },
            }),
          [IDE_RECORDER_BINDING, paused] as const,
        );
      await pauseInBrowser(true);
      await waitFor(() => (last()!.state === 'paused' ? true : undefined));
      await page.locator('[data-test="add-to-cart"]').click();
      await new Promise((r) => setTimeout(r, 500));
      await pauseInBrowser(false);
      await waitFor(() => (last()!.state === 'recording' ? true : undefined));

      await page.locator('[data-test="add-to-cart"]').click();
      await waitFor(() => (last()!.steps.length >= 6 ? true : undefined));
      await new Promise((r) => setTimeout(r, 500));

      expect(last()!.code).toBe(
        [
          "await page.goto('/login');",
          "await page.getByRole('textbox', { name: 'Email' }).fill('dev@example.com');",
          "await page.getByRole('textbox', { name: 'Password' }).fill(process.env.E2E_PASSWORD ?? '');",
          "await page.getByRole('button', { name: 'Sign in' }).click();",
          'await expect(page).toHaveURL(/\\/account(?:[?#]|$)/);',
          "await expect(page.getByRole('link', { name: 'Help' })).toHaveCount(1);",
          "await page.getByRole('link', { name: 'Help' }).click();",
          "await page.getByTestId('add-to-cart').click();",
        ].join('\n'),
      );
      expect(last()!.steps.map((s) => s.line)).toEqual([0, 1, 2, 3, 6, 7]);
      expect(last()!.steps[5]!.locators[last()!.steps[5]!.chosen!]).toBe("getByTestId('add-to-cart')");
      expect(last()!.warnings).toEqual([
        { step: 2, line: 2, message: 'A password was typed here; the spec reads it from E2E_PASSWORD.' },
      ]);
      expect(updates.map((u) => u.state).filter((state, i, all) => state !== all[i - 1])).toEqual([
        'recording',
        'paused',
        'recording',
        'paused',
        'recording',
      ]);

      await sessions.stop(result.sessionId!);
      expect(last()).toMatchObject({ state: 'stopped', code: updates[updates.length - 2]!.code });
      // The launcher exited after closing the browser: nothing answers on the browser's debugging port.
      await waitFor(async () => ((await answers(debugPort)) ? undefined : true), 5_000);
    } finally {
      await attached?.close().catch(() => undefined);
      sessions.dispose();
    }
  }, 90_000);
});
