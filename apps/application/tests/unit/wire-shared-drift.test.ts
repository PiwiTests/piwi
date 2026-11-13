import { describe, test, expect } from 'vitest';
import type { TestCasePayload, StreamEventPayload } from '#shared/types';
import { mapStepEventsToRunEvents } from '../../server/utils/map-step-events';
import { testBeginData } from '../../server/utils/live-case-events';
// Imported from the reporter's *source* (vitest transpiles it), not dist/ —
// `npm run app:test:unit` must pass without a prior `npm run reporter:build`.
import type {
  BeginStreamEvent,
  StepBeginStreamEvent,
  StepEndStreamEvent,
  WireTestCase,
} from '../../../../packages/reporter/src/types/wire';

/**
 * Drift guard for the per-test-case wire contract.
 *
 * `WireTestCase` (reporter/src/types/wire.ts) is the shape `toWireTestCase`
 * produces and is structurally compatible with BOTH `TestCasePayload` (the
 * submit/upload body) and `StreamEventPayload` (per-event streaming) on the
 * server side — the reporter cannot import `application/shared/types` (it
 * would leak the monorepo path into the published `.d.ts`), so the two sides
 * are hand-mirrored. This test fails the moment a field is added, renamed, or
 * removed on one side without the other: the `satisfies` fixtures below fail
 * `npm run app:typecheck:tests` on a shape mismatch, and the key-set comparison
 * fails `vitest run` when a key exists on one side but not the reporter's
 * union (or vice versa).
 */

// Every field populated (including optionals) so `satisfies` catches a
// removed/renamed field as an excess-property error, not a silent omission.
const testCasePayloadFixture = {
  title: 't',
  location: 'a.spec.ts:1:1',
  status: 'passed',
  duration: 100,
  timeout: 30000,
  error: null,
  retries: 0,
  repeatEachIndex: 0,
  attempts: null,
  steps: null,
  stepEvents: null,
  slowestStep: null,
  slowestStepDuration: null,
  wastedTimeMs: null,
  networkRequests: null,
  webVitals: null,
  pageState: { url: 'https://app.example.com/checkout', localStorage: [{ key: 'cart', length: 42 }] },
  pageInventory: [
    { url: 'https://app.example.com/checkout', controls: [{ role: 'button', name: 'Place order' }], links: [] },
  ],
  aiUsage: null,
  consoleLogs: null,
  dialogs: null,
  ariaSnapshot: null,
  ariaSnapshotJson: null,
  workerIndex: 0,
  parallelIndex: 0,
  shardIndex: null,
  startedAt: 0,
  browser: null,
  suitePath: null,
  suiteConfig: null,
  testAnnotations: null,
  tags: ['smoke'],
  testMeta: { owner: 'checkout-team' },
  locatorSnapshots: null,
  testSource: null,
  testSourceFrames: [{ file: 'a.spec.ts', line: 1, snippet: '> 1 | test' }],
  didNotRunReason: null,
  blockedBy: null,
  resources: null,
  coverage: { v: 1, files: [{ path: 'src/Web/Program.cs', runtime: 'server', functions: [[10, 12]] }] },
  stdout: 'order 4521 created\n',
  stderr: null,
} satisfies TestCasePayload;

const streamEventPayloadFixture = {
  type: 'complete',
  title: 't',
  location: 'a.spec.ts:1:1',
  status: 'passed',
  duration: 100,
  timeout: 30000,
  error: null,
  retries: 0,
  maxRetries: 2,
  repeatEachIndex: 0,
  attempts: null,
  workerIndex: 0,
  parallelIndex: 0,
  shardIndex: null,
  startedAt: 0,
  steps: null,
  stepEvents: null,
  stepCategory: null,
  parentTitle: null,
  slowestStep: null,
  slowestStepDuration: null,
  wastedTimeMs: null,
  networkRequests: null,
  webVitals: null,
  pageState: { url: 'https://app.example.com/checkout', localStorage: [{ key: 'cart', length: 42 }] },
  pageInventory: [
    { url: 'https://app.example.com/checkout', controls: [{ role: 'button', name: 'Place order' }], links: [] },
  ],
  aiUsage: null,
  consoleLogs: null,
  dialogs: null,
  ariaSnapshot: null,
  ariaSnapshotJson: null,
  browser: null,
  suitePath: null,
  suiteConfig: null,
  testAnnotations: null,
  tags: ['smoke'],
  testMeta: { owner: 'checkout-team' },
  locatorSnapshots: null,
  testSource: null,
  testSourceFrames: [{ file: 'a.spec.ts', line: 1, snippet: '> 1 | test' }],
  didNotRunReason: null,
  blockedBy: null,
  resources: null,
  coverage: { v: 1, files: [{ path: 'src/Web/Program.cs', runtime: 'server', functions: [[10, 12]] }] },
  stdout: 'order 4521 created\n',
  stderr: null,
} satisfies StreamEventPayload;

