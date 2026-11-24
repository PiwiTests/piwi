import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/** The run page's desktop re-run button, by what it says it runs. */
const RERUN_FAILED = /^Re-run \d+ failed tests?/;

/** What a run of one test that failed prints with the list reporter. */
const FAILED_OUTPUT = [
  '  ✘  1 [chromium] › tests/checkout.spec.ts:3:1 › checkout › pays (1.0s)',
  '',
  '  1) [chromium] › tests/checkout.spec.ts:3:1 › checkout › pays ──────────',
  '',
  '    Error: expect(locator).toBeVisible() failed',
  '',
  '  1 failed',
  '    [chromium] › tests/checkout.spec.ts:3:1 › checkout › pays ──────────',
];

/**
 * The run button's This computer in the desktop window, driven against the regular web build
 * with a faked Tauri IPC bridge. The UI gates itself purely on the bridge's
 * presence, so installing `window.__TAURI__` before the app boots exercises the
 * real components, composables and event plumbing end to end — everything but
 * the Rust process spawn itself (covered by `desktop/e2e/`).
 */

interface FakeInvocation {
  cmd: string;
  args: Record<string, unknown> | undefined;
}

declare global {
  interface Window {
    __piwiFakeTauri: {
      invocations: FakeInvocation[];
      finish: (code: number | null) => void;
      emitLine: (line: string) => void;
      emitEvent: (name: string, payload: unknown) => void;
    };
  }
}

interface FakeBridgeOptions {
  linked: boolean;
  missingSpecs?: string[];
  /** Emit two stdout lines and an exit event shortly after each spawn (default true). */
  autoExit?: boolean;
  exitCode?: number;
  /** Report no Playwright installation from the env pre-flight. */
  playwrightMissing?: boolean;
}

/** Install a fake `window.__TAURI__` before any app script runs. */
async function installFakeBridge(page: Page, options: FakeBridgeOptions) {
  await page.addInitScript((opts: FakeBridgeOptions) => {
    const listeners: Record<string, ((event: { payload: unknown }) => void)[]> = {};
    const emitEvent = (name: string, payload: unknown) => {
      for (const cb of listeners[name] ?? []) cb({ payload });
    };
    const emit = (payload: unknown) => emitEvent('piwi:local-run', payload);
    const state = {
      link: opts.linked ? { path: '/home/dev/acme', exists: true } : null,
      invocations: [] as FakeInvocation[],
      lastRunId: 6,
      finish: (code: number | null) => {
        emit({ id: state.lastRunId, kind: 'exit', line: null, code });
      },
      emitLine: (line: string) => {
        emit({ id: state.lastRunId, kind: 'stdout', line, code: null });
      },
      emitEvent,
    };
    Object.assign(window, { __piwiFakeTauri: state });
    Object.assign(window, {
      __TAURI__: {
        core: {
          invoke: async (cmd: string, args?: Record<string, unknown>) => {
            state.invocations.push({ cmd, args });
            switch (cmd) {
              case 'desktop_get_project_link':
                return state.link;
              case 'desktop_pick_folder':
                return '/home/dev/acme';
              case 'desktop_set_project_link':
                state.link = { path: '/home/dev/acme', exists: true };
                return null;
              case 'desktop_check_local_specs':
                return { folder: '/home/dev/acme', missing: opts.missingSpecs ?? [] };
              case 'desktop_suggest_project_folders':
                return [];
              // The project sets no run variables, and a run for no environment gets none.
              case 'desktop_environment_run_settings':
                return { runVariables: [], environment: null };
              case 'desktop_check_project_folder':
                return {
                  path: args?.path,
                  exists: true,
                  playwrightConfig: 'playwright.config.ts',
                  specsChecked: 1,
                  specsFound: 1,
                  missingSpecs: [],
                  repository: null,
                  sameRepository: null,
                  fits: true,
                  alternatives: [],
                };
              case 'desktop_check_local_env': {
                if (!state.link) throw new Error('no folder is linked to this project');
                return {
                  folder: state.link.path,
                  exists: state.link.exists,
                  playwrightCli: opts.playwrightMissing ? null : '/home/dev/acme/node_modules/@playwright/test/cli.js',
                };
              }
              case 'desktop_run_local_tests': {
                const id = ++state.lastRunId;
                setTimeout(() => {
                  emit({ id, kind: 'stdout', line: 'Running 1 test using 1 worker', code: null });
                  if (opts.autoExit !== false) {
                    emit({ id, kind: 'stdout', line: '  1 passed (2.0s)', code: null });
                    emit({ id, kind: 'exit', line: null, code: opts.exitCode ?? 0 });
                  }
                }, 50);
                return id;
              }
              case 'desktop_stop_local_tests':
              case 'desktop_open_output_window':
                return `output-${String(args?.name)}_0`;
              case 'desktop_close_output_window':
              case 'desktop_bring_to_front':
              case 'desktop_notify':
              case 'desktop_set_notification_choices':
                return null;
              default:
                throw new Error(`unexpected command: ${cmd}`);
            }
          },
        },
        event: {
          listen: async (name: string, cb: (event: { payload: unknown }) => void) => {
            (listeners[name] ??= []).push(cb);
            return () => {};
          },
        },
      },
    });
  }, options);
}

function tray(page: Page) {
  return page.getByRole('region', { name: 'Local runs' });
}

/** The name the tray opened its run's output window under, from its `desktop_open_output_window` call. */
async function outputWindowName(page: Page): Promise<string> {
  await expect
    .poll(() =>
      page.evaluate(() => window.__piwiFakeTauri.invocations.some((i) => i.cmd === 'desktop_open_output_window')),
    )
    .toBe(true);
  return page.evaluate(() =>
    String(window.__piwiFakeTauri.invocations.find((i) => i.cmd === 'desktop_open_output_window')!.args!.name),
  );
}

