import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * Reproduce this flake, and the flake-aware bisect, in the desktop app, driven
 * against the regular web build with a faked Tauri IPC bridge (the pattern of
 * `desktop-reproduce.spec.ts`). The button gates itself on the bridge, so the
 * real component, store and event plumbing run end to end; the Rust command
 * behind it is covered by the shell's unit tests.
 */

interface FakeInvocation {
  cmd: string;
  args: Record<string, unknown> | undefined;
}

interface FakeState {
  invocations: FakeInvocation[];
  lastRunId: number;
  phase: (phase: string) => void;
  line: (line: string) => void;
  finish: (code: number | null) => void;
}

declare global {
  interface Window {
    __piwiFlake: FakeState;
  }
}

async function installFakeBridge(page: Page, options: { linked?: boolean } = {}) {
  await page.addInitScript((opts: { linked?: boolean }) => {
    const listeners: ((event: { payload: unknown }) => void)[] = [];
    const emit = (payload: unknown) => {
      for (const cb of listeners) cb({ payload });
    };
    const state: FakeState = {
      invocations: [],
      lastRunId: 40,
      phase: (phase: string) => emit({ id: state.lastRunId, kind: 'phase', phase }),
      line: (line: string) => emit({ id: state.lastRunId, kind: 'stdout', line, code: null }),
      finish: (code: number | null) => emit({ id: state.lastRunId, kind: 'exit', line: null, code }),
    };
    Object.assign(window, { __piwiFlake: state });
    Object.assign(window, {
      __TAURI__: {
        core: {
          invoke: async (cmd: string, args?: Record<string, unknown>) => {
            state.invocations.push({ cmd, args });
            switch (cmd) {
              case 'desktop_get_project_link':
                return opts.linked === false ? null : { path: '/home/dev/acme', exists: true };
              case 'desktop_inspect_folder':
                return {
                  path: '/home/dev/acme',
                  exists: true,
                  packageName: 'acme',
                  suggestedName: 'acme',
                  playwrightConfig: 'playwright.config.ts',
                  playwrightInstalled: true,
                  reporterInstalled: true,
                  reporterConfigured: true,
                  configuredProjectName: null,
                  webServer: true,
                };
              case 'desktop_flake_lab_here':
              case 'desktop_bisect_here':
                return ++state.lastRunId;
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

test.describe('Flake Lab in the desktop app', () => {
  test.describe.configure({ mode: 'serial' });

  const TITLE = 'shows the cart total';
  const RUNS = 12;
  const FLAKY_RUNS = [1, 4, 7, 10];
  const ERROR = "Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByTestId('cart-total')";

  let projectId: number;
  let testCaseId: number;
  let failingExecutionId: number;

  const cart = (ms: number, startTime: number) => ({
    method: 'GET',
    url: 'http://localhost:3000/api/cart',
    status: 200,
    duration: ms,
    startTime,
    resourceType: 'fetch',
  });

  test.beforeAll(async ({ request }) => {
    test.setTimeout(120_000);
    const base = Date.now() - (RUNS + 1) * 3_600_000;
    const shared = { title: TITLE, location: 'tests/cart.spec.ts:8:3', workerIndex: 0 };
    const submit = async (i: number, status: string, testCases: unknown[]) => {
      const start = base + i * 3_600_000;
      const res = await retryPost(request, '/api/test-runs/submit', {
        data: {
          projectName: PROJECT.FLAKE_LAB_DESKTOP,
          status,
          startTime: new Date(start).toISOString(),
          duration: 10_000,
          totalTests: 1,
          passedTests: status === 'passed' ? 1 : 0,
          failedTests: status === 'passed' ? 0 : 1,
          skippedTests: 0,
          branch: 'main',
          metadata: { scm: { commit: `abc${String(i).padStart(4, '0')}`, branch: 'main' } },
          testCases,
        },
      });
      return res.json();
    };
    for (let i = 0; i < RUNS; i++) {
      const start = base + i * 3_600_000;
      const pass = (retries: number, at: number) => ({
        ...shared,
        status: 'passed',
        duration: 2_000,
        retries,
        startedAt: at,
        networkRequests: [cart(100 + i, at + 500)],
      });
      const cases = FLAKY_RUNS.includes(i)
        ? [
            {
              ...shared,
              status: 'failed',
              duration: 5_000,
              retries: 0,
              startedAt: start,
              error: ERROR,
              networkRequests: [cart(2_000 + i * 10, start + 500)],
            },
            pass(1, start + 6_000),
          ]
        : [pass(0, start)];
      projectId = (await submit(i, 'passed', cases)).projectId;
    }
    // The latest run fails outright, so its execution has a bisect window.
    const failing = await submit(RUNS, 'failed', [
      {
        ...shared,
        status: 'failed',
        duration: 5_000,
        retries: 0,
        startedAt: base + RUNS * 3_600_000,
        error: ERROR,
        networkRequests: [cart(2_100, base + RUNS * 3_600_000 + 500)],
      },
    ]);
    const run = await (await request.get(`/api/test-runs/${failing.runId}`)).json();
    failingExecutionId = run.testCases.find((c: { status: string }) => c.status === 'failed').executionId;
    const cases = await (await request.get(`/api/projects/${projectId}/test-cases`)).json();
    testCaseId = cases.items.find((c: { title: string }) => c.title === TITLE).id;
  });

  test('outside the desktop app the tab offers the command only', async ({ page }) => {
    await page.goto(`/test-cases/${testCaseId}?tab=flakiness`);
    await waitForHydration(page);
    await expect(page.getByTestId('copy-flake-command')).toBeVisible();
    await expect(page.getByTestId('flake-lab-desktop')).toHaveCount(0);
    await expect(page.getByTestId('flake-lab-link-folder')).toHaveCount(0);
  });

  test('without a linked folder the button asks for one', async ({ page }) => {
    await installFakeBridge(page, { linked: false });
    await page.goto(`/test-cases/${testCaseId}?tab=flakiness`);
    await waitForHydration(page);
    await expect(page.getByTestId('flake-lab-link-folder')).toBeVisible();
    await expect(page.getByTestId('flake-lab-desktop')).toHaveCount(0);
  });

  test('Reproduce this flake passes the test and the options, streams, and shows the experiment when done', async ({
    page,
    request,
  }) => {
    await installFakeBridge(page);
    await page.goto(`/test-cases/${testCaseId}?tab=flakiness`);
    await waitForHydration(page);
    await expect(page.getByTestId('flake-experiment')).toHaveCount(0);

    await page.getByTestId('flake-lab-desktop').click();
    const form = page.getByTestId('flake-lab-desktop-options');
    await expect(form).toBeVisible();
    await form.getByTestId('flake-lab-arms').click();
    await page.getByRole('option', { name: 'Suspect 1 only' }).click();
    await form.getByTestId('flake-lab-runs').fill('6');
    await form.getByTestId('flake-lab-budget').fill('20');
    await form.getByTestId('flake-lab-desktop-run').click();

    await expect(tray(page)).toBeVisible();
    await expect(tray(page)).toContainText(`piwi flake ${testCaseId} --suspect 1 --runs 6 --budget 20m`);
    const invoked = await page.evaluate(() =>
      window.__piwiFlake.invocations.find((i) => i.cmd === 'desktop_flake_lab_here'),
    );
    // The test and the options only: no project, commit, path or argument list.
    expect(invoked!.args).toEqual({ testCaseId, suspect: 1, all: false, runs: 6, budgetMinutes: 20 });
    await expect(page.getByTestId('flake-lab-desktop')).toContainText('Running the lab…');

    await page.evaluate(() => window.__piwiFlake.phase('checkout'));
    await expect(tray(page).getByText('── Checking out ──')).toBeVisible();
    await page.evaluate(() => window.__piwiFlake.phase('lab'));
    await expect(tray(page).getByText('── Running the lab ──')).toBeVisible();
    await page.evaluate(() => window.__piwiFlake.line('Verdict: reproduced by delay GET /api/cart 2 s'));

    // What `piwi flake` does while it runs: record the experiment from the desktop app.
    const plan = await (
      await request.get(`/api/test-cases/${testCaseId}/flake-plan?source=desktop&commit=abc0010`)
    ).json();
    const saved = await request.post(`/api/projects/${projectId}/flake-lab/results`, {
      data: {
        experimentId: plan.experimentId,
        commit: 'abc0010',
        arms: [
          { id: 'control', conditions: [], runs: 10, matchingFailures: 0, otherFailures: 0 },
          {
            id: 'suspect-1',
            suspectId: 'slow-route:GET /api/cart',
            conditions: [{ kind: 'delay', route: 'GET /api/cart', ms: 2000 }],
            runs: 4,
            matchingFailures: 3,
            otherFailures: 0,
            stoppedEarly: true,
          },
        ],
      },
    });
    expect(saved.ok()).toBeTruthy();

    await page.evaluate(() => window.__piwiFlake.finish(0));
    await expect(tray(page).getByText('Reproduced', { exact: true })).toBeVisible();
    // The tab reads its experiments again once the session ends.
    await expect(page.getByTestId('flake-experiment')).toHaveCount(1);
    await expect(page.getByTestId('flake-experiment')).toContainText('Reproduced by delay GET /api/cart 2 s');
    await expect(page.getByTestId('flake-experiment')).toContainText('desktop');
    await expect(page.getByTestId('flake-lab-desktop')).toContainText('Reproduce this flake');
  });

  test('a session that could not run is an error, not a verdict', async ({ page }) => {
    await installFakeBridge(page);
    await page.goto(`/test-cases/${testCaseId}?tab=flakiness`);
    await waitForHydration(page);
    await page.getByTestId('flake-lab-desktop').click();
    await page.getByTestId('flake-lab-desktop-run').click();
    const invoked = await page.evaluate(() =>
      window.__piwiFlake.invocations.find((i) => i.cmd === 'desktop_flake_lab_here'),
    );
    expect(invoked!.args).toEqual({ testCaseId, suspect: null, all: false, runs: null, budgetMinutes: null });
    await page.evaluate(() => window.__piwiFlake.finish(2));
    await expect(tray(page).getByText('Failed (exit 2)')).toBeVisible();
  });

  test('the bisect of a reproduced flake runs its arm at each step', async ({ page, request }) => {
    const reproduce = await (await request.get(`/api/test-run-cases/${failingExecutionId}/reproduce`)).json();
    expect(reproduce.desktop.flakeArm).toEqual({ testCaseId, label: 'delay GET /api/cart 2 s' });

    await installFakeBridge(page);
    await page.goto(`/test-run-cases/${failingExecutionId}`);
    await waitForHydration(page);
    const body = page.locator('[data-shot="fix-reproduce-body"]');
    if (!(await body.isVisible())) await page.getByRole('button', { name: /^Reproduce and bisect/ }).click();
    await expect(page.getByTestId('bisect-flake-arm')).toContainText('delay GET /api/cart 2 s');
    await page.getByTestId('bisect-here').click();
    const invoked = await page.evaluate(() =>
      window.__piwiFlake.invocations.find((i) => i.cmd === 'desktop_bisect_here'),
    );
    expect(invoked!.args).toMatchObject({ good: 'abc0011', bad: 'abc0012', flakeTestCaseId: testCaseId });
  });
});
