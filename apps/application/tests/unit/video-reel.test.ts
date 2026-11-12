import { describe, expect, it } from 'vitest';
import {
  VIDEO_TIMING_TOLERANCE_MS,
  buildReel,
  createPageEndMs,
  testSpanInVideo,
  tickedEntries,
  videoTimingMap,
  type ReelExecution,
} from '#shared/video-reel';

const T0 = 1_700_000_000_000;

function execution(over: Partial<ReelExecution> & { executionId: number }): ReelExecution {
  return {
    testCaseId: over.executionId,
    title: `test ${over.executionId}`,
    filePath: 'tests/a.spec.ts',
    line: over.executionId,
    column: 1,
    status: 'passed',
    retries: 0,
    repeatEachIndex: 0,
    browserName: 'chromium',
    passedAfterFailure: false,
    shardIndex: null,
    parallelIndex: 0,
    workerIndex: 0,
    startedAt: T0,
    durationMs: 1000,
    createPageEndMs: null,
    video: { id: over.executionId, path: `p/${over.executionId}.webm`, contentType: 'video/webm', size: 10 },
    ...over,
  };
}

describe('createPageEndMs', () => {
  it('is the end of the first Create page step', () => {
    const steps = [
      { title: 'Launch browser', startTime: T0, duration: 40 },
      { title: 'Create page', startTime: T0 + 100, duration: 30 },
      { title: 'Create page', startTime: T0 + 900, duration: 30 },
    ];
    expect(createPageEndMs(steps)).toBe(T0 + 130);
  });

  it('is null without the step, or when it has no timing', () => {
    expect(createPageEndMs([{ title: 'Navigate', startTime: T0, duration: 5 }])).toBeNull();
    expect(createPageEndMs([{ title: 'Create page' }])).toBeNull();
    expect(createPageEndMs(null)).toBeNull();
  });
});

describe('videoTimingMap', () => {
  it('anchors the video 55 ms before the end of Create page', () => {
    const map = videoTimingMap({ startedAtMs: T0, durationMs: 2000, createPageEndMs: T0 + 400 })!;
    expect(map.source).toBe('create-page');
    expect(map.videoStartMs).toBe(T0 + 345);
    expect(map.toVideoMs(T0 + 345 + 1000)).toBe(1000);
    expect(testSpanInVideo(map)).toEqual({ startMs: 0, endMs: 1655 });
  });

  it('falls back to the test start when there is no Create page step', () => {
    const map = videoTimingMap({ startedAtMs: T0, durationMs: 2000, createPageEndMs: null })!;
    expect(map.source).toBe('start');
    expect(map.videoStartMs).toBe(T0);
    expect(testSpanInVideo(map)).toEqual({ startMs: 0, endMs: 2000 });
  });

  it('maps the first test of a worker, whose browser launch comes before the page', () => {
    const map = videoTimingMap({ startedAtMs: T0, durationMs: 3000, createPageEndMs: T0 + 1200 })!;
    expect(testSpanInVideo(map).startMs).toBe(0);
    expect(testSpanInVideo(map).endMs).toBe(3000 - 1145);
  });

  it('holds a mapped time to the video, at both ends', () => {
    const map = videoTimingMap({ startedAtMs: T0, durationMs: 5000, createPageEndMs: T0 + 100 }, 2000)!;
    expect(map.toVideoMs(T0 - 10_000)).toBe(0);
    expect(map.toVideoMs(T0 + 60_000)).toBe(2000);
    expect(testSpanInVideo(map).endMs).toBe(2000);
  });

  it('is within the tolerance of a frame measured 60 ms off', () => {
    const map = videoTimingMap({ startedAtMs: T0, durationMs: 2000, createPageEndMs: T0 + 400 })!;
    const measured = 1000 + 52; // where the frame that shows the event was found
    expect(Math.abs(map.toVideoMs(T0 + 345 + 1000) - measured)).toBeLessThanOrEqual(VIDEO_TIMING_TOLERANCE_MS);
  });

  it('is null when the test has no start', () => {
    expect(videoTimingMap({ startedAtMs: null, durationMs: 100, createPageEndMs: null })).toBeNull();
  });
});

