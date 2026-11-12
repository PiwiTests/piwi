import { describe, test, expect } from 'vitest';
import { reactive } from 'vue';
import {
  useTimelineModel,
  computeLockSummary,
  isHookKind,
  runningTimeNotes,
  testTimeNotes,
  timelineLaneCount,
  type TimelineItem,
  type TimelineModelInput,
} from '../../app/composables/useTimelineModel';
import { livePlotEnd, liveRunNow, pauseReasonText, shardsStartedText } from '../../app/utils/timeline';
import { usualDurationKey } from '../../shared/stuck-tests';
import type { TestCaseResult, TestStepEvent } from '../../types/api';

type StepLike = Partial<TestStepEvent> & { title: string; category: string };
type CaseLike = {
  executionId: number;
  testCaseId?: number;
  location?: string;
  browser?: { projectName?: string } | null;
  filePath?: string;
  suitePath?: string[];
  stuck?: { elapsedMs: number; usualMs: number } | null;
  title: string;
  status: string;
  workerIndex: number | null;
  parallelIndex?: number | null;
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

describe('the lanes a reporter names', () => {
  /** A test run by worker process `workerIndex` on lane `parallelIndex`, from `startedAt` for `duration`. */
  const ran = (
    executionId: number,
    workerIndex: number,
    parallelIndex: number | undefined,
    startedAt: number | null,
    duration = 500,
    extra: Partial<CaseLike> = {},
  ): CaseLike => ({
    executionId,
    title: `T${executionId}`,
    status: 'passed',
    workerIndex,
    ...(parallelIndex !== undefined ? { parallelIndex } : {}),
    startedAt,
    duration,
    ...extra,
  });
  const lanes = (cases: CaseLike[]) => model(cases).workerRows.value.map((r) => [r.shardIndex, r.slot, r.processes]);

  test('puts a replacement worker process on the lane it took, whatever freed up last', () => {
    // Process 0 fails on lane 0 and Playwright starts process 2 there; lane 1 freed up later, which timing alone picks.
    const cases = [ran(1, 0, 0, 1000, 500, { status: 'failed' }), ran(2, 1, 1, 1000, 600), ran(3, 2, 0, 1700, 400)];
    expect(lanes(cases)).toEqual([
      [null, 0, [0, 2]],
      [null, 1, [1]],
    ]);
    expect(lanes(cases.map(({ parallelIndex: _lane, ...rest }) => rest))).toEqual([
      [null, 0, [0]],
      [null, 1, [1, 2]],
    ]);
    const { timelineData } = model(cases);
    const restart = timelineData.value.find((d) => d.kind === 'restart')!;
    expect([restart.slot, restart.start, restart.duration]).toEqual([0, 500, 200]);
    expect(timelineData.value.find((d) => d.key === 't3')!.slot).toBe(0);
  });

  test('orders lanes by their number, not by when they started', () => {
    expect(lanes([ran(1, 0, 1, 1000), ran(2, 1, 0, 1200)])).toEqual([
      [null, 0, [1]],
      [null, 1, [0]],
    ]);
  });

  test('numbers the lanes of each shard from its own first', () => {
    expect(
      lanes([
        ran(1, 0, 0, 1000, 500, { shardIndex: 2 }),
        ran(2, 1, 1, 1000, 500, { shardIndex: 1 }),
        ran(3, 0, 0, 1000, 500, { shardIndex: 1 }),
      ]),
    ).toEqual([
      [1, 0, [0]],
      [1, 1, [1]],
      [2, 0, [0]],
    ]);
  });

  test('works the lanes out from the timing in a shard where a process names none', () => {
    expect(lanes([ran(1, 0, 1, 1000), ran(2, 1, undefined, 1200)])).toEqual([
      [null, 0, [0]],
      [null, 1, [1]],
    ]);
  });

  test('counts the lanes it lays out, which the Timeline tab shows, not the worker processes', () => {
    // One shard, two workers, three failures: Playwright starts a new process after each, five on two lanes.
    const failed = { status: 'failed' };
    const cases = [
      ran(1, 0, 0, 1000, 500, failed),
      ran(2, 1, 1, 1000, 500, failed),
      ran(3, 2, 0, 1600, 500, failed),
      ran(4, 3, 1, 1600, 500),
      ran(5, 4, 0, 2200, 500),
    ];
    const count = (list: CaseLike[]) => timelineLaneCount(list as unknown as TestCaseResult[]);
    expect(count(cases)).toBe(2);
    expect(model(cases).workerRows.value).toHaveLength(2);
    // Results that name no lane: the timeline works the same two lanes out from the timing.
    const unnamed = cases.map(({ parallelIndex: _lane, ...rest }) => rest);
    expect(count(unnamed)).toBe(2);
    expect(model(unnamed).workerRows.value).toHaveLength(2);
    // A shard where one process names no lane is laid out from the timing as a whole.
    const mixed = [...cases.slice(0, 4), ran(5, 4, undefined, 2200, 500)];
    expect([count(mixed), model(mixed).workerRows.value.length]).toEqual([2, 2]);
    // Each shard's lanes, a test without a worker left out.
    const sharded = [
      ran(1, 0, 0, 1000, 500, { shardIndex: 1 }),
      ran(2, 0, 0, 1000, 500, { shardIndex: 2 }),
      { executionId: 3, title: 'never ran', status: 'skipped', workerIndex: null },
    ];
    expect(count(sharded)).toBe(2);
    expect(count([])).toBe(0);
  });

  test("packs a lane's processes one after another when no test carries a start", () => {
    const { timelineData, workerRows } = model([
      ran(1, 0, 0, null, 500, { status: 'failed' }),
      ran(2, 1, 1, null, 800),
      ran(3, 2, 0, null, 300),
    ]);
    expect(workerRows.value.map((r) => [r.slot, r.processes])).toEqual([
      [0, [0, 2]],
      [1, [1]],
    ]);
    const bar = (key: string) => timelineData.value.find((d) => d.key === key)!;
    expect([bar('t3').rowIndex, bar('t3').start]).toEqual([bar('t1').rowIndex, 500]);
  });
});

describe('stops at the pause bar', () => {
  // A test held 4 s at a breakpoint: Playwright reports 400 ms, the steps keep their clock.
  const paused = (): CaseLike => ({
    executionId: 1,
    title: 'pays',
    status: 'passed',
    workerIndex: 0,
    startedAt: 1000,
    duration: 400,
    stepEvents: [
      { title: 'Before Hooks', category: 'hook', startedAt: 1000, duration: 100, status: 'passed' },
      {
        title: "Click getByRole('button')",
        category: 'pause',
        startedAt: 1200,
        duration: 4000,
        status: 'breakpoint',
        location: 'tests/pay.spec.ts:12:5',
      },
      { title: 'After Hooks', category: 'hook', startedAt: 5300, duration: 100, status: 'passed' },
    ],
  });

  test('draws each stop as a band of its test, and spans the test’s bar over it', () => {
    const items = model([paused()]).timelineData.value;
    const bar = items.find((d) => d.kind === 'test')!;
    expect([bar.start, bar.duration, bar.reportedDuration, bar.pausedMs]).toEqual([0, 4400, 400, 4000]);
    const band = items.find((d) => d.kind === 'pause')!;
    expect(band).toMatchObject({
      testCaseId: 1,
      title: "Click getByRole('button')",
      status: 'breakpoint',
      subtitle: 'tests/pay.spec.ts:12',
      start: 200,
      duration: 4000,
      parentTitle: 'pays',
    });
    expect(isHookKind(band.kind)).toBe(false);
  });

  test('reads a stop stored without its reason as at a breakpoint, as the failure timeline does', () => {
    const tc = paused();
    tc.stepEvents = tc.stepEvents!.map((e) => (e.category === 'pause' ? { ...e, status: undefined } : e));
    const band = model([tc]).timelineData.value.find((d) => d.kind === 'pause')!;
    expect(pauseReasonText(band.status)).toBe('Stopped at a breakpoint');
  });

  test('says why each stop stopped in the run page’s words, and names no origin for a Pause, which any tool sends', () => {
    const reasons = ['breakpoint', 'step', 'pause', 'run-to', 'page-pause', 'failure', 'other', 'newer', null];
    expect(reasons.map(pauseReasonText)).toEqual([
      'Stopped at a breakpoint',
      'Stopped after a step',
      'Paused',
      'Stopped at the line it ran to',
      'Stopped at page.pause()',
      'Held at its failure',
      'Stopped',
      'Stopped',
      'Stopped at a breakpoint',
    ]);
  });

  test('says the rest of the bar is the time paused, with the hooks Playwright leaves out when there are any', () => {
    const bar = model([paused()]).timelineData.value.find((d) => d.kind === 'test')!;
    expect(testTimeNotes(bar)).toEqual([
      "Playwright reports 400ms; the rest is the 4.0s it stood paused at Piwi's pause bar.",
    ]);
    expect(testTimeNotes({ duration: 5400, reportedDuration: 400, pausedMs: 4000 })).toEqual([
      'Playwright reports 400ms; the rest is the 4.0s it stood paused and hooks it does not count (beforeAll, afterAll, worker fixtures).',
    ]);
    expect(testTimeNotes({ duration: 900, reportedDuration: 500, pausedMs: null })).toEqual([
      'Playwright reports 500ms; the rest ran in hooks it does not count (beforeAll, afterAll, worker fixtures).',
    ]);
    expect(testTimeNotes({ duration: 500, reportedDuration: null })).toEqual([]);
  });

  test('ends the bar of a test that stood paused with its last section, whatever duration it reports', () => {
    const bar = model([{ ...paused(), duration: 7_500 }]).timelineData.value.find((d) => d.kind === 'test')!;
    expect([bar.start, bar.duration, bar.reportedDuration ?? null, bar.pausedMs]).toEqual([0, 4400, null, 4000]);
  });

  test('keeps the notes true for a test that ended under the bar, whose reported duration counts the stop', () => {
    // A reported duration that counts the stop the test ended under: the bar is no longer than it...
    expect(testTimeNotes({ duration: 5000, reportedDuration: null, pausedMs: 4000 })).toEqual([
      "Paused 4.0s at Piwi's pause bar.",
    ]);
    // ...or longer only by the hooks it does not count.
    expect(testTimeNotes({ duration: 6000, reportedDuration: 5500, pausedMs: 4000 })).toEqual([
      'Playwright reports 5.5s; the rest ran in hooks it does not count (beforeAll, afterAll, worker fixtures).',
      "Paused 4.0s at Piwi's pause bar.",
    ]);
  });

  test('reads no stop from an old reporter’s run', () => {
    const items = model([{ ...paused(), stepEvents: paused().stepEvents!.filter((e) => e.category !== 'pause') }])
      .timelineData.value;
    expect(items.some((d) => d.kind === 'pause')).toBe(false);
    expect(items.find((d) => d.kind === 'test')!.pausedMs).toBeUndefined();
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

describe('a live run’s lanes', () => {
  const browser = { projectName: 'chromium' };
  const done: CaseLike = {
    executionId: 1,
    title: 'adds to cart',
    status: 'passed',
    workerIndex: 0,
    parallelIndex: 0,
    shardIndex: 1,
    startedAt: 1000,
    duration: 4000,
    browser,
  };
  const running: CaseLike = {
    executionId: -1,
    title: 'pays with PayPal',
    filePath: 'tests/checkout.spec.ts',
    suitePath: ['Checkout'],
    status: 'running',
    workerIndex: 1,
    parallelIndex: 0,
    shardIndex: 2,
    startedAt: 3000,
    duration: null,
    browser,
  };
  const usual = new Map([
    [
      usualDurationKey({
        filePath: 'tests/checkout.spec.ts',
        suitePath: ['Checkout'],
        title: 'pays with PayPal',
        browser: 'chromium',
      }),
      8000,
    ],
  ]);

  test('draws each running attempt to now on the run’s clock, and every other bar as it is', () => {
    const input = reactive({
      testCases: [done, running] as unknown as TestCaseResult[],
      live: true,
      now: 7000 as number | null,
      usualDurations: usual,
    });
    const { timelineData, maxTime, knownUntil, shardGroups } = useTimelineModel(input);
    const bar = () => timelineData.value.find((item) => item.title === 'pays with PayPal')!;
    const doneBar = timelineData.value.find((item) => item.title === 'adds to cart')!;
    expect(bar()).toMatchObject({ start: 2000, duration: 4000, usualMs: 8000, stuck: false });
    expect(shardGroups.value.map((group) => group.shardIndex)).toEqual([1, 2]);

    input.now = 9500;
    expect(bar().duration).toBe(6500);
    // The finished bar is the same object, so it draws nothing again as the clock ticks.
    expect(timelineData.value.find((item) => item.title === 'adds to cart')).toBe(doneBar);
    // The plot's end and what the results tell move with the results, never with the clock.
    expect(maxTime.value).toBe(4000);
    expect(knownUntil.value).toBe(5000);

    // A clock behind the attempt's start draws it from its start.
    input.now = 2000;
    expect(bar().duration).toBe(0);
  });

  test('keeps what a finished bar draws the same objects as the clock ticks', () => {
    const hooked: CaseLike = {
      ...done,
      locks: ['db', 'auth'],
      stepEvents: [
        { title: 'Before Hooks', category: 'hook', startedAt: 1000, duration: 300, status: 'passed' },
        { title: 'Paused', category: 'pause', startedAt: 2000, duration: 500, status: 'pause' },
        { title: 'After Hooks', category: 'hook', startedAt: 4500, duration: 400, status: 'failed' },
      ],
    };
    const input = reactive({
      testCases: [hooked, { ...running, locks: ['db'] }] as unknown as TestCaseResult[],
      live: true,
      now: 7000 as number | null,
      usualDurations: usual,
      showHooks: true,
    });
    const { timelineData, settledData, hooksByTest, barLockColors, lockColorMap } = useTimelineModel(input);
    const ticking = timelineData.value;
    const settled = settledData.value;
    const hooks = hooksByTest.value.get(1)!;
    const colors = barLockColors.value.get('t1')!;
    expect(hooks.map((item) => item.title)).toEqual(['Before Hooks', 'Paused', 'After Hooks']);
    expect(colors).toEqual([lockColorMap.value.get('auth'), lockColorMap.value.get('db')]);

    input.now = 8000;
    // The running bar reaches now on a new array; what the finished bar draws is read from the settled items.
    expect(timelineData.value).not.toBe(ticking);
    expect(settledData.value).toBe(settled);
    expect(hooksByTest.value.get(1)).toBe(hooks);
    expect(barLockColors.value.get('t1')).toBe(colors);
    // The running bar's lock colors are one array too, the same before and after its copy.
    expect(barLockColors.value.get('t-1')).toEqual([lockColorMap.value.get('db')]);

    // With the hooks hidden, the bar keeps its failed section and its stop.
    input.showHooks = false;
    expect(hooksByTest.value.get(1)!.map((item) => item.title)).toEqual(['Paused', 'After Hooks']);
  });

  test('says where the usual time of the running attempt that would end last ends', () => {
    const input = reactive({
      testCases: [done, running] as unknown as TestCaseResult[],
      live: true,
      now: 7000 as number | null,
      usualDurations: usual as ReadonlyMap<string, number> | null,
    });
    const { usualUntil } = useTimelineModel(input);
    // It began 2 s after the timeline's zero and usually takes 8 s.
    expect(usualUntil.value).toBe(10_000);
    input.usualDurations = null;
    expect(usualUntil.value).toBe(0);
    expect(model([done]).usualUntil.value).toBe(0);
  });

  test('takes the usual duration a Stuck? mark carries, marks the bar stuck, and draws no ghost on a finished bar', () => {
    const stuck = { ...running, stuck: { elapsedMs: 200_000, usualMs: 9000 } };
    const { timelineData, knownUntil } = model([done, stuck], { live: true, now: 10_000, usualDurations: usual });
    // The server said how long it had run: the run's clock was at least there.
    expect(knownUntil.value).toBe(203_000);
    expect(timelineData.value.find((item) => item.title === 'pays with PayPal')).toMatchObject({
      usualMs: 9000,
      stuck: true,
    });
    const doneBar = timelineData.value.find((item) => item.title === 'adds to cart')!;
    expect(doneBar.usualMs).toBeUndefined();
    expect(doneBar.stuck).toBeUndefined();

    // A test the project has no passes of draws no ghost.
    const { timelineData: unknown } = model([{ ...running, title: 'pays with a gift card' }], {
      live: true,
      now: 5000,
    });
    expect(unknown.value[0]!.usualMs).toBeNull();
  });

  test('leaves a stored run’s bars as they are, with no clock', () => {
    const { timelineData, knownUntil } = model([done, running]);
    expect(timelineData.value.find((item) => item.title === 'pays with PayPal')!.duration).toBe(1000);
    expect(knownUntil.value).toBe(5000);
    expect(model([{ ...done, startedAt: null }]).knownUntil.value).toBeNull();
  });

  test('says how long a running test usually takes, and that it is stuck once marked', () => {
    expect(runningTimeNotes({ usualMs: null, stuck: false })).toEqual([]);
    expect(runningTimeNotes({ usualMs: 8000, stuck: false })).toEqual([
      'Its last passing runs took 8.0s at most: the pale bar behind it.',
    ]);
    expect(runningTimeNotes({ usualMs: 8000, stuck: true })).toEqual([
      'Stuck?: it has run far longer than its last passing runs, which took 8.0s at most.',
    ]);
  });

  test('reads the run’s clock from the results it heard when they run ahead of the browser’s', () => {
    expect(liveRunNow(10_000, null)).toBe(10_000);
    // Heard at 9 s that the run reached 9.5 s: half a second ahead, one second later.
    expect(liveRunNow(10_000, { at: 9500, seenAt: 9000 })).toBe(10_500);
    // A run whose results lag the browser's clock reads the browser's.
    expect(liveRunNow(10_000, { at: 4000, seenAt: 9000 })).toBe(10_000);
  });

  test('draws the plot past now, so it widens only once in a while', () => {
    expect(livePlotEnd(5000)).toBe(15_000);
    expect(livePlotEnd(100_000)).toBe(120_000);
  });

  test('says which shards of a sharded run have started', () => {
    expect(shardsStartedText([1, 2, 3], 3)).toBe('all 3 shards started');
    expect(shardsStartedText([2], 4)).toBe('shard 2 of 4 started');
    expect(shardsStartedText([3, 1, 1], 4)).toBe('shards 1 and 3 of 4 started');
    expect(shardsStartedText([1, 2, 4], 4)).toBe('shards 1, 2 and 4 of 4 started');
    expect(shardsStartedText([], 2)).toBe('no shard of 2 started');
  });
});
