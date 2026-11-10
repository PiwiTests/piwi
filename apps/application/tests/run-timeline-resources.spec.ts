import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

test.describe('Run timeline resource tracks', () => {
  let runId = 0;
  const t0 = Date.now() - 60_000;
  const GB = 1024 ** 3;

  test.beforeAll(async ({ request }) => {
    // What a test cost its worker and browsers: `cpuMs` of CPU in all, half of it waiting.
    const resources = (cpuMs: number) => ({
      workerCpuMs: cpuMs / 4,
      roles: { renderer: { cpuMs: (cpuMs * 3) / 4, runWaitMs: cpuMs / 2, peakRssMb: 300, processes: 1 } },
      loopUtilization: 0.2,
      loopDelayP99Ms: 20,
      involuntarySwitches: 10,
      heapUsedMb: 50,
    });
    const testCase = (title: string, workerIndex: number, start: number, cpuMs: number) => ({
      title,
      status: 'passed',
      duration: 2000,
      location: `tests/cart.spec.ts:${10 + start}:5`,
      workerIndex,
      startedAt: t0 + start * 1000,
      resources: resources(cpuMs),
    });
    const response = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.RUN_TIMELINE_RESOURCES,
        status: 'passed',
        startTime: new Date(t0).toISOString(),
        duration: 5000,
        totalTests: 3,
        passedTests: 3,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          testCase('adds an item', 0, 0, 3000),
          testCase('removes an item', 0, 2, 1000),
          testCase('empties the cart', 1, 0, 2000),
        ],
        resourceReport: {
          v: 1,
          findings: [],
          counts: { leaked: 0, idle: 0, piling: 0, handle: 0, probable: 0 },
          profile: null,
          workers: [],
          artifactBytes: {},
          workerHealth: null,
          timeline: {
            // The sampler started a second before the first test.
            startedAt: t0 - 1000,
            cpuPct: [
              [1000, 20],
              [2000, 60],
              [3000, 90],
              [4000, 40],
            ],
            memoryBytes: [
              [0, 1 * GB],
              [2500, 3 * GB],
            ],
            pages: [
              {
                worker: 0,
                points: [
                  [1000, 1],
                  [5000, 0],
                ],
              },
              {
                worker: 1,
                points: [
                  [1100, 1],
                  [2900, 2],
                  [3200, 0],
                ],
              },
            ],
            // The sampler read worker 1's processes; worker 0's strip falls back to its tests' cost.
            workers: [
              {
                worker: 1,
                cpuCores: [
                  [1500, 0.9],
                  [2500, 1.2],
                ],
                memoryBytes: [[2500, 1.5 * GB]],
              },
            ],
          },
        },
      },
      timeout: 20000,
    });
    expect(response.ok()).toBeTruthy();
    runId = ((await response.json()) as { runId: number }).runId;
  });

  test('draws CPU, memory and open pages above the rows, reads them on hover, and turns each off', async ({ page }) => {
    await page.goto(`/test-runs/${runId}?tab=workers`);
    await waitForHydration(page);

    const tracks = page.locator('[data-resource-track]');
    await expect(tracks).toHaveCount(3);
    await expect(page.locator('[data-resource-track="memory"]')).toContainText('peak 3.0 GB');
    await expect(page.locator('[data-resource-track="pages"]')).toContainText('peak 3');

    // Halfway through the four-second run: on the run's clock, a second after the sampler's.
    const band = page.getByTestId('timeline-resource-band');
    const box = (await band.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
    const tooltip = page.getByTestId('timeline-resource-tooltip');
    await expect(tooltip).toContainText('90%');
    await expect(tooltip).toContainText('3 open · Worker 1: 1 · Worker 2: 2');
    await expect(page.getByTestId('timeline-resource-cursor')).toBeAttached();

    await page.mouse.move(0, 0);
    await page.getByTestId('timeline-resources-menu').click();
    // The tracks above the rows come first in the menu; the strip under each worker names some alike.
    await page.getByRole('menuitemcheckbox', { name: 'Open pages', exact: true }).first().click();
    await page.keyboard.press('Escape');
    await expect(tracks).toHaveCount(2);
    await expect(page.locator('[data-resource-track="pages"]')).toHaveCount(0);

    // The choice is remembered for the next visit.
    await page.reload();
    await waitForHydration(page);
    await expect(page.locator('[data-resource-track="cpu"]')).toBeVisible();
    await expect(page.locator('[data-resource-track="pages"]')).toHaveCount(0);
  });

  test('draws one metric under each worker row, each test’s value across its bar', async ({ page }) => {
    await page.goto(`/test-runs/${runId}?tab=workers`);
    await waitForHydration(page);
    await expect(page.locator('[data-resource-track]').first()).toBeVisible();
    await expect(page.getByTestId('timeline-worker-strip')).toHaveCount(0);

    await page.getByTestId('timeline-resources-menu').click();
    await page.getByRole('menuitemcheckbox', { name: 'CPU', exact: true }).last().click();
    await page.keyboard.press('Escape');
    const strips = page.getByTestId('timeline-worker-strip');
    await expect(strips).toHaveCount(2);
    await expect(page.locator('[data-worker-strips="cpu"]')).toContainText('1.5 cores');

    // A quarter into the first worker's strip: its first test, 3 s of CPU over 2 s.
    const box = (await strips.first().boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
    const tooltip = page.getByTestId('timeline-worker-strip-tooltip');
    await expect(tooltip).toContainText('Worker 1');
    await expect(tooltip).toContainText('1.5 cores for “adds an item”');

    // The second worker's strip draws the sampler's readings of its processes.
    const sampled = (await strips.nth(1).boundingBox())!;
    await page.mouse.move(sampled.x + sampled.width * 0.25, sampled.y + sampled.height / 2);
    await expect(tooltip).toContainText('Worker 2');
    await expect(tooltip).toContainText('cores, the worker and its browsers');

    await page.mouse.move(0, 0);
    await page.getByTestId('timeline-resources-menu').click();
    await page.getByRole('menuitemcheckbox', { name: 'Waiting for a CPU', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-worker-strips="wait"]')).toContainText('75% wait');

    await page.getByTestId('timeline-resources-menu').click();
    await page.getByRole('menuitemcheckbox', { name: 'Nothing', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(strips).toHaveCount(0);
  });
});

test.describe('Run timeline leaks', () => {
  let runId = 0;
  const t0 = Date.now() - 60_000;

  test.beforeAll(async ({ request }) => {
    const testCase = (title: string, workerIndex: number, start: number) => ({
      title,
      status: 'passed',
      duration: 2000,
      location: `tests/cart.spec.ts:${10 + start}:5`,
      workerIndex,
      startedAt: t0 + start * 1000,
    });
    const response = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.RUN_TIMELINE_RESOURCES,
        status: 'passed',
        startTime: new Date(t0).toISOString(),
        duration: 5000,
        totalTests: 3,
        passedTests: 3,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          testCase('adds an item', 0, 0),
          testCase('removes an item', 0, 3),
          testCase('previews the receipt', 1, 0),
        ],
        resourceReport: {
          v: 1,
          findings: [],
          counts: { leaked: 1, lingering: 1, idle: 0, piling: 0, handle: 0, probable: 0 },
          profile: null,
          workers: [],
          artifactBytes: {},
          workerHealth: null,
          timeline: {
            startedAt: t0,
            cpuPct: [],
            memoryBytes: [],
            pages: [
              {
                worker: 0,
                points: [
                  [100, 1],
                  [3100, 2],
                  [5000, 0],
                ],
              },
            ],
            spans: [
              // The first test's context, left open until worker 0 ended.
              {
                worker: 0,
                verdict: 'leaked',
                kind: 'context',
                where: 'tests/cart.spec.ts:12',
                site: 'tests/cart.spec.ts:12',
                lastUse: 'tests/cart.spec.ts:14',
                from: 2000,
                to: 5000,
                untilWorkerEnd: true,
                scope: 'test',
                pages: 1,
                test: { title: 'adds an item', file: 'tests/cart.spec.ts' },
              },
              // A popup worker 1's test last used a second in and closed as it ended.
              {
                worker: 1,
                verdict: 'lingering',
                kind: 'page',
                where: 'popup after locator.click at tests/cart.spec.ts:30',
                site: 'tests/cart.spec.ts:30',
                lastUse: 'tests/cart.spec.ts:31',
                from: 800,
                to: 1950,
                pages: 1,
                test: { title: 'previews the receipt', file: 'tests/cart.spec.ts' },
              },
            ],
          },
        },
      },
      timeout: 20000,
    });
    expect(response.ok()).toBeTruthy();
    runId = ((await response.json()) as { runId: number }).runId;
  });

  test('draws what each worker kept open for nothing under its row, explains it on hover, and opens its test', async ({
    page,
  }) => {
    await page.goto(`/test-runs/${runId}?tab=workers`);
    await waitForHydration(page);
    await expect(page.getByTestId('timeline-left-open')).toHaveText('1 left open');
    await expect(page.getByTestId('timeline-lingering')).toHaveText('1 lingering');
    await expect(page.getByTestId('timeline-span-tails')).toHaveCount(2);

    // The open pages track draws the page left open; its readout says so.
    await expect(page.locator('[data-resource-left-open]')).toHaveCount(1);
    const band = page.getByTestId('timeline-resource-band');
    const bandBox = (await band.boundingBox())!;
    await page.mouse.move(bandBox.x + bandBox.width * 0.85, bandBox.y + bandBox.height / 2);
    await expect(page.getByTestId('timeline-resource-tooltip')).toContainText('1 left open by earlier tests');

    const leaked = page.locator('[data-span-tails-verdict="leaked"]');
    const box = (await leaked.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const tooltip = page.getByTestId('timeline-span-tooltip');
    await expect(tooltip).toContainText('Leaked context');
    await expect(tooltip).toContainText('tests/cart.spec.ts:12');
    await expect(tooltip).toContainText('“adds an item”');
    await expect(tooltip).toContainText('3.0 s past its test, until the worker shut down');
    await expect(tooltip).toContainText('tests/cart.spec.ts:14');

    const lingering = page.locator('[data-span-tails-verdict="lingering"]');
    const lingeringBox = (await lingering.boundingBox())!;
    await page.mouse.move(lingeringBox.x + lingeringBox.width / 2, lingeringBox.y + lingeringBox.height / 2);
    await expect(tooltip).toContainText('Lingering page');
    await expect(tooltip).toContainText('1.1 s after its last use');

    // A click opens the test the leak outlived.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page).toHaveURL(/tab=test-cases/);
  });

  test('turns the tails off, and back on', async ({ page }) => {
    await page.goto(`/test-runs/${runId}?tab=workers`);
    await waitForHydration(page);
    await expect(page.getByTestId('timeline-span-tails')).toHaveCount(2);
    await page.getByRole('switch', { name: 'Show leaks' }).click();
    await expect(page.getByTestId('timeline-span-tails')).toHaveCount(0);
    await expect(page.locator('[data-resource-left-open]')).toHaveCount(0);
    await page.getByRole('switch', { name: 'Show leaks' }).click();
    await expect(page.getByTestId('timeline-span-tails')).toHaveCount(2);
  });
});
