import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * The desktop window's live view of a run its shell started, in the Local runs tray, driven against the regular web
 * build: a faked Tauri bridge starts the run (as `desktop-local-run.spec.ts` does), and the bundled server's hub of
 * the runs is played by the spec, its stream (`/api/desktop/runs/events`, an EventSource the page gets from the spec)
 * and its commands (`/api/desktop/runs/commands`, routed). The server's own side is covered by
 * `tests/unit/desktop-runs.test.ts` and, with a real Playwright run, `tests/unit/desktop-runs-run.test.ts`.
 */

const VIEWER = 'f'.repeat(32);
const REF = 'desktop-41';
const ROOT = '/home/dev/acme';
const SPEC_URI = `file://${ROOT}/tests/checkout.spec.ts`;

interface Command {
  type: string;
  id: number;
  viewer: string;
  [field: string]: unknown;
}

declare global {
  interface Window {
    __hub: { send(event: unknown): void; open(): number };
    /** The native notifications the page asked the shell for, as `title | body`. */
    __notes: string[];
  }
}

/** Installs the bridge with a linked folder, whose run is shell run 41 and goes on until the spec ends it. */
async function installBridge(page: Page) {
  await page.addInitScript(() => {
    const listeners: ((event: { payload: unknown }) => void)[] = [];
    Object.assign(window, {
      __notes: [],
      __endRun: () => {
        for (const cb of listeners) cb({ payload: { id: 41, kind: 'exit', line: null, code: 0 } });
      },
      __TAURI__: {
        core: {
          invoke: async (cmd: string, args?: Record<string, unknown>) => {
            switch (cmd) {
              case 'desktop_notify':
                window.__notes.push(`${String(args?.title)} | ${String(args?.body)}`);
                return null;
              case 'desktop_get_project_link':
                return { path: '/home/dev/acme', exists: true };
              case 'desktop_check_local_specs':
                return { folder: '/home/dev/acme', missing: [] };
              case 'desktop_check_local_env':
                return {
                  folder: '/home/dev/acme',
                  exists: true,
                  playwrightCli: '/home/dev/acme/node_modules/@playwright/test/cli.js',
                };
              case 'desktop_run_local_tests':
                return 41;
              default:
                return null;
            }
          },
        },
        event: {
          listen: async (name: string, cb: (event: { payload: unknown }) => void) => {
            if (name === 'piwi:local-run') listeners.push(cb);
            return () => {};
          },
        },
      },
    });
  });
}

/**
 * The hub's stream as the page opens it: an EventSource of the spec's, which `window.__hub.send` speaks on; every
 * other stream is the browser's own. And the hub's commands, answered by `answer`.
 */
