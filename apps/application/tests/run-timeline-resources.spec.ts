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
