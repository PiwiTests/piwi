import { describe, expect, test } from 'vitest';
import {
  CI_DISPATCH_LIKELY_CAUSES,
  CI_DISPATCH_WAIT_HINT_MS,
  ciDispatchFollowUp,
  dispatchRunResult,
  runFollowUpPollMs,
  runRequestFollowUp,
} from '#shared/run-follow-up';
import type { CiDispatchView } from '#shared/ci-dispatches';
import type { RunRequestView } from '#shared/handlers/run-requests';

const AT = Date.parse('2026-11-20T10:00:00Z');

function dispatch(over: Partial<CiDispatchView> = {}): CiDispatchView {
  return {
    id: '0123456789abcdef',
    actionId: 'smoke',
    actionName: 'Smoke · staging',
    kind: 'tests',
    origin: 'page',
    provider: 'ci-server',
    preset: 'jenkins',
    url: 'https://jenkins.example.com/job/api/job/smoke/',
    args: 'tests/a.spec.ts:3',
    ref: 'main',
    tests: 3,
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
    kind: 'tests',
    projectId: 1,
    projectName: 'E2E',
    tests: [{ filePath: 'tests/a.spec.ts', line: 3, title: 'pays', projectName: null }],
    options: { headed: false },
    source: { executionId: 1 },
    state: 'running',
    outcome: null,
    detail: null,
    stopRequested: false,
    target: { id: 4, kind: 'desktop', deviceName: 'LAPTOP' },
    runId: null,
    environmentId: null,
    expiresAt: '2026-11-20T10:10:00Z',
    createdAt: '2026-11-20T10:00:00Z',
    updatedAt: '2026-11-20T10:00:00Z',
    ...over,
  } as RunRequestView;
}

describe('ciDispatchFollowUp', () => {
  test('waits for the run with a link to the CI, read every 5 seconds', () => {
    const view = ciDispatchFollowUp(dispatch(), AT + 60_000);
    expect(view).toMatchObject({
      kind: 'dispatch',
      status: 'interrupted',
      sentence: 'Dispatched to Jenkins: waiting for the run to report…',
      tests: 3,
      action: 'Smoke · staging',
      ref: 'main',
      by: 'Ana',
      ciUrl: 'https://jenkins.example.com/job/api/job/smoke/',
      run: null,
      causes: [],
      final: false,
      canStop: false,
    });
    expect(runFollowUpPollMs(view)).toBe(5_000);
  });

  test('gives the likely causes once it waited long, and goes on reading', () => {
    const view = ciDispatchFollowUp(dispatch(), AT + CI_DISPATCH_WAIT_HINT_MS);
    expect(view.sentence).toBe('Dispatched to Jenkins: no run has reported yet');
    expect(view.causes).toEqual(CI_DISPATCH_LIKELY_CAUSES);
    expect(view.final).toBe(false);
  });

  test('names the matched run with its result, read every 30 seconds until it ends', () => {
    const run = { id: 128, status: 'running', totalTests: 3, passedTests: 1, failedTests: 0 };
    const running = ciDispatchFollowUp(dispatch({ state: 'running', runId: 128, run }), AT);
    expect(running).toMatchObject({ status: 'running', run: { id: 128, result: 'is running' }, final: false });
    expect(running.sentence).toBe('Dispatched to Jenkins: run #128 is running');
    expect(runFollowUpPollMs(running)).toBe(30_000);

    const ended = ciDispatchFollowUp(
      dispatch({ state: 'ended', runId: 128, run: { ...run, status: 'failed' } }),
      AT + CI_DISPATCH_WAIT_HINT_MS,
    );
    expect(ended).toMatchObject({ status: 'failed', run: { id: 128, result: 'failed' }, causes: [], final: true });
    expect(runFollowUpPollMs(ended)).toBeNull();
  });

  test('says no run reported, and a refusal in the provider’s words with no CI link', () => {
    const unreported = ciDispatchFollowUp(dispatch({ state: 'unreported' }), AT);
    expect(unreported).toMatchObject({ status: 'skipped', final: true, causes: CI_DISPATCH_LIKELY_CAUSES });
    expect(unreported.sentence).toBe('Dispatched to Jenkins: no run reported within six hours');

    const refused = ciDispatchFollowUp(dispatch({ state: 'refused', detail: 'No such job' }), AT);
    expect(refused).toMatchObject({ status: 'failed', ciUrl: null, final: true });
    expect(refused.sentence).toBe('Jenkins refused the dispatch: No such job');
    expect(ciDispatchFollowUp(dispatch({ state: 'refused', provider: 'github', preset: undefined }), AT).sentence).toBe(
      'GitHub Actions refused the dispatch',
    );
  });
});

describe('runRequestFollowUp', () => {
  test('a request running in an app can be stopped and is read every 2 seconds', () => {
    const view = runRequestFollowUp(request());
    expect(view).toMatchObject({
      kind: 'request',
      status: 'running',
      sentence: 'Running in LAPTOP',
      tests: 1,
      testTitle: 'pays',
      target: 'LAPTOP',
      run: null,
      final: false,
      canStop: true,
    });
    expect(runFollowUpPollMs(view)).toBe(2_000);
  });

  test('an ended request names its run and is read no more', () => {
    const view = runRequestFollowUp(request({ state: 'ended', outcome: 'passed', runId: 9 }));
    expect(view).toMatchObject({
      status: 'passed',
      sentence: 'Ended: every test passed',
      run: { id: 9, result: null },
      final: true,
      canStop: false,
    });
    expect(runFollowUpPollMs(view)).toBeNull();
  });
});

describe('dispatchRunResult', () => {
  test('says how the run that answered a dispatch stands', () => {
    expect(dispatchRunResult({ status: 'running' })).toBe('is running');
    expect(dispatchRunResult({ status: 'passed' })).toBe('passed');
    expect(dispatchRunResult({ status: 'timedout' })).toBe('failed');
    expect(dispatchRunResult({ status: 'cancelled' })).toBe('was cancelled');
  });
});
