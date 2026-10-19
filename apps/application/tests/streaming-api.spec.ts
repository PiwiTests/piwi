import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';

/**
 * Tests for the live-streaming lifecycle:
 *   POST /api/test-runs/start       – create a run in 'running' state
 *   POST /api/test-runs/:id/events  – push test-case results (batch)
 *   POST /api/test-runs/:id/heartbeat – keep the run alive; says, like /events, whether it is watched
 *   POST /api/test-runs/:id/finish  – finalize the run
 *   GET  /api/test-runs/:id/stream  – SSE endpoint (init event check)
 *   GET  /api/test-runs/:id         – streamToken must NOT appear in response
 */
test.describe.serial('Streaming API Tests', () => {
  let runId: number;
  let streamToken: string;

  // ── /start ──────────────────────────────────────────────────────────────────

  test('POST /api/test-runs/start creates a run with running status', async ({ request }) => {
    const response = await request.post('/api/test-runs/start', {
      data: {
        projectName: PROJECT.STREAMING_TEST,
        startTime: new Date().toISOString(),
        // The reporter reports the planned suite size up front; the two streamed
        // tests below make up this run's total.
        totalTests: 2,
      },
    });

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(typeof data.runId).toBe('number');
    expect(typeof data.streamToken).toBe('string');
    expect(data.streamToken.length).toBeGreaterThan(0);

    runId = data.runId;
    streamToken = data.streamToken;
  });

  test('GET /api/test-runs/:id returns running status and no streamToken', async ({ request }) => {
    const response = await request.get(`/api/test-runs/${runId}`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();

    expect(data.status).toBe('running');
    // streamToken must never be exposed to clients
    expect(data.streamToken).toBeUndefined();
  });

  // ── /events ─────────────────────────────────────────────────────────────────

  test('POST /api/test-runs/:id/events accepts a batch of test cases', async ({ request }) => {
    const response = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken,
        testCases: [
          {
            type: 'complete',
            title: 'streaming test 1',
            status: 'passed',
            duration: 1200,
            location: 'tests/streaming.spec.ts:5:3',
            retries: 0,
          },
          {
            type: 'complete',
            title: 'streaming test 2',
            status: 'failed',
            duration: 800,
            location: 'tests/streaming.spec.ts:12:3',
            error: 'Expected true but got false',
            retries: 1,
            attempts: [
              { retry: 0, status: 'failed', duration: 500, startedAt: 1700000000000 },
              { retry: 1, status: 'failed', duration: 800, startedAt: 1700000001000 },
            ],
          },
        ],
      },
    });

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.processed).toBe(2);
  });

  test('POST /api/test-runs/:id/events updates run counters atomically', async ({ request }) => {
    const runResponse = await request.get(`/api/test-runs/${runId}`);
    expect(runResponse.ok()).toBeTruthy();
    const run = await runResponse.json();

    expect(run.totalTests).toBe(2);
    expect(run.passedTests).toBe(1);
    expect(run.failedTests).toBe(1);
  });

  test('POST /api/test-runs/:id/events persists per-attempt outcomes', async ({ request }) => {
    const runResponse = await request.get(`/api/test-runs/${runId}`);
    expect(runResponse.ok()).toBeTruthy();
    const run = await runResponse.json();

    const failing = run.testCases.find((tc: { title: string }) => tc.title === 'streaming test 2');
    expect(failing).toBeDefined();
    expect(failing.attempts).toEqual([
      { retry: 0, status: 'failed', duration: 500, startedAt: 1700000000000 },
      { retry: 1, status: 'failed', duration: 800, startedAt: 1700000001000 },
    ]);
  });

  test('POST /api/test-runs/:id/events rejects a wrong stream token', async ({ request }) => {
    const response = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken: 'wrong-token',
        testCases: [{ title: 'sneaky test', status: 'passed', duration: 100, location: 'x.spec.ts:1:1' }],
      },
    });

    expect(response.status()).toBe(403);
  });

  test('POST /api/test-runs/:id/events rejects a missing stream token', async ({ request }) => {
    const response = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        testCases: [{ title: 'sneaky test', status: 'passed', duration: 100, location: 'x.spec.ts:1:1' }],
      },
    });

    expect(response.status()).toBe(401);
  });

  test('POST /api/test-runs/:id/events handles Windows-style paths correctly', async ({ request }) => {
    const response = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken,
        testCases: [
          {
            type: 'complete',
            title: 'windows path test',
            status: 'passed',
            duration: 500,
            // Simulate a Windows-style path; the `:` in `C:` must not be confused with line/column
            location: 'C:\\repo\\tests\\windows.spec.ts:20:5',
            retries: 0,
          },
        ],
      },
    });

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.processed).toBe(1);
  });

  // ── /stream (SSE) ───────────────────────────────────────────────────────────

  test('streamed test-completed events carry the persisted execution id', async ({ request, baseURL }) => {
    // Subscribe before posting so the in-memory bus has a live listener.
    const controller = new AbortController();
    const response = await fetch(`${baseURL}/api/test-runs/${runId}/stream`, {
      signal: controller.signal,
    });
    expect(response.ok).toBeTruthy();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let streamed: { executionId: number | null; testCaseId: number | null } | null = null;

    try {
      const postRes = await request.post(`/api/test-runs/${runId}/events`, {
        data: {
          streamToken,
          testCases: [
            {
              type: 'complete',
              title: 'streamed deep-link test',
              status: 'failed',
              duration: 300,
              location: 'tests/streaming.spec.ts:30:3',
              error: 'Expected true but got false',
              retries: 0,
            },
          ],
        },
      });
      expect(postRes.ok()).toBeTruthy();

      while (streamed === null) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        for (const chunk of text.split('\n\n')) {
          const line = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let parsed: { type?: string; data?: Record<string, unknown> };
          try {
            parsed = JSON.parse(line.slice('data:'.length).trim());
          } catch {
            continue;
          }
          if (parsed.type === 'test-completed' && parsed.data?.title === 'streamed deep-link test') {
            streamed = {
              executionId: typeof parsed.data.executionId === 'number' ? parsed.data.executionId : null,
              testCaseId: typeof parsed.data.testCaseId === 'number' ? parsed.data.testCaseId : null,
            };
          }
        }
        // Hard cap so a regression cannot hang the suite
        if (text.length > 65536) break;
      }
    } finally {
      reader.releaseLock();
      controller.abort();
    }

    expect(streamed).not.toBeNull();
    expect(streamed!.executionId).toBeGreaterThan(0);
    expect(streamed!.testCaseId).toBeGreaterThan(0);

    // The streamed id is the same execution the run's REST payload reports.
    const runResponse = await request.get(`/api/test-runs/${runId}`);
    expect(runResponse.ok()).toBeTruthy();
    const run = await runResponse.json();
    const matching = run.testCases.find((tc: { title: string }) => tc.title === 'streamed deep-link test');
    expect(matching.executionId).toBe(streamed!.executionId);
  });

  test('GET /api/test-runs/:id/stream sends an init event', async ({ baseURL }) => {
    // Use native fetch with AbortController so we can read just the init event
    // without waiting for the infinite SSE stream to close.
    const controller = new AbortController();
    const response = await fetch(`${baseURL}/api/test-runs/${runId}/stream`, {
      signal: controller.signal,
    });

    expect(response.ok).toBeTruthy();
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    // Read chunks until we have at least one complete data line
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        // Stop as soon as we have the init event
        if (text.includes('"type":"init"')) break;
      }
    } finally {
      reader.releaseLock();
      controller.abort();
    }

    // The stream should start with a data: line containing a JSON object
    expect(text).toContain('data:');
    const firstDataLine = text.split('\n').find((l: string) => l.startsWith('data:'));
    expect(firstDataLine).toBeDefined();

    const parsed = JSON.parse(firstDataLine!.slice('data:'.length).trim());
    expect(parsed.type).toBe('init');
    expect(parsed.data.id).toBe(runId);
    expect(parsed.data.status).toBe('running');
    expect(typeof parsed.data.totalTests).toBe('number');
  });

  test('GET /api/test-runs/:id/stream forwards step events for test-attached steps', async ({ request, baseURL }) => {
    // Subscribe first — the in-memory bus only delivers to live subscribers.
    const controller = new AbortController();
    const response = await fetch(`${baseURL}/api/test-runs/${runId}/stream`, {
      signal: controller.signal,
    });
    expect(response.ok).toBeTruthy();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let sawStepBegin = false;
    let sawStepEnd = false;
    let sawHookBegin = false;
    let sawHookEnd = false;

    const postStepEvents = async () => {
      const res = await request.post(`/api/test-runs/${runId}/events`, {
        data: {
          streamToken,
          testCases: [
            {
              type: 'step-begin',
              title: 'expect(locator).toBeVisible()',
              location: 'tests/streaming.spec.ts:8:5',
              stepCategory: 'expect',
              parentTitle: 'streaming test 1',
              workerIndex: 0,
              startedAt: 1700000000000,
            },
            {
              type: 'step-begin',
              title: 'beforeEach',
              location: 'tests/streaming.spec.ts:2:3',
              stepCategory: 'hook',
              parentTitle: null,
              workerIndex: 0,
              startedAt: 1700000000100,
            },
            {
              type: 'step-end',
              title: 'expect(locator).toBeVisible()',
              location: 'tests/streaming.spec.ts:8:5',
              stepCategory: 'expect',
              status: 'passed',
              duration: 40,
              parentTitle: 'streaming test 1',
              workerIndex: 0,
              startedAt: 1700000000000,
            },
            {
              type: 'step-end',
              title: 'beforeEach',
              location: 'tests/streaming.spec.ts:2:3',
              stepCategory: 'hook',
              status: 'passed',
              duration: 20,
              parentTitle: null,
              workerIndex: 0,
              startedAt: 1700000000100,
            },
          ],
        },
      });
      expect(res.ok()).toBeTruthy();
    };

    try {
      await postStepEvents();
      while (!(sawStepBegin && sawStepEnd && sawHookBegin && sawHookEnd)) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.includes('"type":"step-begin"') && text.includes('expect(locator).toBeVisible()')) sawStepBegin = true;
        if (text.includes('"type":"step-end"')) sawStepEnd = true;
        if (text.includes('"type":"test-begin"') && text.includes('"filePath":"hooks"')) sawHookBegin = true;
        if (text.includes('"type":"test-completed"') && text.includes('"filePath":"hooks"')) sawHookEnd = true;
        // Hard cap so a regression cannot hang the suite
        if (text.length > 65536) break;
      }
    } finally {
      reader.releaseLock();
      controller.abort();
    }

    // Test-attached steps stream as step-begin/step-end with their category.
    expect(sawStepBegin).toBeTruthy();
    expect(sawStepEnd).toBeTruthy();
    // Suite-level hooks keep the timeline shape (test-begin/test-completed, filePath 'hooks').
    expect(sawHookBegin).toBeTruthy();
    expect(sawHookEnd).toBeTruthy();
  });

  test('GET /api/test-runs/:id/stream keeps the posted order of step events within one batch', async ({
    request,
    baseURL,
  }) => {
    // Subscribe first — the in-memory bus only delivers to live subscribers.
    const controller = new AbortController();
    const response = await fetch(`${baseURL}/api/test-runs/${runId}/stream`, {
      signal: controller.signal,
    });
    expect(response.ok).toBeTruthy();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let bytesRead = 0;
    const received: string[] = [];

    // One step ends and the next begins on the same worker, in a single batch —
    // the way the reporter's batching usually delivers them.
    const onWorker = { parentTitle: 'streaming test 1', workerIndex: 0 };
    const wait = { title: 'Wait for timeout', location: 'tests/streaming.spec.ts:9:5', stepCategory: 'pw:api' };
    const assertion = {
      title: 'Expect "toHaveValue"',
      location: 'tests/streaming.spec.ts:10:5',
      stepCategory: 'expect',
    };
    const titles = new Set([wait.title, assertion.title]);

    try {
      const res = await request.post(`/api/test-runs/${runId}/events`, {
        data: {
          streamToken,
          testCases: [
            { type: 'step-begin', ...wait, ...onWorker, startedAt: 1700000000200 },
            { type: 'step-end', ...wait, ...onWorker, startedAt: 1700000000200, status: 'passed', duration: 500 },
            { type: 'step-begin', ...assertion, ...onWorker, startedAt: 1700000000700 },
          ],
        },
      });
      expect(res.ok()).toBeTruthy();

      while (received.length < 3) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        bytesRead += chunk.length;
        // Parse only complete SSE messages; a partial one waits for the next chunk.
        const messages = (buffer + chunk).split('\n\n');
        buffer = messages.pop()!;
        for (const message of messages) {
          const line = message.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          const parsed = JSON.parse(line.slice('data:'.length).trim());
          if ((parsed.type === 'step-begin' || parsed.type === 'step-end') && titles.has(parsed.data?.title)) {
            received.push(`${parsed.type} ${parsed.data.title}`);
          }
        }
        // Hard cap so a regression cannot hang the suite
        if (bytesRead > 65536) break;
      }
    } finally {
      reader.releaseLock();
      controller.abort();
    }

    // The run page keeps the last step event per worker, so the running assertion must arrive last.
    expect(received).toEqual([
      'step-begin Wait for timeout',
      'step-end Wait for timeout',
      'step-begin Expect "toHaveValue"',
    ]);
  });

  test('POST /events and /heartbeat say whether anyone has the run open live', async ({ request, baseURL }) => {
    const postStep = async () => {
      const res = await request.post(`/api/test-runs/${runId}/events`, {
        data: {
          streamToken,
          testCases: [
            {
              type: 'step-end',
              title: 'Click',
              location: 'tests/streaming.spec.ts:8:5',
              stepCategory: 'pw:api',
              parentTitle: 'streaming test 1',
              status: 'passed',
              duration: 5,
              workerIndex: 0,
              startedAt: 1700000000000,
            },
          ],
        },
      });
      expect(res.ok()).toBeTruthy();
      return (await res.json()).watched;
    };
    const heartbeat = async () => {
      const res = await request.post(`/api/test-runs/${runId}/heartbeat`, { data: { streamToken } });
      expect(res.ok()).toBeTruthy();
      return (await res.json()).watched;
    };

    // The streams the tests above opened are gone once the server sees their connections close.
    await expect.poll(postStep).toBe(false);
    expect(await heartbeat()).toBe(false);

    const controller = new AbortController();
    const response = await fetch(`${baseURL}/api/test-runs/${runId}/stream`, { signal: controller.signal });
    expect(response.ok).toBeTruthy();
    const reader = response.body!.getReader();
    try {
      // The stream has subscribed by the time its first event arrives.
      await reader.read();
      expect(await postStep()).toBe(true);
      expect(await heartbeat()).toBe(true);
    } finally {
      reader.releaseLock();
      controller.abort();
    }

    await expect.poll(postStep).toBe(false);
  });

  // ── /finish ──────────────────────────────────────────────────────────────────

  test('POST /api/test-runs/:id/finish finalizes the run', async ({ request }) => {
    const response = await request.post(`/api/test-runs/${runId}/finish`, {
      data: {
        streamToken,
        status: 'failed',
        duration: 5000,
        totalTests: 3,
        passedTests: 2,
        failedTests: 1,
        skippedTests: 0,
        flakyTests: 0,
      },
    });

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.status).toBe('failed');
  });

  test('GET /api/test-runs/:id shows finalized run without streamToken', async ({ request }) => {
    const response = await request.get(`/api/test-runs/${runId}`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();

    expect(data.status).toBe('failed');
    expect(data.streamToken).toBeUndefined();
    // Counters set by /finish should be reflected
    expect(data.totalTests).toBe(3);
    expect(data.passedTests).toBe(2);
    expect(data.failedTests).toBe(1);
    expect(data.flakyTests).toBe(0);
  });

  test('POST /api/test-runs/:id/events is rejected after run is finalized', async ({ request }) => {
    const response = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken,
        testCases: [{ title: 'late test', status: 'passed', duration: 100, location: 'x.spec.ts:1:1' }],
      },
    });

    // Run is no longer 'running', so this should be rejected
    expect(response.status()).toBe(409);
  });

  // ── edge cases ───────────────────────────────────────────────────────────────

  test('POST /api/test-runs/start rejects missing projectName', async ({ request }) => {
    const response = await request.post('/api/test-runs/start', {
      data: { startTime: new Date().toISOString() },
    });

    expect(response.ok()).toBeFalsy();
    expect(response.status()).toBe(400);
  });

  test('POST /api/test-runs/:id/finish preserves flakyTests of 0 explicitly', async ({ request }) => {
    // Create a fresh run
    const startResp = await request.post('/api/test-runs/start', {
      data: { projectName: PROJECT.STREAMING_FLAKY, startTime: new Date().toISOString() },
    });
    const { runId: freshRunId, streamToken: freshToken } = await startResp.json();

    const finishResp = await request.post(`/api/test-runs/${freshRunId}/finish`, {
      data: {
        streamToken: freshToken,
        status: 'passed',
        duration: 1000,
        flakyTests: 0,
      },
    });
    expect(finishResp.ok()).toBeTruthy();

    const detailsResp = await request.get(`/api/test-runs/${freshRunId}`);
    const details = await detailsResp.json();
    expect(details.flakyTests).toBe(0);
  });

  test('POST /api/test-runs/:id/finish with duration 0 does not fall back to elapsed time', async ({ request }) => {
    const startResp = await request.post('/api/test-runs/start', {
      data: { projectName: PROJECT.STREAMING_DURATION, startTime: new Date().toISOString() },
    });
    const { runId: freshRunId, streamToken: freshToken } = await startResp.json();

    const finishResp = await request.post(`/api/test-runs/${freshRunId}/finish`, {
      data: {
        streamToken: freshToken,
        status: 'passed',
        duration: 0,
      },
    });
    expect(finishResp.ok()).toBeTruthy();

    const detailsResp = await request.get(`/api/test-runs/${freshRunId}`);
    const details = await detailsResp.json();
    // duration: 0 must be preserved, not replaced with elapsed time
    expect(details.duration).toBe(0);
  });
});