function runInvocations(page: Page) {
  return page.evaluate(() => window.__piwiFakeTauri.invocations.filter((i) => i.cmd === 'desktop_run_local_tests'));
}

/** Waits for the shell to start the run's process, which follows the run's baseline (read in at most 10 s). */
async function processStarted(page: Page) {
  await expect.poll(async () => (await runInvocations(page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
}

/** A failed chromium result at `location`, as the reporter sends it. */
function failedAt(title: string, location: string) {
  return {
    title,
    status: 'failed',
    duration: 1000,
    location,
    browser: { name: 'chromium', projectName: 'chromium' },
    error: 'Error: boom',
    retries: 0,
    workerIndex: 0,
    startedAt: Date.now(),
  };
}

/** Reports a failed run of these results to its own project, and returns the run's id. */
async function submitFailedRun(request: APIRequestContext, testCases: ReturnType<typeof failedAt>[]): Promise<number> {
  const res = await retryPost(request, '/api/test-runs/submit', {
    data: {
      projectName: PROJECT.DESKTOP_LOCAL_RUN_UNNAMED,
      status: 'failed',
      startTime: new Date().toISOString(),
      duration: 2000,
      totalTests: testCases.length,
      passedTests: 0,
      failedTests: testCases.length,
      skippedTests: 0,
      testCases,
    },
  });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { runId: number }).runId;
}

test.describe('Desktop local run', () => {
  let runId: number;
  let projectId: number;
  let caseId: number;
  let executionId: number;

  test.beforeAll(async ({ request }) => {
    const startTime = Date.now();
    const res = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.DESKTOP_LOCAL_RUN,
        status: 'failed',
        startTime: new Date(startTime).toISOString(),
        duration: 12000,
        totalTests: 2,
        passedTests: 1,
        failedTests: 1,
        skippedTests: 0,
        testCases: [
          {
            title: 'checkout completes',
            status: 'failed',
            duration: 8000,
            location: 'tests/checkout.spec.ts:42:18',
            browser: { name: 'chromium', projectName: 'chromium' },
            error: 'TimeoutError: locator.click: Timeout 30000ms exceeded.',
            retries: 0,
            workerIndex: 0,
            startedAt: startTime,
          },
          {
            title: 'homepage loads',
            status: 'passed',
            duration: 1000,
            location: 'tests/home.spec.ts:5:1',
            retries: 0,
            workerIndex: 0,
            startedAt: startTime,
          },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();
    ({ runId, projectId } = (await res.json()) as { runId: number; projectId: number });
    const cases = await (await request.get(`/api/projects/${projectId}/test-cases`)).json();
    caseId = cases.items.find((c: { title: string; id: number }) => c.title === 'checkout completes')!.id;
    const run = await (await request.get(`/api/test-runs/${runId}`)).json();
    type Case = { title: string; executionId: number };
    executionId = (run.testCases as Case[]).find((c) => c.title === 'checkout completes')!.executionId;
  });

  test('a test with no file path Playwright takes is left out, and the button says so', async ({ page, request }) => {
    await installFakeBridge(page, { linked: true });
    const runId = await submitFailedRun(request, [failedAt('pays', 'tests/pay.spec.ts:7:1'), failedAt('odd', '.:3:1')]);
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Run options' }).first().click();
    await expect(page.getByText('Leaves out 1 of the 2 tests: Playwright cannot take their file paths')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Re-run 2 failed tests · 1 left out', exact: true }).click();
    await processStarted(page);
    expect((await runInvocations(page))[0]!.args!.args).toEqual(['tests/pay.spec.ts:7', '--project=chromium']);
  });

  test('with no test it can name, the button runs nothing and its menu says why', async ({ page, request }) => {
    await installFakeBridge(page, { linked: true });
    const runId = await submitFailedRun(request, [failedAt('odd', '.:3:1')]);
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect(page.getByRole('menu').getByText('Runs nothing')).toBeVisible();
    expect(await runInvocations(page)).toHaveLength(0);
  });

  test('without the bridge the button does not exist', async ({ page }) => {
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    // The copyable Copy retry command button proves the header (where "Run
    // locally" would sit) has rendered with failed cases.
    await expect(page.getByRole('button', { name: 'Copy retry command' })).toBeVisible();
    await expect(page.getByRole('button', { name: RERUN_FAILED })).toHaveCount(0);
  });

  test('one click runs the failed tests and streams output into the tray', async ({ page }) => {
    await installFakeBridge(page, { linked: true });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    // A linked, healthy project runs immediately — no dialog in between.
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await expect(tray(page)).toBeVisible();
    await expect(tray(page).getByText('Running 1 test using 1 worker')).toBeVisible();
    await expect(tray(page).getByText('1 passed (2.0s)')).toBeVisible();
    await expect(tray(page).getByText('Passed', { exact: true })).toBeVisible();
    // The tray names what ran, and the command under it.
    await expect(tray(page).getByText(`1 failed test of run #${runId}`, { exact: true })).toBeVisible();
    await expect(tray(page).getByText('playwright test tests/checkout.spec.ts:42 --project=chromium')).toBeVisible();

    const invocations = await runInvocations(page);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.args!.args).toEqual(['tests/checkout.spec.ts:42', '--project=chromium']);
    expect(String(invocations[0]!.args!.projectId)).toMatch(/^\d+$/);
  });

  test('the button says what it runs, and its menu shows the command', async ({ page }) => {
    await installFakeBridge(page, { linked: true });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await expect(page.getByRole('button', { name: 'Re-run 1 failed test', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Run options' }).click();
    await expect(page.getByText('Runs this command')).toBeVisible();
    await expect(
      page.getByRole('menu').getByText('playwright test tests/checkout.spec.ts:42 --project=chromium'),
    ).toBeVisible();
  });

  test('a failed execution re-runs its test from the page header', async ({ page }) => {
    await installFakeBridge(page, { linked: true });
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: 'Re-run this test' }).click();
    await expect(tray(page).getByText('Passed', { exact: true })).toBeVisible();
    await expect(tray(page).getByText('checkout completes', { exact: true })).toBeVisible();

    const invocations = await runInvocations(page);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.args!.args).toEqual(['tests/checkout.spec.ts:42', '--project=chromium']);
  });

  test("the run's menu re-runs every test of the run, and the list re-runs a selection", async ({ page }) => {
    await installFakeBridge(page, { linked: true });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: 'Run options' }).first().click();
    await page.getByRole('menuitem', { name: 'Re-run all 2 tests' }).click();
    await expect(tray(page).getByText(`All 2 tests of run #${runId}`, { exact: true })).toBeVisible();
    await expect(tray(page).getByText('Passed', { exact: true })).toBeVisible();
    let invocations = await runInvocations(page);
    expect(invocations.map((i) => i.args!.args)).toEqual([
      ['tests/checkout.spec.ts:42', '--project=chromium'],
      ['tests/home.spec.ts:5'],
    ]);

    await page.getByRole('checkbox', { name: 'Select all failing tests' }).check();
    await page.getByRole('button', { name: 'Re-run 1 selected test', exact: true }).click();
    await expect(tray(page).getByText(`1 selected test of run #${runId}`, { exact: true })).toBeVisible();
    await expect.poll(async () => (await runInvocations(page)).length).toBe(3);
    invocations = await runInvocations(page);
    expect(invocations[2]!.args!.args).toEqual(['tests/checkout.spec.ts:42', '--project=chromium']);
  });

  test("a button shows the progress of its own tests only, never another page's run", async ({ page }) => {
    await installFakeBridge(page, { linked: true, autoExit: false });
    await page.goto(`/test-cases/${caseId}`);
    await waitForHydration(page);

    await page
      .getByRole('button', { name: 'Run this test · by title · ×20 until a failure · trace', exact: true })
      .click();
    await expect(tray(page).getByText('Running 0/1…', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Running 0/1…' })).toBeVisible();

    // The execution's run (one line, one project) is not the one running: its button stays ready.
    await page.getByRole('link', { name: 'Latest execution' }).click();
    await expect(page).toHaveURL(/\/test-run-cases\//);
    await expect(page.getByRole('button', { name: 'Re-run this test', exact: true })).toBeVisible();
    await expect(tray(page).getByText('Running 0/1…', { exact: true })).toBeVisible();
  });

  test('a run keeps going across navigation and is never killed by closing UI', async ({ page }) => {
    await installFakeBridge(page, { linked: true, autoExit: false });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect(tray(page).getByText('Running 0/1…', { exact: true })).toBeVisible();

    // Leave the run page entirely — the store, not the page, owns the run.
    await page.getByRole('link', { name: 'Projects', exact: true }).first().click();
    await expect(page).toHaveURL(/\/projects/);
    await expect(tray(page).getByText('Running 0/1…', { exact: true })).toBeVisible();
    await expect(tray(page).getByText('Running 1 test using 1 worker')).toBeVisible();

    await page.evaluate(() => window.__piwiFakeTauri.finish(0));
    await expect(tray(page).getByText('Passed', { exact: true })).toBeVisible();

    const stops = await page.evaluate(
      () => window.__piwiFakeTauri.invocations.filter((i) => i.cmd === 'desktop_stop_local_tests').length,
    );
    expect(stops).toBe(0);
  });

  test('stopping is explicit, from the tray, and waits for the run to wind down', async ({ page }) => {
    await installFakeBridge(page, { linked: true, autoExit: false });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await processStarted(page);
    await expect(tray(page).getByText('Running 0/1…', { exact: true })).toBeVisible();

    await tray(page).getByRole('button', { name: 'Stop', exact: true }).click();
    // The shell asked Playwright to stop; the run ends when its process exits.
    await expect(tray(page).getByText('Stopping…', { exact: true })).toBeVisible();
    await expect(tray(page).getByRole('button', { name: 'Force stop' })).toBeVisible();

    await page.evaluate(() => window.__piwiFakeTauri.finish(130));
    await expect(tray(page).getByText('Stopped', { exact: true })).toBeVisible();

    const stops = await page.evaluate(
      () => window.__piwiFakeTauri.invocations.filter((i) => i.cmd === 'desktop_stop_local_tests').length,
    );
    expect(stops).toBe(1);
  });

  test('a double-click on Stop only stops: Force stop waits a moment, beside how long the wind-down can take', async ({
    page,
  }) => {
    await installFakeBridge(page, { linked: true, autoExit: false });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await processStarted(page);
    await tray(page).getByRole('button', { name: 'Stop', exact: true }).dblclick();
    await expect(tray(page).getByText(/^Ends within (10|9) s$/)).toBeVisible();
    const stops = () =>
      page.evaluate(
        () => window.__piwiFakeTauri.invocations.filter((i) => i.cmd === 'desktop_stop_local_tests').length,
      );
    expect(await stops()).toBe(1);
    await expect(tray(page).getByRole('button', { name: 'Force stop' })).toBeEnabled();
    expect(await stops()).toBe(1);
  });

  test('the sidebar’s Local runs opens and closes the tray, and marks a run that failed while it was closed', async ({
    page,
  }) => {
    await installFakeBridge(page, { linked: true, autoExit: false });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    const entry = page.getByTestId('local-runs-entry');
    await expect(entry).toHaveAccessibleName('Local runs');

    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await processStarted(page);
    await tray(page).getByRole('button', { name: 'Close local runs' }).click();
    await page.evaluate(() => window.__piwiFakeTauri.finish(1));
    await expect(entry).toHaveAccessibleName('Local runs: a run failed since you looked');
    await expect(page.getByTestId('local-runs-unseen')).toHaveClass(/bg-error/);

    await entry.click();
    await expect(tray(page).getByText('Failed', { exact: true })).toBeVisible();
    await expect(entry).toHaveAccessibleName('Local runs');
    await expect(page.getByTestId('local-runs-unseen')).toHaveCount(0);
    await entry.click();
    await expect(tray(page)).toBeHidden();

    // Remove takes one run that ended away.
    await page.keyboard.press('g');
    await page.keyboard.press('t');
    await tray(page).getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Remove from the list' }).click();
    await expect(tray(page).getByText('No local runs yet')).toBeVisible();
  });

  test('an ended run lists the tests it failed on, from its output, each to run again', async ({ page }) => {
    await installFakeBridge(page, { linked: true, autoExit: false });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await processStarted(page);
    for (const line of [
      '  ✘  1 [chromium] › tests/checkout.spec.ts:42:18 › checkout completes (1.2s)',
      '',
      '  1) [chromium] › tests/checkout.spec.ts:42:18 › checkout completes ───────────',
      '',
      '    Error: locator.click: Timeout 30000ms exceeded.',
      '',
      '      41 | test(…)',
      '  1 failed',
      '    [chromium] › tests/checkout.spec.ts:42:18 › checkout completes ────────────',
    ]) {
      await page.evaluate((text) => window.__piwiFakeTauri.emitLine(text), line);
    }
    await page.evaluate(() => window.__piwiFakeTauri.finish(1));

    const result = tray(page).getByTestId('run-result');
    await expect(result).toHaveCount(1);
    await expect(result).toHaveAttribute('data-status', 'failed');
    await expect(result.getByText('checkout completes', { exact: true })).toBeVisible();
    await expect(result.getByText('Error: locator.click: Timeout 30000ms exceeded.')).toBeVisible();
    await expect(result.getByRole('img', { name: 'Failed' })).toBeVisible();

    await expect(result.getByText('chromium', { exact: true })).toBeVisible();
    await result.getByRole('button', { name: 'Run checkout completes in chromium again', exact: true }).click();
    await expect.poll(async () => (await runInvocations(page)).length).toBe(2);
    expect((await runInvocations(page))[1]!.args!.args).toEqual(['tests/checkout.spec.ts:42', '--project=chromium']);
    // The run it came from stays open on its list, so another test runs again from there.
    await expect(tray(page).getByTestId('run-result').first()).toBeVisible();
  });

  test('a second stop forces the run to end', async ({ page }) => {
    await installFakeBridge(page, { linked: true, autoExit: false });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await processStarted(page);
    await tray(page).getByRole('button', { name: 'Stop', exact: true }).click();
    await tray(page).getByRole('button', { name: 'Force stop' }).click();

    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__piwiFakeTauri.invocations.filter((i) => i.cmd === 'desktop_stop_local_tests').map((i) => i.args),
        ),
      )
      .toEqual([{ runId: 7 }, { runId: 7 }]);
  });

  test("the tray's Stop stops the run as its own Stop does", async ({ page }) => {
    await installFakeBridge(page, { linked: true, autoExit: false });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await processStarted(page);
    await expect(tray(page).getByText('Running 0/1…', { exact: true })).toBeVisible();

    // The tray's item names the run by the shell id of its current step.
    await page.evaluate(() => window.__piwiFakeTauri.emitEvent('piwi:tray-stop', 7));
    await expect(tray(page).getByText('Stopping…', { exact: true })).toBeVisible();
    await page.evaluate(() => window.__piwiFakeTauri.finish(130));
    await expect(tray(page).getByText('Stopped', { exact: true })).toBeVisible();

    // A process no window run owns is stopped by the shell directly.
    await page.evaluate(() => window.__piwiFakeTauri.emitEvent('piwi:tray-stop', 99));
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__piwiFakeTauri.invocations.filter((i) => i.cmd === 'desktop_stop_local_tests').map((i) => i.args),
        ),
      )
      .toEqual([{ runId: 7 }, { runId: 99 }]);
  });

  test('colored output shows in its colors and still counts the tests', async ({ page }) => {
    await installFakeBridge(page, { linked: true, autoExit: false });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect(tray(page).getByText('Running 0/1…', { exact: true })).toBeVisible();
    // Playwright's list reporter with FORCE_COLOR=1, as the shell runs it.
    await page.evaluate(() =>
      window.__piwiFakeTauri.emitLine(
        '\u001b[2mRunning \u001b[22m3\u001b[2m tests using \u001b[22m2\u001b[2m workers\u001b[22m',
      ),
    );
    await expect(tray(page).getByText('Running 0/4…', { exact: true })).toBeVisible();
    await page.evaluate(() =>
      window.__piwiFakeTauri.emitLine(
        '  \u001b[32m✓\u001b[39m  \u001b[2m1 \u001b[22m[chromium] › tests/checkout.spec.ts:42:18 › checkout completes\u001b[2m (1.2s)\u001b[22m',
      ),
    );
    await expect(tray(page).getByText('Running 1/4…', { exact: true })).toBeVisible();

    await expect(tray(page).getByText('Running 3 tests using 2 workers')).toBeVisible();
    await expect(tray(page).locator('span', { hasText: /^✓$/ })).toHaveCSS('color', 'rgb(74, 222, 128)');
    await expect(tray(page).getByText('[22m')).toHaveCount(0);
  });

  test('a run moves to a separate window whole, and back when the window closes', async ({ page }) => {
    await installFakeBridge(page, { linked: true, autoExit: false });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect(tray(page).getByText('Running 1 test using 1 worker')).toBeVisible();
    await tray(page).getByRole('button', { name: 'Open the run in a separate window' }).click();
    await expect(tray(page).getByText('The run is in a separate window.')).toBeVisible();
    const name = await outputWindowName(page);

    // The shell opens the window on this page; the tray feeds it over their BroadcastChannel.
    const outputPage = await page.context().newPage();
    await outputPage.goto(`/desktop/run-output?name=${name}`);
    await waitForHydration(outputPage);
    const output = outputPage.getByRole('main', { name: 'Local run' });
    await expect(output.getByText('Running 1 test using 1 worker')).toBeVisible();
    await expect(output.getByRole('heading', { name: `1 failed test of run #${runId}` })).toBeVisible();
    await expect(outputPage).toHaveTitle(`1 failed test of run #${runId} · Piwi Desktop`);

    // Lines keep arriving in the window, and the run stops from it.
    await page.evaluate(() => window.__piwiFakeTauri.emitLine('  \u001b[32m1 passed\u001b[39m (2.0s)'));
    await expect(output.getByText('1 passed (2.0s)')).toBeVisible();
    await expect(output.locator('span', { hasText: /^1 passed$/ })).toHaveCSS('color', 'rgb(74, 222, 128)');
    await output.getByRole('button', { name: 'Stop' }).click();
    await expect(output.getByRole('button', { name: 'Force stop' })).toBeVisible();
    const stops = await page.evaluate(
      () => window.__piwiFakeTauri.invocations.filter((i) => i.cmd === 'desktop_stop_local_tests').length,
    );
    expect(stops).toBe(1);

    // The shell says the window is gone: the output comes back to the tray.
    await page.evaluate(
      (label) => window.__piwiFakeTauri.emitEvent('piwi:output-window-closed', label),
      `output-${name}_0`,
    );
    await expect(tray(page).getByText('1 passed (2.0s)')).toBeVisible();
    await expect(tray(page).getByText('The run is in a separate window.')).toHaveCount(0);
  });

  test('Show the run here closes the separate window', async ({ page }) => {
    await installFakeBridge(page, { linked: true });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect(tray(page).getByText('1 passed (2.0s)')).toBeVisible();
    await tray(page).getByRole('button', { name: 'Open the run in a separate window' }).click();
    await expect(tray(page).getByText('The run is in a separate window.')).toBeVisible();
    const name = await outputWindowName(page);

    const toggle = tray(page).getByRole('button', { name: 'Show the run here' });
    await toggle.click();
    await expect(tray(page).getByText('1 passed (2.0s)')).toBeVisible();
    await expect(tray(page).getByRole('button', { name: 'Open the run in a separate window' })).toBeFocused();
    const closes = await page.evaluate(() =>
      window.__piwiFakeTauri.invocations.filter((i) => i.cmd === 'desktop_close_output_window').map((i) => i.args),
    );
    expect(closes).toEqual([{ name }]);
  });

  test("a run's window runs a failed test again, then the run, in that same window, and gives the run back", async ({
    page,
  }) => {
    await installFakeBridge(page, { linked: true, autoExit: false });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect(tray(page).getByText('Running 1 test using 1 worker')).toBeVisible();
    for (const line of FAILED_OUTPUT) await page.evaluate((l) => window.__piwiFakeTauri.emitLine(l), line);
    await page.evaluate(() => window.__piwiFakeTauri.finish(1));
    await expect(tray(page).getByText('Failed', { exact: true }).first()).toBeVisible();
    await tray(page).getByRole('button', { name: 'Open the run in a separate window' }).click();
    const name = await outputWindowName(page);
    const outputPage = await page.context().newPage();
    await outputPage.goto(`/desktop/run-output?name=${name}`);
    await waitForHydration(outputPage);
    const runWindow = outputPage.getByRole('main', { name: 'Local run' });

    // What the run failed on, with Run again on its test: the run it starts shows in this same window.
    const results = runWindow.getByRole('list', { name: 'Results' });
    await expect(results.getByText('checkout › pays', { exact: true })).toBeVisible();
    await expect(results).toContainText('expect(locator).toBeVisible() failed');
    await runWindow.getByRole('button', { name: 'Run checkout › pays in chromium again', exact: true }).click();
    await expect.poll(async () => (await runInvocations(page)).length).toBe(2);
    await expect(runWindow.getByText('Running 1 test using 1 worker')).toBeVisible();
    await expect(runWindow.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect(runWindow.getByText('expect(locator).toBeVisible() failed')).toHaveCount(0);

    // It passes; its Run again runs it again, here too, and the shell opened one window all along.
    await page.evaluate(() => window.__piwiFakeTauri.emitLine('  1 passed (2.0s)'));
    await page.evaluate(() => window.__piwiFakeTauri.finish(0));
    await expect(runWindow.getByText('Passed', { exact: true })).toBeVisible();
    await runWindow.getByRole('button', { name: 'Run again' }).click();
    await expect.poll(async () => (await runInvocations(page)).length).toBe(3);
    await expect(runWindow.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    const opened = await page.evaluate(
      () => window.__piwiFakeTauri.invocations.filter((i) => i.cmd === 'desktop_open_output_window').length,
    );
    expect(opened).toBe(1);

    // Show in the tray: the run comes back to the tray, which opens on it, and the window closes.
    await runWindow.getByRole('button', { name: 'Show in the tray' }).click();
    await expect(tray(page).getByText('The run is in a separate window.')).toHaveCount(0);
    await expect(tray(page).getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__piwiFakeTauri.invocations.filter((i) => i.cmd === 'desktop_close_output_window').map((i) => i.args),
        ),
      )
      .toEqual([{ name }]);
    expect(
      await page.evaluate(() => window.__piwiFakeTauri.invocations.some((i) => i.cmd === 'desktop_bring_to_front')),
    ).toBe(true);
  });

  test('a run from the menu runs once, and leaves the project defaults alone', async ({ page }) => {
    await installFakeBridge(page, { linked: true });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: 'Run options' }).click();
    await expect(page.getByText('Run once', { exact: true })).toBeVisible();
    await page.getByRole('menuitemcheckbox', { name: 'Headed' }).click();

    await expect(tray(page).getByText('Passed', { exact: true })).toBeVisible();
    const invocations = await runInvocations(page);
    expect(invocations[0]!.args!.args).toEqual(['tests/checkout.spec.ts:42', '--project=chromium', '--headed']);

    const saved = await page.evaluate(
      (id) => JSON.parse(localStorage.getItem('piwi:desktop-local-run-options') ?? '{}')[String(id)],
      projectId,
    );
    expect(saved?.runMode ?? 'normal').toBe('normal');
  });

  test("the project's Local folder settings set the defaults every button starts from", async ({ page }) => {
    await installFakeBridge(page, { linked: true });
    await page.goto(`/projects/${projectId}?tab=settings&section=local-folder`);
    await waitForHydration(page);

    const defaults = page.locator('[data-shot="local-folder-run-defaults"]');
    const trace = defaults.getByRole('switch', { name: 'Trace' });
    await trace.click();
    await expect(trace).toHaveAttribute('aria-checked', 'true');
    // A run that does not repeat has nothing to stop at: its switch waits for a repeat count.
    await expect(defaults.getByRole('switch', { name: 'Stop at the first failing repetition' })).toBeDisabled();

    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    // The button names the option a click runs with.
    await page.getByRole('button', { name: 'Re-run 1 failed test · trace', exact: true }).click();
    await expect(tray(page).getByText('Passed', { exact: true })).toBeVisible();
    const invocations = await runInvocations(page);
    expect(invocations[0]!.args!.args).toEqual(['tests/checkout.spec.ts:42', '--project=chromium', '--trace=on']);
  });

  test('warns via the dialog when the linked folder holds none of the tests', async ({ page }) => {
    await installFakeBridge(page, { linked: true, missingSpecs: ['tests/checkout.spec.ts'] });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    // A wrong checkout demotes the one-click run to the dialog, which explains.
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    const dialog = page.getByRole('dialog');

    await expect(dialog.getByText('None of these tests are in the linked folder')).toBeVisible();
    await expect(dialog.getByText('tests/checkout.spec.ts', { exact: true })).toBeVisible();
    await expect(dialog.getByText('linked to another folder than the one these tests come from')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Choose the right folder…' })).toBeVisible();

    // A warning, never a block: the config may put specs elsewhere.
    await expect(dialog.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(tray(page).getByText('Passed', { exact: true })).toBeVisible();
  });

  test('live test counts reach the button, the tray and the sidebar pill', async ({ page }) => {
    await installFakeBridge(page, { linked: true, autoExit: false });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect(tray(page).getByText('Running 0/1…', { exact: true })).toBeVisible();
    await page.evaluate(() => window.__piwiFakeTauri.emitLine('Running 3 tests using 2 workers'));
    // The fake spawn already announced 1 test; the second announcement adds 3.
    await expect(tray(page).getByText('Running 0/4…', { exact: true })).toBeVisible();

    await page.evaluate(() =>
      window.__piwiFakeTauri.emitLine('  ✓  1 [chromium] › tests/checkout.spec.ts:42:18 › checkout completes (1.2s)'),
    );
    await expect(tray(page).getByText('Running 1/4…', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Running 1/4…' })).toBeVisible();
    await expect(page.getByRole('button', { name: '1 local run' })).toBeVisible();

    await page.evaluate(() => window.__piwiFakeTauri.finish(0));
    await expect(tray(page).getByText('Passed', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '1 local run' })).toHaveCount(0);
  });

  test('links the local process to the Piwi run it produced', async ({ page, request }) => {
    await installFakeBridge(page, { linked: true, autoExit: false });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect(tray(page).getByText('Running 0/1…', { exact: true })).toBeVisible();

    // The local process reports through the project's own Piwi reporter, with the
    // origin reference the app gave it; here that check-in is a real submit to the
    // same server, which announces it on the SSE stream the app correlates from.
    // A run another process reports at the same time is never taken for it.
    const [spawned] = await runInvocations(page);
    const originRef = spawned!.args!.originRef as string;
    expect(originRef).toMatch(/^desktop:[a-z0-9]+$/);
    const other = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.DESKTOP_LOCAL_RUN,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        metadata: { piwiOrigin: { kind: 'local' } },
        testCases: [],
      },
    });
    expect(other.ok()).toBeTruthy();
    const res = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.DESKTOP_LOCAL_RUN,
        metadata: { piwiOrigin: { kind: 'desktop', ref: originRef } },
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 2000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          {
            title: 'checkout completes',
            status: 'passed',
            duration: 2000,
            location: 'tests/checkout.spec.ts:42:18',
            browser: { name: 'chromium', projectName: 'chromium' },
            retries: 0,
            workerIndex: 0,
            startedAt: Date.now(),
          },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();
    const { runId: testRunId } = await res.json();

    await expect(tray(page).getByRole('link', { name: `Open run #${testRunId}` })).toBeVisible({
      timeout: 15000,
    });
    // The run it produced compares with the run its tests come from.
    await expect(tray(page).getByRole('link', { name: `Compare with run #${runId}` })).toHaveAttribute(
      'href',
      `/test-runs/${testRunId}?tab=changes&baseline=${runId}`,
    );

    await page.evaluate(() => window.__piwiFakeTauri.finish(0));
    await expect(tray(page).getByText('Passed', { exact: true })).toBeVisible();
  });

  test('reproduces a test from its evolution page without touching saved defaults', async ({ page }) => {
    await installFakeBridge(page, { linked: true });
    await page.goto(`/test-cases/${caseId}`);
    await waitForHydration(page);

    await page
      .getByRole('button', { name: 'Run this test · by title · ×20 until a failure · trace', exact: true })
      .click();
    await expect(tray(page).getByText('Passed', { exact: true })).toBeVisible();

    const invocations = await runInvocations(page);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.args!.args).toEqual([
      '--grep=checkout completes',
      '--trace=on',
      '--repeat-each=20',
      '--retries=0',
      '--max-failures=1',
    ]);

    // The preset stays out of the project's saved defaults.
    const saved = await page.evaluate(
      (id) => JSON.parse(localStorage.getItem('piwi:desktop-local-run-options') ?? '{}')[String(id)],
      projectId,
    );
    expect(saved?.repeatEach ?? 1).toBe(1);
    expect(saved?.trace ?? false).toBe(false);
  });

  test("a button's toggles change that button only, never the project defaults", async ({ page }) => {
    await installFakeBridge(page, { linked: true });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: 'Run options' }).click();
    await expect(page.getByText('Options of this button', { exact: true })).toBeVisible();
    await page.getByRole('menuitemcheckbox', { name: 'Record trace' }).click();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Re-run 1 failed test · trace', exact: true }).click();
    await expect(tray(page).getByText('Passed', { exact: true })).toBeVisible();
    const invocations = await runInvocations(page);
    expect(invocations[0]!.args!.args).toEqual(['tests/checkout.spec.ts:42', '--project=chromium', '--trace=on']);

    const saved = await page.evaluate(
      (id) => JSON.parse(localStorage.getItem('piwi:desktop-local-run-options') ?? '{}')[String(id)],
      projectId,
    );
    expect(saved?.trace ?? false).toBe(false);
  });

  test("a preset button's toggle turns its preset off for its next run", async ({ page }) => {
    await installFakeBridge(page, { linked: true });
    await page.goto(`/test-cases/${caseId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: 'Run options' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Record trace' }).click();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Run this test · by title · ×20 until a failure', exact: true }).click();
    await expect(tray(page).getByText('Passed', { exact: true })).toBeVisible();
    let invocations = await runInvocations(page);
    expect(invocations[0]!.args!.args).toEqual([
      '--grep=checkout completes',
      '--repeat-each=20',
      '--retries=0',
      '--max-failures=1',
    ]);

    // Without stopping at the first failing repetition, the run repeats every time.
    await page.getByRole('button', { name: 'Run options' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Stop at the first failing repetition' }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Run this test · by title · ×20', exact: true }).click();
    await expect.poll(async () => (await runInvocations(page)).length).toBe(2);
    invocations = await runInvocations(page);
    expect(invocations[1]!.args!.args).toEqual(['--grep=checkout completes', '--repeat-each=20', '--retries=0']);
  });

  test('raises an OS notification when a run finishes while the window is unfocused', async ({ page }) => {
    await installFakeBridge(page, { linked: true, autoExit: false });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await expect(tray(page).getByText('Running 0/1…', { exact: true })).toBeVisible();

    // Headless focus reporting is unreliable, so unfocus deterministically;
    // the subject here is the gate + the shell's Notification shim, which
    // turns the notification into a desktop_notify invoke.
    await page.evaluate(() => {
      document.hasFocus = () => false;
    });
    await page.evaluate(() => window.__piwiFakeTauri.finish(1));

    await expect
      .poll(() =>
        page.evaluate(() => window.__piwiFakeTauri.invocations.find((i) => i.cmd === 'desktop_notify')?.args ?? null),
      )
      .toMatchObject({ title: 'Local run failed' });
  });

  test('the copy-only Copy retry command yields to the split button inside the shell', async ({ page }) => {
    await installFakeBridge(page, { linked: true });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await expect(page.getByRole('button', { name: RERUN_FAILED })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy retry command' })).toHaveCount(0);
  });

  test('warns when the linked folder has no Playwright installation', async ({ page }) => {
    await installFakeBridge(page, { linked: true, playwrightMissing: true });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: 'Run options' }).click();
    await expect(page.getByText('No Playwright found in the linked folder')).toBeVisible();
    await page.keyboard.press('Escape');

    // The primary click demotes to the dialog, which explains — but never blocks.
    await page.getByRole('button', { name: RERUN_FAILED }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('No Playwright installation found')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
  });

  test('prompts to link a folder when none is linked yet', async ({ page }) => {
    await installFakeBridge(page, { linked: false });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: RERUN_FAILED }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Choose folder…' })).toBeVisible();

    // The link dialog opens on top, and checks the folder picked against the tests this run would run.
    await dialog.getByRole('button', { name: 'Choose folder…' }).click();
    const linkDialog = page.getByRole('dialog', { name: /to its folder$/ });
    await linkDialog.getByRole('button', { name: 'Choose folder…' }).click();
    await expect(linkDialog).toBeHidden();

    await expect(dialog.getByText('/home/dev/acme', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();

    const invocations = await page.evaluate(() => window.__piwiFakeTauri.invocations);
    const checked = invocations.find((i) => i.cmd === 'desktop_check_project_folder');
    expect(checked!.args!.specs).toEqual(['tests/checkout.spec.ts']);
    const setInvocation = invocations.find((i) => i.cmd === 'desktop_set_project_link');
    expect(setInvocation!.args!.path).toBe('/home/dev/acme');
  });
});

/**
 * The run button of the desktop window on a project with a CI action that re-runs tests: This computer and CI in one
 * dialog, a green run's flaky tests, a selection's own button, and the face once a CI action was the last Where. The
 * action's base URL is this machine, so a dispatch is refused before anything is sent.
 */
test.describe('Desktop run button beside CI', () => {
  let projectId: number;
  let redRunId: number;
  let greenRunId: number;

  const result = (title: string, location: string, status: 'passed' | 'failed', retries = 0) => ({
    title,
    status,
    duration: 1000,
    location,
    browser: { name: 'chromium', projectName: 'chromium' },
    ...(status === 'failed' ? { error: 'Error: boom' } : {}),
    retries,
    workerIndex: 0,
    startedAt: Date.now(),
  });

  async function submit(request: APIRequestContext, status: 'passed' | 'failed', testCases: unknown[]) {
    const res = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.DESKTOP_RUN_BUTTON,
        status,
        startTime: new Date().toISOString(),
        duration: 3000,
        totalTests: testCases.length,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        testCases,
      },
    });
    expect(res.ok()).toBeTruthy();
    return (await res.json()) as { runId: number; projectId: number };
  }

  test.beforeAll(async ({ request }) => {
    ({ runId: redRunId, projectId } = await submit(request, 'failed', [
      result('pays by card', 'tests/pay.spec.ts:12:5', 'failed'),
      result('pays by voucher', 'tests/pay.spec.ts:30:5', 'passed', 1),
      result('home loads', 'tests/home.spec.ts:5:1', 'passed'),
    ]));
    ({ runId: greenRunId } = await submit(request, 'passed', [
      result('pays by voucher', 'tests/pay.spec.ts:30:5', 'passed', 1),
      result('home loads', 'tests/home.spec.ts:5:1', 'passed'),
    ]));
    const saved = await request.patch(`/api/projects/${projectId}`, {
      data: {
        ciRerun: {
          enabled: true,
          actions: [
            {
              id: 'rerun',
              name: 'Re-run e2e',
              target: { type: 'ci-server', preset: 'jenkins', baseUrl: 'https://localhost:9/', fields: { job: 'e2e' } },
              inputs: [],
              accepts: ['tests'],
            },
          ],
          defaults: { rerun: 'rerun' },
        },
      },
    });
    expect(saved.ok(), await saved.text()).toBeTruthy();
  });

  /** Opens the dialog of the run header's button on This computer, from its menu. */
  async function runWithOptions(page: Page) {
    await page.locator('[data-shot="run-header"]').getByRole('button', { name: 'Run options' }).click();
    await page.getByRole('menuitem', { name: 'Run with options…' }).click();
    const dialog = page.getByRole('dialog');
    // The dialog reads what each CI action takes before it shows the fields of its pick.
    await expect(dialog.getByTestId('run-dialog-local-fields')).toBeVisible({ timeout: 30_000 });
    return dialog;
  }

  test('the dialog lists This computer before CI, and its fields follow the Where', async ({ page }) => {
    await installFakeBridge(page, { linked: true });
    await page.goto(`/test-runs/${redRunId}`);
    await waitForHydration(page);

    const dialog = await runWithOptions(page);
    await expect(dialog.getByTestId('run-dialog-local').getByRole('radio', { name: /Piwi Desktop/ })).toBeChecked();
    await expect(dialog.getByTestId('run-dialog-ci')).toContainText('Re-run e2e');
    await expect(dialog.getByRole('button', { name: 'Run', exact: true })).toBeVisible();

    await dialog
      .getByTestId('run-dialog-ci')
      .getByRole('radio', { name: /Re-run e2e/ })
      .click();
    await expect(dialog.getByTestId('run-dialog-local-fields')).toHaveCount(0);
    await expect(dialog.getByTestId('run-dialog-sentence')).toContainText('A team run');
    await expect(dialog.getByRole('button', { name: 'Send' })).toBeVisible();

    await dialog
      .getByTestId('run-dialog-local')
      .getByRole('radio', { name: /Piwi Desktop/ })
      .click();
    await dialog.getByRole('spinbutton', { name: 'Repeat each' }).fill('3');
    await dialog.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await processStarted(page);
    expect((await runInvocations(page))[0]!.args!.args).toEqual([
      'tests/pay.spec.ts:12',
      '--project=chromium',
      '--repeat-each=3',
      '--retries=0',
    ]);
  });

  test('a green run re-runs its flaky tests here, which no CI action takes', async ({ page }) => {
    await installFakeBridge(page, { linked: true });
    await page.goto(`/test-runs/${greenRunId}`);
    await waitForHydration(page);

    const dialog = await runWithOptions(page);
    await expect(dialog.getByRole('radio', { name: /The flaky tests/ })).toBeChecked();
    await expect(dialog.getByTestId('run-dialog-local').getByRole('radio', { name: /Piwi Desktop/ })).toBeChecked();
    // The project's one action re-runs tests: it takes neither the flaky tests nor a whole suite.
    await expect(dialog.getByTestId('run-dialog-ci')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Re-run 1 flaky test', exact: true }).click();
    await processStarted(page);
    expect((await runInvocations(page))[0]!.args!.args).toEqual(['tests/pay.spec.ts:30', '--project=chromium']);
  });

  test("a selection's button and its dialog run on this computer alone", async ({ page }) => {
    await installFakeBridge(page, { linked: true });
    await page.goto(`/test-runs/${redRunId}`);
    await waitForHydration(page);

    await page.getByRole('checkbox', { name: 'Select all failing tests' }).check();
    const bar = page.locator('[data-shot="test-selection-bar"]');
    await expect(bar.getByRole('button', { name: 'Re-run 1 selected test', exact: true })).toBeVisible();
    await bar.getByRole('button', { name: 'Run options' }).click();
    await page.getByRole('menuitem', { name: 'Run with options…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('run-dialog-local-fields')).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText('The selected tests');
    await expect(dialog.getByTestId('run-dialog-local')).toBeVisible();
    await expect(dialog.getByTestId('run-dialog-ci')).toHaveCount(0);
  });

  test('sent to a CI action last, the button opens the dialog on it until a run here', async ({ page }) => {
    await installFakeBridge(page, { linked: true });
    await page.addInitScript((id) => {
      localStorage.setItem('piwi-run-where', JSON.stringify({ [String(id)]: 'ci:rerun' }));
    }, projectId);
    await page.goto(`/test-runs/${redRunId}`);
    await waitForHydration(page);

    const header = page.locator('[data-shot="run-header"]');
    await header.getByRole('button', { name: 'Run on this computer or CI' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('run-dialog-ci').getByRole('radio', { name: /Re-run e2e/ })).toBeChecked({
      timeout: 30_000,
    });
    await expect(dialog.getByTestId('run-dialog-sentence')).toContainText('A team run');

    await dialog
      .getByTestId('run-dialog-local')
      .getByRole('radio', { name: /Piwi Desktop/ })
      .click();
    await dialog.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await processStarted(page);
    await expect(header.getByRole('button', { name: 'Run on this computer or CI' })).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('piwi-run-where'))).toBe(
      JSON.stringify({ [String(projectId)]: 'local' }),
    );
  });
});
