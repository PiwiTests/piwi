import { createHash } from 'node:crypto';
import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';

test.describe.serial('Sharding API Tests', () => {
  const INSTANCE_ID = 'sharding-test-instance-e2e';
  // Both shards report this start to `/finish`: they ran side by side.
  const SHARDS_START = new Date().toISOString();
  let runId: number;
  let tokenShard0: string;
  let tokenShard1: string;

  test('two shards start a run with the same instanceId', async ({ request }) => {
    // First shard — creates the shared run. Each shard reports its slice of the
    // planned suite (2 here, 1 below), so the run's total is their sum, 3.
    const res0 = await request.post('/api/test-runs/start', {
      data: {
        projectName: PROJECT.SHARDING_TEST,
        startTime: new Date().toISOString(),
        instanceId: INSTANCE_ID,
        shardIndex: 1,
        shardTotal: 2,
        totalTests: 2,
      },
    });
    expect(res0.ok()).toBeTruthy();
    const data0 = await res0.json();
    expect(data0.success).toBe(true);
    expect(typeof data0.runId).toBe('number');
    expect(typeof data0.streamToken).toBe('string');
    runId = data0.runId;
    tokenShard0 = data0.streamToken;

    // Second shard — reuses the same run, gets a different stream token
    const res1 = await request.post('/api/test-runs/start', {
      data: {
        projectName: PROJECT.SHARDING_TEST,
        startTime: new Date().toISOString(),
        instanceId: INSTANCE_ID,
        shardIndex: 2,
        shardTotal: 2,
        totalTests: 1,
      },
    });
    expect(res1.ok()).toBeTruthy();
    const data1 = await res1.json();
    expect(data1.success).toBe(true);
    expect(data1.runId).toBe(runId);
    expect(data1.streamToken).not.toBe(tokenShard0);
    tokenShard1 = data1.streamToken;
  });

  test('run is running with shard metadata and no streamToken leak', async ({ request }) => {
    const res = await request.get(`/api/test-runs/${runId}`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.status).toBe('running');
    expect(data.shardTotal).toBe(2);
    expect(data.shardsFinished).toBe(0);
    expect(data.instanceId).toBe(INSTANCE_ID);
    // streamToken must never be exposed to clients
    expect(data.streamToken).toBeUndefined();
  });

  test('both shards stream events independently with their own tokens', async ({ request }) => {
    // Shard 0 reports 2 tests
    const res0 = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken: tokenShard0,
        testCases: [
          {
            type: 'complete',
            title: 'shard 0 test A',
            status: 'passed',
            duration: 1500,
            location: 'tests/shard0.spec.ts:5:3',
            retries: 0,
            browser: 'chromium',
          },
          {
            type: 'complete',
            title: 'shard 0 test B',
            status: 'passed',
            duration: 800,
            location: 'tests/shard0.spec.ts:10:3',
            retries: 0,
            browser: 'chromium',
          },
        ],
      },
    });
    expect(res0.ok()).toBeTruthy();
    expect((await res0.json()).processed).toBe(2);

    // Shard 1 reports 1 test with a failure
    const res1 = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken: tokenShard1,
        testCases: [
          {
            type: 'complete',
            title: 'shard 1 test C',
            status: 'failed',
            duration: 1100,
            location: 'tests/shard1.spec.ts:8:3',
            retries: 1,
            error: 'Expected element to be visible',
          },
        ],
      },
    });
    expect(res1.ok()).toBeTruthy();
    expect((await res1.json()).processed).toBe(1);
  });

  test('shard 1 token is also valid for posting events to the shared run', async ({ request }) => {
    const res = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken: tokenShard1,
        testCases: [
          // Replaying a test from shard 0 — deduped by unique constraint
          {
            type: 'complete',
            title: 'shard 0 test A',
            status: 'passed',
            duration: 1500,
            location: 'tests/shard0.spec.ts:5:3',
            retries: 0,
            browser: 'chromium',
          },
        ],
      },
    });
    // Succeeds (shard 1 token is valid) but the duplicate is silently skipped
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).processed).toBe(0);
  });

  test('shard token is also valid for uploading case files', async ({ request }) => {
    // tokenShard1 is not the run's primary stream token — uploads from that
    // shard must be accepted via the shard-token fallback.
    const traceContent = Buffer.from('Mock shard trace data');
    const response = await request.post(`/api/test-runs/${runId}/case-files`, {
      multipart: {
        streamToken: tokenShard1,
        testCase: JSON.stringify({ title: 'shard 1 test C', location: 'tests/shard1.spec.ts:8:3', retries: 1 }),
        trace_hash: createHash('sha256').update(traceContent).digest('hex'),
        trace: {
          name: 'trace.zip',
          mimeType: 'application/zip',
          buffer: traceContent,
        },
      },
    });
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.traces).toBe(1);
  });

  test('counters reflect events from both shards while still running', async ({ request }) => {
    const res = await request.get(`/api/test-runs/${runId}`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.totalTests).toBe(3);
    expect(data.passedTests).toBe(2);
    expect(data.failedTests).toBe(1);
    expect(data.status).toBe('running');
  });

  test('run stays running when only one shard finishes', async ({ request }) => {
    // Shard 1 finishes — run should remain running
    const res = await request.post(`/api/test-runs/${runId}/finish`, {
      data: {
        streamToken: tokenShard1,
        status: 'failed',
        startTime: SHARDS_START,
        duration: 5000,
        totalTests: 1,
        passedTests: 0,
        failedTests: 1,
        skippedTests: 0,
        flakyTests: 0,
      },
    });

    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.success).toBe(true);
    // Not all shards done — status is still 'running'
    expect(data.status).toBe('running');

    // Verify via GET
    const runRes = await request.get(`/api/test-runs/${runId}`);
    const runData = await runRes.json();
    expect(runData.status).toBe('running');
    expect(runData.shardsFinished).toBe(1);
    // Counters reflect the streamed events; finish totals are not added on top
    expect(runData.failedTests).toBe(1);
  });

  test('run finishes with failed status after all shards report', async ({ request }) => {
    // Shard 0 finishes with 'passed' status
    const res = await request.post(`/api/test-runs/${runId}/finish`, {
      data: {
        streamToken: tokenShard0,
        status: 'passed',
        startTime: SHARDS_START,
        duration: 4000,
        totalTests: 2,
        passedTests: 2,
        failedTests: 0,
        skippedTests: 0,
        flakyTests: 0,
      },
    });

    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.success).toBe(true);
    // All shards done — final status is 'failed' because shard 1 reported failures
    expect(data.status).toBe('failed');
  });

  test('final counters count each streamed execution exactly once', async ({ request }) => {
    const res = await request.get(`/api/test-runs/${runId}`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.status).toBe('failed');

    // Streamed events: shard 0 reported 2 passed, shard 1 reported 1 failed.
    // The shards' finish totals must not be added on top of these.
    expect(data.totalTests).toBe(3);
    expect(data.passedTests).toBe(2);
    expect(data.failedTests).toBe(1);
    expect(data.shardsFinished).toBe(2);
    expect(data.shardTotal).toBe(2);
    expect(data.instanceId).toBe(INSTANCE_ID);

    // The run lasts from the first shard's start to the last shard's end: with
    // both started together, as long as its longest shard.
    expect(data.duration).toBe(5000);

    // streamToken must be cleared after finalization
    expect(data.streamToken).toBeUndefined();
  });

  test('events are rejected after the run is finalized', async ({ request }) => {
    const res = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken: tokenShard0,
        testCases: [
          {
            title: 'shard 0 test A',
            status: 'passed',
            duration: 1500,
            location: 'tests/shard0.spec.ts:5:3',
            retries: 0,
            browser: 'chromium',
          },
          {
            title: 'shard 0 test B',
            status: 'passed',
            duration: 800,
            location: 'tests/shard0.spec.ts:10:3',
            retries: 0,
            browser: 'chromium',
          },
        ],
      },
    });
    expect(res.status()).toBe(409);
  });
});

