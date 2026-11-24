import { describe, expect, test } from 'vitest';
import { waitingDispatchRow, waitingRequestRow, waitingRunRows, waitingRunsPollMs } from '../../app/utils/waiting-runs';
import { CI_DISPATCH_LIKELY_CAUSES, CI_DISPATCH_WAIT_HINT_MS } from '#shared/run-follow-up';
import type { CiDispatchView } from '#shared/ci-dispatches';
import type { RunRequestView } from '#shared/handlers/run-requests';

const AT = Date.parse('2026-11-20T10:00:00Z');

function dispatch(over: Partial<CiDispatchView> = {}): CiDispatchView {
  return {
    id: '0123456789abcdef',
    actionId: 'smoke',
    actionName: 'Smoke · staging',
    kind: 'suite',
    origin: 'page',
    provider: 'ci-server',
    preset: 'jenkins',
    url: 'https://jenkins.example.com/job/api/job/smoke/',
    args: '',
    ref: 'main',
    tests: null,
    state: 'dispatched',
    detail: null,
    runId: null,
    run: null,
    at: AT,
    byName: 'Ana',
    byUserId: 1,
    ...over,
  };
}

function request(over: Partial<RunRequestView> = {}): RunRequestView {
  return {
    id: 'r1',
    kind: 'run',
    projectId: 1,
    projectName: 'E2E',
    tests: [
      { filePath: 'tests/a.spec.ts', line: 3, title: 'pays', projectName: null },
      { filePath: 'tests/a.spec.ts', line: 9, title: 'refunds', projectName: null },
    ],
    options: {},
    source: { runId: 1 },
    state: 'waiting',
    outcome: null,
    detail: null,
    stopRequested: false,
    target: null,
    runId: null,
    environmentId: null,
    expiresAt: '2026-11-20T10:02:00Z',
    createdAt: '2026-11-20T10:00:30Z',
    updatedAt: '2026-11-20T10:00:30Z',
    ...over,
  } as RunRequestView;
}

describe('waitingDispatchRow', () => {
  test('a whole suite waiting for its run names the action and the branch, as its follow-up does', () => {
    expect(waitingDispatchRow(dispatch(), AT + 2 * 60_000)).toMatchObject({
      kind: 'dispatch',
      id: '0123456789abcdef',
      status: 'interrupted',
      lead: 'Waiting for CI',
      facts: 'Smoke · staging on main',
      at: AT,
      by: 'Ana',
      ciUrl: 'https://jenkins.example.com/job/api/job/smoke/',
      run: null,
      causes: [],
    });
  });

  test('a re-run counts its tests; a job on its own branch names none', () => {
    expect(waitingDispatchRow(dispatch({ kind: 'tests', tests: 1 }), AT)?.facts).toBe(
      '1 test · Smoke · staging on main',
    );
    expect(waitingDispatchRow(dispatch({ kind: 'tests', tests: 3, ref: null }), AT)?.facts).toBe(
      '3 tests · Smoke · staging',
    );
  });

  test('an action with no name left is named by its CI', () => {
    expect(waitingDispatchRow(dispatch({ actionName: null }), AT)?.facts).toBe('Jenkins on main');
    expect(waitingDispatchRow(dispatch({ actionName: null, provider: 'github', preset: undefined }), AT)?.facts).toBe(
      'GitHub Actions on main',
    );
  });

  test('after 30 minutes with no run, it says so and gives the likely causes', () => {
    const row = waitingDispatchRow(dispatch(), AT + CI_DISPATCH_WAIT_HINT_MS);
    expect(row?.lead).toBe('No run reported yet');
    expect(row?.causes).toEqual(CI_DISPATCH_LIKELY_CAUSES);
  });

  test('matched, it stays while its run goes on, with that run', () => {
    const goingOn = (status: string) =>
      waitingDispatchRow(
        dispatch({
          state: 'running',
          runId: 12,
          run: { id: 12, status, totalTests: 3, passedTests: 0, failedTests: 0 },
        }),
        AT + CI_DISPATCH_WAIT_HINT_MS,
      );
    expect(goingOn('running')).toMatchObject({ lead: 'Running', status: 'running', run: { id: 12 }, causes: [] });
    expect(goingOn('initializing')?.lead).toBe('Running');
    expect(goingOn('finalizing')?.lead).toBe('Running');
  });

  test('a dispatch whose run stopped going on, or that can no longer be answered, has no row', () => {
    const ran = (status: string) => ({ id: 12, status, totalTests: 3, passedTests: 3, failedTests: 0 });
    expect(waitingDispatchRow(dispatch({ state: 'ended', runId: 12, run: ran('passed') }), AT)).toBeNull();
    expect(waitingDispatchRow(dispatch({ state: 'running', runId: 12, run: ran('interrupted') }), AT)).toBeNull();
    expect(waitingDispatchRow(dispatch({ state: 'unreported' }), AT)).toBeNull();
    expect(waitingDispatchRow(dispatch({ state: 'refused', detail: 'No such job' }), AT)).toBeNull();
  });
});

