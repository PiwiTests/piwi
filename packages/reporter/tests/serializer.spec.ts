import { describe, it, expect } from 'vitest';
import {
  computeDistinctRunCounts,
  resolveOverallStatus,
  toWireTestCase,
  serializeRun,
} from '../src/internal/submit/serializer.js';
import type { RunPayload } from '../src/internal/submit/uploader.js';
import type { CollectedPerformanceMetrics, CollectedTestCase, TestStepEvent, WireTestCase } from '../src/types.js';

describe('computeDistinctRunCounts', () => {
  it('counts one test regardless of how many attempts it took', () => {
    const counts = computeDistinctRunCounts([
      { title: 't', location: 'a.spec.ts:1:1', status: 'failed', retries: 0 },
      { title: 't', location: 'a.spec.ts:1:1', status: 'passed', retries: 1 },
    ]);
    // The final (highest-retry) attempt wins: one test, passed, and flaky.
    expect(counts.totalTests).toBe(1);
    expect(counts.passedTests).toBe(1);
    expect(counts.failedTests).toBe(0);
    expect(counts.flakyTests).toBe(1);
  });

  it('keeps the same title in different browsers as separate tests', () => {
    const counts = computeDistinctRunCounts([
      { title: 't', location: 'a.spec.ts:1:1', status: 'passed', retries: 0, browser: { projectName: 'chromium' } },
      { title: 't', location: 'a.spec.ts:1:1', status: 'failed', retries: 0, browser: { projectName: 'firefox' } },
    ]);
    expect(counts.totalTests).toBe(2);
    expect(counts.passedTests).toBe(1);
    expect(counts.failedTests).toBe(1);
  });

  it('buckets timed-out separately and tallies skipped / didnotrun', () => {
    const counts = computeDistinctRunCounts([
      { title: 'a', location: 'a.spec.ts:1:1', status: 'timedOut' },
      { title: 'b', location: 'a.spec.ts:2:1', status: 'skipped' },
      { title: 'c', location: 'a.spec.ts:3:1', status: 'didnotrun' },
    ]);
    expect(counts).toMatchObject({
      totalTests: 3,
      timedOutTests: 1,
      skippedTests: 1,
      didNotRunTests: 1,
      failedTests: 0,
      passedTests: 0,
      flakyTests: 0,
    });
  });

  it('counts tests that share a title and a line once each, by their test id', () => {
    // A parameterized test (`for (const user of users) test(...)`) and a --repeat-each repetition.
    const counts = computeDistinctRunCounts([
      { testId: 'alice', title: 'logs in', location: 'a.spec.ts:3:5', status: 'failed', retries: 0 },
      { testId: 'bob', title: 'logs in', location: 'a.spec.ts:3:5', status: 'passed', retries: 0 },
      { testId: 'repeat-1', title: 'pays', location: 'a.spec.ts:9:5', status: 'passed', retries: 0 },
      { testId: 'repeat-2', title: 'pays', location: 'a.spec.ts:9:5', status: 'passed', retries: 0 },
    ]);
    expect(counts).toMatchObject({ totalTests: 4, passedTests: 3, failedTests: 1 });
  });

  it('keeps tests apart by their describe path when they carry no test id', () => {
    const counts = computeDistinctRunCounts([
      { title: 'logs in', location: 'a.spec.ts:3:5', suitePath: ['as Alice'], status: 'failed', retries: 0 },
      { title: 'logs in', location: 'a.spec.ts:3:5', suitePath: ['as Bob'], status: 'passed', retries: 0 },
    ]);
    expect(counts).toMatchObject({ totalTests: 2, passedTests: 1, failedTests: 1 });
  });

  it('lets the failing attempt decide between two with the same retry index, whatever their order', () => {
    const attempts = [
      { title: 't', location: 'a.spec.ts:1:1', status: 'failed', retries: 0 },
      { title: 't', location: 'a.spec.ts:1:1', status: 'passed', retries: 0 },
    ];
    expect(computeDistinctRunCounts(attempts)).toMatchObject({ totalTests: 1, failedTests: 1, passedTests: 0 });
    expect(computeDistinctRunCounts([...attempts].reverse())).toMatchObject({ failedTests: 1, passedTests: 0 });
  });

  it('does not count a first-try pass as flaky', () => {
    const counts = computeDistinctRunCounts([{ title: 'a', location: 'a.spec.ts:1:1', status: 'passed', retries: 0 }]);
    expect(counts.passedTests).toBe(1);
    expect(counts.flakyTests).toBe(0);
  });
});