test.describe.serial('Sharding: flaky-only run finishes as passed', () => {
  const INSTANCE_ID = 'sharding-flaky-only-instance-e2e';
  let runId: number;
  let tokenShard0: string;
  let tokenShard1: string;

  test('two shards start and stream a flaky test plus a passing test', async ({ request }) => {
    const res0 = await request.post('/api/test-runs/start', {
      data: {
        projectName: PROJECT.SHARDING_TEST,
        startTime: new Date().toISOString(),
        instanceId: INSTANCE_ID,
        shardIndex: 1,
        shardTotal: 2,
      },
    });
    expect(res0.ok()).toBeTruthy();
    const data0 = await res0.json();
    runId = data0.runId;
    tokenShard0 = data0.streamToken;

    const res1 = await request.post('/api/test-runs/start', {
      data: {
        projectName: PROJECT.SHARDING_TEST,
        startTime: new Date().toISOString(),
        instanceId: INSTANCE_ID,
        shardIndex: 2,
        shardTotal: 2,
      },
    });
    expect(res1.ok()).toBeTruthy();
    tokenShard1 = (await res1.json()).streamToken;

    // Shard 0 reports a flaky test: a failed first attempt, then a passed retry.
    const events0 = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken: tokenShard0,
        testCases: [
          {
            type: 'complete',
            title: 'flaky test',
            status: 'failed',
            duration: 1200,
            location: 'tests/flaky.spec.ts:5:3',
            retries: 0,
            error: 'Expected element to be visible',
          },
          {
            type: 'complete',
            title: 'flaky test',
            status: 'passed',
            duration: 900,
            location: 'tests/flaky.spec.ts:5:3',
            retries: 1,
          },
        ],
      },
    });
    expect(events0.ok()).toBeTruthy();
    expect((await events0.json()).processed).toBe(2);

    // Shard 1 reports a plain passing test
    const events1 = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken: tokenShard1,
        testCases: [
          {
            type: 'complete',
            title: 'stable test',
            status: 'passed',
            duration: 700,
            location: 'tests/stable.spec.ts:5:3',
            retries: 0,
          },
        ],
      },
    });
    expect(events1.ok()).toBeTruthy();
  });

  test('run finishes as passed although a flaky attempt failed', async ({ request }) => {
    // Both shards report 'passed' (Playwright's verdict for a flaky-only run);
    // shard 0's counters still carry the failed attempt.
    const finish0 = await request.post(`/api/test-runs/${runId}/finish`, {
      data: {
        streamToken: tokenShard0,
        status: 'passed',
        duration: 4000,
        totalTests: 2,
        passedTests: 1,
        failedTests: 1,
        skippedTests: 0,
        flakyTests: 1,
      },
    });
    expect(finish0.ok()).toBeTruthy();
    expect((await finish0.json()).status).toBe('running');

    const finish1 = await request.post(`/api/test-runs/${runId}/finish`, {
      data: {
        streamToken: tokenShard1,
        status: 'passed',
        duration: 3000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        flakyTests: 0,
      },
    });
    expect(finish1.ok()).toBeTruthy();
    // The flaky test's failed attempt must not flip the merged run to failed.
    expect((await finish1.json()).status).toBe('passed');

    const runRes = await request.get(`/api/test-runs/${runId}`);
    expect(runRes.ok()).toBeTruthy();
    const runData = await runRes.json();
    expect(runData.status).toBe('passed');
    expect(runData.flakyTests).toBe(1);
    // Two distinct tests — the flaky one (failed attempt + passed retry) and the
    // stable one — counted once each: the flaky test is a pass, not a failure.
    expect(runData.totalTests).toBe(2);
    expect(runData.passedTests).toBe(2);
    expect(runData.failedTests).toBe(0);
  });
});

