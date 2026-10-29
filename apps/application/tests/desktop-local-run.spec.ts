import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/** The run page's desktop re-run button, by what it says it runs. */
const RERUN_FAILED = /^Re-run \d+ failed tests?/;

/**
 * The desktop-only "Run locally" flow, driven against the regular web build
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
    const listeners: ((event: { payload: unknown }) => void)[] = [];
    const emit = (payload: unknown) => {
      for (const cb of listeners) cb({ payload });
    };
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
              case 'desktop_notify':
              case 'desktop_set_activity':
                return null;
              default:
                throw new Error(`unexpected command: ${cmd}`);
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
  }, options);
}

function tray(page: Page) {
  return page.getByRole('region', { name: 'Local runs' });
}

function runInvocations(page: Page) {
  return page.evaluate(() => window.__piwiFakeTauri.invocations.filter((i) => i.cmd === 'desktop_run_local_tests'));
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
    const data = await res.json();
    const proj = await (await request.get(`/api/projects/${data.projectId}`)).json();
    runId = proj.testRuns[0].id;
    projectId = data.projectId;
    const cases = await (await request.get(`/api/projects/${projectId}/test-cases`)).json();
    caseId = cases.items.find((c: { title: string; id: number }) => c.title === 'checkout completes')!.id;
    const run = await (await request.get(`/api/test-runs/${runId}`)).json();
    type Case = { title: string; executionId: number };
    executionId = (run.testCases as Case[]).find((c) => c.title === 'checkout completes')!.executionId;
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

    await page.getByRole('button', { name: 'Run this test · by title · ×20 · trace', exact: true }).click();
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
    await page.getByRole('link', { name: 'Projects' }).first().click();
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

  test('a second stop forces the run to end', async ({ page }) => {
    await installFakeBridge(page, { linked: true, autoExit: false });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await page.getByRole('button', { name: RERUN_FAILED }).click();
    await tray(page).getByRole('button', { name: 'Stop', exact: true }).click();
    await tray(page).getByRole('button', { name: 'Force stop' }).click();

    const stops = await page.evaluate(() =>
      window.__piwiFakeTauri.invocations.filter((i) => i.cmd === 'desktop_stop_local_tests').map((i) => i.args),
    );
    expect(stops).toEqual([{ runId: 7 }, { runId: 7 }]);
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
    await defaults.getByRole('switch').click();
    await expect(defaults.getByRole('switch')).toHaveAttribute('aria-checked', 'true');

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
    await expect(dialog.getByText('linked to a different checkout')).toBeVisible();
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

    await expect(tray(page).getByRole('link', { name: `Live in Piwi — Run #${testRunId}` })).toBeVisible({
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

    await page.getByRole('button', { name: 'Run this test · by title · ×20 · trace', exact: true }).click();
    await expect(tray(page).getByText('Passed', { exact: true })).toBeVisible();

    const invocations = await runInvocations(page);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.args!.args).toEqual(['--grep', 'checkout completes', '--trace=on', '--repeat-each=20']);

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

    await page.getByRole('button', { name: 'Run this test · by title · ×20', exact: true }).click();
    await expect(tray(page).getByText('Passed', { exact: true })).toBeVisible();
    const invocations = await runInvocations(page);
    expect(invocations[0]!.args!.args).toEqual(['--grep', 'checkout completes', '--repeat-each=20']);
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

  test('the copy-only Retry button yields to the split button inside the shell', async ({ page }) => {
    await installFakeBridge(page, { linked: true });
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);

    await expect(page.getByRole('button', { name: RERUN_FAILED })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
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

    await dialog.getByRole('button', { name: 'Choose folder…' }).click();

    await expect(dialog.getByText('/home/dev/acme')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();

    const setInvocation = await page.evaluate(() =>
      window.__piwiFakeTauri.invocations.find((i) => i.cmd === 'desktop_set_project_link'),
    );
    expect(setInvocation!.args!.path).toBe('/home/dev/acme');
  });
});