async function playHub(page: Page, answer: (command: Command) => Record<string, unknown> = () => ({})) {
  await page.addInitScript(() => {
    const Real = window.EventSource;
    const open: Array<{ closed: boolean; onmessage: ((e: { data: string }) => void) | null }> = [];
    function HubStream(this: unknown, url: string | URL, init?: EventSourceInit) {
      if (!String(url).includes('/api/desktop/runs/events')) return new Real(url, init);
      const stream = {
        url: String(url),
        readyState: 1,
        closed: false,
        onmessage: null as ((e: { data: string }) => void) | null,
        onerror: null,
        close() {
          this.closed = true;
          this.readyState = 2;
        },
      };
      open.push(stream);
      return stream;
    }
    Object.assign(HubStream, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
    Object.assign(window, {
      EventSource: HubStream,
      __hub: {
        send: (event: unknown) => {
          for (const stream of open) if (!stream.closed) stream.onmessage?.({ data: JSON.stringify(event) });
        },
        open: () => open.filter((stream) => !stream.closed).length,
      },
    });
  });
  const commands: Command[] = [];
  await page.route('**/api/desktop/runs/commands', async (route: Route) => {
    const command = route.request().postDataJSON() as Command;
    commands.push(command);
    await route.fulfill({ json: { type: 'answer', id: command.id, ok: true, message: '', ...answer(command) } });
  });
  return commands;
}

function tray(page: Page) {
  return page.getByRole('region', { name: 'Local runs' });
}

/** The run's Hold failures switch in the tray. */
function holdSwitch(page: Page) {
  return tray(page).getByRole('switch', { name: 'Hold failures' });
}

const TEST = {
  id: 't1',
  title: ['checkout', 'pays'],
  uri: SPEC_URI,
  line: 2,
  project: 'chromium',
  retry: 0,
  cannotPause: null,
};

function session(worker: Record<string, unknown>, ended = false) {
  return {
    type: 'session',
    session: { ref: REF, root: ROOT, label: 'acme', command: null, project: 'Acme', workers: [worker], ended },
  };
}

const RUNNING = { worker: 0, parallelIndex: 0, state: 'running', test: TEST, stop: null, pausing: false, intents: [] };

function stopped(since: string, extra: Record<string, unknown> = {}) {
  return {
    ...RUNNING,
    state: 'stopped',
    stop: {
      reason: 'pause',
      title: "Click getByRole('button', { name: 'Pay' })",
      uri: SPEC_URI,
      line: 4,
      character: 2,
      locator: "getByRole('button', { name: 'Pay' })",
      bar: false,
      since,
      intents: ['mock', 'view', 'pick-at'],
      ...extra,
    },
  };
}

/** A JPEG of a small page, as a worker sends the image of a stopped page or a frame. */
async function jpeg(page: Page): Promise<string> {
  const shot = await page.context().newPage();
  await shot.setViewportSize({ width: 640, height: 400 });
  await shot.setContent('<body style="margin:0;font:24px sans-serif"><h1>Cart</h1><button>Pay</button></body>');
  const data = (await shot.screenshot({ type: 'jpeg', quality: 60 })).toString('base64');
  await shot.close();
  return data;
}

test.describe('Desktop run live view', () => {
  // Each test opens a run page and drives a whole stop.
  test.describe.configure({ timeout: 90_000 });
  let runId: number;

  test.beforeAll(async ({ request }) => {
    const startTime = Date.now();
    const res = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.DESKTOP_RUN_VIEW,
        status: 'failed',
        startTime: new Date(startTime).toISOString(),
        duration: 4000,
        totalTests: 1,
        passedTests: 0,
        failedTests: 1,
        skippedTests: 0,
        testCases: [
          {
            title: 'pays',
            status: 'failed',
            duration: 4000,
            location: 'tests/checkout.spec.ts:3:1',
            browser: { name: 'chromium', projectName: 'chromium' },
            error: 'TimeoutError: locator.click: Timeout 30000ms exceeded.',
            retries: 0,
            workerIndex: 0,
            startedAt: startTime,
          },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    const project = await (await request.get(`/api/projects/${data.projectId}`)).json();
    runId = project.testRuns[0].id;
  });

  test('steers a stopped worker, shows its page live, picks on it and gives its code to copy', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const image = await jpeg(page);
    await installBridge(page);
    const commands = await playHub(page, (command) => {
      switch (command.type) {
        case 'pausedPage':
          return { image: { mime: 'image/jpeg', data: image, width: 640, height: 400 } };
        case 'pick-at':
          return {
            locator: "getByRole('button', { name: 'Pay' })",
            message: "getByRole('button', { name: 'Pay' }): copy it in the desktop app's window.",
          };
        case 'requests':
          return {
            message: 'The test kept 1 response.',
            requests: [
              {
                id: 1,
                method: 'GET',
                url: 'http://127.0.0.1:3000/api/cart',
                status: 200,
                type: 'application/json',
                size: 12,
                time: 840,
              },
            ],
          };
        case 'mock':
          return {
            message: "Piwi made the mock to write above checkout.spec.ts:5: copy it in the desktop app's window.",
          };
        default:
          return {};
      }
    });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Run locally' }).click();
    await expect(tray(page)).toBeVisible();

    // The run runs: the window holds the hub's stream, and shows the run live once the hub tells it.
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    await page.evaluate((event) => window.__hub.send(event), session(RUNNING));
    const worker = tray(page).locator('[data-shot="desktop-run-worker"]');
    await expect(worker.getByText('Running', { exact: true })).toBeVisible();
    await expect(worker.getByText('checkout › pays')).toBeVisible();
    await expect(worker.getByText('chromium · attempt 1')).toBeVisible();
    // Hold failures is off: the run is not shown live, and a failure no pause bar shows would go on. Opening or closing
    // its part of the tray changes nothing; the switch does.
    await expect(holdSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await expect(holdSwitch(page)).toHaveAccessibleDescription(
      'A failing test waits at its line for you to look at it and resume.',
    );
    await tray(page).getByRole('button', { name: 'Collapse output' }).click();
    await tray(page).getByRole('button', { name: 'Expand output' }).click();
    expect(commands.filter((c) => c.type === 'show')).toEqual([]);
    await holdSwitch(page).click();
    await expect(holdSwitch(page)).toHaveAttribute('aria-checked', 'true');
    await expect
      .poll(() => commands.find((c) => c.type === 'show'))
      .toMatchObject({ ref: REF, on: true, viewer: VIEWER });

    // Pause: before its next call.
    await worker.getByRole('button', { name: 'Pause' }).click();
    await expect
      .poll(() => commands.find((c) => c.type === 'runControl'))
      .toMatchObject({
        ref: REF,
        worker: 0,
        action: 'pause',
        since: null,
      });
    await page.evaluate((event) => window.__hub.send(event), session(stopped('s1')));
    await expect(worker.getByText('Paused', { exact: true })).toBeVisible();
    await expect(worker.getByText("Click getByRole('button', { name: 'Pay' })")).toBeVisible();
    await expect(worker.getByText('tests/checkout.spec.ts:5')).toBeVisible();
    const still = worker.getByRole('img', {
      name: "The page, stopped before Click getByRole('button', { name: 'Pay' })",
    });
    await expect(still).toBeVisible();
    expect(commands.filter((c) => c.type === 'pausedPage')).toHaveLength(1);
    await expect(worker.getByRole('button')).toHaveText([
      'Watch live',
      'Pick on the image',
      'Resume',
      'Step',
      'Finish',
      'Mock a request',
    ]);

    // Watch live: its frames take the image's place, and the input goes to the page once the stop takes it.
    await worker.getByRole('button', { name: 'Watch live' }).click();
    await expect(worker.getByRole('button', { name: 'Watch live' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => commands.find((c) => c.type === 'view')).toMatchObject({ since: 's1', on: true });
    await page.evaluate(
      ({ ref, data }) =>
        window.__hub.send({ type: 'frame', ref, worker: 0, since: 's1', width: 640, height: 400, data }),
      { ref: REF, data: image },
    );
    await page.evaluate(
      (event) => window.__hub.send(event),
      session(stopped('s1', { intents: ['assert-region', 'mock', 'view', 'input', 'pick-at'] })),
    );
    const view = worker.getByRole('img', { name: 'The page, live: clicks and keys go to it' });
    await expect(view).toBeVisible();
    await expect(view).toHaveAttribute('tabindex', '0');
    await view.click({ position: { x: 20, y: 20 } });
    await expect.poll(() => commands.find((c) => c.type === 'input')).toMatchObject({ since: 's1' });
    // Escape gives the keyboard back to the tray, on Watch live.
    await page.keyboard.press('Escape');
    await expect(worker.getByRole('button', { name: 'Watch live' })).toBeFocused();

    // Pick on the image: the point goes in CSS pixels of the page; the locator shows, to copy.
    await worker.getByRole('button', { name: 'Pick on the image' }).click();
    await view.click({ position: { x: 100, y: 50 } });
    await expect.poll(() => commands.find((c) => c.type === 'pick-at')).toMatchObject({ since: 's1' });
    await expect(
      worker.getByText("getByRole('button', { name: 'Pay' }): copy it in the desktop app's window."),
    ).toBeVisible();
    await worker.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("getByRole('button', { name: 'Pay' })");

    // Mock a request: the response chosen becomes a route, which comes to the window to copy, its imports apart.
    await worker.getByRole('button', { name: 'Mock a request' }).click();
    const list = worker.getByRole('group', { name: 'Choose the response to mock' });
    await list.getByRole('button', { name: /api\/cart/ }).click();
    await expect.poll(() => commands.find((c) => c.type === 'mock')).toMatchObject({ since: 's1', request: 1 });
    // Answered: the list closes, the buttons take a press again.
    await expect(list).toHaveCount(0);
    const code = "  await page.route('**/api/cart', (route) => route.fulfill({ json: { items: [] } }));";
    await page.evaluate(
      ({ ref, uri, code }) =>
        window.__hub.send({
          type: 'stop-code',
          code: {
            ref,
            worker: 0,
            since: 's1',
            action: 'mock',
            uri,
            version: null,
            line: 4,
            code,
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: "import { expect } from '@playwright/test';\n",
              },
              { range: { start: { line: 4, character: 0 }, end: { line: 4, character: 0 } }, newText: `${code}\n` },
            ],
            message: 'Piwi made the mock to write above checkout.spec.ts:5.',
            warnings: ['The body is written as it came: check it holds no personal data.'],
          },
        }),
      { ref: REF, uri: SPEC_URI, code },
    );
    const copies = tray(page).locator('[data-shot="desktop-run-copy"]');
    await expect(copies.getByText('Mock a request', { exact: true })).toBeVisible();
    await expect(copies.getByText('Above tests/checkout.spec.ts:5', { exact: true })).toBeVisible();
    await expect(copies.getByText('The body is written as it came: check it holds no personal data.')).toBeVisible();
    await copies.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(code);
    await copies.getByRole('button', { name: 'Copy the imports' }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("import { expect } from '@playwright/test';");

    // A locator the pause bar picked comes to copy too, with its place.
    await page.evaluate(() =>
      window.__hub.send({
        type: 'pick',
        pick: { locator: "getByRole('link', { name: 'Shop' })", file: 'tests/checkout.spec.ts', line: 7 },
      }),
    );
    await expect(copies.getByText('Locator picked')).toBeVisible();
    await expect(copies.getByText('tests/checkout.spec.ts:7')).toBeVisible();

    // Resume answers the stop shown.
    await worker.getByRole('button', { name: 'Resume' }).click();
    await expect
      .poll(() => commands.filter((c) => c.type === 'runControl').at(-1))
      .toMatchObject({
        action: 'resume',
        since: 's1',
      });

    // Watch live, left on, watches the worker's next stop too.
    await page.evaluate((event) => window.__hub.send(event), session(RUNNING));
    await expect(worker.getByText('Running', { exact: true })).toBeVisible();
    await page.evaluate((event) => window.__hub.send(event), session(stopped('s2', { reason: 'step' })));
    await expect(worker.getByText('Stopped after a step')).toBeVisible();
    await expect.poll(() => commands.filter((c) => c.type === 'view').at(-1)).toMatchObject({ since: 's2', on: true });
    await expect(worker.getByRole('button', { name: 'Watch live' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('shows every stop it hears, a failure with its error, the hub’s text as text, and lets go as it ends', async ({
    page,
  }) => {
    const image = await jpeg(page);
    await installBridge(page);
    const commands = await playHub(page, (command) =>
      command.type === 'pausedPage' ? { image: { mime: 'image/jpeg', data: image, width: 640, height: 400 } } : {},
    );
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Run locally' }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    await page.evaluate((event) => window.__hub.send(event), session(RUNNING));
    const worker = tray(page).locator('[data-shot="desktop-run-worker"]');
    await expect(worker.getByText('Running', { exact: true })).toBeVisible();
    await holdSwitch(page).click();
    await expect.poll(() => commands.filter((c) => c.type === 'show').at(-1)).toMatchObject({ on: true });

    // The tray closed, the run still holds its failures, and a stop opens it again on the run, said in the live region.
    await tray(page).getByRole('button', { name: 'Close local runs' }).click();
    await expect(tray(page)).toHaveCount(0);
    const markup = "Click getByText('<img src=x onerror=alert(1)>')";
    await page.evaluate(
      (event) => window.__hub.send(event),
      session(stopped('s2', { reason: 'page-pause', title: markup })),
    );
    await expect(tray(page)).toBeVisible();
    await expect(worker.getByText('Stopped at page.pause()')).toBeVisible();
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'stopped at' })).toHaveText(
      'checkout › pays stopped at tests/checkout.spec.ts:5.',
    );
    // What the hub sends is text: the call's title never becomes markup.
    await expect(worker.getByText(markup)).toBeVisible();
    await expect(worker.locator('img[src="x"]')).toHaveCount(0);
    expect(commands.filter((c) => c.type === 'show')).toEqual([expect.objectContaining({ ref: REF, on: true })]);

    // A failure: where it failed and its error, with Resume alone.
    await page.evaluate(
      (event) => window.__hub.send(event),
      session(
        stopped('s3', {
          reason: 'failure',
          title: 'Failed: Error: expect failed',
          error: 'expect(locator).toBeVisible() failed',
        }),
      ),
    );
    await expect(worker.getByText('Failed at tests/checkout.spec.ts:5')).toBeVisible();
    await expect(worker.getByText('expect(locator).toBeVisible() failed')).toBeVisible();
    await expect(worker.getByRole('button', { name: 'Resume' })).toHaveAttribute('title', 'End the test as it failed');
    await expect(worker.getByRole('button', { name: 'Step' })).toHaveCount(0);

    // The run ends: once the hub's run ends too, the window lets the stream go, so no stop waits for it.
    await page.evaluate(() => (window as unknown as { __endRun(): void }).__endRun());
    await expect(tray(page).getByText('Passed', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((event) => window.__hub.send(event), session(RUNNING, true));
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(0);
    await expect(worker).toHaveCount(0);
  });

  test('keeps the keyboard on the controls: Pause while a step runs, Step again at the next stop', async ({ page }) => {
    await installBridge(page);
    const commands = await playHub(page);
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Run locally' }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    await page.evaluate((event) => window.__hub.send(event), session(stopped('s1')));
    const worker = tray(page).locator('[data-shot="desktop-run-worker"]');
    const step = worker.getByRole('button', { name: 'Step' });
    await step.focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(() => commands.find((c) => c.type === 'runControl'))
      .toMatchObject({ action: 'step', since: 's1' });
    // The step runs: Step goes, and Pause holds the keyboard meanwhile.
    await page.evaluate((event) => window.__hub.send(event), session(RUNNING));
    await expect(worker.getByRole('button', { name: 'Pause' })).toBeFocused();
    // The next stop: Step has it again, and answers that stop.
    await page.evaluate((event) => window.__hub.send(event), session(stopped('s2', { reason: 'step' })));
    await expect(worker.getByRole('button', { name: 'Step' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect
      .poll(() => commands.filter((c) => c.type === 'runControl').at(-1))
      .toMatchObject({ action: 'step', since: 's2' });
    // Resume, used at a stop, keeps it at the next one too; a press elsewhere lets it go.
    await page.evaluate((event) => window.__hub.send(event), session(stopped('s3', { reason: 'step' })));
    await expect(worker.getByRole('button', { name: 'Step' })).toBeFocused();
    await worker.getByRole('button', { name: 'Resume' }).focus();
    await page.keyboard.press('Enter');
    await page.evaluate((event) => window.__hub.send(event), session(RUNNING));
    await expect(worker.getByRole('button', { name: 'Pause' })).toBeFocused();
    await page.evaluate((event) => window.__hub.send(event), session(stopped('s4', { reason: 'page-pause' })));
    await expect(worker.getByRole('button', { name: 'Resume' })).toBeFocused();
    await tray(page).getByRole('heading', { name: 'Local runs' }).click();
    await page.evaluate((event) => window.__hub.send(event), session(RUNNING));
    await page.evaluate((event) => window.__hub.send(event), session(stopped('s5', { reason: 'step' })));
    await expect(worker.getByRole('button', { name: 'Resume' })).not.toBeFocused();
  });

  test('holds a run from its first step once Hold failures is on, and tells the system of a failure or a page.pause() once', async ({
    page,
  }) => {
    await installBridge(page);
    const commands = await playHub(page);
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Run locally' }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    // Turned on before its workers connect: the run is shown by the name its step gave the hub.
    await holdSwitch(page).click();
    await expect.poll(() => commands.find((c) => c.type === 'show')).toMatchObject({ ref: REF, on: true });
    await page.evaluate((event) => window.__hub.send(event), session(RUNNING));
    const worker = tray(page).locator('[data-shot="desktop-run-worker"]');
    await expect(worker.getByText('Running', { exact: true })).toBeVisible();

    // In the background, steps made elsewhere (Piwi Picker's) say nothing to the system; they show in the tray.
    await page.evaluate(() => {
      document.hasFocus = () => false;
    });
    for (const since of ['s1', 's2']) {
      await page.evaluate((event) => window.__hub.send(event), session(stopped(since, { reason: 'step' })));
      await expect(worker.getByText('Stopped after a step')).toBeVisible();
      await page.evaluate((event) => window.__hub.send(event), session(RUNNING));
      await expect(worker.getByText('Running', { exact: true })).toBeVisible();
    }
    expect(await page.evaluate(() => window.__notes)).toEqual([]);

    // A page.pause() is said, once: the stream opening again brings the same stop, which is not said again.
    await page.evaluate((event) => window.__hub.send(event), session(stopped('s3', { reason: 'page-pause' })));
    await expect(worker.getByText('Stopped at page.pause()')).toBeVisible();
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    await page.evaluate((event) => window.__hub.send(event), session(stopped('s3', { reason: 'page-pause' })));
    await page.evaluate(
      (event) => window.__hub.send(event),
      session(stopped('s4', { reason: 'failure', title: 'Failed: Error', error: 'expect failed' })),
    );
    await expect(worker.getByText('Failed at tests/checkout.spec.ts:5')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.__notes))
      .toEqual([
        'A test waits at page.pause() | checkout › pays stopped at tests/checkout.spec.ts:5.',
        'A test failed and waits | checkout › pays failed at tests/checkout.spec.ts:5.',
      ]);

    // Turned off: the run is shown no more, and its failures go on.
    await holdSwitch(page).click();
    await expect.poll(() => commands.filter((c) => c.type === 'show').at(-1)).toMatchObject({ ref: REF, on: false });
  });

  test('offers no Hold failures for a run nobody attends, and says why', async ({ page }) => {
    await installBridge(page);
    const commands = await playHub(page);
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Run locally' }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    await holdSwitch(page).click();
    await expect.poll(() => commands.find((c) => c.type === 'show')).toMatchObject({ ref: REF, on: true });
    // The hub names the run's step as one nobody attends (a run repeating its tests): the switch goes off, and stays.
    const unattended = session(RUNNING);
    unattended.session.ref = `${REF}-unattended`;
    await page.evaluate((event) => window.__hub.send(event), unattended);
    await expect(holdSwitch(page)).toBeDisabled();
    await expect(holdSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await expect(holdSwitch(page)).toHaveAccessibleDescription(
      'Nobody attends a run of this kind: it goes on past each failure.',
    );
    await expect.poll(() => commands.filter((c) => c.type === 'show').at(-1)).toMatchObject({ ref: REF, on: false });
    // Its workers still show in the run, as the tray's own.
    await expect(
      tray(page).locator('[data-shot="desktop-run-worker"]').getByText('Running', { exact: true }),
    ).toBeVisible();
  });
});