describe('resolveOverallStatus', () => {
  const counters = { failedTests: 0, timedOutTests: 0, totalTests: 5 };

  it('maps Playwright status directly (passed/failed)', () => {
    expect(resolveOverallStatus({ status: 'passed' } as any, counters)).toBe('passed');
    expect(resolveOverallStatus({ status: 'failed' } as any, counters)).toBe('failed');
  });

  it('preserves timedout and interrupted as distinct run statuses', () => {
    expect(resolveOverallStatus({ status: 'timedout' } as any, counters)).toBe('timedout');
    expect(resolveOverallStatus({ status: 'interrupted' } as any, counters)).toBe('interrupted');
  });

  it('falls back to "failed" for unknown status', () => {
    expect(resolveOverallStatus({ status: 'something-weird' } as any, counters)).toBe('failed');
  });

  it('returns "passed" when no status but no failures and totalTests > 0', () => {
    expect(resolveOverallStatus({} as any, counters)).toBe('passed');
  });

  it('returns "failed" when no status and there are failures', () => {
    expect(resolveOverallStatus({} as any, { failedTests: 1, timedOutTests: 0, totalTests: 5 })).toBe('failed');
  });

  it('returns "failed" when no status and there are timeouts', () => {
    expect(resolveOverallStatus({} as any, { failedTests: 0, timedOutTests: 1, totalTests: 5 })).toBe('failed');
  });

  it('returns "failed" when no status and totalTests is 0', () => {
    expect(resolveOverallStatus({} as any, { failedTests: 0, timedOutTests: 0, totalTests: 0 })).toBe('failed');
  });

  it('status takes precedence over counters', () => {
    expect(
      resolveOverallStatus({ status: 'passed' } as any, { failedTests: 5, timedOutTests: 5, totalTests: 10 }),
    ).toBe('passed');
  });
});

