import { describe, test, expect } from 'vitest';
import { mapStepEventsToRunEvents } from '../../server/utils/map-step-events';
import type { StreamEventPayload } from '#shared/types';

// One worker, one running test: every step below belongs to it.
const onWorker = { location: 'tests/signup.spec.ts:9:5', parentTitle: 'signup keeps the email', workerIndex: 0 };

const waitBegin: StreamEventPayload = {
  type: 'step-begin',
  title: 'Wait for timeout',
  stepCategory: 'pw:api',
  startedAt: 1700000000000,
  ...onWorker,
};
const waitEnd: StreamEventPayload = {
  type: 'step-end',
  title: 'Wait for timeout',
  stepCategory: 'pw:api',
  status: 'passed',
  duration: 500,
  startedAt: 1700000000000,
  ...onWorker,
};
const expectBegin: StreamEventPayload = {
  type: 'step-begin',
  title: 'Expect "toHaveValue"',
  subtitle: "getByLabel('Email')",
  stepCategory: 'expect',
  startedAt: 1700000000500,
  ...onWorker,
};

const hookBegin: StreamEventPayload = {
  type: 'step-begin',
  title: 'beforeAll hook',
  location: 'tests/signup.spec.ts:3:3',
  stepCategory: 'hook',
  parentTitle: null,
  workerIndex: 0,
  startedAt: 1699999999000,
};
const hookEnd: StreamEventPayload = { ...hookBegin, type: 'step-end', status: 'passed', duration: 80 };

const sequence = (batch: StreamEventPayload[]) =>
  mapStepEventsToRunEvents(batch).map((e) => `${e.type} ${e.data.title}`);

describe('mapStepEventsToRunEvents', () => {
  test('keeps the batch order, so a step ends before the next one begins', () => {
    expect(sequence([waitBegin, waitEnd, expectBegin])).toEqual([
      'step-begin Wait for timeout',
      'step-end Wait for timeout',
      'step-begin Expect "toHaveValue"',
    ]);
  });

  test('suite-level hooks keep their place among test-attached steps', () => {
    expect(sequence([hookBegin, waitBegin, hookEnd, waitEnd])).toEqual([
      'test-begin beforeAll hook',
      'step-begin Wait for timeout',
      'test-completed beforeAll hook',
      'step-end Wait for timeout',
    ]);
  });

  test('names no text a fill typed, whatever reporter sent the step', () => {
    const fill: StreamEventPayload = {
      ...waitBegin,
      title: 'Fill "S3cr3t!Passw0rd"',
      subtitle: "getByLabel('Password')",
    };
    expect(sequence([fill, { ...fill, type: 'step-end', status: 'passed', duration: 4 }])).toEqual([
      'step-begin Fill "<hidden>"',
      'step-end Fill "<hidden>"',
    ]);
  });

  test('keeps the title of a step the test names itself', () => {
    const own: StreamEventPayload = { ...waitBegin, title: 'Fill "Shipping address"', stepCategory: 'test.step' };
    expect(sequence([own])).toEqual(['step-begin Fill "Shipping address"']);
  });

  test('skips test-case begin and complete events', () => {
    const begin: StreamEventPayload = {
      type: 'begin',
      title: 'signup keeps the email',
      location: 'tests/signup.spec.ts:5:1',
    };
    const complete: StreamEventPayload = { ...begin, type: 'complete', status: 'passed', duration: 1200 };
    expect(sequence([begin, waitBegin, complete])).toEqual(['step-begin Wait for timeout']);
    expect(mapStepEventsToRunEvents([begin, complete])).toEqual([]);
  });

  test('a test-attached step streams with its target, category and outcome', () => {
    const [begin, end] = mapStepEventsToRunEvents([
      expectBegin,
      { ...expectBegin, type: 'step-end', status: 'failed', duration: 18000 },
    ]);
    expect(begin).toEqual({
      type: 'step-begin',
      data: {
        title: 'Expect "toHaveValue"',
        subtitle: "getByLabel('Email')",
        parentTitle: 'signup keeps the email',
        stepCategory: 'expect',
        location: 'tests/signup.spec.ts:9:5',
        workerIndex: 0,
        startedAt: 1700000000500,
      },
    });
    expect(end).toEqual({
      type: 'step-end',
      data: {
        title: 'Expect "toHaveValue"',
        subtitle: "getByLabel('Email')",
        parentTitle: 'signup keeps the email',
        stepCategory: 'expect',
        status: 'failed',
        duration: 18000,
        location: 'tests/signup.spec.ts:9:5',
        workerIndex: 0,
        startedAt: 1700000000500,
      },
    });
  });

  test('a suite-level hook publishes under the hooks file path', () => {
    const [begin, end] = mapStepEventsToRunEvents([hookBegin, hookEnd]);
    expect(begin).toEqual({
      type: 'test-begin',
      data: {
        title: 'beforeAll hook',
        filePath: 'hooks',
        parentTitle: null,
        stepCategory: 'hook',
        location: 'tests/signup.spec.ts:3:3',
        workerIndex: 0,
        startedAt: 1699999999000,
      },
    });
    expect(end).toEqual({
      type: 'test-completed',
      data: {
        title: 'beforeAll hook',
        filePath: 'hooks',
        parentTitle: null,
        stepCategory: 'hook',
        status: 'passed',
        duration: 80,
        location: 'tests/signup.spec.ts:3:3',
        workerIndex: 0,
        startedAt: 1699999999000,
      },
    });
  });

  test('missing optional fields stream as null', () => {
    const [step] = mapStepEventsToRunEvents([
      {
        type: 'step-begin',
        title: 'Click',
        location: 'tests/signup.spec.ts:12:5',
        parentTitle: 'signup keeps the email',
      },
    ]);
    expect(step!.data).toMatchObject({ subtitle: null, stepCategory: null, workerIndex: null, startedAt: null });
  });
});
