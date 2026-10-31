import { describe, expect, test } from 'vitest';
import { runLiveViewStatus, type RunLiveViewReadiness } from '../../app/utils/run-live-view-status';

const run = (over: Partial<RunLiveViewReadiness> = {}): RunLiveViewReadiness => ({
  desktop: false,
  demo: false,
  connected: true,
  state: { enabled: true, keyed: true },
  enabled: true,
  ci: true,
  workers: 0,
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

  test('the current setting takes precedence over the page’s initial setting', () => {
    expect(runLiveViewStatus(run({ state: { enabled: false, keyed: true }, workers: 2 })).kind).toBe('disabled');
    expect(runLiveViewStatus(run({ enabled: false })).kind).toBe('waiting');
  });

  test('an instance omitting the setting uses the project from the run details', () => {
    expect(runLiveViewStatus(run({ state: { keyed: true }, enabled: false })).kind).toBe('disabled');
    expect(runLiveViewStatus(run({ state: { keyed: true } })).kind).toBe('waiting');
  });

  test('enabling a project does not claim an existing run registered for live view', () => {
    const status = runLiveViewStatus(run({ state: { enabled: true, keyed: false } }));
    expect(status.kind).toBe('unavailable');
  });

  test('a key without workers explains CI startup and local sharing separately', () => {
    expect(runLiveViewStatus(run()).kind).toBe('waiting');
    const status = runLiveViewStatus(run({ ci: false }));
    expect(status.kind).toBe('unshared');
  });

  test('a connected worker makes both a CI run and a shared local run available', () => {
    expect(runLiveViewStatus(run({ workers: 1 })).kind).toBe('available');
    expect(runLiveViewStatus(run({ workers: 1, ci: false })).kind).toBe('available');
  });
});