describe('buildReel', () => {
  it('keeps the final attempt of a retried test only', () => {
    const reels = buildReel(
      [
        execution({ executionId: 1, testCaseId: 7, retries: 0, status: 'failed' }),
        execution({ executionId: 2, testCaseId: 7, retries: 1, status: 'passed', passedAfterFailure: true }),
      ],
      'worker',
    );
    expect(reels).toHaveLength(1);
    expect(reels[0]!.entries.map((e) => e.execution.executionId)).toEqual([2]);
  });

  it('keeps a failed test without a video as an entry that takes no playing time', () => {
    const [reel] = buildReel(
      [
        execution({ executionId: 1, startedAt: T0 }),
        execution({ executionId: 2, startedAt: T0 + 2000, status: 'failed', video: null }),
        execution({ executionId: 3, startedAt: T0 + 4000 }),
      ],
      'worker',
    );
    expect(reel!.entries.map((e) => [e.execution.executionId, e.lengthMs])).toEqual([
      [1, 1000],
      [2, 0],
      [3, 1000],
    ]);
    expect(reel!.entries[2]!.reelStartMs).toBe(1000);
    expect(reel!.videoCount).toBe(2);
    expect(reel!.hasFailure).toBe(true);
    expect(reel!.totalMs).toBe(2000);
  });

  it('makes one reel per worker lane, each in the order its tests ran', () => {
    const reels = buildReel(
      [
        execution({ executionId: 1, parallelIndex: 1, workerIndex: 1, startedAt: T0 + 3000 }),
        execution({ executionId: 2, parallelIndex: 0, workerIndex: 0, startedAt: T0 + 1000 }),
        execution({ executionId: 3, parallelIndex: 1, workerIndex: 1, startedAt: T0 + 500 }),
        execution({ executionId: 4, parallelIndex: 0, workerIndex: 0, startedAt: T0 }),
      ],
      'worker',
    );
    expect(reels.map((r) => r.label)).toEqual(['Worker 1', 'Worker 2']);
    expect(reels.map((r) => r.entries.map((e) => e.execution.executionId))).toEqual([
      [4, 2],
      [3, 1],
    ]);
  });

  it('keeps a lane whose worker Playwright restarted on one reel', () => {
    const reels = buildReel(
      [
        execution({ executionId: 1, parallelIndex: 0, workerIndex: 0, startedAt: T0 }),
        execution({ executionId: 2, parallelIndex: 0, workerIndex: 3, startedAt: T0 + 2000 }),
      ],
      'worker',
    );
    expect(reels).toHaveLength(1);
    expect(reels[0]!.entries).toHaveLength(2);
  });

  it('makes one reel in declared order for the file grouping, tagging each test with its worker', () => {
    const reels = buildReel(
      [
        execution({ executionId: 1, filePath: 'tests/b.spec.ts', line: 5, parallelIndex: 0, startedAt: T0 }),
        execution({ executionId: 2, filePath: 'tests/a.spec.ts', line: 20, parallelIndex: 1, workerIndex: 1 }),
        execution({ executionId: 3, filePath: 'tests/a.spec.ts', line: 3, parallelIndex: 0, startedAt: T0 + 900 }),
      ],
      'file',
    );
    expect(reels).toHaveLength(1);
    expect(reels[0]!.entries.map((e) => [e.execution.executionId, e.laneLabel])).toEqual([
      [3, 'Worker 1'],
      [2, 'Worker 2'],
      [1, 'Worker 1'],
    ]);
  });

  it('puts results with no worker on one reel', () => {
    const reels = buildReel(
      [
        execution({ executionId: 1, parallelIndex: null, workerIndex: null }),
        execution({ executionId: 2, parallelIndex: null, workerIndex: null, startedAt: T0 + 2000 }),
      ],
      'worker',
    );
    expect(reels).toHaveLength(1);
    expect(reels[0]!.label).toBe('No worker');
    expect(reels[0]!.entries.map((e) => e.laneLabel)).toEqual([null, null]);
  });

  it('leaves out tests that did not run, and is empty without executions', () => {
    expect(buildReel([], 'worker')).toEqual([]);
    expect(buildReel([execution({ executionId: 1, status: 'skipped', video: null })], 'file')).toEqual([]);
  });

  it('keeps the browsers and repetitions of one test as separate entries', () => {
    const [reel] = buildReel(
      [
        execution({ executionId: 1, testCaseId: 9, browserName: 'chromium', startedAt: T0 }),
        execution({ executionId: 2, testCaseId: 9, browserName: 'firefox', startedAt: T0 + 2000 }),
        execution({ executionId: 3, testCaseId: 9, browserName: 'firefox', repeatEachIndex: 1, startedAt: T0 + 4000 }),
      ],
      'worker',
    );
    expect(reel!.entries).toHaveLength(3);
  });

  it('uses the mapped end of a test, not its duration, for the playing time', () => {
    const [reel] = buildReel([execution({ executionId: 1, durationMs: 2000, createPageEndMs: T0 + 400 })], 'worker');
    expect(reel!.entries[0]!.lengthMs).toBe(1655);
  });
});

describe('tickedEntries', () => {
  const reel = buildReel(
    [
      execution({ executionId: 1, startedAt: T0 }),
      execution({ executionId: 2, startedAt: T0 + 2000, video: null }),
      execution({ executionId: 3, startedAt: T0 + 4000 }),
    ],
    'worker',
  )[0]!;

  it('ticks nothing before playback begins', () => {
    expect(tickedEntries(reel, null)).toEqual([false, false, false]);
  });

  it('ticks the playing test once its video passes the end of the test', () => {
    expect(tickedEntries(reel, { index: 0, videoMs: 999 })).toEqual([false, false, false]);
    expect(tickedEntries(reel, { index: 0, videoMs: 1000 })).toEqual([true, false, false]);
  });

  it('ticks the tests before the playing one, a test with no video among them', () => {
    expect(tickedEntries(reel, { index: 2, videoMs: 10 })).toEqual([true, true, false]);
  });
});
