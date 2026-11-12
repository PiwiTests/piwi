import { afterEach, describe, expect, it, vi } from 'vitest';
import { CiRunsWatch, ciRunsOf, mappedProjects } from '../../src/background/ci-runs';
import type { ConnectionSettings } from '../../src/shared/connection-settings';
import type { ActiveRun } from '../../src/shared/piwi-client';

const settings = (mapped: number[] = []): ConnectionSettings => ({
  instanceUrl: 'https://piwi.example',
  projectMappings: mapped.map((projectId) => ({
    urlPattern: `https://app${projectId}.example/*`,
    projectId,
    projectLabel: '',
  })),
  serverMappings: [],
  serverProjects: [],
  serverSyncedAt: 0,
  connectedAs: '',
});

const active = (id: number, projectId = 7, over: Partial<ActiveRun> = {}): ActiveRun => ({
  id,
  projectId,
  projectName: projectId === 7 ? 'Shop' : 'Admin',
  branch: 'feature/pay',
  status: 'running',
  startTime: `2026-11-12T10:${String(id).padStart(2, '0')}:00.000Z`,
  totalTests: 40,
  passedTests: 10,
  failedTests: 1,
  skippedTests: 1,
  didNotRunTests: 0,
  flakyTests: 0,
  ...over,
});

const url = (id: number) => `https://piwi.example/test-runs/${id}`;

describe('the CI runs the Runs window lists', () => {
  it('are those of the mapped projects, else of every project the key reads', () => {
    expect([...mappedProjects(settings([7, 9]))]).toEqual([7, 9]);
    const runs = [active(1), active(2, 8), active(3)];
    const ci = () => true;
    expect(ciRunsOf(runs, new Set([7]), ci, url).map((r) => r.id)).toEqual([3, 1]);
    expect(ciRunsOf(runs, new Set(), ci, url).map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it('are the CI runs alone, named, placed and counted as the instance lists them', () => {
    const runs = [active(1), active(2), active(3, 7, { branch: null })];
    const listed = ciRunsOf(runs, new Set(), (run) => (run.id === 2 ? false : run.id === 1 ? true : true), url);
    expect(listed).toEqual([
      {
        id: 3,
        projectId: 7,
        project: 'Shop',
        branch: null,
        status: 'running',
        startTime: '2026-11-12T10:03:00.000Z',
        total: 40,
        done: 12,
        failed: 1,
        flaky: 0,
        url: url(3),
      },
      expect.objectContaining({ id: 1, branch: 'feature/pay', url: url(1) }),
    ]);
    // A run whose details were not read yet is no CI run until they are.
    expect(ciRunsOf([active(4)], new Set(), () => undefined, url)).toEqual([]);
  });
});

describe('the watch of the CI runs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function watch(over: { mapped?: number[]; runs?: ActiveRun[]; connected?: boolean } = {}) {
    const lists: number[] = [];
    const details: number[] = [];
    let runs = over.runs ?? [active(1), active(2)];
    const ci = new CiRunsWatch({
      settings: async () => (over.connected === false ? null : settings(over.mapped)),
      activeRuns: async () => {
        lists.push(Date.now());
        return runs;
      },
      metadata: async (_settings, runId) => {
        details.push(runId);
        return runId === 2 ? { piwiOrigin: { kind: 'local' } } : { piwiOrigin: { kind: 'ci' } };
      },
      runUrl: (_settings, runId) => url(runId),
      pollMs: 1_000,
    });
    return { ci, lists, details, setRuns: (next: ActiveRun[]) => (runs = next) };
  }

  it('reads only while a window listens: as it opens, then at its pace, each run’s details once', async () => {
    vi.useFakeTimers();
    const { ci, lists, details, setRuns } = watch();
    expect(lists).toHaveLength(0);
    const changed = vi.fn();
    const stop = ci.listen(changed);
    await vi.advanceTimersByTimeAsync(0);
    expect(lists).toHaveLength(1);
    expect(details.sort()).toEqual([1, 2]);
    expect(ci.state().map((r) => r.id)).toEqual([1]);
    expect(changed).toHaveBeenCalledTimes(1);

    // The next read asks for no details it has; the same list tells the window nothing.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lists).toHaveLength(2);
    expect(details).toHaveLength(2);
    expect(changed).toHaveBeenCalledTimes(1);

    // A run that ended leaves the list.
    setRuns([active(2)]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ci.state()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lists).toHaveLength(3);
  });

  it('reads nothing without connected mode', async () => {
    vi.useFakeTimers();
    const { ci, lists } = watch({ connected: false });
    ci.listen(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(lists).toHaveLength(0);
    expect(ci.state()).toEqual([]);
  });

  it('keeps the runs last read while the instance does not answer', async () => {
    vi.useFakeTimers();
    let fail = false;
    const ci = new CiRunsWatch({
      settings: async () => settings(),
      activeRuns: async () => {
        if (fail) throw new Error('unreachable');
        return [active(1)];
      },
      metadata: async () => ({ piwiOrigin: { kind: 'ci' } }),
      runUrl: (_settings, runId) => url(runId),
      pollMs: 1_000,
    });
    ci.listen(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(ci.state().map((r) => r.id)).toEqual([1]);
    fail = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ci.state().map((r) => r.id)).toEqual([1]);
  });
});
