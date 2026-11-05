import { test, expect } from 'vitest';
import { stepLabel } from '@piwitests/core/step-analysis';
import {
  captionCall,
  liveStepForCase,
  liveStepOf,
  STILL_PAGE_MS,
  type LiveStepsByWorker,
} from '../../app/utils/live-steps';
import type { TestCaseResult } from '../../types/api';

function makeCase(overrides: Partial<TestCaseResult>): TestCaseResult {
  return {
    executionId: 1,
    testCaseId: 1,
    title: 'checkout completes',
    status: 'running',
    location: 'tests/checkout.spec.ts:5:3',
    workerIndex: 0,
    ...overrides,
  } as TestCaseResult;
}

const steps: LiveStepsByWorker = {
  ':0': { title: 'click "Pay now"', category: 'pw:api', parentTitle: 'checkout completes' },
  ':1': { title: 'expect(page).toHaveURL(...)', category: 'expect', status: 'passed', parentTitle: 'catalog filters' },
};

test('matches the running row to its worker step', () => {
  expect(liveStepForCase(steps, makeCase({}))?.title).toBe('click "Pay now"');
});

test('in a sharded run, each shard’s worker shows its own step', () => {
  const sharded: LiveStepsByWorker = {
    '1:0': { title: 'Click', parentTitle: 'pays by card' },
    '2:0': { title: 'Fill', parentTitle: 'searches' },
  };
  expect(liveStepForCase(sharded, makeCase({ title: 'pays by card', shardIndex: 1 }))?.title).toBe('Click');
  expect(liveStepForCase(sharded, makeCase({ title: 'searches', shardIndex: 2 }))?.title).toBe('Fill');
});

test('a step a reporter sent without its shard still shows on its worker’s row', () => {
  const unsharded: LiveStepsByWorker = { ':0': { title: 'Click', parentTitle: 'pays by card' } };
  expect(liveStepForCase(unsharded, makeCase({ title: 'pays by card', shardIndex: 2 }))?.title).toBe('Click');
});

test('only running rows show a step', () => {
  expect(liveStepForCase(steps, makeCase({ status: 'passed' }))).toBeNull();
  expect(liveStepForCase(steps, makeCase({ status: 'failed' }))).toBeNull();
});

test('rows without a worker, and workers without a step, show nothing', () => {
  expect(liveStepForCase(steps, makeCase({ workerIndex: null }))).toBeNull();
  expect(liveStepForCase(steps, makeCase({ workerIndex: 7 }))).toBeNull();
  expect(liveStepForCase(null, makeCase({}))).toBeNull();
  expect(liveStepForCase(undefined, makeCase({}))).toBeNull();
});

test('a lingering step from the previous test never surfaces on the next row', () => {
  // Worker 1's last step belongs to "catalog filters"; a new test began on
  // that worker but its first step has not arrived yet.
  const next = makeCase({ title: 'catalog sorts by price', workerIndex: 1 });
  expect(liveStepForCase(steps, next)).toBeNull();
  // The step still shows on the row it belongs to (same worker, same title).
  const owner = makeCase({ title: 'catalog filters', workerIndex: 1 });
  expect(liveStepForCase(steps, owner)?.status).toBe('passed');
});

test('a step with no parent title falls back to the worker match', () => {
  const anonymous: LiveStepsByWorker = { ':0': { title: 'fixture: context', category: 'fixture' } };
  expect(liveStepForCase(anonymous, makeCase({}))?.title).toBe('fixture: context');
});

test('a live step keeps its subtitle, and the label composes both', () => {
  const withSubtitle: LiveStepsByWorker = {
    ':0': {
      title: 'Click',
      subtitle: "getByRole('button', { name: 'Pay' })",
      category: 'pw:api',
      parentTitle: 'checkout completes',
    },
  };
  const live = liveStepForCase(withSubtitle, makeCase({}));
  expect(live?.subtitle).toBe("getByRole('button', { name: 'Pay' })");
  expect(stepLabel(live!)).toBe("Click getByRole('button', { name: 'Pay' })");
});

test('finds a watched worker’s step in its test, by shard and worker, else by worker alone', () => {
  const sharded: LiveStepsByWorker = {
    '2:0': { title: 'Fill', category: 'pw:api', parentTitle: 'pays by card' },
    ':1': { title: 'Click', category: 'pw:api', parentTitle: 'searches' },
  };
  expect(liveStepOf(sharded, { shard: 2, worker: 0, test: 'pays by card' })?.title).toBe('Fill');
  expect(liveStepOf(sharded, { shard: 1, worker: 0, test: 'pays by card' })).toBeNull();
  expect(liveStepOf(sharded, { shard: 3, worker: 1, test: 'searches' })?.title).toBe('Click');
  expect(liveStepOf(sharded, { shard: 2, worker: 0, test: 'another test' })).toBeNull();
});

test('a live view’s caption names the call log’s call, else the step newer than the image, else the image’s', () => {
  const framed = { title: "Fill getByLabel('Card')", file: 'tests/pay.spec.ts', line: 11 };
  const logged = { title: "Click getByRole('button')", file: 'tests/pay.spec.ts', line: 12 };
  const step = { title: 'Click', subtitle: "getByRole('button', { name: 'Pay' })", category: 'pw:api' };
  const view = { logged: null, framed, framedAt: 1_000, step, stepAt: 1_000 + STILL_PAGE_MS + 1 };

  expect(captionCall({ ...view, logged })).toBe(logged);
  expect(captionCall(view)).toEqual({ title: "Click getByRole('button', { name: 'Pay' })", file: null, line: null });
  // The step reached the page soon after the image: it may be one the image has gone past, delayed by its batch.
  expect(captionCall({ ...view, stepAt: 1_000 + STILL_PAGE_MS })).toBe(framed);
  expect(captionCall({ ...view, stepAt: 500 })).toBe(framed);
  // A step known before any image is named at once.
  expect(captionCall({ ...view, framed: null, framedAt: 0 })?.title).toBe("Click getByRole('button', { name: 'Pay' })");
  // Its credentials and typed text are hidden, as an image's call has them.
  const navigate = { title: 'Navigate to "/login?token=abcd1234efgh5678ijkl"', category: 'pw:api' };
  expect(captionCall({ ...view, step: navigate })?.title).not.toContain('abcd1234efgh5678ijkl');
  const fill = { title: 'Fill "hunter2"', subtitle: "getByLabel('Password')", category: 'pw:api' };
  expect(captionCall({ ...view, step: fill })?.title).not.toContain('hunter2');
  // The step is the image's call: the image's place stays, with its link.
  expect(
    captionCall({ ...view, framed: { ...framed, title: "Click getByRole('button', { name: 'Pay' })" } })?.file,
  ).toBe('tests/pay.spec.ts');
  // A hook or a fixture is no call an image is taken at.
  expect(captionCall({ ...view, step: { title: 'beforeEach hook', category: 'hook' } })).toBe(framed);
  expect(captionCall({ ...view, framed: null, step: null })).toBeNull();
});
