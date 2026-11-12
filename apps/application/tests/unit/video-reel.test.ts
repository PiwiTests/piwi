import { describe, expect, it } from 'vitest';
import {
  VIDEO_TIMING_TOLERANCE_MS,
  buildReel,
  createPageEndMs,
  entryEndMs,
  focusLimit,
  focusReel,
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

describe('a video whose test span is unknown', () => {
  it('has no playing time of its own when the test has no start time', () => {
    const [reel] = buildReel([execution({ executionId: 1, startedAt: null })], 'worker');
    expect(reel!.entries[0]!.lengthMs).toBe(0);
  });

  it('has none when the span maps to nothing: a test that ended before the video began', () => {
    const [reel] = buildReel(
      [execution({ executionId: 1, startedAt: T0, durationMs: 100, createPageEndMs: T0 + 5000 })],
      'worker',
    );
    expect(reel!.entries[0]!.lengthMs).toBe(0);
  });

  it('plays the whole video once its length is known, and nothing before', () => {
    const [reel] = buildReel([execution({ executionId: 1, startedAt: null })], 'worker');
    const entry = reel!.entries[0]!;
    expect(entryEndMs(entry)).toBe(0);
    expect(entryEndMs(entry, 4200)).toBe(4200);
  });

  it('is never ticked before its length is known', () => {
    const [reel] = buildReel([execution({ executionId: 1, startedAt: null })], 'worker');
    expect(tickedEntries(reel!, { index: 0, videoMs: 0 })).toEqual([false]);
    expect(tickedEntries(reel!, { index: 0, videoMs: 4200, endMs: 4200 })).toEqual([true]);
  });

  it('still ends a test with a known span at its end, held to a shorter video', () => {
    const [reel] = buildReel([execution({ executionId: 1, durationMs: 1000 })], 'worker');
    expect(entryEndMs(reel!.entries[0]!, 5000)).toBe(1000);
    expect(entryEndMs(reel!.entries[0]!, 600)).toBe(600);
  });

  it('has no end for a test with no video', () => {
    const [reel] = buildReel([execution({ executionId: 1, video: null })], 'worker');
    expect(entryEndMs(reel!.entries[0]!, 5000)).toBe(0);
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
    expect(tickedEntries(reel, { index: 0, videoMs: 1000 })).toEqual([true, true, false]);
  });

  it('ticks the tests before the playing one, a test with no video among them', () => {
    expect(tickedEntries(reel, { index: 2, videoMs: 10 })).toEqual([true, true, false]);
  });

  it('ticks a test with no video along with the test before it, also at the end of the reel', () => {
    const tail = buildReel(
      [execution({ executionId: 1, startedAt: T0 }), execution({ executionId: 2, startedAt: T0 + 2000, video: null })],
      'worker',
    )[0]!;
    expect(tickedEntries(tail, { index: 0, videoMs: 500 })).toEqual([false, false]);
    expect(tickedEntries(tail, { index: 0, videoMs: 1000 })).toEqual([true, true]);
  });

  it('ticks at the end the cursor names, a video shorter than its test', () => {
    expect(tickedEntries(reel, { index: 0, videoMs: 600, endMs: 600 })).toEqual([true, true, false]);
  });
});

describe('focusReel', () => {
  // Two files: a.spec.ts declares tests 1 to 3 (on slots 0, 1, 0), b.spec.ts declares test 4 (slot 1).
  const run = [
    execution({ executionId: 1, filePath: 'tests/a.spec.ts', line: 10, parallelIndex: 0, startedAt: T0 }),
    execution({ executionId: 2, filePath: 'tests/a.spec.ts', line: 20, parallelIndex: 1, startedAt: T0 + 100 }),
    execution({ executionId: 3, filePath: 'tests/a.spec.ts', line: 5, parallelIndex: 0, startedAt: T0 + 2000 }),
    execution({ executionId: 4, filePath: 'tests/b.spec.ts', line: 1, parallelIndex: 1, startedAt: T0 + 2100 }),
  ];
  const by = (id: number) => run.find((e) => e.executionId === id)!;
  const ids = (r: { reel: { entries: Array<{ execution: ReelExecution }> } } | null) =>
    r?.reel.entries.map((e) => e.execution.executionId);

  describe('This test', () => {
    it('plays the test alone, with the other tests of its file listed after the declared order as context', () => {
      const focused = focusReel(run, by(2), 'test')!;
      expect(ids(focused)).toEqual([3, 1, 2]);
      expect(focused.focusIndex).toBe(2);
      expect(focused.reel.entries.map((e) => e.context ?? false)).toEqual([true, true, false]);
      expect(focused.reel.videoCount).toBe(1);
      expect(focused.reel.totalMs).toBe(1000);
      expect(focused.reel.entries[2]!.execution.video).not.toBeNull();
    });

    it('lists no test of another file', () => {
      expect(ids(focusReel(run, by(4), 'test'))).toEqual([4]);
    });

    it('keeps the context out of playing time, with no video of its own', () => {
      const [a, b] = focusReel(run, by(1), 'test')!.reel.entries;
      expect(a!.execution.video).toBeNull();
      expect(a!.lengthMs).toBe(0);
      expect(a!.reelStartMs).toBe(0);
      expect(b!.reelStartMs).toBe(0);
    });

    it('is null for a test with no video', () => {
      expect(focusReel(run, { ...by(2), video: null }, 'test')).toBeNull();
    });

    it('plays an earlier attempt in the place of the final one, with its own video', () => {
      const earlier = execution({
        executionId: 22,
        testCaseId: 2,
        filePath: 'tests/a.spec.ts',
        line: 20,
        retries: 0,
        status: 'failed',
        video: { id: 22, path: 'p/22.webm', contentType: 'video/webm', size: 10 },
      });
      const final = { ...by(2), retries: 1 };
      const focused = focusReel([by(1), final, by(3), by(4)], earlier, 'test')!;
      expect(ids(focused)).toEqual([3, 1, 22]);
      expect(focused.reel.entries[2]!.execution.video!.path).toBe('p/22.webm');
      expect(focused.focusIndex).toBe(2);
    });

    it('adds the test to the list when the run list was cut and holds nothing of it', () => {
      const missing = execution({ executionId: 99, testCaseId: 99, filePath: 'tests/a.spec.ts', line: 30 });
      const focused = focusReel(run, missing, 'test')!;
      expect(ids(focused)).toEqual([3, 1, 2, 99]);
      expect(focused.focusIndex).toBe(3);
    });
  });

  describe('Whole file', () => {
    it('lists the final attempts of the file in declared order, each with its worker slot', () => {
      const focused = focusReel(run, by(2), 'file')!;
      expect(ids(focused)).toEqual([3, 1, 2]);
      expect(focused.focusIndex).toBe(2);
      expect(focused.reel.entries.map((e) => e.laneLabel)).toEqual(['Worker 1', 'Worker 1', 'Worker 2']);
      expect(focused.reel.entries.every((e) => !e.context)).toBe(true);
      expect(focused.reel.totalMs).toBe(3000);
    });

    it('leaves out an earlier attempt of a retried test, and a test that did not run', () => {
      const retried = [
        ...run,
        { ...by(2), executionId: 12, retries: 1, status: 'failed' },
        { ...by(2), executionId: 2, retries: 0, status: 'failed' },
        execution({ executionId: 5, filePath: 'tests/a.spec.ts', line: 40, status: 'skipped', video: null }),
      ].filter((e, i, all) => all.findIndex((o) => o.executionId === e.executionId) === i);
      const focused = focusReel(
        retried,
        retried.find((e) => e.executionId === 12)!,
        'file',
      )!;
      expect(ids(focused)).toEqual([3, 1, 12]);
    });

    it('is null for an execution that is not on the list', () => {
      const earlier = { ...by(2), executionId: 22, retries: 0 };
      expect(focusReel([by(1), { ...by(2), retries: 1 }], earlier, 'file')).toBeNull();
    });
  });

  describe('Its worker', () => {
    it('is the reel of the slot the test ran in, in the order they ran', () => {
      const focused = focusReel(run, by(3), 'worker')!;
      expect(ids(focused)).toEqual([1, 3]);
      expect(focused.focusIndex).toBe(1);
      expect(focused.reel.label).toBe('Worker 1');
    });

    it('holds the tests of other files that ran in the slot', () => {
      expect(ids(focusReel(run, by(2), 'worker'))).toEqual([2, 4]);
    });

    it("keeps the shard in the label, and tells a shard's slot from another shard's", () => {
      const sharded = run.map((e) => ({ ...e, shardIndex: e.executionId === 3 ? 2 : 1 }));
      const focused = focusReel(sharded, sharded[0]!, 'worker')!;
      expect(focused.reel.label).toBe('Worker 1 (shard 1)');
      expect(ids(focused)).toEqual([1]);
    });

    it('is null for an execution that is not on the list', () => {
      expect(focusReel([by(1)], { ...by(2), retries: 0 }, 'worker')).toBeNull();
    });
  });

  describe('focusLimit', () => {
    it('is null for a final attempt that is listed', () => {
      expect(focusLimit(run, by(2))).toBeNull();
    });

    it('names an earlier attempt: the list holds a later one of the same result', () => {
      expect(focusLimit([{ ...by(2), retries: 1 }], { ...by(2), executionId: 22, retries: 0 })).toBe('earlier-attempt');
    });

    it('does not take a later attempt of another browser or repetition for the final one', () => {
      const other = { ...by(2), retries: 1, browserName: 'firefox' };
      expect(focusLimit([other], { ...by(2), executionId: 22 })).toBe('not-listed');
      expect(
        focusLimit([{ ...other, browserName: 'chromium', repeatEachIndex: 1 }], { ...by(2), executionId: 22 }),
      ).toBe('not-listed');
    });

    it('names a test the list does not hold: the list was cut', () => {
      expect(focusLimit(run, execution({ executionId: 99, testCaseId: 99 }))).toBe('not-listed');
    });
  });

  it('ticks only the test in focus on a This test reel', () => {
    const { reel, focusIndex } = focusReel(run, by(2), 'test')!;
    expect(tickedEntries(reel, null)).toEqual([false, false, false]);
    expect(tickedEntries(reel, { index: focusIndex, videoMs: 500 })).toEqual([false, false, false]);
    expect(tickedEntries(reel, { index: focusIndex, videoMs: 1000 })).toEqual([false, false, true]);
  });
});