describe('toWireTestCase', () => {
  function perfMetrics(overrides: Partial<CollectedPerformanceMetrics>): CollectedPerformanceMetrics {
    return {
      steps: [],
      totalStepDuration: 0,
      slowestStep: null,
      navigationCount: 0,
      navigationTotalDuration: 0,
      waitTotalDuration: 0,
      waitCount: 0,
      ...overrides,
    };
  }

  it('carries the type discriminant through', () => {
    const out = toWireTestCase({ type: 'begin', title: 't', location: 'l' });
    expect(out.type).toBe('begin');
  });

  it('passes status/duration/error/retries through unchanged (no null default)', () => {
    const out = toWireTestCase({ type: 'begin', title: 't', location: 'l' });
    expect('status' in out).toBe(true);
    expect(out.status).toBe(undefined);
    expect(out.duration).toBe(undefined);
    expect(out.error).toBe(undefined);
    expect(out.retries).toBe(undefined);
    expect(out.attempts).toBe(null);
  });

  it('carries per-attempt outcomes through', () => {
    const attempts = [
      { retry: 0, status: 'failed', duration: 500, startedAt: 1700000000000 },
      { retry: 1, status: 'passed', duration: 800, startedAt: 1700000001000 },
    ];
    const out = toWireTestCase({ type: 'complete', title: 't', location: 'l', attempts });
    expect(out.attempts).toEqual(attempts);
  });

  it('defaults workerIndex/shardIndex/startedAt/suitePath/suiteConfig/testAnnotations to null via ??', () => {
    const out = toWireTestCase({ type: 'begin', title: 't', location: 'l' });
    expect(out.workerIndex).toBe(null);
    expect(out.shardIndex).toBe(null);
    expect(out.startedAt).toBe(null);
    expect(out.suitePath).toBe(null);
    expect(out.suiteConfig).toBe(null);
    expect(out.testAnnotations).toBe(null);
  });

  it('preserves workerIndex=0 (?? null, not || null)', () => {
    const out = toWireTestCase({ type: 'begin', title: 't', location: 'l', workerIndex: 0 });
    expect(out.workerIndex).toBe(0);
  });

  it('preserves startedAt=0', () => {
    const out = toWireTestCase({ type: 'begin', title: 't', location: 'l', startedAt: 0 });
    expect(out.startedAt).toBe(0);
  });

  it('collapses slowestStepDuration=0 to null (|| null quirk)', () => {
    const out = toWireTestCase({
      type: 'complete',
      title: 't',
      location: 'l',
      performanceMetrics: perfMetrics({ slowestStep: { title: 's', duration: 0 } }),
    });
    expect(out.slowestStepDuration).toBe(null);
    expect(out.slowestStep).toBe('s');
  });

  it('preserves empty steps array (|| null does not collapse truthy [])', () => {
    const out = toWireTestCase({
      type: 'complete',
      title: 't',
      location: 'l',
      performanceMetrics: perfMetrics({ steps: [] }),
    });
    expect(out.steps).toEqual([]);
  });

  it('exposes steps from performanceMetrics.steps', () => {
    const steps = [{ title: 'x', duration: 1, category: 'action' }];
    const out = toWireTestCase({
      type: 'complete',
      title: 't',
      location: 'l',
      performanceMetrics: perfMetrics({ steps }),
    });
    expect(out.steps).toBe(steps);
  });

  it('exposes stepEvents, networkRequests, webVitals, consoleLogs, ariaSnapshot, testSource when present', () => {
    const stepEvents: TestStepEvent[] = [{ title: 's', category: 'hook', startedAt: 1, duration: 1, status: 'passed' }];
    const out = toWireTestCase({
      type: 'complete',
      title: 't',
      location: 'l',
      stepEvents,
      networkRequests: [{ method: 'GET', url: 'u', status: 0, duration: 12, failure: 'net::ERR_CONNECTION_RESET' }],
      webVitals: { navigation: {} },
      consoleLogs: [{ type: 'error' }],
      ariaSnapshot: 'snapshot',
      testSource: 'src',
    });
    expect(out.stepEvents).toEqual(stepEvents);
    expect(out.networkRequests).toEqual([
      { method: 'GET', url: 'u', status: 0, duration: 12, failure: 'net::ERR_CONNECTION_RESET' },
    ]);
    expect(out.webVitals).toEqual({ navigation: {} });
    expect(out.consoleLogs).toEqual([{ type: 'error' }]);
    expect(out.ariaSnapshot).toBe('snapshot');
    expect(out.testSource).toBe('src');
  });

  it('projects the coverage beside the code reach, null when there is none', () => {
    const coverage = {
      v: 1 as const,
      files: [
        { path: 'src/Web/Program.cs', runtime: 'server' as const, functions: [[10, 12] as [number, number]] },
        { path: 'src/a.ts', runtime: 'browser' as const },
      ],
      incomplete: true,
    };
    const out = toWireTestCase({ type: 'complete', title: 't', location: 'l', codeReach: ['src/a.ts'], coverage });
    expect(out.coverage).toBe(coverage);
    expect(out.codeReach).toEqual(['src/a.ts']);
    expect(toWireTestCase({ type: 'complete', title: 't', location: 'l' }).coverage).toBe(null);
  });

  it('collapses browser=undefined to null', () => {
    const out = toWireTestCase({ type: 'begin', title: 't', location: 'l' });
    expect(out.browser).toBe(null);
  });

  it('preserves a populated browser object', () => {
    const browser = { projectName: 'chromium' };
    const out = toWireTestCase({ type: 'begin', title: 't', location: 'l', browser });
    expect(out.browser).toBe(browser);
  });

  it('drops unknown/internal fields (only listed fields are emitted)', () => {
    const collected: CollectedTestCase & { _filesUploaded: boolean } = {
      type: 'complete',
      title: 't',
      location: 'l',
      attachments: [{ name: 'trace' }], // raw attachment — must NOT appear on the wire
      _filesUploaded: true, // bookkeeping — must NOT appear on the wire
    };
    const out = toWireTestCase(collected);
    expect('attachments' in out).toBe(false);
    expect('_filesUploaded' in out).toBe(false);
  });

  it('emits exactly the expected set of keys', () => {
    const out = toWireTestCase({ type: 'complete', title: 't', location: 'l' });
    expect(Object.keys(out).sort()).toEqual([
      'aiUsage',
      'ariaSnapshot',
      'ariaSnapshotJson',
      'attempts',
      'blockedBy',
      'browser',
      'codeReach',
      'consoleLogs',
      'coverage',
      'dialogs',
      'didNotRunReason',
      'duration',
      'error',
      'expectedStatus',
      'location',
      'locatorPages',
      'locatorSnapshots',
      'locks',
      'networkRequests',
      'pageInventory',
      'pageState',
      'resources',
      'retries',
      'shardIndex',
      'slowestStep',
      'slowestStepDuration',
      'startedAt',
      'status',
      'stepEvents',
      'steps',
      'suiteConfig',
      'suitePath',
      'tags',
      'testAnnotations',
      'testMeta',
      'testSource',
      'testSourceFrames',
      'timeout',
      'title',
      'type',
      'wastedTimeMs',
      'webVitals',
      'workerIndex',
    ]);
  });
});