describe('waitingRequestRow', () => {
  test('a waiting request says where it stands and counts its tests', () => {
    expect(waitingRequestRow(request())).toMatchObject({
      kind: 'request',
      id: 'r1',
      status: 'interrupted',
      lead: 'Waiting for one of your apps to pick it up',
      facts: '2 tests',
      at: Date.parse('2026-11-20T10:00:30Z'),
      by: null,
      ciUrl: null,
      run: null,
      causes: [],
    });
  });

  test('a running request keeps its row, names its one test and links its run', () => {
    const row = waitingRequestRow(
      request({
        state: 'running',
        runId: 44,
        target: { id: 4, kind: 'desktop', deviceName: 'LAPTOP' },
        tests: [{ filePath: 'tests/a.spec.ts', line: 3, title: 'pays', projectName: null }],
      }),
    );
    expect(row).toMatchObject({ status: 'running', lead: 'Running in LAPTOP', facts: 'pays', run: { id: 44 } });
  });

  test('a request that ended has no row', () => {
    expect(waitingRequestRow(request({ state: 'ended', outcome: 'passed', runId: 44 }))).toBeNull();
    expect(waitingRequestRow(request({ state: 'expired' }))).toBeNull();
    expect(waitingRequestRow(request({ state: 'declined' }))).toBeNull();
  });
});

describe('waitingRunRows', () => {
  test('both kinds, newest first, without what no longer waits or runs', () => {
    const rows = waitingRunRows(
      [
        dispatch({ id: 'aaaaaaaaaaaaaaaa', at: AT - 60_000 }),
        dispatch({ id: 'bbbbbbbbbbbbbbbb', at: AT + 60_000 }),
        dispatch({
          id: 'cccccccccccccccc',
          state: 'ended',
          runId: 9,
          run: { id: 9, status: 'passed', totalTests: 1, passedTests: 1, failedTests: 0 },
        }),
      ],
      [request(), request({ id: 'r2', state: 'ended', outcome: 'failed' })],
      AT + 2 * 60_000,
    );
    expect(rows.map((r) => r.id)).toEqual(['bbbbbbbbbbbbbbbb', 'r1', 'aaaaaaaaaaaaaaaa']);
  });
});

describe('waitingRunsPollMs', () => {
  const rows = (...shown: { kind: 'dispatch' | 'request'; run: { id: number; result: string | null } | null }[]) =>
    shown;
  const run = { id: 1, result: null };

  test('a request every 5 s until its run starts, then every 30 s', () => {
    expect(waitingRunsPollMs(rows({ kind: 'request', run: null }, { kind: 'request', run }), 'request')).toBe(5_000);
    expect(waitingRunsPollMs(rows({ kind: 'request', run }), 'request')).toBe(30_000);
  });

  test('a dispatch every 30 s, whatever its state; a kind with no row is not read', () => {
    expect(waitingRunsPollMs(rows({ kind: 'dispatch', run: null }, { kind: 'request', run: null }), 'dispatch')).toBe(
      30_000,
    );
    expect(waitingRunsPollMs(rows({ kind: 'request', run: null }), 'dispatch')).toBeNull();
    expect(waitingRunsPollMs(rows({ kind: 'dispatch', run: null }), 'request')).toBeNull();
    expect(waitingRunsPollMs([], 'request')).toBeNull();
  });
});
