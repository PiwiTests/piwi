import * as http from 'node:http';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { resolveE2ETarget, targetAuthHeaders } from './desktop-target';
import { waitForHydration } from './utils';
import { holdWorkerStream } from './utils/live-view';

/**
 * A run page opened while its run initializes (the reporter's global setup registered it, no test has begun) goes
 * live as the run starts, without a reload: its running test shows the step its worker is on and, in a project with
 * the live view on, Watch. It goes live on the run's start event, and on a start sent before the page listened, which
 * it reads as the instance's stream opens; the stream opens as soon as the server has subscribed it.
 */

const target = resolveE2ETarget();

/** The instance's run events (`/api/stream`), as they arrive. */
function openInstanceStream(): { text: () => string; close: () => void } {
  let text = '';
  const request = http.request(`${target.baseUrl}/api/stream`, {
    headers: { Accept: 'text/event-stream', ...targetAuthHeaders(target) },
  });
  request.on('response', (response) => response.on('data', (chunk) => (text += String(chunk))));
  request.on('error', () => {});
  request.end();
  return { text: () => text, close: () => request.destroy() };
}

/** A CI run's setup, as the reporter's global setup asks for it: the run initializes. */
async function setUpRun(request: APIRequestContext, liveView = false) {
  const setup = await request.post('/api/test-runs/setup', {
    data: { projectName: PROJECT.RUN_GOES_LIVE, startTime: new Date().toISOString(), liveView },
  });
  expect(setup.ok()).toBeTruthy();
  return (await setup.json()) as { runId: number; setupToken: string; liveView?: { key: string } };
}

/** The run's tests begin. Returns the run's stream token. */
async function beginRun(request: APIRequestContext, runId: number, setupToken: string): Promise<string> {
  const begun = await request.post(`/api/test-runs/${runId}/begin`, { data: { setupToken, totalTests: 1 } });
  expect(begun.ok()).toBeTruthy();
  return ((await begun.json()) as { streamToken: string }).streamToken;
}

/** Worker 0 runs the run's test. */
async function beginTest(request: APIRequestContext, runId: number, streamToken: string) {
  const events = await request.post(`/api/test-runs/${runId}/events`, {
    data: {
      streamToken,
      testCases: [
        {
          type: 'begin',
          title: 'pays on a slow page',
          location: 'tests/checkout.spec.ts:3:1',
          workerIndex: 0,
          startedAt: Date.now(),
        },
      ],
    },
  });
  expect(events.ok()).toBeTruthy();
}

/** End the run, beginning it first when it never began, so it is not left for the stale-run sweep. */
async function endRun(request: APIRequestContext, runId: number, setupToken: string, streamToken: string | null) {
  let token = streamToken;
  if (!token) {
    const begun = await request.post(`/api/test-runs/${runId}/begin`, { data: { setupToken, totalTests: 0 } });
    token = ((await begun.json()) as { streamToken?: string }).streamToken ?? null;
  }
  if (token) {
    await request.post(`/api/test-runs/${runId}/finish`, {
      data: { streamToken: token, status: 'passed', totalTests: 0 },
    });
  }
}

/** Open the run's page and see it initializing; the page notes it was loaded, so a reload shows. */
async function openInitializingRun(page: Page, runId: number) {
  await page.goto(`/test-runs/${runId}`);
  await waitForHydration(page);
  const header = page.locator('[data-shot="run-header"]');
  await expect(header).toContainText(/initializing/i);
  // The Tests tab says the run is in its global setup, not that it recorded no test.
  await expect(page.getByTestId('before-first-test')).toContainText(/^Global setup · /);
  await page.evaluate(() => ((window as unknown as { sameDocument: boolean }).sameDocument = true));
  return header;
}

async function sameDocument(page: Page): Promise<boolean | undefined> {
  return page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument);
}