describe('serializeRun', () => {
  function makePayload(testCases: CollectedTestCase[] = []): RunPayload {
    return {
      projectName: 'proj',
      projectDescription: 'desc',
      status: 'passed',
      startTime: '2024-01-01T00:00:00.000Z',
      duration: 1000,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      skippedTests: 0,
      environment: 'staging',
      label: 'v1',
      metadata: { scm: { commit: 'abc' } },
      instanceId: 'inst-1',
      testCases,
      playwrightVersion: '1.50.0',
      reporterVersion: '0.5.0',
      shardIndex: 1,
      shardTotal: 3,
    };
  }

  it('includes all run-level fields exactly once', () => {
    const body = serializeRun(makePayload(), { includeTestCases: false });
    expect(Object.keys(body).sort()).toEqual([
      'didNotRunTests',
      'duration',
      'environment',
      'failedTests',
      'filterDetails',
      'instanceId',
      'isFullRun',
      'keep',
      'label',
      'metadata',
      'passedTests',
      'playwrightVersion',
      'projectDescription',
      'projectName',
      'reporterVersion',
      'shardIndex',
      'shardTotal',
      'skippedTests',
      'startTime',
      'status',
      'timedOutTests',
      'totalTests',
    ]);
  });

  it('carries the delivery key when the run has one', () => {
    expect(serializeRun({ ...makePayload(), deliveryKey: 'key-1' }, { includeTestCases: true }).deliveryKey).toBe(
      'key-1',
    );
  });

  it('sends keep: true only when the run asked to be kept', () => {
    expect(serializeRun(makePayload(), { includeTestCases: false }).keep).toBe(false);
    expect(serializeRun({ ...makePayload(), keep: true }, { includeTestCases: false }).keep).toBe(true);
  });

  it('omits testCases when includeTestCases is false', () => {
    const body = serializeRun(makePayload([{ type: 'complete', title: 't', location: 'l' } as any]), {
      includeTestCases: false,
    });
    expect('testCases' in body).toBe(false);
  });

  it('projects testCases to wire shape when includeTestCases is true', () => {
    const collected: CollectedTestCase = {
      type: 'complete',
      title: 't',
      location: 'l',
      status: 'passed',
      duration: 5,
      attachments: [{ name: 'trace', path: '/tmp/trace.zip' }],
    } as any;
    const body = serializeRun(makePayload([collected]), { includeTestCases: true });
    expect(Array.isArray(body.testCases)).toBeTruthy();
    const testCases = body.testCases as WireTestCase[];
    expect(testCases.length).toBe(1);
    // attachments are stripped on the wire
    expect('attachments' in testCases[0]).toBe(false);
    expect(testCases[0].title).toBe('t');
  });

  it('coerces environment/label to null when absent', () => {
    const payload = makePayload();
    delete payload.environment;
    delete payload.label;
    const body = serializeRun(payload, { includeTestCases: false });
    expect(body.environment).toBe(null);
    expect(body.label).toBe(null);
  });

  it('preserves metadata object by reference', () => {
    const payload = makePayload();
    const body = serializeRun(payload, { includeTestCases: false });
    expect(body.metadata).toBe(payload.metadata);
  });
});
