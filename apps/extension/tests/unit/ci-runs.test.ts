import { afterEach, describe, expect, it, vi } from 'vitest';
import { CiRunsWatch, ciRunsOf, mappedProjects } from '../../src/background/ci-runs';
import type { ConnectionSettings } from '../../src/shared/connection-settings';
import type { ActiveRun } from '../../src/shared/piwi-client';

const settings = (mapped: number[] = [7]): ConnectionSettings => ({
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
  it('are those of the mapped projects', () => {
    expect([...mappedProjects(settings([7, 9]))]).toEqual([7, 9]);
    const runs = [active(1), active(2, 8), active(3)];
    const ci = () => true;
    expect(ciRunsOf(runs, new Set([7]), ci, url).map((r) => r.id)).toEqual([3, 1]);
    expect(ciRunsOf(runs, new Set([7, 8]), ci, url).map((r) => r.id)).toEqual([3, 2, 1]);
    expect(ciRunsOf(runs, new Set(), ci, url)).toEqual([]);
  });

  it('are the CI runs alone, named, placed and counted as the instance lists them', () => {
    const runs = [active(1), active(2), active(3, 7, { branch: null })];
    const listed = ciRunsOf(runs, new Set([7]), (run) => (run.id === 2 ? false : run.id === 1 ? true : true), url);
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
    expect(ciRunsOf([active(4)], new Set([7]), () => undefined, url)).toEqual([]);
  });
});