test('the instance’s stream opens once subscribed, and hears every run event after', async ({ request }) => {
  const stream = openInstanceStream();
  let run: { runId: number; setupToken: string } | null = null;
  try {
    // The comment comes at once, not with the first heartbeat.
    await expect.poll(stream.text, { timeout: 5_000 }).toMatch(/^: subscribed\n\n/);
    run = await setUpRun(request);
    await expect.poll(stream.text).toContain(`"type":"run-initializing","runId":${run.runId}`);
  } finally {
    stream.close();
    if (run) await endRun(request, run.runId, run.setupToken, null);
  }
});

test.describe('Run page of an initializing run', () => {
  test.skip(target.desktop, 'the desktop app mints no live view key, and a test worker holds no desktop token');

  test('goes live as the run starts, with its worker’s step and Watch, without a reload', async ({ page, request }) => {
    test.setTimeout(60_000);
    // The project, with the live view on.
    const submitted = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.RUN_GOES_LIVE,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1,
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        testCases: [],
      },
    });
    expect(submitted.ok()).toBeTruthy();
    const first = (await submitted.json()) as { runId: number };
    const { projectId } = (await (await request.get(`/api/test-runs/${first.runId}`)).json()) as { projectId: number };
    expect((await request.patch(`/api/projects/${projectId}`, { data: { liveView: true } })).ok()).toBeTruthy();

    const { runId, setupToken, liveView } = await setUpRun(request, true);
    let streamToken: string | null = null;
    let worker: { close: () => void } | null = null;
    try {
      const stream = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/stream');
      const header = await openInitializingRun(page, runId);
      // The page hears the run's events from here.
      await stream;

      streamToken = await beginRun(request, runId, setupToken);
      await beginTest(request, runId, streamToken);
      worker = holdWorkerStream(target.baseUrl, runId, liveView!.key);
      await expect(header).toContainText(/running/i, { timeout: 15_000 });
      await expect(page.getByText('In progress…')).toBeVisible({ timeout: 15_000 });

      // The page streams the run now: the step the worker takes shows on its test's row.
      const step = await request.post(`/api/test-runs/${runId}/events`, {
        data: {
          streamToken,
          testCases: [
            {
              type: 'step-begin',
              title: 'Click',
              subtitle: "getByRole('button', { name: 'Pay' })",
              parentTitle: 'pays on a slow page',
              stepCategory: 'pw:api',
              location: 'tests/checkout.spec.ts:5:3',
              workerIndex: 0,
              startedAt: Date.now(),
            },
          ],
        },
      });
      expect(step.ok()).toBeTruthy();
      await expect(page.getByTestId('live-step')).toContainText('Click');
      // Whoever opens the run after sees the step the worker is in, though it began before they listened.
      const later = await page.context().newPage();
      await later.goto(`/test-runs/${runId}`);
      await waitForHydration(later);
      await expect(later.getByTestId('live-step')).toContainText('Click');
      await later.close();
      await expect(page.getByRole('button', { name: 'Watch worker 0 live' })).toBeVisible({ timeout: 15_000 });

      expect(await sameDocument(page)).toBe(true);
    } finally {
      worker?.close();
      await endRun(request, runId, setupToken, streamToken);
    }
  });

  test('goes live when the run started before the page listened', async ({ page, request }) => {
    test.setTimeout(60_000);
    const { runId, setupToken } = await setUpRun(request);
    let streamToken: string | null = null;
    // The page's request for the instance's stream waits until the run has begun: its start event reaches no one.
    let held!: () => void;
    const requested = new Promise<void>((resolve) => (held = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.pathname === '/api/stream',
      async (route) => {
        held();
        await released;
        await route.continue();
      },
    );
    try {
      const header = await openInitializingRun(page, runId);
      await requested;
      streamToken = await beginRun(request, runId, setupToken);
      await beginTest(request, runId, streamToken);
      release();

      await expect(header).toContainText(/running/i, { timeout: 15_000 });
      await expect(page.getByText('In progress…')).toBeVisible({ timeout: 15_000 });
      expect(await sameDocument(page)).toBe(true);
    } finally {
      release();
      await endRun(request, runId, setupToken, streamToken);
    }
  });
});

