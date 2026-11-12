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
    /** Ends shell run 41 with `code`. */
    __exitRun: (code: number) => void;
    /** Prints `line` as shell run 41's output. */
    __printLine: (line: string) => void;
  }
}

/**
 * Installs the bridge with a linked folder, whose run is shell run 41 and goes on until the spec ends it, as the shell
 * says to a page that reloaded (`desktop_local_runs`).
 */
async function installBridge(page: Page) {
  await page.addInitScript(() => {
    const listeners: ((event: { payload: unknown }) => void)[] = [];
    const emit = (payload: unknown) => {
      for (const cb of listeners) cb({ payload });
    };
    Object.assign(window, {
      __notes: [],
      __endRun: () => emit({ id: 41, kind: 'exit', line: null, code: 0 }),
      __exitRun: (code: number) => emit({ id: 41, kind: 'exit', line: null, code }),
      __printLine: (line: string) => emit({ id: 41, kind: 'stdout', line, code: null }),
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
              case 'desktop_local_runs':
                return { running: [41], ended: [] };
              case 'desktop_open_output_window':
                return `output-${String(args?.name)}_1`;
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
  return sessionOf([worker], ended);
}

/** The hub's run with several workers. */
function sessionOf(workers: Record<string, unknown>[], ended = false) {
  return {
    type: 'session',
    session: { ref: REF, root: ROOT, label: 'acme', command: null, project: 'Acme', workers, ended },
  };
}

const RUNNING = { worker: 0, parallelIndex: 0, state: 'running', test: TEST, stop: null, pausing: false, intents: [] };

/** The names of a page's live view, with and without the input, and of a watched lane's last image. */
const LIVE = 'Live view of the test’s page';
const LIVE_INPUT = 'Live view of the test’s page: keys and clicks go to the page';
const LAST_SEEN = 'The test’s page, as last seen';

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
    // The focus Pause had never goes to End the test, which a key pressed again would answer.
    await expect(endTest).not.toBeFocused();
    await expect(worker.locator('code', { hasText: "Click getByRole('button', { name: 'Never' })" })).toBeVisible();
    await endTest.click();
    await expect
      .poll(() => commands.filter((c) => c.type === 'runControl').at(-1))
      .toMatchObject({ ref: REF, worker: 0, action: 'give-up', since: null });
    await page.evaluate((event) => window.__hub.send(event), session(stopped('s1')));
    await expect(worker.getByText('Paused', { exact: true })).toBeVisible();
    await expect(worker.getByText("Click getByRole('button', { name: 'Pay' })")).toBeVisible();
    await expect(worker.getByText('tests/checkout.spec.ts:5')).toBeVisible();
    const still = worker.getByRole('img', {
      name: "The test’s page, stopped before: Click getByRole('button', { name: 'Pay' })",
    });
    await expect(still).toBeVisible();
    expect(commands.filter((c) => c.type === 'pausedPage')).toHaveLength(1);
    // The stop's place opens in the editor (its chooser beside it), then the controls.
    await expect(worker.getByRole('button')).toHaveText([
      'tests/checkout.spec.ts:5',
      '',
      'Resume',
      'Step',
      'Finish',
      'Mock a request',
      'Watch',
      'Pick on the image',
    ]);

    // The stop's Watch: its frames take the image's place, and Interact sends the input to the page once the stop takes it.
    await worker.getByRole('button', { name: 'Watch', exact: true }).click();
    await expect(worker.getByRole('button', { name: 'Watch', exact: true })).toHaveAttribute('aria-pressed', 'true');
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
    await expect(worker.getByRole('img', { name: LIVE, exact: true })).not.toHaveAttribute('tabindex');
    const interact = worker.getByRole('button', { name: 'Interact' });
    await expect(interact).toHaveAttribute('aria-pressed', 'false');
    // Interact sends the clicks and keys on the view to the page, and the first of them drives the stop.
    await interact.click();
    await expect(interact).toHaveAttribute('aria-pressed', 'true');
    const view = worker.getByRole('img', { name: LIVE_INPUT });
    await expect(view).toBeVisible();
    await expect(view).toHaveAttribute('tabindex', '0');
    expect(commands.filter((c) => c.type === 'drive')).toEqual([]);
    await view.click({ position: { x: 20, y: 20 } });
    await expect.poll(() => commands.find((c) => c.type === 'input')).toMatchObject({ since: 's1' });
    // While a region's pick runs in the test's window, Escape is the page's: it goes there, and Interact stays on.
    const intents = ['assert-region', 'mock', 'view', 'input', 'pick-at'];
    await page.evaluate(
      (event) => window.__hub.send(event),
      session(stopped('s1', { intents, acting: 'assert-region' })),
    );
    await expect(view).toHaveAttribute('data-acting', '');
    const typed = commands.length;
    await page.keyboard.press('Escape');
    await expect
      .poll(() => commands.slice(typed).flatMap((c) => (c.type === 'input' ? (c.events as unknown[]) : [])))
      .toContainEqual({ type: 'key', action: 'press', key: 'Escape' });
    await expect(interact).toHaveAttribute('aria-pressed', 'true');
    expect(commands.slice(typed).filter((c) => c.type === 'drive')).toEqual([]);
    await page.evaluate((event) => window.__hub.send(event), session(stopped('s1', { intents })));
    await expect(view).not.toHaveAttribute('data-acting');
    // Escape turns Interact off, on Interact, and gives back the stop its input drove, once that input went.
    await page.keyboard.press('Escape');
    await expect(interact).toBeFocused();
    await expect(interact).toHaveAttribute('aria-pressed', 'false');
    const watched = worker.getByRole('img', { name: LIVE, exact: true });
    await expect(watched).toBeVisible();
    await expect
      .poll(() => commands.filter((c) => c.type === 'drive'))
      .toEqual([expect.objectContaining({ since: 's1', on: false })]);
    expect(commands.findIndex((c) => c.type === 'drive')).toBeGreaterThan(
      commands.findLastIndex((c) => c.type === 'input'),
    );

    // Pick on the image, Interact off: the point goes in CSS pixels of the page; the locator shows, to copy.
    await worker.getByRole('button', { name: 'Pick on the image' }).click();
    await watched.click({ position: { x: 100, y: 50 } });
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
    const list = worker.getByRole('group', { name: 'Choose the request to mock' });
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

    // The stop's Watch and Interact, left on, watch the worker's next stop too, and send it the input.
    await interact.click();
    await page.evaluate((event) => window.__hub.send(event), session(RUNNING));
    await expect(worker.getByText('Running', { exact: true })).toBeVisible();
    await page.evaluate(
      (event) => window.__hub.send(event),
      session(stopped('s2', { reason: 'step', intents: ['view', 'input', 'pick-at'] })),
    );
    await expect(worker.getByText('Stopped after a step')).toBeVisible();
    await expect.poll(() => commands.filter((c) => c.type === 'view').at(-1)).toMatchObject({ since: 's2', on: true });
    await expect(worker.getByRole('button', { name: 'Watch', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(
      ({ ref, data }) =>
        window.__hub.send({ type: 'frame', ref, worker: 0, since: 's2', width: 640, height: 400, data }),
      { ref: REF, data: image },
    );
    await expect(interact).toHaveAttribute('aria-pressed', 'true');
    await expect(worker.getByRole('img', { name: LIVE_INPUT })).toBeVisible();
    // The stop's Watch off turns Interact off, and gives back the stop the window drives.
    const drove = { kind: 'desktop', name: 'the desktop app', self: true };
    await page.evaluate(
      (event) => window.__hub.send(event),
      session(stopped('s2', { reason: 'step', intents: ['view', 'input', 'pick-at'], driver: drove })),
    );
    await worker.getByRole('button', { name: 'Watch', exact: true }).click();
    await expect(interact).toHaveCount(0);
    await expect
      .poll(() => commands.filter((c) => c.type === 'drive').at(-1))
      .toMatchObject({ since: 's2', on: false });
    // Given back before the view ends, which would give it back unsaid.
    await expect
      .poll(() => commands.findLastIndex((c) => c.type === 'view' && c.since === 's2' && c.on === false))
      .toBeGreaterThan(commands.findLastIndex((c) => c.type === 'drive'));
    // A stop another tool drives is left to it.
    const drives = commands.filter((c) => c.type === 'drive').length;
    await worker.getByRole('button', { name: 'Watch', exact: true }).click();
    const editor = { kind: 'editor', name: 'Visual Studio Code' };
    await page.evaluate(
      (event) => window.__hub.send(event),
      session(stopped('s2', { reason: 'step', intents: ['view', 'input', 'pick-at'], driver: editor })),
    );
    await page.evaluate(
      ({ ref, data }) =>
        window.__hub.send({ type: 'frame', ref, worker: 0, since: 's2', width: 640, height: 400, data }),
      { ref: REF, data: image },
    );
    await expect(interact).toHaveAttribute('aria-pressed', 'false');
    await interact.click();
    await interact.click();
    await expect(interact).toHaveAttribute('aria-pressed', 'false');
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(commands.filter((c) => c.type === 'drive')).toHaveLength(drives);
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
    // The stop's place opens in the editor (its chooser beside it), then the controls.
    await expect(worker.getByRole('button')).toHaveText([
      'tests/checkout.spec.ts:5',
      '',
      'Resume',
      'Step',
      'Finish',
      'End the test',
      'Mock a request',
      'Watch',
      'Pick on the image',
    ]);
    const end = worker.getByRole('button', { name: 'End the test' });
    await expect(end).toHaveAttribute('title', 'End the test here: the rest of it is skipped');
    await end.click();
    await expect
      .poll(() => commands.filter((c) => c.type === 'runControl').at(-1))
      .toMatchObject({ ref: REF, worker: 0, action: 'end', since: 's2' });

    // A failure: where it failed and its error, with Resume alone; the hub offers no End the test there.
    await page.evaluate(
      (event) => window.__hub.send(event),
      session(
        stopped('s3', {
          reason: 'failure',
          title: 'Failed: Error: expect failed',
          error: 'expect(locator).toBeVisible() failed',
          intents: ['mock', 'view', 'pick-at'],
        }),
      ),
    );
    await expect(worker.getByText('Failed at tests/checkout.spec.ts:5')).toBeVisible();
    await expect(worker.getByText('expect(locator).toBeVisible() failed')).toBeVisible();
    await expect(worker.getByRole('button', { name: 'Resume' })).toHaveAttribute(
      'title',
      'Let the test end as it failed',
    );
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

  test('names the run by its number on the instance it reports to, and opens its page', async ({ page }) => {
    await installBridge(page);
    await playHub(page);
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect(tray(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    const withPage = (url: string) => {
      const event = session(RUNNING);
      return { ...event, session: { ...event.session, page: { id: runId, url } } };
    };

    // A run on this app's own server opens in the window.
    const own = `${new URL(page.url()).origin}/test-runs/${runId}`;
    await page.evaluate((event) => window.__hub.send(event), withPage(own));
    const line = tray(page).getByTestId('desktop-run-page');
    await expect(line).toHaveText(new RegExp(`^Run #${runId}\\s*·\\s*Open$`));
    await expect(line.getByRole('link', { name: `Open run #${runId}` })).toHaveAttribute('href', `/test-runs/${runId}`);

    // One a team instance holds opens in the browser.
    await page.evaluate((event) => window.__hub.send(event), withPage(`https://piwi.example.com/test-runs/${runId}`));
    const team = line.getByRole('link', { name: `Open run #${runId}` });
    await expect(team).toHaveAttribute('href', `https://piwi.example.com/test-runs/${runId}`);
    await expect(team).toHaveAttribute('target', '_blank');
  });

  test('says who else has the run open, who watches a worker’s page and who drives its stop', async ({ page }) => {
    await installBridge(page);
    const commands = await playHub(page);
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    const PICKER = { kind: 'picker', name: 'Piwi Picker' };
    const AGENT = { kind: 'agent', name: 'an agent' };
    const SELF = { kind: 'desktop', name: 'the desktop app', self: true };
    const present = (worker: Record<string, unknown>) => {
      const event = session(worker);
      return { ...event, session: { ...event.session, presence: [SELF, PICKER, AGENT] } };
    };

    // The run: who else has it open, this window left out; the worker: who watches its page beside this window.
    await page.evaluate((event) => window.__hub.send(event), present({ ...RUNNING, watchers: [PICKER, SELF] }));
    await expect(tray(page).getByTestId('desktop-run-presence')).toHaveText(
      'Also open in Piwi Picker · An agent follows this run',
    );
    const worker = tray(page).locator('[data-shot="desktop-run-worker"]');
    await expect(worker.getByTestId('desktop-worker-watchers')).toHaveText('Watched by you and Piwi Picker');

    // A stop the agent asked for and drives: Take control drives it from this window.
    const agentStop = stopped('s1', { by: 'agent', driver: AGENT });
    await page.evaluate((event) => window.__hub.send(event), present(agentStop));
    await expect(worker.getByText('Paused by the agent')).toBeVisible();
    const driver = worker.getByTestId('desktop-stop-driver');
    await expect(driver).toContainText('An agent drives this stop');
    await driver.getByRole('button', { name: 'Take control' }).click();
    await expect
      .poll(() => commands.find((c) => c.type === 'drive'))
      .toMatchObject({ ref: REF, worker: 0, since: 's1', on: true, viewer: VIEWER });

    // This window drives it: Give back lets the agent act again.
    await page.evaluate((event) => window.__hub.send(event), present(stopped('s1', { by: 'agent', driver: SELF })));
    await expect(driver).toContainText('You drive this stop');
    await driver.getByRole('button', { name: 'Give back' }).click();
    await expect
      .poll(() => commands.filter((c) => c.type === 'drive').at(-1))
      .toMatchObject({ ref: REF, worker: 0, since: 's1', on: false });

    // Another tool's person drives it: said, and the window may take it.
    await page.evaluate((event) => window.__hub.send(event), present(stopped('s1', { driver: PICKER })));
    await expect(driver).toContainText('Piwi Picker drives this stop');
    await expect(driver.getByRole('button', { name: 'Take control' })).toBeVisible();

    // Nobody else on the run: no line.
    await page.evaluate((event) => window.__hub.send(event), session(RUNNING));
    await expect(tray(page).getByTestId('desktop-run-presence')).toHaveCount(0);
    await expect(worker.getByTestId('desktop-worker-watchers')).toHaveCount(0);
    await expect(driver).toHaveCount(0);
  });

  test('asks before Stop sharing a run shared live, and stops only once confirmed', async ({ page }) => {
    await installBridge(page);
    const commands = await playHub(page);
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    const shared = session(RUNNING);
    Object.assign(shared.session, {
      page: { id: runId, url: `https://piwi.example.com/test-runs/${runId}` },
      live: {
        shared: true,
        refused: null,
        stopped: null,
        page: `https://piwi.example.com/test-runs/${runId}`,
        viewers: 2,
      },
    });
    await page.evaluate((event) => window.__hub.send(event), shared);
    await expect(tray(page).getByText('Shared live on piwi.example.com · 2 views open')).toBeVisible();

    // Cancel stops nothing.
    await tray(page).getByRole('button', { name: 'Stop sharing…' }).click();
    const ask = page.getByRole('dialog', { name: `Stop sharing run #${runId} live?` });
    await expect(ask).toContainText(
      'The 2 views open on piwi.example.com close, and nothing more of the run goes there.',
    );
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toHaveCount(0);
    expect(commands.filter((c) => c.type === 'share')).toHaveLength(0);

    // Confirmed, it stops sharing.
    await tray(page).getByRole('button', { name: 'Stop sharing…' }).click();
    await ask.getByRole('button', { name: 'Stop sharing' }).click();
    await expect.poll(() => commands.find((c) => c.type === 'share')).toMatchObject({ ref: REF, on: false });
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

  test('a run started with Hold failures on holds from its start, and Run again keeps the switch as left', async ({
    page,
  }) => {
    await installBridge(page);
    const commands = await playHub(page);
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Run options' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Hold failures' }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Re-run \d+ failed tests? · hold failures$/ }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    await expect(holdSwitch(page)).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => commands.find((c) => c.type === 'show')).toMatchObject({ ref: REF, on: true });

    // Turned off in the tray, the run ends; Run again starts it as it was left, with Hold failures off.
    await holdSwitch(page).click();
    await expect.poll(() => commands.filter((c) => c.type === 'show').at(-1)).toMatchObject({ ref: REF, on: false });
    await page.evaluate(() => window.__endRun());
    await expect(holdSwitch(page)).toHaveCount(0);
    await tray(page).getByRole('button', { name: 'Run again' }).first().click();
    await expect(holdSwitch(page)).toHaveAttribute('aria-checked', 'false');
    expect(commands.filter((c) => c.type === 'show' && c.on)).toHaveLength(1);
    // The new run was off: turning it on shows it again, once the hub's stream is open for it.
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    await holdSwitch(page).click();
    await expect.poll(() => commands.filter((c) => c.type === 'show' && c.on)).toHaveLength(2);
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
    const live = lane.getByRole('img', { name: LIVE, exact: true });
    await expect(live).toBeVisible();
    await expect(live).not.toHaveAttribute('data-stale');
    await expect(lane.getByText('Live', { exact: true })).toBeVisible();

    // A stop: the lane's frame of the stopped page comes, and with Interact the stop takes the clicks on it through the
    // lane, with no view of its own; the stop's Watch is not offered, the lane shows the stop.
    const atStop = { ...stopped('s1', { intents: ['mock', 'view', 'input', 'pick-at'] }), intents: WATCHABLE.intents };
    await page.evaluate((event) => window.__hub.send(event), session(atStop));
    await expect(worker.getByText('Paused', { exact: true })).toBeVisible();
    await expect(lane.getByText('Taking an image of the page…')).toBeVisible();
    await frame('s1');
    await expect(live).toBeVisible();
    // The stop's place opens in the editor (its chooser beside it), then the controls.
    await expect(worker.getByRole('button')).toHaveText([
      'tests/checkout.spec.ts:5',
      '',
      'Resume',
      'Step',
      'Finish',
      'Mock a request',
      'Watch',
      'Interact',
      'Pick on the image',
    ]);
    const laneInteract = lane.getByRole('button', { name: 'Interact' });
    await laneInteract.click();
    const view = lane.getByRole('img', { name: LIVE_INPUT });
    await expect(view).toBeVisible();
    await view.click({ position: { x: 20, y: 20 } });
    await expect.poll(() => commands.find((c) => c.type === 'input')).toMatchObject({ since: 's1', worker: 0 });
    // Escape on the lane's view turns Interact off and gives back the stop its input drove.
    await page.keyboard.press('Escape');
    await expect(laneInteract).toBeFocused();
    await expect(laneInteract).toHaveAttribute('aria-pressed', 'false');
    await expect
      .poll(() => commands.filter((c) => c.type === 'drive'))
      .toEqual([expect.objectContaining({ since: 's1', worker: 0, on: false })]);
    await laneInteract.click();
    await worker.getByRole('button', { name: 'Pick on the image' }).click();
    await view.click({ position: { x: 100, y: 50 } });
    await expect.poll(() => commands.find((c) => c.type === 'pick-at')).toMatchObject({ since: 's1' });

    // Resumed: the last image stays, dimmed and marked as running, until the next frame.
    await worker.getByRole('button', { name: 'Resume' }).click();
    await expect
      .poll(() => commands.filter((c) => c.type === 'runControl').at(-1))
      .toMatchObject({ action: 'resume', since: 's1' });
    await page.evaluate((event) => window.__hub.send(event), session(WATCHABLE));
    const lastShown = lane.getByRole('img', { name: LAST_SEEN });
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

    // A worker whose reporter shows a stopped test alone holds its Watch, and says what would show it.
    await page.evaluate((event) => window.__hub.send(event), session(RUNNING));
    const outdated = worker.getByTestId('desktop-watch-needs-update');
    await expect(outdated).toHaveText('Watch');
    await expect(outdated).toHaveAttribute('aria-disabled', 'true');
    await expect(outdated).not.toHaveAttribute('aria-pressed');
    await expect(outdated).toHaveAttribute('title', 'Update the reporter to watch a running test');
  });

  test('opens a watched lane’s trace so far from its page’s head, for a worker whose reporter answers, and says the hub’s answer', async ({
    page,
  }, testInfo) => {
    await installBridge(page);
    const opened = 'Playwright’s trace viewer opened on the trace so far.';
    const untraced = 'This test’s attempt is not traced: its project’s trace option records none of it.';
    let answer = { ok: true, message: opened };
    const commands = await playHub(page, (command) => (command.type === 'openTrace' ? answer : {}));
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    await page.evaluate((event) => window.__hub.send(event), session(WATCHABLE));
    const worker = tray(page).locator('[data-shot="desktop-run-worker"]');
    const lane = worker.locator('[data-shot="desktop-run-lane"]');
    const trace = worker.getByRole('button', { name: 'Open the trace so far' });

    // Watched, a worker whose reporter does not say where its trace grows offers none.
    await worker.getByRole('button', { name: 'Watch', exact: true }).click();
    await expect(lane).toBeVisible();
    await expect(trace).toHaveCount(0);

    // Its reporter answers the ask: the button shows in the page's head, beside nothing else while the test runs.
    await page.evaluate((event) => window.__hub.send(event), session({ ...WATCHABLE, traces: true }));
    await expect(trace).toBeVisible();
    await expect(trace).toHaveAttribute(
      'title',
      'Open this test’s trace up to now in Playwright’s trace viewer, on the machine the run runs on',
    );
    await trace.click();
    await expect
      .poll(() => commands.filter((c) => c.type === 'openTrace'))
      .toEqual([{ type: 'openTrace', id: expect.any(Number), viewer: VIEWER, ref: REF, lane: 0 }]);
    await expect(worker.getByText(opened)).toBeVisible();
    await lane.screenshot({ path: testInfo.outputPath('tray-lane-trace.png') });

    // A refusal says why, as the worker's other answers do.
    answer = { ok: false, message: untraced };
    await trace.click();
    await expect(worker.getByText(untraced)).toBeVisible();

    // Between tests, no test runs: the button goes.
    await page.evaluate(
      (event) => window.__hub.send(event),
      session({ ...WATCHABLE, traces: true, state: 'between', test: null }),
    );
    await expect(worker.getByText('Between tests')).toBeVisible();
    await expect(trace).toHaveCount(0);
  });

  test('inspects a watched lane’s running test from its own trace, as the run page’s lane panel does, and lets it go', async ({
    page,
  }, testInfo) => {
    await installBridge(page);
    const untraced = 'This test’s attempt is not traced: its project’s trace option records none of it.';
    let inspectAnswer = { ok: true, message: 'Inspect shows the test’s pages from its own trace, on this machine.' };
    const commands = await playHub(page, (command) => (command.type === 'inspect' ? inspectAnswer : {}));
    const notice = (call: string, phase: string, title: string) => ({
      type: 'snapshot',
      shard: null,
      worker: 0,
      call,
      title,
      phase,
      page: 'page@1',
      frame: 'frame@1',
      main: true,
      full: true,
      index: 0,
      at: Date.now(),
      test: 'checkout › pays',
    });
    // The server's routes of Inspect: what it read so far, and each page rendered, by its call.
    const listed: string[] = [];
    await page.route('**/api/desktop/runs/inspect/calls?**', async (route) => {
      listed.push(route.request().url());
      await route.fulfill({
        json: {
          attempt: 't1#0',
          heard: [notice('call@1', 'after', 'Navigate to "/cart"')],
          refused: null,
        },
      });
    });
    const pages: URL[] = [];
    await page.route('**/api/desktop/runs/inspect/page?**', async (route) => {
      const url = new URL(route.request().url());
      pages.push(url);
      if (url.searchParams.get('format') === 'json') {
        return route.fulfill({ json: { viewport: { width: 800, height: 500 } } });
      }
      const heading = url.searchParams.get('call') === 'call@2' ? 'Checkout' : 'Cart';
      await route.fulfill({
        contentType: 'text/html',
        headers: { 'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'" },
        body: `<!doctype html><html><body><h1>${heading}</h1><button>Pay</button></body></html>`,
      });
    });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    await page.evaluate((event) => window.__hub.send(event), session({ ...WATCHABLE, traces: true }));
    const worker = tray(page).locator('[data-shot="desktop-run-worker"]');
    const lane = worker.locator('[data-shot="desktop-run-lane"]');
    const inspectButton = worker.getByRole('button', { name: 'Inspect', exact: true });
    await expect(inspectButton).toHaveCount(0);

    // The lane watched, its reporter answering where its trace grows: Inspect beside Open the trace so far.
    await worker.getByRole('button', { name: 'Watch', exact: true }).click();
    await expect(inspectButton).toBeVisible();
    await expect(inspectButton).toHaveAttribute('aria-pressed', 'false');
    await inspectButton.click();
    await expect(inspectButton).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() => commands.filter((c) => c.type === 'inspect'))
      .toEqual([{ type: 'inspect', id: expect.any(Number), viewer: VIEWER, ref: REF, lane: 0, on: true }]);
    // What the server read so far, by the window's stream, the run and the lane: the page at its latest call shows.
    await expect.poll(() => listed.length).toBe(1);
    expect(new URL(listed[0]!).searchParams.toString()).toBe(`viewer=${VIEWER}&ref=${REF}&lane=0`);
    const inspect = lane.getByTestId('live-inspect');
    const frame = inspect.getByTestId('live-inspect-frame').locator('iframe').contentFrame();
    await expect(frame.getByRole('heading', { name: 'Cart' })).toBeVisible();
    await expect(inspect.getByTestId('live-inspect-at')).toContainText('Navigate to "/cart"');
    expect(pages.at(-1)!.searchParams.get('mode')).toBe('readonly');
    expect(Object.fromEntries(pages.at(-1)!.searchParams)).toMatchObject({
      viewer: VIEWER,
      ref: REF,
      lane: '0',
      call: 'call@1',
      phase: 'after',
    });
    await expect(inspect).toContainText('reads these pages from the test’s own trace on this machine');

    // Each page read after comes on the stream: the view follows it.
    const said = (event: Record<string, unknown>) =>
      page.evaluate((e) => window.__hub.send(e), { type: 'inspect', ref: REF, lane: 0, attempt: 't1#0', ...event });
    await said({ snapshot: notice('call@2', 'before', "Click getByRole('button', { name: 'Checkout' })") });
    await expect(frame.getByRole('heading', { name: 'Checkout' })).toBeVisible();
    await expect(inspect.getByTestId('live-inspect-call')).toHaveCount(2);
    await lane.screenshot({ path: testInfo.outputPath('tray-lane-inspect.png') });

    // Pick a locator opens the picker on the page shown, saying where it came from.
    await inspect.getByTestId('live-inspect-pick').click();
    const picker = page.getByRole('dialog').filter({ hasText: 'Find a locator on the page at this call' });
    await expect(picker).toContainText('Rendered from the page its trace took at');
    await picker.getByRole('button', { name: 'Cancel' }).click();

    // Between two tests, the server let the test's pages go: Inspect says so, then follows the next test afresh.
    await page.evaluate(
      (event) => window.__hub.send(event),
      session({ ...WATCHABLE, traces: true, state: 'between', test: null }),
    );
    await said({ attempt: null });
    await expect(inspect.getByTestId('live-inspect-waiting')).toHaveText(
      'The test ended: the desktop app let its pages go. The next test’s come as it runs.',
    );
    const next = { ...TEST, id: 't2', title: ['checkout', 'refunds'] };
    await page.evaluate((event) => window.__hub.send(event), session({ ...WATCHABLE, traces: true, test: next }));
    await said({ attempt: 't2#0', refused: untraced });
    await expect(inspect.getByTestId('live-inspect-waiting')).toHaveText(untraced);

    // Turned off: the server hears it, and Inspect goes.
    await inspectButton.click();
    await expect(inspect).toHaveCount(0);
    await expect
      .poll(() => commands.filter((c) => c.type === 'inspect').at(-1))
      .toMatchObject({ ref: REF, lane: 0, on: false });

    // A server that refuses to open it says why, as the worker's other answers do.
    inspectAnswer = { ok: false, message: 'Inspect is open on 16 lanes already: close one first.' };
    await inspectButton.click();
    await expect(worker.getByText(inspectAnswer.message)).toBeVisible();
    await expect(inspectButton).toHaveAttribute('aria-pressed', 'false');
    await expect(inspect).toHaveCount(0);

    // Open again, the lane's watch turned off closes it.
    inspectAnswer = { ok: true, message: '' };
    await inspectButton.click();
    await expect(inspect).toBeVisible();
    await worker.getByRole('button', { name: 'Watch', exact: true }).click();
    await expect
      .poll(() => commands.filter((c) => c.type === 'inspect').at(-1))
      .toMatchObject({ ref: REF, lane: 0, on: false });
    await expect(inspectButton).toHaveCount(0);
  });

  test('keeps the tray’s Inspect on the latest call taken, the keyboard as it closes, and says why a new stream refuses it', async ({
    page,
  }) => {
    await installBridge(page);
    let inspectAnswer: { ok: boolean; message: string } = { ok: true, message: '' };
    const commands = await playHub(page, (command) => (command.type === 'inspect' ? inspectAnswer : {}));
    const notice = (call: string, at: number) => ({
      type: 'snapshot',
      shard: null,
      worker: 0,
      call,
      title: `Click ${call}`,
      phase: 'after',
      page: 'page@1',
      frame: 'frame@1',
      main: true,
      full: false,
      index: at,
      at: 1_800_000_000_000 + at,
      test: 'checkout › pays',
    });
    // The listing of what the server read so far waits until the spec lets it go.
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let asked = false;
    await page.route('**/api/desktop/runs/inspect/calls?**', async (route) => {
      asked = true;
      await released;
      await route.fulfill({
        json: {
          attempt: 't1#0',
          heard: [notice('call@1', 1), notice('call@2', 2), notice('call@3', 3)],
          refused: null,
        },
      });
    });
    await page.route('**/api/desktop/runs/inspect/page?**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('format') === 'json') {
        return route.fulfill({ json: { viewport: { width: 800, height: 500 } } });
      }
      await route.fulfill({
        contentType: 'text/html',
        headers: { 'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'" },
        body: `<!doctype html><html><body><h1>Page at ${url.searchParams.get('call')}</h1></body></html>`,
      });
    });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    await page.evaluate((event) => window.__hub.send(event), session({ ...WATCHABLE, traces: true }));
    const worker = tray(page).locator('[data-shot="desktop-run-worker"]');
    const lane = worker.locator('[data-shot="desktop-run-lane"]');
    const inspectButton = worker.getByRole('button', { name: 'Inspect', exact: true });
    await worker.getByRole('button', { name: 'Watch', exact: true }).click();
    await inspectButton.click();

    // The stream says the latest page before the listing of the earlier ones comes back: the view stays on the latest.
    await expect.poll(() => asked).toBe(true);
    await page.evaluate((event) => window.__hub.send(event), {
      type: 'inspect',
      ref: REF,
      lane: 0,
      attempt: 't1#0',
      snapshot: notice('call@3', 3),
    });
    release();
    const inspect = lane.getByTestId('live-inspect');
    const list = inspect.getByRole('list', {
      name: 'The calls whose page the desktop app read from the test’s trace, the latest last',
    });
    await expect(list.getByTestId('live-inspect-call')).toHaveText(['Click call@1', 'Click call@2', 'Click call@3']);
    const frame = inspect.getByTestId('live-inspect-frame').locator('iframe').contentFrame();
    await expect(frame.getByRole('heading', { name: 'Page at call@3' })).toBeVisible();
    await expect(inspect.getByTestId('live-inspect-at')).toContainText('Click call@3');

    // Between two tests, Inspect turned off from the keyboard: its button goes, and the keyboard stays on the worker.
    await page.evaluate(
      (event) => window.__hub.send(event),
      session({ ...WATCHABLE, traces: true, state: 'between', test: null }),
    );
    await inspectButton.focus();
    await page.keyboard.press('Enter');
    await expect(inspect).toHaveCount(0);
    await expect(inspectButton).toHaveCount(0);
    await expect(worker.getByRole('button', { name: 'Pause', exact: true })).toBeFocused();

    // Open again on the next test; the stream opens again and the server refuses it there: it closes, saying why.
    await page.evaluate((event) => window.__hub.send(event), session({ ...WATCHABLE, traces: true }));
    await inspectButton.click();
    await expect(inspect).toBeVisible();
    inspectAnswer = { ok: false, message: 'Inspect is open on 16 lanes already: close one first.' };
    await page.evaluate(
      ([viewer, event]) => {
        window.__hub.send({ type: 'hello', viewer });
        window.__hub.send(event);
      },
      ['e'.repeat(32), session({ ...WATCHABLE, traces: true })] as const,
    );
    await expect
      .poll(() => commands.filter((c) => c.type === 'inspect').at(-1))
      .toMatchObject({ viewer: 'e'.repeat(32), ref: REF, lane: 0, on: true });
    await expect(worker.getByText(inspectAnswer.message)).toBeVisible();
    await expect(inspect).toHaveCount(0);
    await expect(inspectButton).toHaveAttribute('aria-pressed', 'false');
  });

  test('shows a watched lane’s layers under its page: why its call waits, its events, its text as asked and its filmstrip', async ({
    page,
  }) => {
    const image = await jpeg(page);
    await installBridge(page);
    const commands = await playHub(page);
    await page.clock.install();
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    await page.evaluate((event) => window.__hub.send(event), session(WATCHABLE));
    const worker = tray(page).locator('[data-shot="desktop-run-worker"]');
    await worker.getByRole('button', { name: 'Watch', exact: true }).click();
    // The window takes every layer of the lane but the page's text, which it asks for as the person does.
    await expect
      .poll(() => commands.filter((c) => c.type === 'watch').map((c) => c.layers))
      .toEqual([['calls', 'events', 'filmstrip']]);
    const send = (event: Record<string, unknown>) =>
      page.evaluate((e) => window.__hub.send(e), { ref: REF, lane: 0, worker: 0, test: 't1', ...event });
    await send({ type: 'lane-frame', since: null, width: 640, height: 400, data: image });
    await expect(worker.getByRole('img', { name: LIVE, exact: true })).toBeVisible();
    // Nothing shows under the page until the lane sends a layer.
    const layers = worker.getByTestId('desktop-lane-layers');
    await expect(layers).toHaveCount(0);

    const at = Date.now();
    await send({
      type: 'lane-layer',
      layer: 'calls',
      log: {
        id: 'call@7',
        call: { title: "Click getByRole('button', { name: 'Pay' })", file: 'tests/checkout.spec.ts', line: 12 },
        status: 'running',
        lines: ["waiting for getByRole('button', { name: 'Pay' })", '  - element is not enabled'],
        point: null,
        target: { count: 1, box: null, enabled: false },
        viewport: null,
        ms: 3400,
        error: null,
      },
    });
    await expect(layers.getByRole('heading')).toHaveText(['Why it waits', 'Events', 'Text', 'Filmstrip']);
    await expect(layers.getByTestId('desktop-lane-call-state')).toHaveText(
      'Running for 3.4s · 1 element matches its locator · Its element is not enabled',
    );
    await expect(layers.getByText('element is not enabled', { exact: false }).last()).toBeVisible();

    // The page's events, newest first, a pending request one line whose time grows.
    const pending = { kind: 'request-pending', id: 3, method: 'POST', url: 'http://shop.test/api/checkout' };
    await send({ type: 'lane-layer', layer: 'events', at, event: { ...pending, ms: 5000, done: false } });
    await send({ type: 'lane-layer', layer: 'events', at, event: { kind: 'console', text: 'cart broke' } });
    await send({ type: 'lane-layer', layer: 'events', at, event: { ...pending, ms: 10_000, done: false } });
    await expect(layers.getByTestId('desktop-lane-events').getByRole('listitem')).toHaveText([
      'Console error cart broke',
      'Pending request POST http://shop.test/api/checkout pending for 10s',
    ]);

    // The page's text, as asked: the hub hears the lane's layers with it, and it shows with its password hidden.
    await layers.getByRole('button', { name: 'Show the page’s text' }).click();
    await expect
      .poll(() => commands.filter((c) => c.type === 'watch').map((c) => c.layers))
      .toEqual([
        ['calls', 'events', 'filmstrip'],
        ['calls', 'events', 'text', 'filmstrip'],
      ]);
    await expect(layers.getByText('Reading the page…')).toBeVisible();
    await send({
      type: 'lane-layer',
      layer: 'text',
      test: null,
      text: { call: null, source: 'snapshot', text: '- textbox "Password": S3cr3t\n- button "Pay"', cut: false, at },
    });
    const text = layers.getByTestId('desktop-lane-text');
    await expect(text).toContainText('textbox "Password": <hidden>');
    await expect(text).not.toContainText('S3cr3t');
    await expect(layers.getByText('Taken as you asked')).toBeVisible();

    // The filmstrip: one image a call, chosen to show larger with its call's title, Close going back.
    const thumb = (call: string, index: number, title: string) => ({ call, title, index, width: 320, height: 200, at });
    await send({ type: 'lane-layer', layer: 'filmstrip', thumb: thumb('call@2', 1, 'Click Check'), data: image });
    await send({ type: 'lane-layer', layer: 'filmstrip', thumb: thumb('call@5', 2, 'Fill Card number'), data: image });
    await send({ type: 'lane-layer', layer: 'filmstrip', thumb: thumb('call@2', 1, 'Click Check'), data: image });
    const film = layers.getByTestId('desktop-lane-film').getByRole('button');
    await expect(film).toHaveCount(2);
    await film.nth(1).click();
    await expect(film.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(layers.getByRole('img', { name: 'The page after Fill Card number' }).first()).toBeVisible();
    await expect(layers.locator('figcaption')).toHaveText('Fill Card number');
    await layers.getByRole('button', { name: 'Close' }).click();
    await expect(layers.locator('figcaption')).toHaveCount(0);

    // The lane's next test begins: its text is asked for, the one before it gone.
    const watches = () => commands.filter((c) => c.type === 'watch');
    const before = watches().length;
    await send({
      type: 'lane-layer',
      test: 't2',
      layer: 'events',
      at,
      event: { kind: 'console', text: 'next test' },
    });
    await expect.poll(() => watches().length).toBe(before + 1);
    expect(watches().at(-1)).toMatchObject({ on: true, layers: ['calls', 'events', 'text', 'filmstrip'] });
    await expect(text).toHaveCount(0);
    const reading = layers.getByText('Reading the page…');
    await expect(reading).toBeVisible();
    // Taken again before the first ask gave up: the window says it reads for 15 seconds from the latest ask.
    await page.clock.fastForward(10_000);
    await layers.getByRole('button', { name: 'Take it again' }).click();
    await expect.poll(() => watches().length).toBe(before + 2);
    await page.clock.fastForward(6_000);
    await expect(reading).toBeVisible();
    await page.clock.fastForward(10_000);
    await expect(reading).toHaveCount(0);

    // Hide the text: the hub hears the layers without it.
    await layers.getByRole('button', { name: 'Hide the text' }).click();
    await expect
      .poll(() =>
        commands
          .filter((c) => c.type === 'watch')
          .map((c) => c.layers)
          .at(-1),
      )
      .toEqual(['calls', 'events', 'filmstrip']);
    await expect(text).toHaveCount(0);

    // Watch off: the layers go with the lane.
    await worker.getByRole('button', { name: 'Watch', exact: true }).click();
    await expect(layers).toHaveCount(0);
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
    const watchLive = worker
      .locator('[data-shot="desktop-run-page"]')
      .getByRole('button', { name: 'Watch', exact: true });
    const live = lane.getByRole('img', { name: LIVE, exact: true });
    const lastShown = lane.getByRole('img', { name: LAST_SEEN });
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

    // Watch has the keyboard as the running test stops: the stop's Watch, in its place at the stop, takes it.
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

    // A stop outside a test: the lane sends no frame of it, so the stop's own page shows it, with the stop's Watch.
    await send(atStop('s2', null));
    await expect(watchLive).toBeVisible();
    await expect(lane).toHaveCount(0);

    // A stop of a test shows in the lane. Watch, turned off there, gives the keyboard to the stop's Watch, which stays off.
    await send(session(WATCHABLE));
    await send(atStop('s3'));
    await frame('s3');
    await expect(live).toBeVisible();
    await watch.focus();
    await page.keyboard.press('Enter');
    await expect(watchLive).toBeFocused();
    await expect(watchLive).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(lastWatch).toMatchObject({ on: false });

    // A lane the hub would not show says why, while the test runs and at its next stop, where the stop's Watch is offered.
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
        .getByRole('link', { name: `Open run #${live.runId}` })
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
      await expect(
        tray(page).locator('[data-shot="desktop-run-page"]').getByRole('button', { name: 'Watch', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');

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
      await expect(
        tray(page).locator('[data-shot="desktop-run-page"]').getByRole('button', { name: 'Watch', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');

      // The row says where the test stopped. Closed, the tray ends the view; Show its page opens it on the worker,
      // the focus there, and the stop's Watch, left on, watches the stop again.
      await expect(page.getByTestId('desktop-stopped')).toContainText(
        /Paused\s*·\s*Click getByRole\('button', \{ name: 'Pay' \}\)\s*·\s*tests\/checkout\.spec\.ts:5/,
      );
      await tray(page).getByRole('button', { name: 'Close local runs' }).click();
      await expect(tray(page)).toHaveCount(0);
      await page.getByRole('button', { name: 'Show its page' }).click();
      await expect(tray(page).locator(`[data-worker="${REF}|0"]`)).toBeFocused();
      await expect(
        tray(page).locator('[data-shot="desktop-run-page"]').getByRole('button', { name: 'Watch', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
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
      await expect(
        tray(page).locator('[data-shot="desktop-run-page"]').getByRole('button', { name: 'Watch', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
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
      const shown = tray(page).locator(`[data-worker="${REF}|0"]`);
      await expect(shown).toBeFocused();
      await expect(shown.getByRole('button', { name: 'Watch', exact: true })).toHaveAttribute('aria-pressed', 'true');
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

  test('shows a run of two workers one at a time, behind tabs a new stop takes and Resume moves on', async ({
    page,
    request,
  }) => {
    await installBridge(page);
    const commands = await playHub(page);
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    const send = (event: unknown) => page.evaluate((e) => window.__hub.send(e), event);
    const REFUNDS = { ...TEST, id: 't2', title: ['checkout', 'refunds'], line: 7 };
    const first = RUNNING;
    const second = { ...RUNNING, worker: 1, parallelIndex: 1, test: REFUNDS };
    const firstAt = (since: string, extra: Record<string, unknown> = {}) => stopped(since, extra);
    const secondAt = (since: string, extra: Record<string, unknown> = {}) => ({
      ...stopped(since, extra),
      worker: 1,
      parallelIndex: 1,
      test: REFUNDS,
    });
    const tabs = tray(page).getByRole('tablist', { name: 'Workers' });
    const tab1 = tabs.getByRole('tab', { name: 'worker 1', exact: true });
    const tab2 = tabs.getByRole('tab', { name: 'worker 2', exact: true });
    const panel = (name: string) => tray(page).getByRole('tabpanel', { name, exact: true });

    // Both run: a tab each, named by its lane and marked with its state, the first shown; Pause all pauses them.
    await send(sessionOf([first, second]));
    await expect(tabs.getByRole('tab')).toHaveText(['worker 1', 'worker 2']);
    await expect(tab1).toHaveAttribute('aria-selected', 'true');
    await expect(tab2).toHaveAttribute('aria-selected', 'false');
    await expect(tab1).toHaveAttribute('data-status', 'running');
    await expect(tab1).toHaveAttribute('title', 'Running');
    await expect(panel('worker 1')).toContainText('checkout › pays');
    await expect(panel('worker 2')).toBeHidden();
    const controls = tray(page).getByRole('group', { name: 'Run controls' });
    await expect(controls.getByRole('button')).toHaveText(['Pause all']);
    await controls.getByRole('button', { name: 'Pause all' }).click();
    await expect
      .poll(() => commands.filter((c) => c.type === 'runControl').at(-1))
      .toMatchObject({ ref: REF, worker: null, action: 'pause', since: null });

    // A stop takes the tab from a worker that runs, in its tone.
    await send(sessionOf([first, secondAt('s1')]));
    await expect(tab2).toHaveAttribute('aria-selected', 'true');
    await expect(tab2).toHaveAttribute('data-status', 'stopped');
    await expect(tab2).toHaveAttribute('title', 'Paused');
    await expect(panel('worker 2')).toContainText('checkout › refunds');
    await expect(panel('worker 2')).toContainText('Paused');
    await expect(panel('worker 1')).toBeHidden();

    // One tab stop; the arrow keys, Home and End move between the tabs, showing each worker in turn.
    await expect(tab1).toHaveAttribute('tabindex', '-1');
    await expect(tab2).toHaveAttribute('tabindex', '0');
    await tab2.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(tab1).toBeFocused();
    await expect(tab1).toHaveAttribute('aria-selected', 'true');
    await expect(panel('worker 1')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(tab2).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tab1).toBeFocused();
    await page.keyboard.press('End');
    await expect(tab2).toBeFocused();
    await expect(tab2).toHaveAttribute('aria-selected', 'true');

    // A stop of the other worker leaves the tab with the stop shown, which the person answers; Resume all resumes both.
    await send(sessionOf([firstAt('s2'), secondAt('s1')]));
    await expect(tab1).toHaveAttribute('data-status', 'stopped');
    await expect(tab2).toHaveAttribute('aria-selected', 'true');
    await expect(controls.getByRole('button')).toHaveText(['Resume all']);
    // Resume there, from the keyboard: once it goes on, the next stopped test takes the tab, and the keyboard follows
    // to its tab, never to a control a key pressed again would answer.
    await panel('worker 2').getByRole('button', { name: 'Resume' }).focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(() => commands.filter((c) => c.type === 'runControl').at(-1))
      .toMatchObject({ worker: 1, action: 'resume', since: 's1' });
    await expect(tab2).toHaveAttribute('aria-selected', 'true');
    await send(sessionOf([firstAt('s2'), second]));
    await expect(tab1).toHaveAttribute('aria-selected', 'true');
    await expect(tab1).toBeFocused();
    await send(sessionOf([firstAt('s2'), secondAt('s3')]));
    await expect(tab1).toHaveAttribute('aria-selected', 'true');
    // Step on its way at the worker shown: Resume all waits for its answer, and sends nothing meanwhile.
    let held = false;
    let release = () => {};
    await page.route('**/api/desktop/runs/commands', async (route: Route) => {
      if ((route.request().postDataJSON() as Command).action === 'step') {
        await new Promise<void>((done) => {
          release = done;
          held = true;
        });
      }
      await route.fallback();
    });
    const sent = commands.length;
    await panel('worker 1').getByRole('button', { name: 'Step' }).click();
    await expect.poll(() => held).toBe(true);
    const resumeAll = controls.getByRole('button', { name: 'Resume all' });
    await expect(resumeAll).toHaveAttribute('aria-disabled', 'true');
    await resumeAll.click({ force: true });
    release();
    await expect(resumeAll).not.toHaveAttribute('aria-disabled');
    await expect.poll(() => commands.slice(sent).map((c) => c.action)).toEqual(['step']);
    await resumeAll.click();
    await expect
      .poll(() => commands.filter((c) => c.type === 'runControl').slice(-2))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ worker: 0, action: 'resume', since: 's2' }),
          expect.objectContaining({ worker: 1, action: 'resume', since: 's3' }),
        ]),
      );

    // A failure says so in its tab.
    await send(sessionOf([firstAt('s2'), secondAt('s4', { reason: 'failure', error: 'expect failed' })]));
    await expect(tab2).toHaveAttribute('data-status', 'failed');
    await expect(tab2).toHaveAttribute('title', 'Failed, held at its line');

    // The tray closed, a stop that opens it shows its worker's tab, whatever the tab showed.
    await send(sessionOf([firstAt('s2'), second]));
    await tray(page).getByRole('button', { name: 'Close local runs' }).click();
    await expect(tray(page)).toHaveCount(0);
    await send(sessionOf([firstAt('s2'), secondAt('s5')]));
    await expect(tray(page)).toBeVisible();
    await expect(tab2).toHaveAttribute('aria-selected', 'true');

    // The run goes down to one worker, and back as Playwright starts another: the worker stays drawn as it was, the
    // tabs gone, then back.
    const kept = tray(page).locator('div[data-lane="1"] [data-shot="desktop-run-worker"]');
    await kept.evaluate((element) => element.setAttribute('data-kept', ''));
    await send(sessionOf([secondAt('s5')]));
    await expect(tabs).toHaveCount(0);
    await expect(tray(page).getByRole('listitem')).toContainText('checkout › refunds');
    await expect(tray(page).locator('[data-kept]')).toHaveCount(1);
    await send(sessionOf([first, secondAt('s5')]));
    await expect(tab2).toHaveAttribute('aria-selected', 'true');
    await expect(panel('worker 2').locator('[data-kept]')).toHaveCount(1);

    // The run reports to this app, its second worker on the refunds test: the run page's Show its page shows that
    // worker's tab, the focus on it.
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
              title: 'refunds',
              location: 'tests/checkout.spec.ts:8:1',
              workerIndex: 1,
              startedAt: Date.now(),
              browser: { projectName: 'chromium' },
            },
          ],
        },
      });
      expect(begun.ok()).toBeTruthy();
      await tray(page)
        .getByRole('link', { name: `Open run #${live.runId}` })
        .click({ timeout: 15_000 });
      await expect(page).toHaveURL(new RegExp(`/test-runs/${live.runId}$`));
      await page.getByRole('button', { name: '1 local run' }).click();
      await tab1.click();
      await expect(tab1).toHaveAttribute('aria-selected', 'true');
      await tray(page).getByRole('button', { name: 'Close local runs' }).click();
      await page.getByRole('button', { name: 'Show its page: checkout › refunds' }).click();
      await expect(tab2).toHaveAttribute('aria-selected', 'true');
      await expect(tray(page).locator(`[data-worker="${REF}|1"]`)).toBeFocused();
    } finally {
      await request.post(`/api/test-runs/${live.runId}/finish`, {
        data: { streamToken: live.streamToken, status: 'passed', totalTests: 1 },
      });
    }
  });

  test('keeps its own run, its Hold failures and its separate output window through a reload of the window', async ({
    page,
  }) => {
    await installBridge(page);
    const commands = await playHub(page);
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    await page.evaluate((event) => window.__hub.send(event), session(RUNNING));
    await holdSwitch(page).click();
    await expect.poll(() => commands.find((c) => c.type === 'show')).toMatchObject({ ref: REF, on: true });
    await page.evaluate(() => window.__printLine('Running 1 test using 1 worker'));
    await tray(page).getByRole('button', { name: 'Open the output in a separate window' }).click();
    await expect(tray(page).getByText('The output is in a separate window.')).toBeVisible();
    const key = await tray(page).locator('article[data-run]').first().getAttribute('data-run');
    const outputPage = await page.context().newPage();
    await outputPage.goto(`/desktop/run-output?name=piwi-run-output-${key}`);
    await waitForHydration(outputPage);
    const output = outputPage.getByRole('region', { name: 'Run output' });
    await expect(output.getByText('Running 1 test using 1 worker')).toBeVisible();

    // Reloaded: the tray opens on the run as its own, with its Stop, its Hold failures and its output still apart.
    const shows = commands.filter((c) => c.type === 'show' && c.on).length;
    await page.reload();
    await waitForHydration(page);
    await expect(tray(page).getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect(holdSwitch(page)).toHaveAttribute('aria-checked', 'true');
    await expect(tray(page).getByText('The output is in a separate window.')).toBeVisible();
    await expect(tray(page).getByRole('region', { name: 'Other runs of the desktop app' })).toHaveCount(0);
    // The hub's stream opens again, and the run holds its failures again.
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    await page.evaluate((event) => window.__hub.send(event), session(RUNNING));
    await expect.poll(() => commands.filter((c) => c.type === 'show' && c.on).length).toBeGreaterThan(shows);
    expect(commands.filter((c) => c.type === 'show').at(-1)).toMatchObject({ ref: REF, on: true });

    // The separate window was not opened again: it goes on from its last line, and ends with the run.
    await page.evaluate(() => window.__printLine('  ✓  1 tests/checkout.spec.ts:3:1 › pays (1.0s)'));
    await expect(output.getByText('pays (1.0s)')).toBeVisible();
    await expect(output.getByText('Running 1 test using 1 worker')).toBeVisible();
    await page.evaluate(() => window.__endRun());
    await expect(output.getByText('Passed', { exact: true })).toBeVisible();
    await expect(tray(page).getByText('Passed', { exact: true })).toBeVisible();
  });

  test('counts a running run’s tests as its own process does, a test held at its failure among the failed', async ({
    page,
  }) => {
    await installBridge(page);
    await playHub(page);
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    // Its output alone does not count it: Playwright's own lines would say 0 of 9.
    await page.evaluate(() => window.__printLine('Running 9 tests using 2 workers'));
    const counted = (progress: Record<string, number>, workers: Record<string, unknown>[] = [RUNNING]) => {
      const event = sessionOf(workers);
      return {
        ...event,
        session: {
          ...event.session,
          progress: {
            total: 9,
            done: 0,
            failed: 0,
            flaky: 0,
            skipped: 0,
            status: 'running',
            failure: null,
            ...progress,
          },
        },
      };
    };
    await page.evaluate((event) => window.__hub.send(event), counted({ done: 3 }));
    await expect(tray(page).getByText('3 of 9 tests', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '3 of 9 tests', exact: true })).toBeVisible();

    // A test held at its failure is failed so far, and stays counted once its process counts it.
    const held = {
      ...stopped('s1', { reason: 'failure', title: 'Failed: Error', error: 'expect failed' }),
      worker: 1,
      parallelIndex: 1,
    };
    await page.evaluate((event) => window.__hub.send(event), counted({ done: 3, flaky: 1 }, [RUNNING, held]));
    await expect(tray(page).getByText('3 of 9 tests · 1 failed · 1 flaky', { exact: true })).toBeVisible();
    await page.evaluate((event) => window.__hub.send(event), counted({ done: 4, failed: 1, flaky: 1 }));
    await expect(tray(page).getByText('4 of 9 tests · 1 failed · 1 flaky', { exact: true })).toBeVisible();
  });

  test('leads a failed run’s end to its first failure, from its end toast and from the tray', async ({
    page,
    request,
  }) => {
    await installBridge(page);
    await playHub(page);
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    await expect.poll(() => page.evaluate(() => window.__runArgs?.originRef)).toBeTruthy();
    const originRef = await page.evaluate(() => window.__runArgs?.originRef);

    // The run reports to the app: its second test failed first, as its process names it.
    const at = Date.now();
    const testCase = (title: string, status: string) => ({
      title,
      status,
      duration: 1000,
      location: 'tests/checkout.spec.ts:3:1',
      browser: { name: 'chromium', projectName: 'chromium' },
      error: status === 'failed' ? 'expect failed' : undefined,
      retries: 0,
      workerIndex: 0,
      startedAt: at,
    });
    const res = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.DESKTOP_RUN_VIEW,
        metadata: { piwiOrigin: { kind: 'desktop', ref: originRef } },
        status: 'failed',
        startTime: new Date(at).toISOString(),
        duration: 2000,
        totalTests: 3,
        passedTests: 1,
        failedTests: 2,
        skippedTests: 0,
        testCases: [testCase('lists the cart', 'failed'), testCase('pays', 'failed'), testCase('refunds', 'passed')],
      },
    });
    expect(res.ok()).toBeTruthy();
    const { runId: reported } = await res.json();
    await expect(tray(page).getByRole('link', { name: `Open run #${reported}` })).toBeVisible({ timeout: 15_000 });
    const details = await (await request.get(`/api/test-runs/${reported}`)).json();
    const pays = details.testCases.find((c: { title: string }) => c.title === 'pays').executionId;

    const ended = sessionOf([], true);
    Object.assign(ended.session, {
      progress: {
        total: 3,
        done: 3,
        failed: 2,
        flaky: 0,
        skipped: 0,
        status: 'failed',
        failure: { title: 'pays', error: 'expect failed' },
      },
    });
    await page.evaluate((event) => window.__hub.send(event), ended);
    await page.evaluate(() => window.__exitRun(1));
    await expect(tray(page).getByText('Failed (exit 1)')).toBeVisible();
    await expect(tray(page).getByRole('button', { name: 'Open the failure' })).toBeVisible();
    const toast = page.locator('li', { hasText: 'Local run failed' });
    await toast.getByRole('button', { name: 'Open the failure' }).click();
    await expect(page).toHaveURL(new RegExp(`/test-run-cases/${pays}$`));
  });

  test('shows each run as one line in the compact list, with the one action it needs now, whole on a click', async ({
    page,
  }) => {
    await installBridge(page);
    await playHub(page);
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect.poll(() => page.evaluate(() => window.__hub.open())).toBe(1);
    await page.evaluate((viewer) => window.__hub.send({ type: 'hello', viewer }), VIEWER);
    const withProgress = (worker: Record<string, unknown>) => {
      const event = session(worker);
      return {
        ...event,
        session: {
          ...event.session,
          progress: { total: 9, done: 3, failed: 0, flaky: 0, skipped: 0, status: 'running', failure: null },
        },
      };
    };
    await page.evaluate((event) => window.__hub.send(event), withProgress(RUNNING));

    const compact = tray(page).getByRole('button', { name: 'Compact list' });
    await compact.click();
    await expect(compact).toHaveAttribute('aria-pressed', 'true');
    const line = tray(page).locator('[data-shot="desktop-run-line"]');
    await expect(line).toHaveCount(1);
    await expect(line).toContainText('Running');
    await expect(line).toContainText('3 of 9 tests');
    await expect(line.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect(tray(page).locator('[data-shot="desktop-run-worker"]')).toHaveCount(0);

    // A stop shows the run whole, as the tray opens on it; back to one line, the line says the run waits, and its one
    // action shows the stop again, its worker focused.
    await page.evaluate((event) => window.__hub.send(event), withProgress(stopped('s1')));
    await expect(line).toHaveCount(0);
    await expect(tray(page).locator(`[data-worker="${REF}|0"]`)).toBeVisible();
    await tray(page).getByRole('button', { name: 'Show as one line' }).click();
    await expect(line).toContainText('Waiting');
    await line.getByRole('button', { name: 'Show the stop' }).click();
    await expect(line).toHaveCount(0);
    await expect(tray(page).locator(`[data-worker="${REF}|0"]`)).toBeFocused();

    // Back to one line, as the tray remembers after a reload.
    await tray(page).getByRole('button', { name: 'Show as one line' }).click();
    await expect(line).toHaveCount(1);
    await page.reload();
    await waitForHydration(page);
    await expect(tray(page).getByRole('button', { name: 'Compact list' })).toHaveAttribute('aria-pressed', 'true');
    await expect(tray(page).locator('[data-shot="desktop-run-line"]')).toHaveCount(1);

    // A click on the line shows the run whole.
    await tray(page).locator('[data-shot="desktop-run-line"]').getByRole('button', { expanded: false }).click();
    await expect(tray(page).locator('article[data-run]')).toHaveCount(1);
  });
});