describe('the watch of the CI runs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function watch(
    over: { stored?: ConnectionSettings; runs?: ActiveRun[]; metadata?: (runId: number) => Promise<unknown> } = {},
  ) {
    const lists: number[] = [];
    const details: number[] = [];
    let runs = over.runs ?? [active(1), active(2)];
    const ci = new CiRunsWatch({
      settings: async () => over.stored ?? settings(),
      activeRuns: async () => {
        lists.push(Date.now());
        return runs;
      },
      metadata: async (_settings, runId) => {
        details.push(runId);
        if (over.metadata) return over.metadata(runId);
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

  it('reads nothing without connected mode: an instance address alone is not', async () => {
    vi.useFakeTimers();
    for (const stored of [settings([]), { ...settings(), instanceUrl: ' ' }]) {
      const { ci, lists } = watch({ stored });
      const stop = ci.listen(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(lists).toHaveLength(0);
      expect(ci.state()).toEqual([]);
      stop();
    }
  });

  it('tells a run by the origin the list names once it has begun, reading no details', async () => {
    vi.useFakeTimers();
    const { ci, details, setRuns } = watch({
      runs: [
        active(1, 7, { origin: 'ci' }),
        active(2, 7, { origin: 'local' }),
        active(3, 7, { origin: 'local', status: 'initializing' }),
      ],
    });
    ci.listen(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(ci.state().map((r) => r.id)).toEqual([1]);
    // The initializing run, told nothing while it set up, is a CI run's once it began.
    setRuns([active(1, 7, { origin: 'ci' }), active(3, 7, { origin: 'ci-rerun' })]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ci.state().map((r) => r.id)).toEqual([3, 1]);
    expect(details).toEqual([]);
  });

  it('asks an older instance for details that did not come later each time, then no more', async () => {
    vi.useFakeTimers();
    const { ci, details, lists } = watch({
      runs: [active(1)],
      metadata: async () => {
        throw new Error('unreachable');
      },
    });
    ci.listen(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lists.length).toBeGreaterThan(30);
    // At the first read, then 2, 4 and 8 reads' waits later.
    expect(details).toEqual([1, 1, 1, 1]);
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

describe('the lanes of the CI runs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A run's stream the test writes to: each event a `data:` line, closed when the test says. */
  function stream() {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    return {
      response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      send: (type: string, data: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data, seq: 1 })}\n\n`)),
      raw: (text: string) => controller.enqueue(encoder.encode(text)),
      close: () => controller.close(),
    };
  }

  const lane = (n: number, over: Record<string, unknown> = {}) => ({
    id: { run: 1, shard: null, lane: n },
    state: 'running',
    worker: n,
    test: { id: `t${n}`, title: `cart › pays ${n}`, retry: 0 },
    stop: null,
    waiting: null,
    done: 0,
    failed: 0,
    ...over,
  });

  function watch(ids: number[]) {
    const opened: number[] = [];
    const streams = new Map<number, ReturnType<typeof stream>>();
    const signals = new Map<number, AbortSignal>();
    let runs = ids.map((id) => active(id, 7, { origin: 'ci' }));
    const left: number[] = [];
    const ci = new CiRunsWatch({
      settings: async () => settings(),
      activeRuns: async () => runs,
      metadata: async () => null,
      runUrl: (_settings, runId) => url(runId),
      stream: async (_settings, runId, signal) => {
        opened.push(runId);
        const s = stream();
        streams.set(runId, s);
        signals.set(runId, signal);
        return s.response;
      },
      left: (runId) => left.push(runId),
      pollMs: 1_000,
      pushMs: 100,
      streamIdleMs: 5_000,
    });
    return {
      ci,
      opened,
      streams,
      signals,
      left,
      setRuns: (next: number[]) => (runs = next.map((id) => active(id, 7, { origin: 'ci' }))),
    };
  }

  it('follows the newest runs listed through their own stream while a window listens, and those alone', async () => {
    vi.useFakeTimers();
    const { ci, opened, signals } = watch([1, 2, 3, 4, 5]);
    const stop = ci.listen(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(opened.sort()).toEqual([3, 4, 5]);
    // The next read opens nothing it follows already.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(opened).toHaveLength(3);
    stop();
    expect([3, 4, 5].every((id) => signals.get(id)!.aborted)).toBe(true);
  });

  it('lists the tests the lanes run, whether they can be watched, and the lane a watch asks', async () => {
    vi.useFakeTimers();
    const { ci, streams } = watch([1]);
    const changed = vi.fn();
    ci.listen(changed);
    await vi.advanceTimersByTimeAsync(0);
    expect(ci.state()[0]).toMatchObject({ id: 1, tests: [], watchable: false });
    const s = streams.get(1)!;
    s.send('init', { id: 1, status: 'running' });
    s.send('live-view', { enabled: true, keyed: true });
    s.send('lane', lane(1));
    s.send('lane', lane(0));
    s.send('lane', lane(2, { state: 'between', test: null }));
    s.raw(': heartbeat\n\n');
    await vi.advanceTimersByTimeAsync(100);
    expect(ci.state()[0]!.watchable).toBe(true);
    expect(ci.state()[0]!.tests).toEqual([
      { shard: null, lane: 0, worker: 0, state: 'running', title: 'cart › pays 0', retry: 0 },
      { shard: null, lane: 1, worker: 1, state: 'running', title: 'cart › pays 1', retry: 0 },
    ]);
    expect(ci.lane(1, null, 1)).toEqual({ watchable: true, worker: 1 });
    expect(ci.lane(1, null, 7)).toEqual({ watchable: true, worker: null });
    expect(ci.lane(2, null, 1)).toBeNull();
    // A lane that ends its test leaves the list; a project that turns its live view off is no more watchable.
    s.send('lane', lane(1, { state: 'done' }));
    s.send('live-view', { enabled: false, keyed: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(ci.state()[0]!.tests.map((t) => t.lane)).toEqual([0]);
    expect(ci.state()[0]!.watchable).toBe(false);
  });

  it('opens a stream again at the next read once it ended or went silent, and tells a run that left', async () => {
    vi.useFakeTimers();
    const { ci, opened, streams, left, setRuns } = watch([1]);
    ci.listen(() => {});
    await vi.advanceTimersByTimeAsync(0);
    streams.get(1)!.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(opened).toEqual([1, 1]);
    // Nothing, not even a heartbeat, for the idle time: the stream is let go and opened again.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(opened.length).toBeGreaterThanOrEqual(3);
    setRuns([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(left).toEqual([1]);
    expect(ci.lane(1, null, 0)).toBeNull();
  });
});