test('shows each shard’s step on its own row, though both shards run worker 0', async ({ page, request }) => {
  test.setTimeout(60_000);
  const start = async (shardIndex: number) => {
    const started = await request.post('/api/test-runs/start', {
      data: {
        projectName: PROJECT.RUN_GOES_LIVE,
        startTime: new Date().toISOString(),
        instanceId: 'run-goes-live-two-shards',
        shardIndex,
        shardTotal: 2,
        totalTests: 1,
      },
    });
    expect(started.ok()).toBeTruthy();
    return (await started.json()) as { runId: number; streamToken: string };
  };
  const shards = [await start(1), await start(2)];
  const runId = shards[0]!.runId;
  expect(shards[1]!.runId).toBe(runId);
  /** Worker 0 of the shard sends an event. */
  const send = async (shard: number, event: Record<string, unknown>) => {
    const sent = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken: shards[shard - 1]!.streamToken,
        testCases: [{ workerIndex: 0, shardIndex: shard, startedAt: Date.now(), ...event }],
      },
    });
    expect(sent.ok()).toBeTruthy();
  };
  try {
    await send(1, { type: 'begin', title: 'pays by card', location: 'tests/checkout.spec.ts:3:1' });
    await send(2, { type: 'begin', title: 'searches', location: 'tests/search.spec.ts:3:1' });
    const stream = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/${runId}/stream`));
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await stream;
    const step = { stepCategory: 'pw:api', location: 'tests/x.spec.ts:5:3' };
    await send(1, { ...step, type: 'step-begin', title: 'Click', parentTitle: 'pays by card' });
    await send(2, { ...step, type: 'step-begin', title: 'Fill', parentTitle: 'searches' });

    // The page that heard the steps, and one that opens after them, show each on its own shard's row.
    const later = await page.context().newPage();
    await later.goto(`/test-runs/${runId}`);
    await waitForHydration(later);
    for (const viewer of [page, later]) {
      await expect
        .poll(async () => (await viewer.getByTestId('live-step').allInnerTexts()).map((text) => text.trim()).sort())
        .toEqual(['Click', 'Fill']);
    }
    await later.close();
  } finally {
    for (const [index, shard] of shards.entries()) {
      await request.post(`/api/test-runs/${runId}/finish`, {
        data: { streamToken: shard.streamToken, status: 'passed', totalTests: 1, shardIndex: index + 1, shardTotal: 2 },
      });
    }
  }
});

test('a retry reads as one while it runs, the list stays put, and its tags are searchable', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const started = await request.post('/api/test-runs/start', {
    data: {
      projectName: PROJECT.RUN_GOES_LIVE,
      startTime: new Date().toISOString(),
      instanceId: 'run-goes-live-retry',
      totalTests: 2,
    },
  });
  expect(started.ok()).toBeTruthy();
  const { runId, streamToken } = (await started.json()) as { runId: number; streamToken: string };
  const send = async (event: Record<string, unknown>) => {
    const sent = await request.post(`/api/test-runs/${runId}/events`, {
      data: { streamToken, testCases: [{ location: 'tests/checkout.spec.ts:3:1', startedAt: Date.now(), ...event }] },
    });
    expect(sent.ok()).toBeTruthy();
  };
  const first = { title: 'pays by card', tags: ['smoke'], maxRetries: 2 };
  try {
    await send({ ...first, type: 'begin', retries: 0, workerIndex: 0 });
    await send({ type: 'begin', title: 'searches', location: 'tests/search.spec.ts:3:1', retries: 0, workerIndex: 1 });
    const stream = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/${runId}/stream`));
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await stream;

    // The first attempt fails: the list opened green stays flat in run order.
    await send({
      type: 'complete',
      title: 'searches',
      location: 'tests/search.spec.ts:3:1',
      status: 'failed',
      duration: 40,
      error: 'Error: no results',
      retries: 0,
      workerIndex: 1,
    });
    await expect(page.locator(':is(a, span)[title="searches"]:visible')).toHaveCount(1);
    await expect(page.locator('[data-tour="run-tests-group-by"]')).toContainText('None');
    // One batch of the reporter carries a test's failed attempt and its retry's begin: one row, the retry's.
    const batch = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken,
        testCases: [
          {
            ...first,
            type: 'complete',
            location: 'tests/checkout.spec.ts:3:1',
            status: 'failed',
            duration: 50,
            error: 'Error: boom',
            retries: 0,
            workerIndex: 0,
            startedAt: Date.now() - 100,
          },
          {
            ...first,
            type: 'begin',
            location: 'tests/checkout.spec.ts:3:1',
            retries: 1,
            workerIndex: 2,
            startedAt: Date.now(),
          },
        ],
      },
    });
    expect(batch.ok()).toBeTruthy();
    await expect(page.locator('[data-testid="live-retry"]:visible')).toHaveText(['Retry 1 of 2']);
    await expect(page.locator(':is(a, span)[title="pays by card"]:visible')).toHaveCount(1);

    // A row that streamed in answers the search's qualifiers.
    await page.getByRole('combobox', { name: 'Search tests' }).fill('tag:smoke');
    await expect(page.getByRole('option', { name: 'tag:smoke 1' })).toBeVisible();
    await expect(page.locator('[data-testid="live-retry"]:visible')).toHaveText(['Retry 1 of 2']);
    await expect(page.locator(':is(a, span)[title="searches"]:visible')).toHaveCount(0);
  } finally {
    await request.post(`/api/test-runs/${runId}/finish`, { data: { streamToken, status: 'failed', totalTests: 2 } });
  }
});

