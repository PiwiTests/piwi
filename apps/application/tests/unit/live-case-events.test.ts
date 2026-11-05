import { describe, expect, test } from 'vitest';
import type { StreamEventPayload } from '#shared/types';
import { testBeginData, testCompletedData } from '../../server/utils/live-case-events';
import { mapWireCaseToRunCase } from '../../server/utils/map-wire-case';

const begin: StreamEventPayload = {
  type: 'begin',
  title: 'pays by card',
  location: 'tests/checkout.spec.ts:12:3',
  workerIndex: 4,
  parallelIndex: 1,
  shardIndex: 2,
  startedAt: 1_000,
  retries: 1,
  maxRetries: 2,
  tags: ['@smoke', 'checkout', 'smoke'],
  locks: ['db'],
  testMeta: { owner: 'payments', priority: 'high' },
};

describe('testBeginData', () => {
  test('says which attempt begins of how many, and what the run page searches', () => {
    expect(testBeginData(begin, 5_000)).toMatchObject({
      title: 'pays by card',
      filePath: 'tests/checkout.spec.ts',
      workerIndex: 4,
      parallelIndex: 1,
      shardIndex: 2,
      startedAt: 1_000,
      retries: 1,
      maxRetries: 2,
      tags: ['smoke', 'checkout'],
      locks: ['db'],
      testMeta: { owner: 'payments', priority: 'high' },
    });
  });

  test('leaves out what an older reporter does not send, or sends in the wrong shape', () => {
    const data = testBeginData(
      {
        type: 'begin',
        title: 'searches',
        location: 'tests/search.spec.ts:3:1',
        retries: -1,
        maxRetries: 'two' as unknown as number,
        parallelIndex: -1,
        tags: 'smoke' as unknown as string[],
        testMeta: { owner: 42 } as unknown as StreamEventPayload['testMeta'],
      },
      5_000,
    );
    expect(data).toMatchObject({
      startedAt: 5_000,
      workerIndex: null,
      parallelIndex: null,
      retries: null,
      maxRetries: null,
      tags: null,
      locks: null,
    });
    expect(data.testMeta).toBeNull();
  });
});

describe('testCompletedData', () => {
  test('carries the attempt as stored, with its ids once persisted, and what the run page searches', () => {
    const complete: StreamEventPayload = { ...begin, type: 'complete', status: 'failed', duration: 900, error: 'boom' };
    const data = testCompletedData(complete, mapWireCaseToRunCase(complete), {
      id: 41,
      testCaseId: 7,
      attempts: null,
      passedAfterFailure: false,
    });
    expect(data).toMatchObject({
      status: 'failed',
      retries: 1,
      executionId: 41,
      testCaseId: 7,
      workerIndex: 4,
      parallelIndex: 1,
      shardIndex: 2,
      tags: ['smoke', 'checkout'],
      locks: ['db'],
      testMeta: { owner: 'payments', priority: 'high' },
    });
  });
});
