import { describe, expect, test } from 'vitest';
import type { StreamEventPayload, TestCasePayload, WireExecutionResources, WireNetworkRequest } from '#shared/types';
import type { LocatorSnapshot } from '#shared/locator-healing.types';
import { mapWireCaseToRunCase } from '../../server/utils/map-wire-case';
import type { RunCaseInput } from '../../server/utils/persist-run-cases';

/**
 * Every field of the per-case wire contract, each with a value of its own, so
 * a field the mapper drops or swaps shows up as a mismatch.
 */
const wireCase = {
  title: 'pays with a saved card',
  location: 'tests/checkout.spec.ts:42:7',
  status: 'failed',
  duration: 1234,
  timeout: 30_000,
  error: 'Error: expect(locator).toBeVisible() failed',
  retries: 1,
  attempts: [{ retry: 0, status: 'failed', duration: 1100, startedAt: 1_700_000_000_000 }],
  steps: [{ title: 'click Pay', duration: 40 }],
  stepEvents: [{ title: 'click', category: 'expect', startedAt: 1, duration: 2 }],
  slowestStep: 'click Pay',
  slowestStepDuration: 40,
  wastedTimeMs: 900,
  networkRequests: [{ method: 'POST', url: 'https://shop.example/api/pay', status: 502 }] as WireNetworkRequest[],
  webVitals: { lcp: 1800 },
  pageState: { url: 'https://shop.example/checkout' },
  pageInventory: [{ url: 'https://shop.example/checkout', controls: [], links: [] }],
  locatorPages: [{ location: 'tests/checkout.spec.ts:44:9', locator: "getByRole('button')" }],
  codeReach: ['src/checkout.ts'],
  coverage: { v: 1, files: [] },
  resources: { workerCpuMs: 12, loopUtilization: 0.4 } as WireExecutionResources,
  aiUsage: { entries: ['pay-flow'] },
  consoleLogs: [{ type: 'error', text: 'payment failed' }],
  dialogs: [{ type: 'alert', message: 'Declined' }],
  ariaSnapshot: '- button "Pay"',
  ariaSnapshotJson: '{"role":"button"}',
  workerIndex: 3,
  shardIndex: 2,
  startedAt: 1_700_000_001_000,
  browser: { projectName: 'chromium' },
  suitePath: ['checkout', 'saved card'],
  suiteConfig: [{ mode: 'serial', annotations: [{ type: 'slow' }] }],
  testAnnotations: [{ type: 'issue', description: 'SHOP-12' }],
  tags: ['payments'],
  locks: ['stripe-sandbox'],
  testMeta: { owner: 'payments-team' },
  externalId: 'SHOP-7',
  displayTitle: 'saved card payment',
  locatorSnapshots: [{ locator: "getByRole('button', { name: 'Pay' })" }] as unknown as LocatorSnapshot[],
  testSource: '> 42 | await pay();',
  testSourceFrames: [{ file: 'tests/checkout.spec.ts', line: 42, snippet: '> 42 | await pay();' }],
  didNotRunReason: 'previous-failure',
  expectedStatus: 'passed',
  blockedBy: 'tests/checkout.spec.ts:10:3',
} satisfies Required<TestCasePayload>;

/** What `persistRunCases` must receive for `wireCase`: every field it reads, by name. */
const expected = {
  filePath: 'tests/checkout.spec.ts',
  line: 42,
  column: 7,
  suitePath: wireCase.suitePath,
  suiteConfig: wireCase.suiteConfig,
  testAnnotations: wireCase.testAnnotations,
  tags: wireCase.tags,
  locks: wireCase.locks,
  testMeta: wireCase.testMeta,
  externalId: wireCase.externalId,
  displayTitle: wireCase.displayTitle,
  title: wireCase.title,
  status: wireCase.status,
  duration: wireCase.duration,
  timeout: wireCase.timeout,
  error: wireCase.error,
  retries: wireCase.retries,
  attempts: wireCase.attempts,
  steps: wireCase.steps,
  stepEvents: wireCase.stepEvents,
  slowestStep: wireCase.slowestStep,
  slowestStepDuration: wireCase.slowestStepDuration,
  wastedTimeMs: wireCase.wastedTimeMs,
  networkRequests: wireCase.networkRequests,
  webVitals: wireCase.webVitals,
  pageState: wireCase.pageState,
  pageInventory: wireCase.pageInventory,
  locatorPages: wireCase.locatorPages,
  codeReach: wireCase.codeReach,
  coverage: wireCase.coverage,
  resources: wireCase.resources,
  aiUsage: wireCase.aiUsage,
  consoleLogs: wireCase.consoleLogs,
  dialogs: wireCase.dialogs,
  ariaSnapshot: wireCase.ariaSnapshot,
  ariaSnapshotJson: wireCase.ariaSnapshotJson,
  testSource: wireCase.testSource,
  testSourceFrames: wireCase.testSourceFrames,
  workerIndex: wireCase.workerIndex,
  shardIndex: wireCase.shardIndex,
  startedAt: wireCase.startedAt,
  browser: wireCase.browser,
  locatorSnapshots: wireCase.locatorSnapshots,
  didNotRunReason: wireCase.didNotRunReason,
  expectedStatus: wireCase.expectedStatus,
  blockedBy: wireCase.blockedBy,
} satisfies Required<RunCaseInput>;

describe('mapWireCaseToRunCase', () => {
  test('maps every wire field to the stored field of the same name, the location read into file, line and column', () => {
    expect(mapWireCaseToRunCase(wireCase)).toEqual(expected);
  });

  test('carries every field of the wire contract', () => {
    const mapped = mapWireCaseToRunCase(wireCase);
    const dropped = Object.keys(wireCase).filter((key) => key !== 'location' && !(key in mapped));
    expect(dropped).toEqual([]);
  });

  test('a streamed complete event maps as the same case submitted in a batch', () => {
    const event: StreamEventPayload = { ...wireCase, type: 'complete', stepCategory: null, parentTitle: null };
    expect(mapWireCaseToRunCase(event)).toEqual(mapWireCaseToRunCase(wireCase));
  });

  test('an older reporter sends no external ID: the field stays absent, so the server reads piwi:id itself', () => {
    expect(mapWireCaseToRunCase({ title: 'bare', status: 'passed' }).externalId).toBeUndefined();
    expect(mapWireCaseToRunCase({ title: 'bare', status: 'passed', externalId: null }).externalId).toBeNull();
  });

  test('a case with no location goes to the unknown file, and missing optional fields become null', () => {
    const mapped = mapWireCaseToRunCase({ title: 'bare', status: 'passed' });
    expect(mapped).toMatchObject({ filePath: 'unknown', line: null, column: null, title: 'bare', status: 'passed' });
    for (const key of [
      'suitePath',
      'timeout',
      'stepEvents',
      'resources',
      'workerIndex',
      'browser',
      'blockedBy',
    ] as const) {
      expect(mapped[key], key).toBeNull();
    }
  });
});