const wireTestCaseFixture = {
  type: 'complete',
  title: 't',
  location: 'a.spec.ts:1:1',
  status: 'passed',
  duration: 100,
  timeout: 30000,
  error: null,
  retries: 0,
  maxRetries: 2,
  repeatEachIndex: 0,
  attempts: null,
  workerIndex: 0,
  parallelIndex: 0,
  shardIndex: null,
  startedAt: 0,
  steps: null,
  stepEvents: null,
  slowestStep: null,
  slowestStepDuration: null,
  wastedTimeMs: null,
  networkRequests: null,
  webVitals: null,
  pageState: { url: 'https://app.example.com/checkout', localStorage: [{ key: 'cart', length: 42 }] },
  pageInventory: [
    { url: 'https://app.example.com/checkout', controls: [{ role: 'button', name: 'Place order' }], links: [] },
  ],
  aiUsage: null,
  consoleLogs: null,
  dialogs: null,
  ariaSnapshot: null,
  ariaSnapshotJson: null,
  testSource: null,
  testSourceFrames: [{ file: 'a.spec.ts', line: 1, snippet: '> 1 | test' }],
  browser: null,
  suitePath: null,
  suiteConfig: null,
  testAnnotations: null,
  tags: ['smoke'],
  testMeta: { owner: 'checkout-team' },
  stepCategory: null,
  parentTitle: null,
  locatorSnapshots: null,
  didNotRunReason: null,
  blockedBy: null,
  resources: null,
  coverage: { v: 1, files: [{ path: 'src/Web/Program.cs', runtime: 'server', functions: [[10, 12]] }] },
  stdout: 'order 4521 created\n',
  stderr: null,
} satisfies WireTestCase;

// Every field of the reporter's step events, each also a `StreamEventPayload`, so a field renamed or removed on
// either side fails the typecheck.
// Every field of the reporter's begin event, also a `StreamEventPayload`.
const beginFixture = {
  type: 'begin',
  title: 't',
  location: 'a.spec.ts:1:1',
  retries: 1,
  maxRetries: 2,
  tags: ['smoke'],
  locks: ['db'],
  testMeta: { owner: 'checkout' },
  repeatEachIndex: 0,
  workerIndex: 3,
  parallelIndex: 1,
  shardIndex: null,
  browser: null,
  suitePath: null,
  suiteConfig: null,
} satisfies BeginStreamEvent satisfies StreamEventPayload;

const stepBeginFixture = {
  type: 'step-begin',
  title: 'Click',
  subtitle: "getByRole('button')",
  location: 'a.spec.ts:1:1',
  stepCategory: 'pw:api',
  parentTitle: 't',
  workerIndex: 0,
  shardIndex: 2,
  startedAt: 0,
} satisfies StepBeginStreamEvent satisfies StreamEventPayload;
const stepEndFixture = {
  type: 'step-end',
  title: 'Click',
  subtitle: "getByRole('button')",
  location: 'a.spec.ts:1:1',
  status: 'passed',
  duration: 5,
  stepCategory: 'pw:api',
  parentTitle: 't',
  workerIndex: 0,
  shardIndex: 2,
  startedAt: 0,
} satisfies StepEndStreamEvent satisfies StreamEventPayload;

describe('wire ↔ shared per-case contract drift guard', () => {
  test('WireTestCase carries every TestCasePayload field', () => {
    const missing = Object.keys(testCasePayloadFixture).filter((k) => !(k in wireTestCaseFixture));
    expect(missing, 'fields present in TestCasePayload but missing from WireTestCase').toEqual([]);
  });

  test('WireTestCase carries every StreamEventPayload field', () => {
    const missing = Object.keys(streamEventPayloadFixture).filter((k) => !(k in wireTestCaseFixture));
    expect(missing, 'fields present in StreamEventPayload but missing from WireTestCase').toEqual([]);
  });

  test("the reporter's begin event reaches the run stream with its attempt, its worker and what search reads", () => {
    expect(testBeginData(beginFixture, 0)).toMatchObject({
      retries: 1,
      maxRetries: 2,
      workerIndex: 3,
      parallelIndex: 1,
      tags: ['smoke'],
      locks: ['db'],
    });
  });

  test("the reporter's step events reach the run stream with their shard and worker", () => {
    const published = mapStepEventsToRunEvents([stepBeginFixture, stepEndFixture]);
    expect(published.map((e) => [e.type, e.data.shardIndex, e.data.workerIndex])).toEqual([
      ['step-begin', 2, 0],
      ['step-end', 2, 0],
    ]);
  });

  test('WireTestCase has no fields unaccounted for by either shared contract', () => {
    const known = new Set([...Object.keys(testCasePayloadFixture), ...Object.keys(streamEventPayloadFixture)]);
    const unexpected = Object.keys(wireTestCaseFixture).filter((k) => !known.has(k));
    expect(unexpected, 'WireTestCase fields not backed by TestCasePayload or StreamEventPayload').toEqual([]);
  });
});
