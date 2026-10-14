import { describe, test, expect } from 'vitest';
import {
  useTimelineModel,
  computeLockSummary,
  isHookKind,
  type TimelineItem,
  type TimelineModelInput,
} from '../../app/composables/useTimelineModel';
import type { TestCaseResult, TestStepEvent } from '../../types/api';

type StepLike = Partial<TestStepEvent> & { title: string; category: string };
type CaseLike = {
  executionId: number;
  testCaseId?: number;
  location?: string;
  browser?: { projectName?: string } | null;
  title: string;
  status: string;
  workerIndex: number | null;
  shardIndex?: number | null;
  startedAt?: number | null;
  duration?: number | null;
  stepEvents?: StepLike[] | null;
  locks?: string[] | null;
  retries?: number | null;
};

/** Minimal test-kind timeline item for the pure lock-summary tests. */
function testItem(start: number, duration: number, locks: string[]): TimelineItem {
  return {
    key: `t${start}`,
    kind: 'test',
    testCaseId: start,
    title: `t${start}`,
    status: 'passed',
    workerIndex: 0,
    start,
    duration,
    rowIndex: 0,
    locks,
  };
}

function model(cases: CaseLike[], extra: Partial<TimelineModelInput> = {}) {
  return useTimelineModel({ testCases: cases as unknown as TestCaseResult[], ...extra });
}