// ── /stream catch-up for still-running cases ────────────────────────────────

/**
 * A case that has begun but not completed has no DB row, so a client that
 * connects (or refreshes) mid-run must still see it: the stream catch-up
 * replays every still-running case as a `test-begin` event, and stops once the
 * case completes (it is then replayed as `test-completed` from the DB row).
 */
test.describe.serial('Streaming catch-up for running cases', () => {
  let runId: number;
  let streamToken: string;

  const runningCase = { title: 'in-progress case', location: 'tests/running.spec.ts:7:3' };

  // Read the SSE stream's catch-up until `predicate` matches a parsed event or
  // the byte cap is hit, then abort. Posting the begin/complete BEFORE opening
  // the stream is the mid-run-refresh scenario: the client connects late.
  async function findCatchUpEvent(
    baseURL: string,
    predicate: (e: { type?: string; data?: Record<string, unknown> }) => boolean,
  ): Promise<{ type?: string; data?: Record<string, unknown> } | null> {
    const controller = new AbortController();
    const response = await fetch(`${baseURL}/api/test-runs/${runId}/stream`, { signal: controller.signal });
    expect(response.ok).toBeTruthy();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let match: { type?: string; data?: Record<string, unknown> } | null = null;
    try {
      while (match === null) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        for (const chunk of text.split('\n\n')) {
          const line = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          try {
            const parsed = JSON.parse(line.slice('data:'.length).trim());
            if (predicate(parsed)) match = parsed;
          } catch {
            continue;
          }
        }
        // Hard cap so a regression cannot hang the suite
        if (text.length > 65536) break;
      }
    } finally {
      reader.releaseLock();
      controller.abort();
    }
    return match;
  }

  test.beforeAll(async ({ request }) => {
    const startResp = await request.post('/api/test-runs/start', {
      data: { projectName: PROJECT.STREAMING_RUNNING_CATCHUP, startTime: new Date().toISOString(), totalTests: 1 },
    });
    expect(startResp.ok()).toBeTruthy();
    const data = await startResp.json();
    runId = data.runId;
    streamToken = data.streamToken;
  });

  test('a begun-but-unfinished case is not in the REST payload yet', async ({ request }) => {
    const beginResp = await request.post(`/api/test-runs/${runId}/events`, {
      data: { streamToken, testCases: [{ type: 'begin', ...runningCase, workerIndex: 0 }] },
    });
    expect(beginResp.ok()).toBeTruthy();

    // The run's REST payload only carries persisted (completed) cases, so the
    // running case is absent — this is exactly why the stream must replay it.
    const run = await (await request.get(`/api/test-runs/${runId}`)).json();
    expect(run.testCases.find((tc: { title: string }) => tc.title === runningCase.title)).toBeUndefined();
  });

  test('the stream catch-up replays the running case as test-begin', async ({ baseURL }) => {
    const event = await findCatchUpEvent(
      baseURL!,
      (e) => e.type === 'test-begin' && e.data?.title === runningCase.title,
    );
    expect(event, 'running case should be replayed on connect, not wait for the next live event').not.toBeNull();
    expect(event!.data!.location).toBe(runningCase.location);
  });

  test('once the case completes it is replayed as test-completed, not test-begin', async ({ request, baseURL }) => {
    const completeResp = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken,
        testCases: [{ type: 'complete', ...runningCase, status: 'passed', duration: 900, retries: 0 }],
      },
    });
    expect(completeResp.ok()).toBeTruthy();

    // The case now has a DB row, so the catch-up serves it as test-completed and
    // no longer as a running-case test-begin.
    const completed = await findCatchUpEvent(
      baseURL!,
      (e) => e.data?.title === runningCase.title && (e.type === 'test-completed' || e.type === 'test-begin'),
    );
    expect(completed).not.toBeNull();
    expect(completed!.type).toBe('test-completed');
    expect(completed!.data!.status).toBe('passed');
  });

  test.afterAll(async ({ request }) => {
    await request.post(`/api/test-runs/${runId}/finish`, {
      data: { streamToken, status: 'passed', duration: 1000, totalTests: 1, passedTests: 1, failedTests: 0 },
    });
  });
});

