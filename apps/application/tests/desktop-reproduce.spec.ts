import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * The desktop-only "Reproduce here" and "Find the breaking commit here" actions
 * in the Reproduce section, driven against the regular web build with a faked
 * Tauri IPC bridge (the same pattern as `desktop-local-run.spec.ts`). The section
 * gates itself purely on the bridge's presence, so installing `window.__TAURI__`
 * before boot exercises the real component, store and event plumbing end to end —
 * everything but the Rust worktree/bisect drivers themselves (covered by
 * `desktop/e2e/` and the Rust unit tests).
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
  bisectStep: (step: number, estimate: number, sha: string) => void;
  bisectVerdict: (sha: string, verdict: string) => void;
  bisectResult: (firstBad: { sha: string; subject: string; author: string; date: string }) => void;
  finish: (code: number | null) => void;
}

declare global {
  interface Window {
    __piwiRepro: FakeState;
  }
}

interface FakeBridgeOptions {
  webServer?: boolean;
}

async function installFakeBridge(page: Page, options: FakeBridgeOptions = {}) {
  await page.addInitScript((opts: FakeBridgeOptions) => {
    const listeners: ((event: { payload: unknown }) => void)[] = [];
    const emit = (payload: unknown) => {
      for (const cb of listeners) cb({ payload });
    };
    const state: FakeState = {
      invocations: [],
      lastRunId: 10,
      phase: (phase: string) => emit({ id: state.lastRunId, kind: 'phase', phase }),
      line: (line: string) => emit({ id: state.lastRunId, kind: 'stdout', line, code: null }),
      bisectStep: (step: number, estimate: number, sha: string) =>
        emit({ id: state.lastRunId, kind: 'bisect', bisect: { event: 'step', step, stepsEstimate: estimate, sha } }),
      bisectVerdict: (sha: string, verdict: string) =>
        emit({ id: state.lastRunId, kind: 'bisect', bisect: { event: 'verdict', sha, verdict } }),
      bisectResult: (firstBad) => emit({ id: state.lastRunId, kind: 'bisect', bisect: { event: 'result', firstBad } }),
      finish: (code: number | null) => emit({ id: state.lastRunId, kind: 'exit', line: null, code }),
    };
    Object.assign(window, { __piwiRepro: state });
    Object.assign(window, {
      __TAURI__: {
        core: {
          invoke: async (cmd: string, args?: Record<string, unknown>) => {
            state.invocations.push({ cmd, args });
            switch (cmd) {
              case 'desktop_get_project_link':
                return { path: '/home/dev/acme', exists: true };
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
                  webServer: opts.webServer ?? false,
                };
              case 'desktop_reproduce_here':
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

function section(page: Page) {
  return page.locator('[data-shot="fix-reproduce-body"]');
}

// The Reproduce section lives in the folded "More ways to fix" toolbox; open it
// (it opens on the page only when the next step is to reproduce) before driving
// the recipe. Idempotent — a no-op when the body is already showing.
async function openReproduce(page: Page) {
  const body = section(page);
  if (await body.isVisible()) return;
  await page.getByRole('button', { name: /^Reproduce and bisect/ }).click();
  await expect(body).toBeVisible();
}

test.describe('Desktop reproduce & bisect', () => {
  let executionId: number;

  test.beforeAll(async ({ request }) => {
    const base = Date.now() - 60_000;
    // A prior green run gives the bisect a `good` end; the failing run is `bad`.
    await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.DESKTOP_REPRODUCE,
        status: 'passed',
        startTime: new Date(base).toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        branch: 'main',
        metadata: { scm: { commit: 'green0001', branch: 'main', remoteUrl: 'https://github.com/acme/web.git' } },
        testCases: [
          {
            title: 'checkout completes',
            status: 'passed',
            duration: 1000,
            location: 'tests/checkout.spec.ts:42:18',
            browser: { name: 'chromium', projectName: 'chromium' },
            retries: 0,
            workerIndex: 0,
            startedAt: base,
          },
        ],
      },
    });
    const failing = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.DESKTOP_REPRODUCE,
        status: 'failed',
        startTime: new Date(base + 30_000).toISOString(),
        duration: 9000,
        totalTests: 1,
        passedTests: 0,
        failedTests: 1,
        skippedTests: 0,
        branch: 'main',
        metadata: { scm: { commit: 'bad00002', branch: 'main', remoteUrl: 'https://github.com/acme/web.git' } },
        testCases: [
          {
            title: 'checkout completes',
            status: 'failed',
            duration: 9000,
            location: 'tests/checkout.spec.ts:42:18',
            browser: { name: 'chromium', projectName: 'chromium' },
            error: 'TimeoutError: locator.click: Timeout 30000ms exceeded.',
            retries: 0,
            workerIndex: 0,
            startedAt: base + 30_000,
          },
        ],
      },
    });
    expect(failing.ok()).toBeTruthy();
    const data = await failing.json();
    const run = await (await request.get(`/api/test-runs/${data.runId}`)).json();
    const failed = run.testCases.find((c: { status: string; executionId: number }) => c.status === 'failed');
    executionId = failed.executionId;
    expect(executionId).toBeTruthy();
  });

  test('without the bridge the section shows only the copyable recipe', async ({ page }) => {
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);
    await openReproduce(page);
    await expect(section(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reproduce here' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Find the breaking commit here' })).toHaveCount(0);
  });

  test('reproduce here streams the phases into the tray', async ({ page }) => {
    await installFakeBridge(page);
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);
    await openReproduce(page);

    await page.getByRole('button', { name: 'Reproduce here' }).click();
    await expect(tray(page)).toBeVisible();

    // The shell drives the phases; the store surfaces each header and the label.
    await page.evaluate(() => window.__piwiRepro.phase('checkout'));
    await expect(tray(page).getByText('── Checking out ──')).toBeVisible();
    await page.evaluate(() => window.__piwiRepro.phase('install'));
    await expect(tray(page).getByText('── Installing ──')).toBeVisible();
    await page.evaluate(() => window.__piwiRepro.phase('test'));
    await page.evaluate(() => window.__piwiRepro.line('  1 passed (2.0s)'));
    await page.evaluate(() => window.__piwiRepro.finish(0));
    await expect(tray(page).getByText('Passed', { exact: true })).toBeVisible();

    const invoked = await page.evaluate(() =>
      window.__piwiRepro.invocations.find((i) => i.cmd === 'desktop_reproduce_here'),
    );
    expect(invoked!.args!.commit).toBe('bad00002');
    expect(invoked!.args!.args).toEqual(['tests/checkout.spec.ts:42', '--project=chromium']);
  });

  test('a failing phase leaves the run failed', async ({ page }) => {
    await installFakeBridge(page);
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);
    await openReproduce(page);

    await page.getByRole('button', { name: 'Reproduce here' }).click();
    await page.evaluate(() => window.__piwiRepro.phase('install'));
    await page.evaluate(() => window.__piwiRepro.line('npm error could not resolve dependency'));
    await page.evaluate(() => window.__piwiRepro.finish(1));
    await expect(tray(page).getByText(/Failed/)).toBeVisible();
  });

  test('the bisect shows progress, a stop, and the found commit', async ({ page }) => {
    await installFakeBridge(page);
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);
    await openReproduce(page);

    await page.getByRole('button', { name: 'Find the breaking commit here' }).click();
    await expect(tray(page)).toBeVisible();

    await page.evaluate(() => window.__piwiRepro.phase('bisect'));
    await page.evaluate(() => window.__piwiRepro.bisectStep(1, 3, 'aaaaaaa'));
    await expect(tray(page).getByText(/Step 1 of ~3 — aaaaaaa — testing…/)).toBeVisible();

    // Stop is explicit, from the tray.
    await tray(page).getByRole('button', { name: 'Stop' }).click();
    const stopped = await page.evaluate(() =>
      window.__piwiRepro.invocations.some((i) => i.cmd === 'desktop_stop_local_tests'),
    );
    expect(stopped).toBeTruthy();
  });

  test('the found commit is shown in the section with a copy action', async ({ page }) => {
    await installFakeBridge(page);
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);
    await openReproduce(page);

    await page.getByRole('button', { name: 'Find the breaking commit here' }).click();
    await page.evaluate(() => window.__piwiRepro.phase('bisect'));
    await page.evaluate(() => window.__piwiRepro.bisectStep(1, 2, 'deadbee'));
    await page.evaluate(() => window.__piwiRepro.bisectVerdict('deadbee', 'bad'));
    await page.evaluate(() =>
      window.__piwiRepro.bisectResult({
        sha: 'deadbeef1234567',
        subject: 'tighten the checkout guard',
        author: 'Dev One',
        date: '2026-01-02',
      }),
    );
    await page.evaluate(() => window.__piwiRepro.finish(0));

    const bisected = section(page).locator('[data-shot="fix-bisected-commit"]');
    await expect(bisected).toBeVisible();
    // The section shows the first 12 chars of the found sha.
    await expect(bisected.getByText('deadbeef1234', { exact: true })).toBeVisible();
    await expect(bisected.getByText('tighten the checkout guard')).toBeVisible();
    await expect(bisected.getByRole('button', { name: 'Copy sha' })).toBeVisible();
    await expect(bisected.getByRole('link', { name: 'Open commit' })).toHaveAttribute(
      'href',
      'https://github.com/acme/web/commit/deadbeef1234567',
    );
  });

  test('when the config has no webServer the section says only test-side changes are exercised', async ({ page }) => {
    await installFakeBridge(page, { webServer: false });
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);
    await openReproduce(page);

    await expect(section(page).getByText(/only exercises test-side changes/)).toBeVisible();
  });

  test('with a webServer the section says Playwright starts the app', async ({ page }) => {
    await installFakeBridge(page, { webServer: true });
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);
    await openReproduce(page);
    await expect(section(page).getByText(/starts the app at each commit/)).toBeVisible();
  });
});