describe('useTimelineModel', () => {
  test('positions bars by startedAt, renders hooks and only wasted waits', () => {
    const { timelineData, workerRows, maxTime } = model([
      {
        executionId: 1,
        title: 'A',
        status: 'passed',
        workerIndex: 0,
        startedAt: 1000,
        duration: 500,
        stepEvents: [
          { title: 'Before Hooks', category: 'hook', startedAt: 1000, duration: 100, status: 'passed' },
          { title: 'Wait for load state', category: 'wait', startedAt: 1100, duration: 50, status: 'passed' },
          { title: 'Wait for timeout', category: 'wait', startedAt: 1200, duration: 200, status: 'wasted' },
        ],
      },
      {
        executionId: 2,
        title: 'B',
        status: 'passed',
        workerIndex: 1,
        startedAt: 1000,
        duration: 400,
        stepEvents: null,
      },
    ]);

    const items = timelineData.value;
    // Two test bars, one hook, one wasted wait. The non-wasted "load state"
    // wait is dropped.
    expect(items.filter((d) => d.kind === 'test')).toHaveLength(2);
    expect(items.filter((d) => d.kind === 'hook')).toHaveLength(1);
    expect(items.filter((d) => d.kind === 'wait')).toHaveLength(1);
    expect(items.some((d) => d.title === 'Wait for load state')).toBe(false);

    const aBar = items.find((d) => d.key === 't1')!;
    expect(aBar.start).toBe(0); // anchored to the run's min startedAt
    expect(aBar.testCaseId).toBe(1);
    const wasted = items.find((d) => d.kind === 'wait')!;
    expect(wasted.start).toBe(200); // 1200 - 1000
    expect(wasted.duration).toBe(200);

    expect(workerRows.value).toHaveLength(2);
    expect(maxTime.value).toBe(500);
  });

  test('sequential fallback packs cases and waits when startedAt is absent', () => {
    const { timelineData, maxTime } = model([
      {
        executionId: 1,
        title: 'A',
        status: 'passed',
        workerIndex: 0,
        duration: 300,
        stepEvents: [{ title: 'Wait for timeout', category: 'wait', duration: 100, status: 'wasted' }],
      },
    ]);

    const items = timelineData.value;
    const bar = items.find((d) => d.kind === 'test')!;
    const wait = items.find((d) => d.kind === 'wait')!;
    expect(bar.start).toBe(0);
    expect(wait.start).toBe(300); // appended right after the test bar
    expect(maxTime.value).toBe(400);
  });

  test('groups rows into shards', () => {
    const { workerRows, shardGroups } = model([
      { executionId: 1, title: 'A', status: 'passed', workerIndex: 0, shardIndex: 0, startedAt: 1000, duration: 100 },
      { executionId: 2, title: 'B', status: 'passed', workerIndex: 0, shardIndex: 1, startedAt: 1000, duration: 100 },
    ]);

    expect(workerRows.value).toHaveLength(2);
    expect(shardGroups.value).toEqual([
      { shardIndex: 0, rowRange: [0, 0] },
      { shardIndex: 1, rowRange: [1, 1] },
    ]);
  });

  test('skips cases without a worker index', () => {
    const { timelineData, workerRows } = model([
      { executionId: 1, title: 'A', status: 'passed', workerIndex: null, startedAt: 1000, duration: 100 },
    ]);
    expect(timelineData.value).toHaveLength(0);
    expect(workerRows.value).toHaveLength(0);
  });

  test('flags suite setup steps and keeps the fixture kind distinct', () => {
    const { timelineData } = model(
      [
        {
          executionId: 1,
          title: 'A',
          status: 'passed',
          workerIndex: 0,
          startedAt: 1000,
          duration: 300,
          stepEvents: [
            { title: 'Before Hooks', category: 'hook', startedAt: 1000, duration: 40, status: 'passed' },
            { title: 'fixture: page', category: 'fixture', startedAt: 1040, duration: 30, status: 'passed' },
          ],
        },
      ],
      {
        setupSteps: [
          { title: 'beforeAll', category: 'hook', workerIndex: 0, startedAt: 1000, duration: 50, status: 'passed' },
        ] as unknown as TimelineModelInput['setupSteps'],
      },
    );

    const items = timelineData.value;
    const setup = items.find((d) => d.kind === 'setup');
    expect(setup?.title).toContain('[Setup]');
    expect(setup?.testCaseId).toBeNull();
    const fixture = items.find((d) => d.kind === 'fixture');
    expect(fixture?.title).toBe('fixture: page');
    const hook = items.find((d) => d.kind === 'hook');
    expect(hook?.title).toBe('Before Hooks');
  });

  test('carries a hook section, the hooks it ran and its error onto the bar', () => {
    const { timelineData } = model([
      {
        executionId: 1,
        title: 'A',
        status: 'failed',
        workerIndex: 0,
        startedAt: 1000,
        duration: 400,
        stepEvents: [
          {
            title: 'Before Hooks',
            category: 'hook',
            startedAt: 1000,
            duration: 200,
            status: 'passed',
            hooks: [
              { title: 'beforeAll hook', category: 'hook', duration: 150 },
              { title: 'Fixture "page"', category: 'fixture', duration: 50 },
            ],
          },
          {
            title: 'After Hooks',
            category: 'hook',
            startedAt: 1300,
            duration: 60,
            status: 'failed',
            error: 'Error: afterAll boom',
            hooks: [{ title: 'afterAll hook', category: 'hook', duration: 60, failed: true }],
          },
          { title: 'Worker Cleanup', category: 'hook', startedAt: 1360, duration: 5, status: 'passed' },
        ],
      },
    ]);

    const hooks = timelineData.value.filter((d) => isHookKind(d.kind));
    expect(hooks.map((d) => [d.title, d.section])).toEqual([
      ['Before Hooks', 'setup'],
      ['After Hooks', 'teardown'],
      ['Worker Cleanup', 'teardown'],
    ]);
    expect(hooks[0]!.hooks?.map((h) => h.title)).toEqual(['beforeAll hook', 'Fixture "page"']);
    expect(hooks[0]!.error).toBeNull();
    expect(hooks[1]!.status).toBe('failed');
    expect(hooks[1]!.error).toBe('Error: afterAll boom');
    // A section from an older reporter carries no breakdown.
    expect(hooks[2]!.hooks).toBeNull();
  });

  test('lays a replacement worker process on the lane its predecessor left', () => {
    // Two worker slots. Process 0 fails and Playwright replaces it with process 2,
    // which retries on the same slot; process 1 runs alongside the whole time.
    const { timelineData, workerRows } = model([
      { executionId: 1, title: 'A', status: 'failed', workerIndex: 0, startedAt: 1000, duration: 500 },
      { executionId: 2, title: 'B', status: 'passed', workerIndex: 1, startedAt: 1000, duration: 2500 },
      { executionId: 3, title: 'A', status: 'passed', workerIndex: 2, startedAt: 2200, duration: 400, retries: 1 },
      { executionId: 4, title: 'C', status: 'passed', workerIndex: 2, startedAt: 2600, duration: 900 },
    ] as CaseLike[]);

    expect(workerRows.value.map((r) => [r.slot, r.processes])).toEqual([
      [0, [0, 2]],
      [1, [1]],
    ]);
    const items = timelineData.value;
    expect(items.find((d) => d.key === 't3')!.rowIndex).toBe(items.find((d) => d.key === 't1')!.rowIndex);
    expect(items.find((d) => d.key === 't3')!.slot).toBe(0);

    // The stretch between the failed test and the retry is the new process starting up.
    const restart = items.find((d) => d.kind === 'restart')!;
    expect(restart.start).toBe(500);
    expect(restart.duration).toBe(700);
    expect(restart.gap?.after).toEqual({ title: 'A', status: 'failed', workerIndex: 0 });
    expect(restart.gap?.before).toEqual({ title: 'A', status: 'passed', workerIndex: 2 });
    // Worker 1 finishes at 3500, the run at 3500: no idle tail on either lane.
    expect(items.filter((d) => d.kind === 'idle')).toHaveLength(0);
  });

  test('marks idle stretches of a lane and leaves short ones unmarked', () => {
    const { timelineData } = model([
      { executionId: 1, title: 'A', status: 'passed', workerIndex: 0, startedAt: 1000, duration: 500 },
      // 100ms later: too short to mark.
      { executionId: 2, title: 'B', status: 'passed', workerIndex: 0, startedAt: 1600, duration: 500 },
      // 2s later on the same process: idle.
      { executionId: 3, title: 'C', status: 'passed', workerIndex: 0, startedAt: 4100, duration: 500 },
      // Worker 1 starts late and ends early.
      { executionId: 4, title: 'D', status: 'passed', workerIndex: 1, startedAt: 2000, duration: 1000 },
    ] as CaseLike[]);

    const idle = timelineData.value
      .filter((d) => d.kind === 'idle')
      .map((d) => [d.slot, d.start, d.duration, d.gap?.after?.title ?? null, d.gap?.before?.title ?? null]);
    expect(idle).toEqual([
      [0, 1100, 2000, 'B', 'C'],
      [1, 0, 1000, null, 'D'],
      [1, 2000, 1600, 'D', null],
    ]);
    expect(timelineData.value.some((d) => d.kind === 'restart')).toBe(false);
  });

  test('marks no empty stretches while the run is live', () => {
    const { timelineData } = model(
      [
        { executionId: 1, title: 'A', status: 'failed', workerIndex: 0, startedAt: 1000, duration: 500 },
        { executionId: 2, title: 'B', status: 'passed', workerIndex: 1, startedAt: 3000, duration: 500 },
      ],
      { live: true },
    );
    expect(timelineData.value.some((d) => d.kind === 'idle' || d.kind === 'restart')).toBe(false);
  });

  test('honors a custom wasted-wait pattern', () => {
    const { timelineData } = model(
      [
        {
          executionId: 1,
          title: 'A',
          status: 'passed',
          workerIndex: 0,
          startedAt: 1000,
          duration: 300,
          stepEvents: [
            { title: 'Wait for response', category: 'wait', startedAt: 1050, duration: 80, status: 'passed' },
          ],
        },
      ],
      { wastedPatterns: ['Wait for response*'] },
    );
    expect(timelineData.value.filter((d) => d.kind === 'wait')).toHaveLength(1);
  });

  // Step ids stay unique across tests with adjacent ids (test 101 step 1 vs
  // test 102 step 0): colliding ids would break hover dimming (bars sharing the
  // hovered id stay highlighted) and duplicate v-for keys.
  test('assigns a unique key to every item across tests with adjacent ids', () => {
    const steps: StepLike[] = [
      { title: 'Before Hooks', category: 'hook', startedAt: 1000, duration: 40, status: 'passed' },
      { title: 'Wait for timeout', category: 'wait', startedAt: 1100, duration: 100, status: 'wasted' },
      { title: 'After Hooks', category: 'hook', startedAt: 1300, duration: 30, status: 'passed' },
    ];
    const { timelineData } = model([
      {
        executionId: 101,
        title: 'A',
        status: 'passed',
        workerIndex: 0,
        startedAt: 1000,
        duration: 500,
        stepEvents: steps,
      },
      {
        executionId: 102,
        title: 'B',
        status: 'passed',
        workerIndex: 0,
        startedAt: 1600,
        duration: 500,
        stepEvents: steps,
      },
      {
        executionId: 103,
        title: 'C',
        status: 'passed',
        workerIndex: 1,
        startedAt: 1000,
        duration: 500,
        stepEvents: steps,
      },
    ]);

    const items = timelineData.value;
    // 3 tests × (1 bar + 2 hooks + 1 wait), plus worker 1 idling after C until B ends.
    expect(items).toHaveLength(13);
    expect(items.filter((d) => d.kind === 'idle')).toHaveLength(1);
    const keys = items.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('hook and wait segments carry their owning test case id', () => {
    const { timelineData } = model([
      {
        executionId: 7,
        title: 'A',
        status: 'passed',
        workerIndex: 0,
        startedAt: 1000,
        duration: 500,
        stepEvents: [
          { title: 'Before Hooks', category: 'hook', startedAt: 1000, duration: 40, status: 'passed' },
          { title: 'Wait for timeout', category: 'wait', startedAt: 1100, duration: 100, status: 'wasted' },
        ],
      },
    ]);

    for (const segment of timelineData.value.filter((d) => d.kind !== 'test')) {
      expect(segment.testCaseId).toBe(7);
      expect(segment.parentTitle).toBe('A');
    }
  });

  // Regression: setup items used to carry shardIndex null while sitting on a
  // real shard's row, which made the row list (then re-derived from items)
  // grow a phantom empty row per setup worker on sharded runs.
  test('sharded runs with setup steps do not grow phantom rows', () => {
    const { timelineData, workerRows, shardGroups } = model(
      [
        { executionId: 1, title: 'A', status: 'passed', workerIndex: 0, shardIndex: 1, startedAt: 1000, duration: 100 },
        { executionId: 2, title: 'B', status: 'passed', workerIndex: 0, shardIndex: 2, startedAt: 1000, duration: 100 },
      ],
      {
        setupSteps: [
          { title: 'beforeAll', category: 'hook', workerIndex: 0, startedAt: 1000, duration: 50, status: 'passed' },
        ] as unknown as TimelineModelInput['setupSteps'],
      },
    );

    expect(workerRows.value).toHaveLength(2);
    expect(shardGroups.value).toHaveLength(2);
    // The setup step lands on the first shard's row for that worker.
    expect(timelineData.value.find((d) => d.kind === 'setup')?.rowIndex).toBe(0);
  });

  test('ignores step categories that are not hooks, fixtures or waits', () => {
    const { timelineData } = model([
      {
        executionId: 1,
        title: 'A',
        status: 'passed',
        workerIndex: 0,
        startedAt: 1000,
        duration: 300,
        stepEvents: [
          { title: 'expect.toBe', category: 'expect', startedAt: 1010, duration: 5, status: 'passed' },
          { title: 'my step', category: 'test.step', startedAt: 1020, duration: 50, status: 'passed' },
        ],
      },
    ]);

    expect(timelineData.value).toHaveLength(1);
    expect(timelineData.value[0]!.kind).toBe('test');
  });

  test('links the attempts of a retried test across lanes and marks every attempt but the last as retried', () => {
    const { timelineData } = model([
      // Attempt 2 is listed first: the order comes from the retry index, not the input.
      {
        executionId: 2,
        testCaseId: 7,
        title: 'pays',
        status: 'passed',
        retries: 1,
        workerIndex: 2,
        startedAt: 6000,
        duration: 1000,
      },
      {
        executionId: 1,
        testCaseId: 7,
        title: 'pays',
        status: 'failed',
        retries: 0,
        workerIndex: 0,
        startedAt: 1000,
        duration: 2000,
      },
      {
        executionId: 3,
        testCaseId: 8,
        title: 'lists',
        status: 'passed',
        workerIndex: 1,
        startedAt: 1000,
        duration: 500,
      },
      // The same test in another browser project is another test.
      {
        executionId: 4,
        testCaseId: 7,
        title: 'pays',
        status: 'failed',
        workerIndex: 1,
        startedAt: 2000,
        duration: 900,
        browser: { projectName: 'firefox' },
      },
    ]);
    const bar = (id: number) => timelineData.value.find((d) => d.key === `t${id}`)!;

    expect(bar(1).attemptKeys).toEqual(['t1', 't2']);
    expect(bar(2).attemptKeys).toBe(bar(1).attemptKeys);
    expect(bar(1).retried).toBe(true);
    expect(bar(2).retried).toBe(false);
    expect(bar(3).attemptKeys ?? null).toBeNull();
    expect(bar(3).retried ?? false).toBe(false);
    expect(bar(4).attemptKeys ?? null).toBeNull();
  });

  test('links live attempts by title and location before they carry a test case id', () => {
    const { timelineData } = model(
      [
        {
          executionId: -1,
          testCaseId: 0,
          title: 'pays',
          location: 'a.spec.ts:3:5',
          status: 'failed',
          workerIndex: 0,
          startedAt: 1000,
          duration: 900,
        },
        {
          executionId: -2,
          testCaseId: 0,
          title: 'pays',
          location: 'a.spec.ts:3:5',
          status: 'running',
          retries: 1,
          workerIndex: 1,
          startedAt: 2500,
          duration: 100,
        },
        {
          executionId: -3,
          testCaseId: 0,
          title: 'pays',
          location: 'b.spec.ts:3:5',
          status: 'passed',
          workerIndex: 2,
          startedAt: 1000,
          duration: 900,
        },
      ],
      { live: true },
    );
    const bar = (id: number) => timelineData.value.find((d) => d.key === `t${id}`)!;

    expect(bar(-1).attemptKeys).toEqual(['t-1', 't-2']);
    expect(bar(-1).retried).toBe(true);
    expect(bar(-3).attemptKeys ?? null).toBeNull();
  });

  test('exposes the run locks (sorted, distinct) and carries them onto test bars', () => {
    const { runLocks, timelineData } = model([
      {
        executionId: 1,
        title: 'A',
        status: 'passed',
        workerIndex: 0,
        startedAt: 1000,
        duration: 500,
        locks: ['db', 'api'],
      },
      { executionId: 2, title: 'B', status: 'passed', workerIndex: 1, startedAt: 1000, duration: 400, locks: ['db'] },
      { executionId: 3, title: 'C', status: 'passed', workerIndex: 0, startedAt: 1600, duration: 200, locks: null },
    ]);
    expect(runLocks.value).toEqual(['api', 'db']);
    expect(timelineData.value.find((d) => d.key === 't1')!.locks).toEqual(['db', 'api']);
    expect(timelineData.value.find((d) => d.key === 't3')!.locks).toBeNull();
  });
});

describe('computeLockSummary', () => {
  test('reports held time, share and back-to-back serialization per lock', () => {
    // Two holders of `db` run back-to-back (gap 0), one holder of `api` alone.
    const items = [testItem(0, 1000, ['db']), testItem(1000, 1000, ['db']), testItem(3000, 500, ['api'])];
    const summary = computeLockSummary(items, 4000);

    const db = summary.find((r) => r.lock === 'db')!;
    expect(db.testCount).toBe(2);
    expect(db.heldMs).toBe(2000); // merged 0..2000
    expect(db.share).toBeCloseTo(0.5);
    // The second holder started within 500ms of the first ending → serialized.
    expect(db.serializationMs).toBe(1000);

    const api = summary.find((r) => r.lock === 'api')!;
    expect(api.serializationMs).toBe(0); // a single holder never serializes

    // Ordered by held time descending.
    expect(summary[0]!.lock).toBe('db');
  });

  test('a gap over 500ms is not counted as serialization', () => {
    const items = [testItem(0, 1000, ['db']), testItem(2000, 1000, ['db'])];
    const summary = computeLockSummary(items, 4000);
    expect(summary[0]!.serializationMs).toBe(0);
  });

  test('flags a lock that dominates the run tail', () => {
    // Held across the whole final quarter (3000..4000) of a 4000ms run.
    const summary = computeLockSummary([testItem(2800, 1200, ['db'])], 4000);
    expect(summary[0]!.dominatesTail).toBe(true);
  });

  test('ignores non-test items and lock-less bars', () => {
    const hook: TimelineItem = { ...testItem(0, 100, ['db']), kind: 'hook' };
    const summary = computeLockSummary([hook, testItem(0, 100, [])], 1000);
    expect(summary).toHaveLength(0);
  });
});
