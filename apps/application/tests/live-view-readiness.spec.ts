import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { holdWorkerStream } from './utils/live-view';
import { resolveE2ETarget } from './desktop-target';

test('explains each readiness gate and updates when the project changes', async ({ page, request }) => {
  test.skip(resolveE2ETarget().desktop, 'Dashboard live view is served by a team instance.');
  test.setTimeout(120_000);
  const started = await request.post('/api/test-runs/start', {
    data: { projectName: PROJECT.LIVE_VIEW_READINESS, startTime: new Date().toISOString() },
  });
  expect(started.ok()).toBeTruthy();
  const first = await started.json();
  const projectId = first.projectId;
  const setting = async (enabled: boolean) => {
    const response = await request.patch(`/api/projects/${projectId}`, { data: { liveView: enabled } });
    expect(response.ok()).toBeTruthy();
  };
  const readiness = page.getByTestId('live-view-readiness');
  const runs = [first];
  let closeWorker = () => {};
  try {
    await setting(false);
    await page.goto(`/test-runs/${first.runId}`);
    await expect(readiness).toHaveAttribute('data-state', 'disabled', { timeout: 30_000 });
    const help = page.getByRole('dialog', { name: 'Help: Live view prerequisites' });
    await expect(help).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Open live-view settings' })).toHaveCount(0);
    expect((await readiness.boundingBox())!.height).toBeLessThanOrEqual(32);
    await readiness.getByRole('button', { name: 'Help: Live view prerequisites' }).click();
    await expect(help.getByRole('link', { name: 'Open live-view settings' })).toHaveAttribute(
      'href',
      `/projects/${projectId}?tab=settings&section=live-view`,
    );
    // A Project admin turns it on from here: the run, started without it, gets none, and the status says so.
    await help.getByRole('button', { name: 'Turn the live view on for the next runs' }).click();
    await expect(readiness).toHaveAttribute('data-state', 'next-run');
    await expect(readiness).toContainText('Live view on from the next run');
    await page.keyboard.press('Escape');

    await page.reload();
    await expect(readiness).toHaveAttribute('data-state', 'unavailable', { timeout: 30_000 });
    await expect(help).toHaveCount(0);
    await readiness.getByRole('button', { name: 'Help: Live view prerequisites' }).click();
    await expect(help).toContainText('capture fixtures');
    await page.keyboard.press('Escape');

    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: 375, height: 844 });
    expect((await readiness.boundingBox())!.height).toBeLessThanOrEqual(32);
    await readiness.getByRole('button', { name: 'Help: Live view prerequisites' }).click();
    await expect(help).toBeVisible();
    expect((await help.boundingBox())!.width).toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.keyboard.press('Escape');
    await page.setViewportSize(viewport);

    const setupResponse = await request.post('/api/test-runs/setup', {
      data: { projectName: PROJECT.LIVE_VIEW_READINESS, startTime: new Date().toISOString(), liveView: true },
    });
    expect(setupResponse.ok()).toBeTruthy();
    const setup = await setupResponse.json();
    const beginResponse = await request.post(`/api/test-runs/${setup.runId}/begin`, {
      data: { setupToken: setup.setupToken, totalTests: 1, metadata: { ci: { provider: 'github' } } },
    });
    expect(beginResponse.ok()).toBeTruthy();
    const begun = await beginResponse.json();
    runs.push(begun);
    await page.goto(`/test-runs/${setup.runId}`);
    await expect(readiness).toHaveAttribute('data-state', 'waiting', { timeout: 30_000 });

    // A test starts and no worker opens the view, as when the specs do not import the capture fixtures.
    const began = await request.post(`/api/test-runs/${setup.runId}/events`, {
      data: {
        streamToken: begun.streamToken,
        testCases: [
          { type: 'begin', title: 'runs without the fixtures', location: 'tests/plain.spec.ts:3:1', workerIndex: 0 },
        ],
      },
    });
    expect(began.ok()).toBeTruthy();
    await expect(readiness).toHaveAttribute('data-state', 'no-workers', { timeout: 20_000 });
    await readiness.getByRole('button', { name: 'Help: No worker connected' }).click();
    await expect(page.getByRole('dialog', { name: 'Help: No worker connected' })).toContainText(
      "import { test, expect } from './fixtures'",
    );
    await page.keyboard.press('Escape');

    const worker = holdWorkerStream(resolveE2ETarget().baseUrl, setup.runId, setup.liveView.key);
    closeWorker = () => worker.close();
    await expect(readiness).toHaveAttribute('data-state', 'available');
    await page.reload();
    await expect(readiness).toHaveAttribute('data-state', 'available');
    worker.close();
    await expect(readiness).toHaveAttribute('data-state', 'waiting');

    await setting(false);
    await expect(readiness).toHaveAttribute('data-state', 'disabled');
    // Turned on again, the running run's key opens its view again.
    await setting(true);
    await expect(readiness).toHaveAttribute('data-state', 'waiting');
  } finally {
    closeWorker();
    for (const run of runs) {
      await request.post(`/api/test-runs/${run.runId}/finish`, {
        data: { streamToken: run.streamToken, status: 'passed', totalTests: 0 },
      });
    }
    await setting(false);
  }
});

