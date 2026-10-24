/**
 * Recording from a paused test, end to end: the service's record channel and a recording session on one side, the
 * reporter's relay (`packages/reporter`, the capture fixtures' half) on the other, between them a page of a Chromium
 * this repository's Playwright opened, as a test would have left it. The session's recorder bundle is the built one
 * (`dist/`); the person's input is Playwright's own. Needs `npm run editor:build` and Playwright's Chromium.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { formatRecordChannel } from '@piwitests/core/ide-recorder';
import { recordFromHere } from '../../reporter/src/internal/capture/record-handoff';
import type { RecordingUpdate } from '../src/protocol';
import { RecordChannel, handoffLauncher, type Handoff } from '../src/recorder/handoff';
import { BUNDLE_FILE, MESSAGES_FILE, RecordingSessions } from '../src/recorder/sessions';

const DIST = path.join(__dirname, '..', 'dist');
const PROJECT = path.join(__dirname, 'fixtures', 'record-project');
const CONFIG = path.join(PROJECT, 'playwright.config.ts');
const SPEC_FILE = path.join(PROJECT, 'specs', 'checkout.spec.ts');
/** A test paused at its last line, before the Pay click: the recorded steps go above it. */
const SPEC = [
  "import { test } from '@playwright/test';",
  '',
  "test('pays', async ({ page }) => {",
  "  await page.goto('/cart');",
  "  await page.getByRole('button', { name: 'Pay' }).click();",
  '});',
  '',
].join('\n');
const RECORDER = '#piwi-record-hud-host';

const PAGES: Record<string, string> = {
  '/cart': `<!doctype html><html lang="en"><head><title>Cart</title></head><body>
    <h1>Cart</h1>
    <label>Coupon <input name="coupon"></label>
    <button>Apply</button>
    <button>Pay</button>
  </body></html>`,
};

let server: http.Server;
let baseURL = '';
let ready: string | null = null;

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, ms = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body = PAGES[new URL(req.url ?? '/', 'http://x').pathname];
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const missing = [BUNDLE_FILE, MESSAGES_FILE].filter((f) => !fs.existsSync(path.join(DIST, f)));
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

describe('recording from a paused test', () => {
  test('records in the test’s page from where it is paused, above the paused line, then gives the page back', async (ctx) => {
    if (ready) return ctx.skip(ready);
    const updates: RecordingUpdate[] = [];
    const sessions = new RecordingSessions({
      distDir: DIST,
      notify: (update) => updates.push(update),
      readOptions: async (configFile) => ({ configFile, rootDir: PROJECT, projects: [] }),
    });
    let asked: Handoff | null = null;
    const channel = await RecordChannel.open({ onAttach: (handoff) => (asked = handoff) });
    expect(channel).not.toBeNull();
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ baseURL });
      await page.goto('/cart');
      await page.getByLabel('Coupon').fill('typed before the pause');

      // The test, paused before the Pay click, hands its page over.
      const location = `${path.relative(process.cwd(), SPEC_FILE).split(path.sep).join('/')}:5:44`;
      const recording = recordFromHere({
        page,
        testInfo: { project: { use: { baseURL, testIdAttribute: null } } } as never,
        location,
        reason: 'breakpoint',
        channel: channel!.value,
      });
      const handoff = await waitFor(() => asked ?? undefined);
      expect(handoff).toMatchObject({ file: SPEC_FILE, line: 5, reason: 'breakpoint', baseURL });

      const result = await sessions.start(
        {
          uri: pathToFileURL(SPEC_FILE).href,
          line: 0,
          character: 0,
          into: 'steps',
          handoff: handoff.id,
        },
        { file: SPEC_FILE, text: SPEC, configFile: CONFIG, catalog: [], preferLocators: new Set() },
        channel!.take(handoff.id),
      );
      expect(result).toMatchObject({ ok: true, placement: { line: 4, newLine: true, indent: '  ' } });
      expect(result.message).toBe("Recording in the test's browser from the breakpoint at checkout.spec.ts:5.");
      await waitFor(() => (updates.some((u) => u.state === 'recording') ? true : undefined));
      await page.locator(RECORDER).waitFor({ state: 'attached' });

      await page.getByLabel('Coupon').fill('WELCOME10');
      await page.getByRole('button', { name: 'Apply' }).click();
      const last = () => updates[updates.length - 1]!;
      await waitFor(() => (last().steps.length >= 2 ? true : undefined));
      await new Promise((r) => setTimeout(r, 300));
      // From where the test left the page: no navigation to where the recording began, nor what came before it.
      expect(last().code).toBe(
        [
          "await page.getByRole('textbox', { name: 'Coupon' }).fill('WELCOME10');",
          "await page.getByRole('button', { name: 'Apply' }).click();",
        ].join('\n'),
      );

      await sessions.stop(result.sessionId!);
      expect(last()).toMatchObject({ state: 'stopped' });
      // The test goes on: the page is its own again, and the recorder there stopped.
      expect(await recording).toBeNull();
      await waitFor(async () => ((await page.locator(RECORDER).count()) === 0 ? true : undefined), 5_000);
      await page.getByRole('button', { name: 'Pay' }).click();
    } finally {
      await browser?.close();
      sessions.dispose();
      channel?.close();
    }
  }, 60_000);

  test('refuses a test that does not name the channel’s token, and one no editor takes in time', async () => {
    let asked = 0;
    const channel = await RecordChannel.open({ onAttach: () => asked++, waitMs: 100 });
    try {
      const said = (token: string) =>
        new Promise<string>((resolve) => {
          const socket = net.connect(channel!.path);
          let heard = '';
          socket.setEncoding('utf8');
          socket.on('connect', () =>
            socket.write(
              `${JSON.stringify({ type: 'attach', token, file: SPEC_FILE, line: 5, reason: 'pause', testIdAttribute: null, baseURL: null })}\n`,
            ),
          );
          socket.on('data', (chunk: string) => (heard += chunk));
          socket.on('close', () => resolve(heard));
        });
      expect(await said('x'.repeat(32))).toBe('');
      expect(asked).toBe(0);
      expect(JSON.parse(await said(channel!.token))).toEqual({
        type: 'refused',
        message: 'the editor did not start the recording in time.',
      });
      expect(asked).toBe(1);
      expect(channel!.value).toBe(formatRecordChannel({ path: channel!.path, token: channel!.token }));
    } finally {
      channel?.close();
    }
  });

  test('a test that closes before its session started ends the session as a closed page', async () => {
    const socket = new net.Socket();
    const handoff: Handoff = {
      id: 'h',
      file: SPEC_FILE,
      line: 5,
      reason: 'pause',
      testIdAttribute: null,
      baseURL: null,
      socket,
      kept: ['{"type":"closed"}'],
      deliver: () => {},
    };
    const heard: string[] = [];
    handoffLauncher(handoff)(PROJECT, {
      message: (message) => heard.push(message.type),
      exit: () => heard.push('exit'),
    });
    expect(heard[0]).toBe('closed');
    socket.destroy();
  });
});
