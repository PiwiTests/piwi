import { describe, expect, test } from 'vitest';
import { runLiveViewStatus, type RunLiveViewReadiness } from '../../app/utils/run-live-view-status';

const run = (over: Partial<RunLiveViewReadiness> = {}): RunLiveViewReadiness => ({
  desktop: false,
  demo: false,
  connected: true,
  state: { enabled: true, keyed: true },
  ci: true,
  workers: 0,
  testsWithoutWorkers: false,
  ...over,
});

describe('live-view readiness', () => {
  test('local preview and simulated progress do not depend on a dashboard key or stream', () => {
    expect(runLiveViewStatus(run({ desktop: true, connected: false, state: null })).kind).toBe('desktop');
    expect(runLiveViewStatus(run({ demo: true, connected: false, state: null })).kind).toBe('demo');
  });

  test('does not claim readiness from workers left over from a disconnected stream', () => {
    expect(runLiveViewStatus(run({ connected: false, workers: 2 })).kind).toBe('checking');
    expect(runLiveViewStatus(run({ state: null, workers: 2 })).kind).toBe('checking');
  });

  test('the project’s setting turned off wins over connected workers', () => {
    expect(runLiveViewStatus(run({ state: { enabled: false, keyed: true }, workers: 2 })).kind).toBe('disabled');
  });

  test('enabling a project does not claim an existing run registered without a key', () => {
    expect(runLiveViewStatus(run({ state: { enabled: true, keyed: false } })).kind).toBe('unavailable');
  });

  test('a connected worker makes the run watchable whatever the key last said', () => {
    expect(runLiveViewStatus(run({ state: { enabled: true, keyed: false }, workers: 1 })).kind).toBe('available');
  });

  test('a key without workers explains CI startup and local sharing separately', () => {
    expect(runLiveViewStatus(run()).kind).toBe('waiting');
    expect(runLiveViewStatus(run({ ci: false })).kind).toBe('unshared');
  });

  test('a CI run whose tests run without any worker says none connected, and a local one that it is not shared', () => {
    expect(runLiveViewStatus(run({ testsWithoutWorkers: true })).kind).toBe('no-workers');
    expect(runLiveViewStatus(run({ testsWithoutWorkers: true, ci: false })).kind).toBe('unshared');
    expect(runLiveViewStatus(run({ testsWithoutWorkers: true, state: { enabled: true, keyed: false } })).kind).toBe(
      'unavailable',
    );
  });

  test('a connected worker makes both a CI run and a shared local run available', () => {
    expect(runLiveViewStatus(run({ workers: 1 })).kind).toBe('available');
    expect(runLiveViewStatus(run({ workers: 1, ci: false })).kind).toBe('available');
  });
});