test.describe.serial('Sharding: cross-run instanceId cancellation', () => {
  const INSTANCE_A = 'sharding-cancel-instance-a';
  const INSTANCE_B = 'sharding-cancel-instance-b';

  test('non-shard start with same instanceId cancels the sharded run', async ({ request }) => {
    // Create a sharded run tied to instance A
    const shardRes = await request.post('/api/test-runs/start', {
      data: {
        projectName: PROJECT.SHARDING_TEST,
        startTime: new Date().toISOString(),
        instanceId: INSTANCE_A,
        shardIndex: 1,
        shardTotal: 2,
      },
    });
    expect(shardRes.ok()).toBeTruthy();
    const shardData = await shardRes.json();
    const shardedRunId = shardData.runId;

    // Start a non-sharded run with the same instanceId A.
    // Since `cancelInstanceRuns` has no shard guard for non-sharded starts,
    // it should cancel ALL runs (including sharded ones) with this instanceId.
    const nonShardRes = await request.post('/api/test-runs/start', {
      data: {
        projectName: PROJECT.SHARDING_TEST,
        startTime: new Date().toISOString(),
        instanceId: INSTANCE_A,
      },
    });
    expect(nonShardRes.ok()).toBeTruthy();
    const nonShardData = await nonShardRes.json();
    const nonShardedRunId = nonShardData.runId;

    // The non-sharded run should be a DIFFERENT run
    expect(nonShardedRunId).not.toBe(shardedRunId);

    // The sharded run should now be cancelled
    const shardedCheck = await request.get(`/api/test-runs/${shardedRunId}`);
    expect(shardedCheck.ok()).toBeTruthy();
    const shardedRun = await shardedCheck.json();
    expect(shardedRun.status).toBe('cancelled');

    // The non-sharded run should be running
    const nonShardedCheck = await request.get(`/api/test-runs/${nonShardedRunId}`);
    expect(nonShardedCheck.ok()).toBeTruthy();
    const nonShardedRun = await nonShardedCheck.json();
    expect(nonShardedRun.status).toBe('running');
  });

  test('sharded start cancels non-sharded runs with the same instanceId', async ({ request }) => {
    // Create a non-sharded run with instance B
    const baseRes = await request.post('/api/test-runs/start', {
      data: {
        projectName: PROJECT.SHARDING_TEST,
        startTime: new Date().toISOString(),
        instanceId: INSTANCE_B,
      },
    });
    expect(baseRes.ok()).toBeTruthy();
    const baseData = await baseRes.json();
    const baseRunId = baseData.runId;

    // Start a sharded run with the SAME instance B.
    // The sharded start cancels non-sharded runs (shardTotal=null) with the
    // same instanceId, but preserves sibling shards (which don't exist yet).
    const shardRes = await request.post('/api/test-runs/start', {
      data: {
        projectName: PROJECT.SHARDING_TEST,
        startTime: new Date().toISOString(),
        instanceId: INSTANCE_B,
        shardIndex: 1,
        shardTotal: 2,
      },
    });
    expect(shardRes.ok()).toBeTruthy();
    const shardData = await shardRes.json();

    // The base non-sharded run should be cancelled
    const baseCheck = await request.get(`/api/test-runs/${baseRunId}`);
    expect(baseCheck.ok()).toBeTruthy();
    const baseRun = await baseCheck.json();
    expect(baseRun.status).toBe('cancelled');

    // The sharded run should be running
    const shardCheck = await request.get(`/api/test-runs/${shardData.runId}`);
    expect(shardCheck.ok()).toBeTruthy();
    expect((await shardCheck.json()).status).toBe('running');
  });
});