test('opens the run stream again after an error answer closed it', async ({ page, request }) => {
  test.skip(resolveE2ETarget().desktop, 'Dashboard live view is served by a team instance.');
  test.setTimeout(60_000);
  const started = await request.post('/api/test-runs/start', {
    data: { projectName: PROJECT.LIVE_VIEW_STREAM, startTime: new Date().toISOString() },
  });
  expect(started.ok()).toBeTruthy();
  const run = await started.json();
  let refused = 0;
  // The first stream answers as a proxy does while the instance restarts: the browser does not reconnect by itself.
  await page.route(`**/api/test-runs/${run.runId}/stream`, async (route) => {
    if (refused++ === 0) await route.fulfill({ status: 502, body: 'Bad gateway' });
    else await route.continue();
  });
  try {
    await page.goto(`/test-runs/${run.runId}`);
    const readiness = page.getByTestId('live-view-readiness');
    await expect(readiness).toHaveAttribute('data-state', 'disabled', { timeout: 20_000 });
    expect(refused).toBeGreaterThanOrEqual(2);
  } finally {
    await request.post(`/api/test-runs/${run.runId}/finish`, {
      data: { streamToken: run.streamToken, status: 'passed', totalTests: 0 },
    });
  }
});

test('keeps the run it shows and opens its stream once the run reads again', async ({ page, request }) => {
  test.skip(resolveE2ETarget().desktop, 'Dashboard live view is served by a team instance.');
  test.setTimeout(60_000);
  const started = await request.post('/api/test-runs/start', {
    data: { projectName: PROJECT.LIVE_VIEW_STREAM, startTime: new Date().toISOString() },
  });
  expect(started.ok()).toBeTruthy();
  const run = await started.json();
  let streams = 0;
  let reads = 0;
  // The first stream and the page's first read of the run answer as a proxy does while the instance restarts.
  await page.route(`**/api/test-runs/${run.runId}/stream`, async (route) => {
    if (streams++ === 0) await route.fulfill({ status: 502, body: 'Bad gateway' });
    else await route.continue();
  });
  await page.route(`**/api/test-runs/${run.runId}`, async (route) => {
    if (reads++ === 0) await route.fulfill({ status: 502, body: 'Bad gateway' });
    else await route.continue();
  });
  try {
    await page.goto(`/test-runs/${run.runId}`);
    const readiness = page.getByTestId('live-view-readiness');
    await expect.poll(() => reads, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    await expect(readiness).toBeVisible();
    // The page reads the run again later, then opens the stream.
    await expect(readiness).toHaveAttribute('data-state', 'disabled', { timeout: 30_000 });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(streams).toBeGreaterThanOrEqual(2);
  } finally {
    await request.post(`/api/test-runs/${run.runId}/finish`, {
      data: { streamToken: run.streamToken, status: 'passed', totalTests: 0 },
    });
  }
});

test('stops following a run it can no longer read, and says why', async ({ page, request }) => {
  test.skip(resolveE2ETarget().desktop, 'Dashboard live view is served by a team instance.');
  test.setTimeout(90_000);
  const started = await request.post('/api/test-runs/start', {
    data: { projectName: PROJECT.LIVE_VIEW_STREAM, startTime: new Date().toISOString() },
  });
  expect(started.ok()).toBeTruthy();
  const run = await started.json();
  const cases = [
    { status: 404, state: 'gone', title: 'This run no longer exists', signIn: false },
    { status: 401, state: 'signed-out', title: 'Your session has ended', signIn: true },
    { status: 403, state: 'forbidden', title: 'Your access to this run was removed', signIn: true },
  ];
  try {
    for (const { status, state, title, signIn } of cases) {
      let reads = 0;
      // The stream answers with an error, and the run's read with the final status: deleted, signed out, no access.
      await page.route(`**/api/test-runs/${run.runId}/stream`, (route) =>
        route.fulfill({ status, body: JSON.stringify({ statusCode: status }) }),
      );
      await page.route(`**/api/test-runs/${run.runId}`, (route) => {
        reads++;
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ statusCode: status }) });
      });
      await page.goto(`/test-runs/${run.runId}`);
      const notice = page.getByTestId('run-read-ended');
      await expect(notice).toHaveAttribute('data-state', state, { timeout: 20_000 });
      await expect(notice).toContainText(title);
      await expect(notice.getByRole('link', { name: 'Sign in again' })).toHaveCount(signIn ? 1 : 0);
      await expect(page.getByTestId('live-view-readiness')).toHaveCount(0);
      // No more tries: the next would come after 4 s, then 8 s.
      const tried = reads;
      await page.waitForTimeout(6_000);
      expect(reads, state).toBe(tried);
      await page.unrouteAll();
    }
  } finally {
    await request.post(`/api/test-runs/${run.runId}/finish`, {
      data: { streamToken: run.streamToken, status: 'passed', totalTests: 0 },
    });
  }
});
