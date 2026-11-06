import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/** The run page's desktop re-run button, by what it says it runs. */
const RERUN_FAILED = /^Re-run \d+ failed tests?/;

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
    /** What the page asked the shell to run its tests with, last. */
    __runArgs?: { originRef?: string };
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
                window.__runArgs = args;
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

/** A running worker whose reporter shows its lane while the test runs (`watch`). */
const WATCHABLE = { ...RUNNING, intents: ['mock', 'view', 'input', 'pick-at', 'watch'] };

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
    await page.getByRole('button', { name: RERUN_FAILED }).click();
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
    // The Pause waits for the call the test runs: the call, how long it has run, and End the test, which gives it up.
    const waiting = {
      title: "Click getByRole('button', { name: 'Never' })",
      uri: SPEC_URI,
      line: 3,
      since: new Date(Date.now() - 12_000).toISOString(),
      endable: true,
    };
    await page.evaluate(
      (event) => window.__hub.send(event),
      session({ ...RUNNING, pausing: true, waiting, intents: ['give-up'] }),
    );
    await expect(worker.getByText("Pausing: waits in Click getByRole('button', { name: 'Never' })")).toBeVisible();
    await expect(worker.getByTestId('desktop-waited')).toHaveText(/^for 1\d s$/);
    const endTest = worker.getByRole('button', { name: 'End the test' });
    await expect(endTest).toHaveAttribute('title', /the call it waits in is given up/);
    await endTest.click();
    await expect
      .poll(() => commands.filter((c) => c.type === 'runControl').at(-1))
      .toMatchObject({ ref: REF, worker: 0, action: 'give-up', since: null });
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

  test('shows every stop it hears, ends a test there, a failure with its error, the hub’s text as text, and lets go as it ends', async ({
    page,
  }) => {
    const image = await jpeg(page);
    await installBridge(page);
    const commands = await playHub(page, (command) =>
      command.type === 'pausedPage' ? { image: { mime: 'image/jpeg', data: image, width: 640, height: 400 } } : {},
    );
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: RERUN_FAILED }).click();
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
      session(stopped('s2', { reason: 'page-pause', title: markup, intents: ['mock', 'view', 'pick-at', 'end'] })),
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

    // End the test, which the stop takes: its reporter ends the test there, skipped.
    await expect(worker.getByRole('button')).toHaveText([
      'Watch live',
      'Pick on the image',
      'Resume',
      'Step',
      'Finish',
      'End the test',
      'Mock a request',
    ]);
    const end = worker.getByRole('button', { name: 'End the test' });
    await expect(end).toHaveAttribute('title', 'End the test here: the rest of it is skipped');
    await end.click();
    await expect
      .poll(() => commands.filter((c) => c.type === 'runControl').at(-1))
      .toMatchObject({ ref: REF, worker: 0, action: 'end', since: 's2' });

    // A failure: where it failed and its error, with Resume alone.
    await page.evaluate(
      (event) => window.__hub.send(event),
      session(
        stopped('s3', {
          reason: 'failure',
          title: 'Failed: Error: expect failed',
          error: 'expect(locator).toBeVisible() failed',
          intents: ['mock', 'view', 'pick-at', 'end'],
        }),
      ),
    );
    await expect(worker.getByText('Failed at tests/checkout.spec.ts:5')).toBeVisible();
    await expect(worker.getByText('expect(locator).toBeVisible() failed')).toBeVisible();
    await expect(worker.getByRole('button', { name: 'Resume' })).toHaveAttribute('title', 'End the test as it failed');
    await expect(worker.getByRole('button', { name: 'Step' })).toHaveCount(0);
    await expect(worker.getByRole('button', { name: 'End the test' })).toHaveCount(0);

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
    await page.getByRole('button', { name: RERUN_FAILED }).click();
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
    await page.getByRole('button', { name: RERUN_FAILED }).click();
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
    await page.getByRole('button', { name: RERUN_FAILED }).click();
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

  test('watches a running worker’s page, through a stop and between tests, and offers no Watch to an older reporter', async ({
    page,
  }) => {
    const image = await jpeg(page);
    await installBridge(page);
    const commands = await playHub(page);
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    await page.evaluate((event) => window.__hub.send(event), session(WATCHABLE));
    const worker = tray(page).locator('[data-shot="desktop-run-worker"]');
    const lane = worker.locator('[data-shot="desktop-run-lane"]');
    const watch = worker.getByRole('button', { name: 'Watch', exact: true });
    await expect(watch).toHaveAttribute('aria-pressed', 'false');
    await expect(worker.getByTestId('desktop-watch-needs-update')).toHaveCount(0);

    // Watch: the window watches the worker's lane, and its frames show the running test's page.
    await watch.click();
    await expect(watch).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() => commands.filter((c) => c.type === 'watch'))
      .toEqual([expect.objectContaining({ ref: REF, lane: 0, on: true, viewer: VIEWER })]);
    await expect(lane.getByText('Starting the live view…')).toBeVisible();
    const frame = (since: string | null, test = 't1') =>
      page.evaluate((event) => window.__hub.send(event), {
        type: 'lane-frame',
        ref: REF,
        lane: 0,
        worker: 0,
        test,
        since,
        width: 640,
        height: 400,
        data: image,
      });
    await frame(null);
    const live = lane.getByRole('img', { name: 'The page, live', exact: true });
    await expect(live).toBeVisible();
    await expect(live).not.toHaveAttribute('data-stale');
    await expect(lane.getByText('Live', { exact: true })).toBeVisible();

    // A stop: the lane's frame of the stopped page comes, and the stop takes the clicks on it through the lane, with no
    // view of its own; Watch live is not offered, the lane shows the stop.
    const atStop = { ...stopped('s1', { intents: ['mock', 'view', 'input', 'pick-at'] }), intents: WATCHABLE.intents };
    await page.evaluate((event) => window.__hub.send(event), session(atStop));
    await expect(worker.getByText('Paused', { exact: true })).toBeVisible();
    await expect(lane.getByText('Taking an image of the page…')).toBeVisible();
    await frame('s1');
    const view = lane.getByRole('img', { name: 'The page, live: clicks and keys go to it' });
    await expect(view).toBeVisible();
    await expect(worker.getByRole('button')).toHaveText([
      'Watch',
      'Pick on the image',
      'Resume',
      'Step',
      'Finish',
      'Mock a request',
    ]);
    await view.click({ position: { x: 20, y: 20 } });
    await expect.poll(() => commands.find((c) => c.type === 'input')).toMatchObject({ since: 's1', worker: 0 });
    await worker.getByRole('button', { name: 'Pick on the image' }).click();
    await view.click({ position: { x: 100, y: 50 } });
    await expect.poll(() => commands.find((c) => c.type === 'pick-at')).toMatchObject({ since: 's1' });

    // Resumed: the last image stays, dimmed and marked as running, until the next frame.
    await worker.getByRole('button', { name: 'Resume' }).click();
    await expect
      .poll(() => commands.filter((c) => c.type === 'runControl').at(-1))
      .toMatchObject({ action: 'resume', since: 's1' });
    await page.evaluate((event) => window.__hub.send(event), session(WATCHABLE));
    const lastShown = lane.getByRole('img', { name: 'The page as it last showed' });
    await expect(lastShown).toBeVisible();
    await expect(lastShown).toHaveAttribute('data-stale', 'true');
    await expect(lane.getByText('Running…', { exact: true })).toBeVisible();
    await frame(null);
    await expect(live).toBeVisible();
    await expect(live).not.toHaveAttribute('data-stale');

    // Between two tests, and as the next one starts, the image stays as it last showed until that test's frame.
    await page.evaluate((event) => window.__hub.send(event), session({ ...WATCHABLE, state: 'between', test: null }));
    await expect(worker.getByText('Between tests')).toBeVisible();
    await expect(lastShown).toHaveAttribute('data-stale', 'true');
    const next = { ...TEST, id: 't2', title: ['checkout', 'refunds'] };
    await page.evaluate((event) => window.__hub.send(event), session({ ...WATCHABLE, test: next }));
    await expect(worker.getByText('checkout › refunds')).toBeVisible();
    await expect(lastShown).toBeVisible();
    await frame(null, 't2');
    await expect(live).toBeVisible();
    // The lane's frames were the window's view of the stop: it asked for no view of its own.
    expect(commands.filter((c) => c.type === 'view')).toEqual([]);

    // Turned off: the hub hears it, and the image goes.
    await watch.click();
    await expect(watch).toHaveAttribute('aria-pressed', 'false');
    await expect
      .poll(() => commands.filter((c) => c.type === 'watch').at(-1))
      .toMatchObject({ ref: REF, lane: 0, on: false });
    await expect(lane.getByRole('img')).toHaveCount(0);

    // A worker whose reporter shows a stopped test alone offers no Watch, and says what would.
    await page.evaluate((event) => window.__hub.send(event), session(RUNNING));
    await expect(watch).toHaveCount(0);
    await expect(worker.getByTestId('desktop-watch-needs-update')).toHaveText(
      'Update the reporter to watch a running test.',
    );
  });

  test('keeps the keyboard on the worker and the image honest as its lane stops, hides, refuses and leaves a test', async ({
    page,
  }) => {
    const image = await jpeg(page);
    await installBridge(page);
    let refuse = false;
    const commands = await playHub(page, (command) =>
      command.type === 'watch' && command.on && refuse
        ? { ok: false, message: 'This run has no worker 1 to watch.' }
        : {},
    );
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    const send = (event: unknown) => page.evaluate((e) => window.__hub.send(e), event);
    await send(session(WATCHABLE));
    const worker = tray(page).locator('[data-shot="desktop-run-worker"]');
    const lane = worker.locator('[data-shot="desktop-run-lane"]');
    const watch = worker.getByRole('button', { name: 'Watch', exact: true });
    const watchLive = worker.getByRole('button', { name: 'Watch live' });
    const live = lane.getByRole('img', { name: 'The page, live', exact: true });
    const lastShown = lane.getByRole('img', { name: 'The page as it last showed' });
    const intents = ['mock', 'view', 'input', 'pick-at'];
    const atStop = (since: string, test: typeof TEST | null = TEST) =>
      session({ ...stopped(since, { intents }), intents: WATCHABLE.intents, test });
    const frame = (since: string | null) =>
      send({
        type: 'lane-frame',
        ref: REF,
        lane: 0,
        worker: 0,
        test: 't1',
        since,
        width: 640,
        height: 400,
        data: image,
      });
    const lastWatch = () => commands.filter((c) => c.type === 'watch').at(-1);
    const setHidden = (hidden: boolean) =>
      page.evaluate((on) => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => on });
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);

    // Watch has the keyboard as the running test stops: Watch live, in its place at the stop, takes it.
    await watch.focus();
    await send(atStop('s1'));
    await expect(watchLive).toBeFocused();

    // Watched, the running test's page shows live.
    await send(session(WATCHABLE));
    await watch.click();
    await expect.poll(lastWatch).toMatchObject({ ref: REF, lane: 0, on: true });
    await frame(null);
    await expect(live).toBeVisible();

    // The window hidden, then shown again: the image is the page as it last showed until a frame of the lane comes.
    await setHidden(true);
    await expect.poll(lastWatch).toMatchObject({ on: false });
    await setHidden(false);
    await expect.poll(lastWatch).toMatchObject({ on: true });
    await expect(lastShown).toHaveAttribute('data-stale', 'true');
    await expect(lane.getByText('Running…', { exact: true })).toBeVisible();
    await frame(null);
    await expect(live).not.toHaveAttribute('data-stale');

    // Why the lane sends no frame stays, the image dimmed, though a frame was on its way as it came.
    await page.evaluate(
      ({ ref, data }) => {
        const at = { type: 'lane-frame', ref, lane: 0, worker: 0, test: 't1', since: null };
        window.__hub.send({ ...at, width: 640, height: 400, data });
        window.__hub.send({ ...at, refused: 'Each image of the page is too long.' });
      },
      { ref: REF, data: image },
    );
    const tooLong = lane.getByText('Each image of the page is too long.');
    await expect(tooLong).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    await expect(tooLong).toBeVisible();
    await expect(lastShown).toHaveAttribute('data-stale', 'true');
    await frame(null);
    await expect(live).toBeVisible();
    await expect(tooLong).toHaveCount(0);

    // A stop outside a test: the lane sends no frame of it, so the stop's own page shows it, with Watch live.
    await send(atStop('s2', null));
    await expect(watchLive).toBeVisible();
    await expect(lane).toHaveCount(0);

    // A stop of a test shows in the lane. Watch, turned off there, gives the keyboard to Watch live, which stays off.
    await send(session(WATCHABLE));
    await send(atStop('s3'));
    await frame('s3');
    await expect(lane.getByRole('img', { name: 'The page, live: clicks and keys go to it' })).toBeVisible();
    await watch.focus();
    await page.keyboard.press('Enter');
    await expect(watchLive).toBeFocused();
    await expect(watchLive).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(lastWatch).toMatchObject({ on: false });

    // A lane the hub would not show says why, while the test runs and at its next stop, where Watch live is offered.
    refuse = true;
    await send(session(WATCHABLE));
    await watch.click();
    await expect(lane.getByText('This run has no worker 1 to watch.')).toBeVisible();
    await expect(watch).toHaveAttribute('aria-pressed', 'false');
    await send(atStop('s4'));
    await expect(worker.getByTestId('desktop-lane-refused')).toHaveText('This run has no worker 1 to watch.');
    await expect(watchLive).toBeVisible();
  });

  test('pauses a running test from its row on the run’s page, and shows its page live at the stop', async ({
    page,
    request,
  }) => {
    await installBridge(page);
    // The first pause meets a test that has just stopped.
    let stoppedAlready = true;
    let refuseWatch = false;
    const commands = await playHub(page, (command) => {
      if (command.type === 'watch' && command.on && refuseWatch) {
        return { ok: false, message: 'This run has no worker 1 to watch.' };
      }
      if (command.type !== 'runControl' || !stoppedAlready) return {};
      stoppedAlready = false;
      return { ok: false, message: 'The test is stopped already.' };
    });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    // A run another window of the app started runs the same test on the same worker: no row of this run is its.
    const elsewhere = session(RUNNING);
    elsewhere.session.ref = 'desktop-77';
    await page.evaluate((event) => window.__hub.send(event), elsewhere);
    await page.evaluate((event) => window.__hub.send(event), session(RUNNING));

    // The run reports to this app with the reference the app gave it, and its test begins on worker 0.
    await expect.poll(() => page.evaluate(() => window.__runArgs?.originRef)).toMatch(/^desktop:/);
    const originRef = await page.evaluate(() => window.__runArgs?.originRef);
    const start = await retryPost(request, '/api/test-runs/start', {
      data: {
        projectName: PROJECT.DESKTOP_RUN_VIEW,
        startTime: new Date().toISOString(),
        metadata: { piwiOrigin: { kind: 'desktop', ref: originRef } },
      },
    });
    expect(start.ok()).toBeTruthy();
    const live = (await start.json()) as { runId: number; streamToken: string };
    try {
      const begun = await retryPost(request, `/api/test-runs/${live.runId}/events`, {
        data: {
          streamToken: live.streamToken,
          testCases: [
            {
              type: 'begin',
              title: 'pays',
              location: 'tests/checkout.spec.ts:3:1',
              workerIndex: 0,
              startedAt: Date.now(),
              browser: { projectName: 'chromium' },
            },
          ],
        },
      });
      expect(begun.ok()).toBeTruthy();
      await tray(page)
        .getByRole('link', { name: `Live in Piwi — Run #${live.runId}` })
        .click({ timeout: 15_000 });
      await expect(page).toHaveURL(new RegExp(`/test-runs/${live.runId}$`));

      // Its running row: Pause and watch pauses that worker of this run before its next call. The test stopped at a
      // page.pause() as the pause went: the hub says so, and that stop, which comes next, is watched live.
      const watch = page.getByRole('button', { name: 'Pause and watch' });
      // Its reporter shows a stopped test alone: no Watch, and Pause and watch says what would.
      await expect(watch).toHaveAttribute(
        'title',
        'Stop the test before its next call that acts on or checks the page, and watch its page live in Local runs. ' +
          'Update the reporter to watch a running test.',
      );
      await expect(watch).toHaveAccessibleName('Pause and watch: checkout › pays');
      await expect(page.getByTestId('desktop-watch-lane')).toHaveCount(0);
      await watch.click();
      // The toast, and its copy for screen readers.
      await expect(page.getByText('The test is stopped already.').first()).toBeVisible();
      await page.evaluate((event) => window.__hub.send(event), session(stopped('s0', { reason: 'page-pause' })));
      await expect(tray(page).getByText('Stopped at page.pause()')).toBeVisible();
      await expect(tray(page).getByRole('button', { name: 'Watch live' })).toHaveAttribute('aria-pressed', 'true');

      // It goes on, and the next pause reaches it.
      await page.evaluate((event) => window.__hub.send(event), session(RUNNING));
      await watch.click();
      await expect
        .poll(() => commands.filter((c) => c.type === 'runControl'))
        .toEqual([
          expect.objectContaining({ ref: REF, worker: 0, action: 'pause', since: null }),
          expect.objectContaining({ ref: REF, worker: 0, action: 'pause', since: null }),
        ]);
      await page.evaluate((event) => window.__hub.send(event), session({ ...RUNNING, pausing: true }));
      await expect(page.getByRole('button', { name: 'Pausing…' })).toHaveAttribute('aria-disabled', 'true');
      await page.evaluate((event) => window.__hub.send(event), session(stopped('s1')));
      await expect(tray(page).getByText('Paused', { exact: true })).toBeVisible();
      await expect(tray(page).getByRole('button', { name: 'Watch live' })).toHaveAttribute('aria-pressed', 'true');

      // The row says where the test stopped. Closed, the tray ends the view; Show its page opens it on the worker,
      // the focus there, and Watch live, left on, watches the stop again.
      await expect(page.getByTestId('desktop-stopped')).toContainText(
        /Paused\s*·\s*Click getByRole\('button', \{ name: 'Pay' \}\)\s*·\s*tests\/checkout\.spec\.ts:5/,
      );
      await tray(page).getByRole('button', { name: 'Close local runs' }).click();
      await expect(tray(page)).toHaveCount(0);
      await page.getByRole('button', { name: 'Show its page' }).click();
      await expect(tray(page).locator(`[data-worker="${REF}|0"]`)).toBeFocused();
      await expect(tray(page).getByRole('button', { name: 'Watch live' })).toHaveAttribute('aria-pressed', 'true');
      await expect
        .poll(() => commands.filter((c) => c.type === 'view').map((c) => [c.ref, c.since, c.on]))
        .toEqual([
          [REF, 's0', true],
          [REF, 's0', false],
          [REF, 's1', true],
          [REF, 's1', false],
          [REF, 's1', true],
        ]);

      // A reporter that shows the lane while the test runs, whose lane the hub would not show: Pause and watch shows the
      // stop live all the same, and the tray says why the lane does not show.
      refuseWatch = true;
      await tray(page).getByRole('button', { name: 'Close local runs' }).click();
      await page.evaluate((event) => window.__hub.send(event), session(WATCHABLE));
      await page.getByRole('button', { name: 'Pause and watch: checkout › pays', exact: true }).click();
      await page.evaluate(
        (event) => window.__hub.send(event),
        session({ ...stopped('s2', { intents: ['mock', 'view', 'input', 'pick-at'] }), intents: WATCHABLE.intents }),
      );
      await expect(tray(page).getByTestId('desktop-lane-refused')).toHaveText('This run has no worker 1 to watch.');
      await expect(tray(page).getByRole('button', { name: 'Watch live' })).toHaveAttribute('aria-pressed', 'true');
      await expect
        .poll(() => commands.filter((c) => c.type === 'view').at(-1))
        .toMatchObject({ ref: REF, since: 's2', on: true });
      refuseWatch = false;

      // Watch, on the row, opens the tray on the worker with its lane watched.
      await tray(page).getByRole('button', { name: 'Close local runs' }).click();
      await page.evaluate((event) => window.__hub.send(event), session(WATCHABLE));
      const watchLane = page.getByRole('button', { name: 'Watch: checkout › pays', exact: true });
      await expect(watchLane).toHaveAttribute(
        'title',
        'Open Local runs on this test, where its page shows as it runs, and at each stop',
      );
      await watchLane.click();
      await expect(tray(page).locator(`[data-worker="${REF}|0"]`)).toBeFocused();
      await expect(tray(page).getByRole('button', { name: 'Watch', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect
        .poll(() => commands.filter((c) => c.type === 'watch').at(-1))
        .toMatchObject({ ref: REF, lane: 0, on: true, viewer: VIEWER });

      // A test that never stops says why, in place of Pause and watch.
      const never = "Playwright's Inspector runs the test (PWDEBUG) — run without --debug";
      await page.evaluate(
        (event) => window.__hub.send(event),
        session({ ...RUNNING, test: { ...TEST, cannotPause: never } }),
      );
      await expect(page.getByTestId('desktop-cannot-pause')).toHaveText(`This test never stops: ${never}`);
      await expect(page.getByRole('button', { name: 'Pause and watch' })).toHaveCount(0);
    } finally {
      await request.post(`/api/test-runs/${live.runId}/finish`, {
        data: { streamToken: live.streamToken, status: 'passed', totalTests: 1 },
      });
    }
  });
});