// ── /heartbeat ────────────────────────────────────────────────────────────────

test.describe.serial('Heartbeat API Tests', () => {
  let runId: number;
  let streamToken: string;

  test.beforeAll(async ({ request }) => {
    const startResp = await request.post('/api/test-runs/start', {
      data: { projectName: PROJECT.HEARTBEAT_TEST, startTime: new Date().toISOString() },
    });
    expect(startResp.ok()).toBeTruthy();
    const data = await startResp.json();
    runId = data.runId;
    streamToken = data.streamToken;
  });

  test('POST /api/test-runs/:id/heartbeat with a valid token bumps updatedAt and returns success', async ({
    request,
  }) => {
    const before = await (await request.get(`/api/test-runs/${runId}`)).json();

    // Ensure a measurable clock tick between the two updatedAt values.
    await new Promise((r) => setTimeout(r, 1100));

    const response = await request.post(`/api/test-runs/${runId}/heartbeat`, {
      data: { streamToken },
    });
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    // Nobody has this run open, so the answer says it is not watched.
    expect(data).toEqual({ success: true, watched: false });

    const after = await (await request.get(`/api/test-runs/${runId}`)).json();
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(new Date(before.updatedAt).getTime());
    // The run itself is left untouched otherwise (still running).
    expect(after.status).toBe('running');
  });

  test('POST /api/test-runs/:id/heartbeat rejects a missing stream token with 401', async ({ request }) => {
    const response = await request.post(`/api/test-runs/${runId}/heartbeat`, {
      data: {},
    });
    expect(response.status()).toBe(401);
    const data = await response.json();
    expect(data.message).toContain('Missing stream token');
  });

  test('POST /api/test-runs/:id/heartbeat rejects a wrong stream token with 403', async ({ request }) => {
    const response = await request.post(`/api/test-runs/${runId}/heartbeat`, {
      data: { streamToken: 'not-the-right-token' },
    });
    expect(response.status()).toBe(403);
    const data = await response.json();
    expect(data.message).toContain('Invalid stream token');
  });

  test('POST /api/test-runs/:id/heartbeat returns 404 for a non-existent run', async ({ request }) => {
    const response = await request.post('/api/test-runs/999999/heartbeat', {
      data: { streamToken: 'anything' },
    });
    expect(response.status()).toBe(404);
  });

  test('POST /api/test-runs/:id/heartbeat returns 400 for a non-numeric run id', async ({ request }) => {
    const response = await request.post('/api/test-runs/not-a-number/heartbeat', {
      data: { streamToken: 'anything' },
    });
    expect(response.status()).toBe(400);
  });
});
