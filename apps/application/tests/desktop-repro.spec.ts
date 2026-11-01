import type { Page, Request } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';
import { couponBugReport } from './utils/bug-report-sample';

/**
 * A repro request from Piwi Picker or an editor, as the desktop window shows
 * it: driven against the regular web build with a faked Tauri bridge and the
 * desktop endpoints routed (they answer 404 outside the desktop build). Covers
 * the confirmation, the run through `desktop_run_repro`, `desktop_bisect_here`
 * or `desktop_flake_lab_job`, and the verdict recorded on the request; the
 * spec's writing and the runs themselves are the shell's
 * (`src-tauri/src/repro.rs`, `worktree.rs`).
 */

interface FakeInvocation {
  cmd: string;
  args: Record<string, unknown> | undefined;
}

declare global {
  interface Window {
    __piwiFakeTauri: { invocations: FakeInvocation[] };
  }
}

const REQUEST_ID = 'a1b2c3d4e5f60718';

async function installFakeBridge(page: Page, linkedProjectId: number) {
  await page.addInitScript((linked: string) => {
    const listeners: ((event: { payload: unknown }) => void)[] = [];
    const emit = (payload: unknown) => {
      for (const cb of listeners) cb({ payload });
    };
    const state = { invocations: [] as FakeInvocation[], lastRunId: 20 };
    Object.assign(window, { __piwiFakeTauri: state });
    Object.assign(window, {
      __TAURI__: {
        core: {
          invoke: async (cmd: string, args?: Record<string, unknown>) => {
            state.invocations.push({ cmd, args });
            switch (cmd) {
              case 'desktop_get_project_link':
                return String(args?.projectId) === linked ? { path: '/home/dev/shop', exists: true } : null;
              case 'desktop_run_repro': {
                const id = ++state.lastRunId;
                setTimeout(() => {
                  emit({ id, kind: 'stdout', line: 'Running 1 test using 1 worker', code: null });
                  emit({
                    id,
                    kind: 'repro',
                    repro: {
                      status: 'failed',
                      line: 11,
                      message: 'Error: expect(locator).toHaveText(expected) failed\n\nReceived string: "Total: 40"',
                    },
                  });
                  emit({ id, kind: 'exit', line: null, code: 1 });
                }, 50);
                return id;
              }
              case 'desktop_bisect_here': {
                const id = ++state.lastRunId;
                setTimeout(() => {
                  emit({ id, kind: 'phase', phase: 'bisect', line: null, code: null });
                  emit({
                    id,
                    kind: 'bisect',
                    bisect: {
                      event: 'result',
                      firstBad: { sha: 'c1c1c1c1c1c1', subject: 'Drop the coupon cache', author: 'Ada', date: null },
                    },
                  });
                  emit({ id, kind: 'exit', line: null, code: 0 });
                }, 50);
                return id;
              }
              case 'desktop_flake_lab_job': {
                const id = ++state.lastRunId;
                const report = {
                  kind: 'reproduce',
                  testCaseId: 9,
                  experimentId: '77',
                  commit: 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0',
                  verdict: 'reproduced',
                  reproducingArm: 'suspect-1',
                  uploaded: false,
                  arms: [
                    {
                      id: 'control',
                      runs: 10,
                      matchingFailures: 0,
                      otherFailures: 0,
                      discardedRounds: 0,
                      stoppedEarly: false,
                      skipped: null,
                    },
                    {
                      id: 'suspect-1',
                      runs: 4,
                      matchingFailures: 3,
                      otherFailures: 0,
                      discardedRounds: 0,
                      stoppedEarly: true,
                      skipped: null,
                    },
                  ],
                };
                setTimeout(() => {
                  emit({ id, kind: 'phase', phase: 'lab', line: null, code: null });
                  emit({ id, kind: 'stdout', line: JSON.stringify(report), code: null });
                  emit({ id, kind: 'lab', lab: report, line: null, code: null });
                  emit({ id, kind: 'exit', line: null, code: 0 });
                }, 50);
                return id;
              }
              case 'desktop_bring_to_front':
              case 'desktop_notify':
              case 'desktop_set_notification_choices':
              case 'desktop_set_run_progress':
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
        window: { getCurrentWindow: () => ({ label: 'main' }) },
      },
    });
  }, String(linkedProjectId));
}

/** The desktop event stream, answering the request once, then nothing, as the server resends only waiting ones. */
async function routeDesktop(page: Page, patches: unknown[], overrides: Record<string, unknown> = {}) {
  const steps = couponBugReport().steps;
  const request = {
    id: REQUEST_ID,
    kind: 'steps',
    title: steps.title,
    steps,
    options: { headed: true, trace: true, project: null, repeatEach: 1 },
    job: null,
    bugReportId: 37,
    instanceUrl: 'https://piwi.example.com',
    status: 'waiting',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    projectId: null,
    verdict: null,
    jobVerdict: null,
    runId: null,
    ...overrides,
  };
  let sent = false;
  await page.route('**/api/desktop/events', (route) => {
    const body = sent ? ': idle\n\n' : `data: ${JSON.stringify({ type: 'repro-request', request })}\n\n`;
    sent = true;
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
  await page.route(`**/api/desktop/repro-requests/${REQUEST_ID}/spec*`, (route) =>
    route.fulfill({ json: { code: '', stepLines: [4, 5, 6, 8], warnings: [] } }),
  );
  await page.route(`**/api/desktop/repro-requests/${REQUEST_ID}`, (route, req: Request) => {
    patches.push(req.postDataJSON());
    return route.fulfill({ json: { ...request, ...req.postDataJSON() } });
  });
}

test.describe('Desktop repro request', () => {
  let projectId: number;

  test.beforeAll(async ({ request }) => {
    const res = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.DESKTOP_REPRO,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [{ title: 'cart loads', status: 'passed', duration: 1000, location: 'tests/cart.spec.ts:3:1' }],
      },
    });
    expect(res.ok()).toBeTruthy();
    projectId = (await res.json()).projectId;
  });

  test('waits for the click, runs in the linked project and records the verdict', async ({ page }) => {
    const patches: unknown[] = [];
    await installFakeBridge(page, projectId);
    await routeDesktop(page, patches);
    await page.goto('/setup');
    await waitForHydration(page);

    const dialog = page.getByRole('dialog', { name: 'Run a bug report with Playwright' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Coupon not applied to the total')).toBeVisible();
    await expect(dialog.getByText('/home/dev/shop')).toBeVisible();
    await expect(dialog.getByText(`<testDir>/piwi-repro/bug-${REQUEST_ID}.spec.ts --headed --trace=on`)).toBeVisible();
    // Nothing ran before the click.
    expect(
      await page.evaluate(() => window.__piwiFakeTauri.invocations.some((i) => i.cmd === 'desktop_run_repro')),
    ).toBe(false);

    await dialog.getByRole('button', { name: 'Run with Playwright' }).click();
    await expect(dialog).toHaveCount(0);

    const tray = page.getByRole('region', { name: 'Local runs' });
    await expect(tray.getByText('Running 1 test using 1 worker')).toBeVisible();
    await expect(page.getByText('Bug reproduced').first()).toBeVisible();
    const runs = await page.evaluate(() =>
      window.__piwiFakeTauri.invocations.filter((i) => i.cmd === 'desktop_run_repro'),
    );
    expect(runs).toEqual([
      {
        cmd: 'desktop_run_repro',
        args: {
          projectId: String(projectId),
          requestId: REQUEST_ID,
          args: ['--headed', '--trace=on'],
          bugReportId: 37,
          originRef: '37',
        },
      },
    ]);
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[0]).toEqual({ status: 'running', projectId });
    expect(patches[1]).toMatchObject({
      status: 'done',
      verdict: { kind: 'reproduced', step: 3, found: '"Total: 40"' },
    });
  });

  test('declining runs nothing and says so to the request', async ({ page }) => {
    const patches: unknown[] = [];
    await installFakeBridge(page, projectId);
    await routeDesktop(page, patches);
    await page.goto('/setup');
    await waitForHydration(page);

    const dialog = page.getByRole('dialog', { name: 'Run a bug report with Playwright' });
    await dialog.getByRole('button', { name: 'Decline' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => patches).toEqual([{ status: 'declined' }]);
    expect(
      await page.evaluate(() => window.__piwiFakeTauri.invocations.some((i) => i.cmd === 'desktop_run_repro')),
    ).toBe(false);
  });

  test("an editor's bisect waits for the click, runs in a worktree and records the first bad commit", async ({
    page,
  }) => {
    const patches: unknown[] = [];
    await installFakeBridge(page, projectId);
    await routeDesktop(page, patches, {
      kind: 'bisect',
      title: 'applies the coupon',
      steps: null,
      bugReportId: null,
      job: {
        commit: 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0',
        good: 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0',
        tests: [{ filePath: 'tests/cart.spec.ts', title: 'applies the coupon', line: 12, projectName: 'chromium' }],
        browser: 'chromium',
        clusterId: 214,
      },
    });
    await page.goto('/setup');
    await waitForHydration(page);

    const dialog = page.getByRole('dialog', { name: 'Find the commit that broke a test' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('from piwi.example.com')).toBeVisible();
    await expect(dialog.getByText('tests/cart.spec.ts:12 (chromium)')).toBeVisible();
    expect(
      await page.evaluate(() => window.__piwiFakeTauri.invocations.some((i) => i.cmd === 'desktop_bisect_here')),
    ).toBe(false);

    await dialog.getByRole('button', { name: 'Bisect', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const runs = await page.evaluate(() =>
      window.__piwiFakeTauri.invocations.filter((i) => i.cmd === 'desktop_bisect_here'),
    );
    // The cluster belongs to the instance the job came from: it is not this app's, so only the job names the run.
    expect(runs).toEqual([
      {
        cmd: 'desktop_bisect_here',
        args: {
          projectId: String(projectId),
          good: 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0',
          bad: 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0',
          browser: 'chromium',
          // By file and title, so the test still matches at a commit where its line differs.
          args: ['tests/cart.spec.ts', '--grep=applies the coupon', '--project=chromium'],
          flakeTestCaseId: null,
          clusterId: null,
          originRef: `job:${REQUEST_ID}`,
        },
      },
    ]);
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[0]).toEqual({ status: 'running', projectId });
    expect(patches[1]).toMatchObject({
      status: 'done',
      jobVerdict: {
        kind: 'first-bad',
        commit: { sha: 'c1c1c1c1c1c1', subject: 'Drop the coupon cache', author: 'Ada', date: null },
      },
    });
  });

  test("an editor's Flake Lab job waits for the click, runs its plan in a worktree and records what the lab measured", async ({
    page,
  }) => {
    const patches: unknown[] = [];
    await installFakeBridge(page, projectId);
    const arm = (id: string, label: string, conditions: unknown[]) => ({
      id,
      label,
      suspectId: id === 'control' ? null : 'slow-route:GET /api/cart',
      rank: id === 'control' ? null : 1,
      conditions,
      runs: 10,
      stopAt: id === 'control' ? null : 3,
    });
    await routeDesktop(page, patches, {
      kind: 'flake-lab',
      title: 'cart › applies the coupon',
      steps: null,
      bugReportId: null,
      job: {
        commit: 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0',
        good: null,
        tests: [
          { filePath: 'tests/cart.spec.ts', title: 'cart › applies the coupon', line: null, projectName: 'chromium' },
        ],
        browser: null,
        clusterId: null,
        plan: {
          version: 1,
          experimentId: '77',
          kind: 'reproduce',
          projectId: 7,
          testCaseId: 9,
          test: { file: 'tests/cart.spec.ts', title: 'applies the coupon', suite: ['cart'], project: 'chromium' },
          displayTitle: 'cart › applies the coupon',
          windowDays: 14,
          failures: 6,
          passes: 40,
          failureCommit: 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0',
          medianDurationMs: 1800,
          errorSignatures: ['Expected <n> to be <n>'],
          suspects: [],
          control: arm('control', 'control', []),
          arms: [
            arm('suspect-1', 'delay GET /api/cart 1.8 s', [
              { kind: 'delay', route: 'GET /api/cart', ms: 1800, match: 'all' },
            ]),
          ],
          combined: null,
          verifies: null,
        },
      },
    });
    await page.goto('/setup');
    await waitForHydration(page);

    const dialog = page.getByRole('dialog', { name: 'Run Flake Lab on a flaky test' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('from piwi.example.com')).toBeVisible();
    const arms = dialog.getByTestId('flake-lab-job-arms');
    await expect(arms.getByRole('listitem')).toHaveCount(2);
    await expect(arms.getByText('delay GET /api/cart 1.8 s')).toBeVisible();
    expect(
      await page.evaluate(() => window.__piwiFakeTauri.invocations.some((i) => i.cmd === 'desktop_flake_lab_job')),
    ).toBe(false);

    await dialog.getByRole('button', { name: 'Run the lab', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    // The window names the project and the request only: the shell reads the commit and the plan itself.
    const runs = await page.evaluate(() =>
      window.__piwiFakeTauri.invocations.filter((i) => i.cmd === 'desktop_flake_lab_job'),
    );
    expect(runs).toEqual([
      { cmd: 'desktop_flake_lab_job', args: { projectId: String(projectId), requestId: REQUEST_ID } },
    ]);
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[0]).toEqual({ status: 'running', projectId });
    expect(patches[1]).toMatchObject({
      status: 'done',
      jobVerdict: {
        kind: 'lab',
        report: {
          verdict: 'reproduced',
          reproducingArm: 'suspect-1',
          commit: 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0',
          arms: [
            { id: 'control', runs: 10, matchingFailures: 0, otherFailures: 0, discardedRounds: 0, stoppedEarly: false },
            { id: 'suspect-1', runs: 4, matchingFailures: 3, otherFailures: 0, discardedRounds: 0, stoppedEarly: true },
          ],
        },
      },
    });
  });
});
