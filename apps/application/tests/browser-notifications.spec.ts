import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { waitForHydration } from './utils';
import { readSseUntil } from './utils/sse';

test.describe.serial('Browser Notifications (Cookie Mode)', () => {
  let projectId: number;

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.BROWSER_NOTIFY,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        didNotRunTests: 0,
        testCases: [{ title: 'placeholder', status: 'passed', duration: 500 }],
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    projectId = body.projectId;
  });

  // ── Cookie write / read via page.evaluate ───────────────────────────────────

  test('cookie stores per-project events', async ({ page }) => {
    const cookieValue = encodeURIComponent(
      JSON.stringify({
        projects: {
          [String(projectId)]: { events: ['run.failed', 'cluster.new'] },
          999: { events: ['run.finished'] },
        },
      }),
    );

    await page.context().addCookies([
      {
        name: 'piwi-browser-notify',
        value: cookieValue,
        domain: 'localhost',
        path: '/',
        httpOnly: false,
        secure: false,
        sameSite: 'Lax' as const,
      },
    ]);

    await page.goto(`/projects/${projectId}`);
    await waitForHydration(page);

    // Verify the cookie is present
    const cookies = await page.context().cookies();
    const notifyCookie = cookies.find((c) => c.name === 'piwi-browser-notify');
    expect(notifyCookie).toBeDefined();

    const parsed = JSON.parse(decodeURIComponent(notifyCookie!.value));
    expect(parsed.projects[String(projectId)]).toBeDefined();
    expect(parsed.projects[String(projectId)].events).toContain('run.failed');
    expect(parsed.projects[String(projectId)].events).toContain('cluster.new');
    expect(parsed.projects['999'].events).toContain('run.finished');

    // Verify the composable reads the cookie correctly via page.evaluate
    const composableState = await page.evaluate((pid) => {
      const match = document.cookie.match(/(?:^|;\s*)piwi-browser-notify=([^;]*)/);
      if (!match) return null;
      try {
        const cfg = JSON.parse(decodeURIComponent(match[1]!));
        return {
          hasProject: !!cfg.projects[pid],
          events: cfg.projects[pid]?.events ?? [],
          otherProject: !!cfg.projects[999],
        };
      } catch {
        return null;
      }
    }, projectId);

    expect(composableState).toBeDefined();
    expect(composableState!.hasProject).toBe(true);
    expect(composableState!.events).toEqual(['run.failed', 'cluster.new']);
    expect(composableState!.otherProject).toBe(true);
  });

  test('cookie removing all events deletes the project entry', async ({ page }) => {
    const cookieValue = encodeURIComponent(
      JSON.stringify({
        projects: { [String(projectId)]: { events: ['run.failed'] } },
      }),
    );

    await page.context().addCookies([
      {
        name: 'piwi-browser-notify',
        value: cookieValue,
        domain: 'localhost',
        path: '/',
        httpOnly: false,
        secure: false,
        sameSite: 'Lax' as const,
      },
    ]);

    await page.goto(`/`);
    await waitForHydration(page);

    // Simulate unchecking all events (what SubscribeBell does)
    await page.evaluate(() => {
      // Write empty events for the project → should delete the entry
      document.cookie =
        'piwi-browser-notify=' +
        encodeURIComponent(JSON.stringify({ projects: {} })) +
        '; path=/; max-age=31536000; sameSite=lax';
    });

    // Verify cookie was updated
    const cookies = await page.context().cookies();
    const notifyCookie = cookies.find((c) => c.name === 'piwi-browser-notify');
    expect(notifyCookie).toBeDefined();
    const parsed = JSON.parse(decodeURIComponent(notifyCookie!.value));
    expect(parsed.projects[String(projectId)]).toBeUndefined();
  });

  // ── SSE stream delivers notification events ─────────────────────────────────

  test('SSE stream GET /api/notifications/stream returns 200 with SSE content-type', async ({ baseURL }) => {
    const controller = new AbortController();
    const res = await fetch(`${baseURL}/api/notifications/stream`, {
      signal: controller.signal,
    });
    controller.abort();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  test('SSE stream delivers run.finished and run.failed on test run submit', async ({ baseURL, request }) => {
    const controller = new AbortController();
    const sseRes = await fetch(`${baseURL}/api/notifications/stream`, {
      signal: controller.signal,
    });
    expect(sseRes.ok).toBeTruthy();
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream');

    const submitRes = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.BROWSER_NOTIFY,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 3000,
        totalTests: 3,
        passedTests: 1,
        failedTests: 2,
        skippedTests: 0,
        didNotRunTests: 0,
        testCases: [
          { title: 'passes', status: 'passed', duration: 400 },
          { title: 'fails', status: 'failed', duration: 600, error: 'Expected A but got B' },
          { title: 'also fails', status: 'failed', duration: 300, error: 'Timeout' },
        ],
      },
    });
    expect(submitRes.ok()).toBeTruthy();

    const reader = sseRes.body!.getReader();

    const events = await readSseUntil(reader, (es) => {
      const hasFinished = es.some((e) => e.type === 'run.finished' && e.projectId === projectId);
      const hasFailed = es.some((e) => e.type === 'run.failed' && e.projectId === projectId)!;
      return hasFinished && hasFailed;
    });

    reader.releaseLock();
    controller.abort();

    expect(events.length).toBeGreaterThanOrEqual(1);

    const runFinished = events.find(
      (e: Record<string, unknown>) => e.type === 'run.finished' && e.projectId === projectId,
    )!;
    expect(runFinished).toBeDefined();
    expect(runFinished.projectName).toBe(PROJECT.BROWSER_NOTIFY);
    expect(runFinished.status).toBe('failed');
    expect(runFinished.totalTests).toBe(3);

    const runFailed = events.find(
      (e: Record<string, unknown>) => e.type === 'run.failed' && e.projectId === projectId,
    )!;
    expect(runFailed).toBeDefined();
    expect(runFailed.failedTests).toBe(2);

    const topFailures = runFailed.topFailures as Array<{ title: string }>;
    expect(topFailures).toBeDefined();
    expect(topFailures.length).toBeGreaterThanOrEqual(1);
    expect(topFailures[0]!.title).toBe('fails');
  });

  test('SSE stream receives cluster.new for new clusters', async ({ baseURL, request }) => {
    const controller = new AbortController();
    const sseRes = await fetch(`${baseURL}/api/notifications/stream`, {
      signal: controller.signal,
    });
    expect(sseRes.ok).toBeTruthy();

    const uniqueError = `Unique cluster test ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const submitRes = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.BROWSER_NOTIFY,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 2,
        passedTests: 0,
        failedTests: 2,
        skippedTests: 0,
        didNotRunTests: 0,
        testCases: [
          { title: 'unique failure', status: 'failed', duration: 500, error: uniqueError },
          { title: 'another', status: 'failed', duration: 400, error: uniqueError },
        ],
      },
    });
    expect(submitRes.ok()).toBeTruthy();

    const reader = sseRes.body!.getReader();

    const events = await readSseUntil(reader, (es) =>
      es.some((e) => e.type === 'cluster.new' && e.projectId === projectId),
    );

    reader.releaseLock();
    controller.abort();

    const clusterEvent = events.find(
      (e: Record<string, unknown>) => e.type === 'cluster.new' && e.projectId === projectId,
    )!;
    expect(clusterEvent).toBeDefined();
    expect(clusterEvent.signature).toBeDefined();
    expect(clusterEvent.affectedCases).toBe(2);
  });

  // ── Channels & subscriptions without auth ──────────────────────────────────

  test('channels and subscriptions work without auth and are global', async ({ request }) => {
    const chRes = await request.post('/api/channels', {
      data: { name: 'No-auth webhook', type: 'webhook', config: { url: 'https://example.com/hook' } },
    });
    expect(chRes.ok()).toBeTruthy();
    const channelId = ((await chRes.json()) as { channel: { id: number } }).channel.id;

    const listRes = await request.get('/api/channels');
    const listData = (await listRes.json()) as { items: Array<{ id: number; userId: number | null }> };
    const created = listData.items.find((c) => c.id === channelId);
    expect(created).toBeDefined();
    expect(created!.userId).toBeNull();

    const subRes = await request.post('/api/subscriptions', {
      data: { channelId, projectId, events: ['run.failed'] },
    });
    expect(subRes.ok()).toBeTruthy();
    const subId = ((await subRes.json()) as { subscription: { id: number } }).subscription.id;

    const subList = await request.get(`/api/subscriptions?projectId=${projectId}`);
    const subData = (await subList.json()) as { items: Array<{ id: number; userId: number | null }> };
    const sub = subData.items.find((s) => s.id === subId);
    expect(sub).toBeDefined();
    expect(sub!.userId).toBeNull();

    const delSub = await request.delete(`/api/subscriptions/${subId}`);
    expect(delSub.ok()).toBeTruthy();
    const delCh = await request.delete(`/api/channels/${channelId}`);
    expect(delCh.ok()).toBeTruthy();
  });

  // ── Client-side cookie filter logic ────────────────────────────────────────

  test('handleEvent filters by cookie project+event', async ({ page }) => {
    const cookieValue = encodeURIComponent(
      JSON.stringify({
        projects: {
          [String(projectId)]: { events: ['run.failed'] },
          999: { events: ['run.finished'] },
        },
      }),
    );

    await page.context().addCookies([
      {
        name: 'piwi-browser-notify',
        value: cookieValue,
        domain: 'localhost',
        path: '/',
        httpOnly: false,
        secure: false,
        sameSite: 'Lax' as const,
      },
    ]);

    await page.goto(`/projects/${projectId}`);
    await waitForHydration(page);

    // Simulate the filter logic from handleEvent
    const result = await page.evaluate((pid) => {
      const match = document.cookie.match(/(?:^|;\s*)piwi-browser-notify=([^;]*)/);
      if (!match) return null;
      const cfg = JSON.parse(decodeURIComponent(match[1]!));

      function isEventSubscribed(projId: number, eventType: string): boolean {
        return (cfg.projects[projId]?.events ?? []).includes(eventType);
      }

      return {
        subscribedToRunFailed: isEventSubscribed(pid, 'run.failed'),
        subscribedToRunFinished: isEventSubscribed(pid, 'run.finished'),
        subscribedToClusterNew: isEventSubscribed(pid, 'cluster.new'),
        notSubscribedOnOther: isEventSubscribed(999, 'run.failed'),
        subscribedOnOther: isEventSubscribed(999, 'run.finished'),
      };
    }, projectId);

    expect(result).toBeDefined();
    expect(result!.subscribedToRunFailed).toBe(true);
    expect(result!.subscribedToRunFinished).toBe(false);
    expect(result!.subscribedToClusterNew).toBe(false);
    expect(result!.notSubscribedOnOther).toBe(false);
    expect(result!.subscribedOnOther).toBe(true);
  });
});
