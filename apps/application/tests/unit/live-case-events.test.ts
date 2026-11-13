import { describe, expect, test } from 'vitest';
import type { StreamEventPayload } from '#shared/types';
import { testBeginData, testCompletedData } from '../../server/utils/live-case-events';
import { mapWireCaseToRunCase } from '../../server/utils/map-wire-case';
import { ENDED_AT_STOP_REASON } from '@piwitests/core/run-channel';
import { isEndedAtStop } from '#shared/utils/skip-kind';

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
      expectedStatus: null,
    });
    const shouldFail: StreamEventPayload = { ...complete, expectedStatus: 'failed' };
    expect(testCompletedData(shouldFail, mapWireCaseToRunCase(shouldFail), undefined).expectedStatus).toBe('failed');
  });

  test('carries the failure cluster the attempt joined and its label, else none', () => {
    const complete: StreamEventPayload = { ...begin, type: 'complete', status: 'failed', duration: 900, error: 'boom' };
    const stored = { id: 41, testCaseId: 7, attempts: null, passedAfterFailure: false };
    const label = { name: 'Pay button times out', status: 'open' };
    expect(
      testCompletedData(complete, mapWireCaseToRunCase(complete), {
        ...stored,
        failureClusterId: 3,
        failureCluster: label,
      }),
    ).toMatchObject({ failureClusterId: 3, failureCluster: label });
    for (const persisted of [undefined, { ...stored, failureClusterId: null, failureCluster: label }]) {
      expect(testCompletedData(complete, mapWireCaseToRunCase(complete), persisted)).toMatchObject({
        failureClusterId: null,
        failureCluster: null,
      });
    }
  });

  test('carries the attempt’s annotations, so its row reads a test ended at a stop', () => {
    const ended: StreamEventPayload = {
      ...begin,
      type: 'complete',
      status: 'skipped',
      duration: 300,
      testAnnotations: [{ type: 'skip', description: ENDED_AT_STOP_REASON }],
    };
    const data = testCompletedData(ended, mapWireCaseToRunCase(ended), undefined);
    expect(isEndedAtStop(data as unknown as Parameters<typeof isEndedAtStop>[0])).toBe(true);
    const plain: StreamEventPayload = { ...ended, testAnnotations: undefined };
    expect(testCompletedData(plain, mapWireCaseToRunCase(plain), undefined).testAnnotations).toBeNull();
  });
});