test('a streamed failure joins its cluster’s group at once, a new cluster’s group appearing', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const started = await request.post('/api/test-runs/start', {
    data: {
      projectName: PROJECT.RUN_GOES_LIVE,
      startTime: new Date().toISOString(),
      instanceId: 'run-goes-live-cluster',
      totalTests: 3,
    },
  });
  expect(started.ok()).toBeTruthy();
  const { runId, streamToken } = (await started.json()) as { runId: number; streamToken: string };
  const fail = async (title: string, error: string) => {
    const sent = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken,
        testCases: [
          { type: 'begin', title, location: `tests/${title}.spec.ts:3:1`, workerIndex: 0, startedAt: Date.now() },
          {
            type: 'complete',
            title,
            location: `tests/${title}.spec.ts:3:1`,
            status: 'failed',
            duration: 40,
            error,
            workerIndex: 0,
            startedAt: Date.now(),
          },
        ],
      },
    });
    expect(sent.ok()).toBeTruthy();
  };
  const timeout =
    'TimeoutError: locator.click: Timeout 5000ms exceeded waiting for getByRole("button", { name: "Pay" })';
  const strict = 'Error: strict mode violation: getByText("Total") resolved to 2 elements';
  try {
    // The run is red as the page opens, so its list is grouped by cluster for the page view.
    await fail('pays by card', timeout);
    const stream = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/${runId}/stream`));
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await stream;
    const groups = page.getByRole('link', { name: /Open cluster/ });
    await expect(groups).toHaveCount(1);

    // A failure of the same cause joins its group; one of a cause the page has not read opens a group of its own.
    await fail('pays by wallet', timeout);
    await fail('shows the total', strict);
    await expect(groups).toHaveCount(2);
    await expect(page.getByText('Ungrouped failures')).toHaveCount(0);
    const read = await request.get(`/api/test-runs/${runId}/failure-groups`);
    const { items } = (await read.json()) as {
      items: Array<{ clusterId: number; title: string | null; caseCount: number }>;
    };
    expect(items.map((group) => group.caseCount).sort()).toEqual([1, 2]);
    for (const group of items) {
      await expect(groups.and(page.locator(`[href="/failure-clusters/${group.clusterId}"]`))).toBeVisible();
      await expect(page.getByText(group.title || `Cluster #${group.clusterId}`, { exact: true }).first()).toBeVisible();
    }
    await expect(page.locator(':is(a, span)[title="shows the total"]:visible')).toHaveCount(1);
  } finally {
    await request.post(`/api/test-runs/${runId}/finish`, { data: { streamToken, status: 'failed', totalTests: 3 } });
  }
});
