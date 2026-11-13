import { afterEach, describe, expect, test, vi } from 'vitest';
import { computed, ref } from 'vue';

/** What the shell sends the window of a process it started (`piwi:local-run`). */
type ShellEvent = { payload: { id: number; kind: string; line: string | null; code: number | null } };

/**
 * The shell's runs as `desktop_local_runs` answers: those still going, the latest that ended with their codes and the
 * events that carried their verdicts, and the origin reference the window gave each plain run.
 */
interface ShellRuns {
  running: number[];
  ended: Array<{ id: number; code: number | null; events?: Array<Record<string, unknown>> }>;
  origins?: Array<{ id: number; originRef: string }>;
}

/** A request the page made of its server: its address, its method and its body. */
interface Fetched {
  url: string;
  method: string;
  body?: unknown;
  query?: Record<string, unknown>;
}

/**
 * One page of the window: the local runs store, its Nuxt auto-imports and the desktop bridge stubbed, on the window's
 * session storage (`storage`, which a reload keeps). The shell answers each start with the next id from `firstId`, and
 * `desktop_local_runs` with `shellRuns`; `shell` speaks for it once the page listens.
 */
async function pageWith(storage: Map<string, string>, shellRuns: ShellRuns = { running: [], ended: [] }, firstId = 40) {
  vi.resetModules();
  let shellId = firstId;
  const invoked: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const listeners: Array<(event: ShellEvent) => void> = [];
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()));
  vi.stubGlobal('useToast', () => ({ add: () => {} }));
  vi.stubGlobal('useRouter', () => ({ push: () => {} }));
  vi.stubGlobal('errorMessage', (error: unknown) => (error instanceof Error ? error.message : String(error)));
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal('tauriCore', () => ({
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      invoked.push({ cmd, args });
      if (cmd === 'desktop_local_runs') return Promise.resolve(shellRuns);
      if (cmd === 'desktop_close_other_output_windows') return Promise.resolve(null);
      return Promise.resolve(++shellId);
    },
  }));
  vi.stubGlobal('tauriEvent', () => ({
    listen: async (_name: string, listener: (event: ShellEvent) => void) => {
      listeners.push(listener);
      return () => {};
    },
  }));
  const fetched: Fetched[] = [];
  vi.stubGlobal('$fetch', async (url: string, options: Omit<Fetched, 'url'> = { method: 'GET' }) => {
    fetched.push({ url, method: options.method ?? 'GET', body: options.body, query: options.query });
    if (url.startsWith('/api/test-runs/')) return runDetails(url);
    return latestRun(url, options.query);
  });
  // The hub of the page: what it kept of the runs that ended, by ref, and what a reload gives it back.
  const hub = {
    get endedProgress() {
      return endedProgress;
    },
    get endedAtStop() {
      return endedAtStop;
    },
  };
  vi.stubGlobal('useDesktopRunHub', () => ({
    state: hub,
    takeBackEnded(ended: Record<string, { progress?: unknown; endedAtStop?: number }>) {
      for (const [ref, kept] of Object.entries(ended)) {
        if (kept.progress) endedProgress[ref] = kept.progress;
        if (kept.endedAtStop) endedAtStop[ref] = kept.endedAtStop;
      }
    },
  }));
  const { useDesktopLocalRuns } = await import('../../app/composables/useDesktopLocalRuns');
  const shell = (payload: ShellEvent['payload'] | Record<string, unknown>) => {
    for (const listener of listeners) listener({ payload: payload as ShellEvent['payload'] });
  };
  return { store: useDesktopLocalRuns(), invoked, shell, fetched, hub };
}

/** What the hub kept of the runs that ended, and what `/api/test-runs/:id` answers, as a test sets them. */
let endedProgress: Record<string, unknown> = {};
let endedAtStop: Record<string, number> = {};
let runDetails: (url: string) => unknown = () => {
  throw new Error('no run');
};
/** What `/api/projects/:id/latest-run` answers, as a test sets it: the baseline `{ id: 7 }` by default. */
let latestRun: (url: string, query?: Record<string, unknown>) => unknown = () => ({ id: 7 });

const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true));
const line = (id: number, text: string) => ({ id, kind: 'stdout', line: text, code: null });
const exit = (id: number, code: number) => ({ id, kind: 'exit', line: null, code });

afterEach(() => {
  endedProgress = {};
  endedAtStop = {};
  latestRun = () => ({ id: 7 });
  runDetails = () => {
    throw new Error('no run');
  };
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the Local runs a reload of the window keeps', () => {
  test('takes back a run the shell still runs, its Hold failures, its separate output and its output so far', async () => {
    const storage = new Map<string, string>();
    const before = await pageWith(storage);
    const run = before.store.startRun({
      projectId: 3,
      projectLabel: 'Shop',
      cases: [{ filePath: 'cart.spec.ts', title: 'checks out' }],
    })!;
    await until(() => run.shellId === 41);
    before.shell(line(41, 'Running 2 tests using 1 worker'));
    before.store.holds.value = { [run.key]: true };
    before.store.separate.value = { [run.key]: true };
    before.store.keepForReload();

    const after = await pageWith(storage, { running: [41], ended: [] });
    await after.store.takeBackAfterReload();
    const back = after.store.runs.value[0]!;
    expect(back).toMatchObject({
      key: run.key,
      status: 'running',
      shellId: 41,
      projectLabel: 'Shop',
      hubRefs: ['desktop-41'],
    });
    expect(back.lines.map((l) => l.text)).toEqual(['Running 2 tests using 1 worker']);
    expect(after.store.holds.value).toEqual({ [run.key]: true });
    expect(after.store.separate.value).toEqual({ [run.key]: true });

    // Its output goes on in the run, and its end ends it.
    after.shell(line(41, '  ✘  1 cart.spec.ts:3:1 › pays (1.2s)'));
    after.shell(exit(41, 1));
    await until(() => back.status === 'failed');
    expect(back.lines.at(-1)?.text).toContain('pays');
    expect(back.exitCode).toBe(1);

    // A run started after the reload takes a key of its own.
    const next = after.store.startRun({ projectId: 3, cases: [{ filePath: 'cart.spec.ts', title: 'checks out' }] })!;
    expect(next.key).toBeGreaterThan(run.key);
  });

  test('ends a step that ended during the reload with its code, then runs the run’s next step', async () => {
    const storage = new Map<string, string>();
    const before = await pageWith(storage);
    const run = before.store.startRun({
      projectId: 3,
      cases: [
        { filePath: 'cart.spec.ts', title: 'checks out', projectName: 'chromium' },
        { filePath: 'cart.spec.ts', title: 'checks out', projectName: 'firefox' },
      ],
    })!;
    await until(() => run.shellId === 41);
    expect(run.steps).toHaveLength(2);
    before.store.keepForReload();

    const after = await pageWith(storage, { running: [], ended: [{ id: 41, code: 1 }] }, 41);
    await after.store.takeBackAfterReload();
    const back = after.store.runs.value[0]!;
    await until(() => back.shellId === 42);
    expect(after.invoked.filter((i) => i.cmd === 'desktop_run_local_tests')).toHaveLength(1);
    expect(back.stepIndex).toBe(1);
    after.shell(exit(42, 0));
    // The worst step decides: the first one failed.
    await until(() => back.status === 'failed');
    expect(back.exitCode).toBe(1);
  });

  test('says so of a run the shell no longer knows, and keeps the runs that had ended as they were', async () => {
    const storage = new Map<string, string>();
    const before = await pageWith(storage);
    const done = before.store.startRun({ projectId: 3, cases: [{ filePath: 'a.spec.ts', title: 'checks out' }] })!;
    await until(() => done.shellId === 41);
    before.shell(exit(41, 0));
    await until(() => done.status === 'passed');
    const lost = before.store.startRun({ projectId: 3, cases: [{ filePath: 'b.spec.ts', title: 'checks out' }] })!;
    await until(() => lost.shellId === 42);
    before.store.keepForReload();

    const after = await pageWith(storage, { running: [], ended: [] }, 42);
    await after.store.takeBackAfterReload();
    const [lostBack, doneBack] = after.store.runs.value;
    await until(() => lostBack!.status === 'error');
    expect(lostBack!.lines.at(-1)).toMatchObject({ error: true, text: expect.stringMatching(/reload/i) });
    expect(doneBack).toMatchObject({ key: done.key, status: 'passed', exitCode: 0 });
    expect(after.invoked.filter((i) => i.cmd === 'desktop_run_local_tests')).toHaveLength(0);
  });

  test('replays the output of a step that ended while the shell was asked', async () => {
    const storage = new Map<string, string>();
    const before = await pageWith(storage);
    const run = before.store.startRun({ projectId: 3, cases: [{ filePath: 'cart.spec.ts', title: 'checks out' }] })!;
    await until(() => run.shellId === 41);
    before.store.keepForReload();

    // The process prints and exits after the next page listens, before the shell answers it.
    const after = await pageWith(storage);
    let answer: (runs: ShellRuns) => void = () => {};
    vi.stubGlobal('tauriCore', () => ({
      invoke: (cmd: string) =>
        cmd === 'desktop_local_runs' ? new Promise((resolve) => (answer = resolve)) : Promise.resolve(99),
    }));
    const taken = after.store.takeBackAfterReload();
    await until(() => after.store.runs.value.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    after.shell(line(41, '  ✘  1 cart.spec.ts:3:1 › pays (1.2s)'));
    after.shell(exit(41, 1));
    answer({ running: [], ended: [{ id: 41, code: 1 }], origins: [] });
    await taken;
    const back = after.store.runs.value[0]!;
    await until(() => back.status === 'failed');
    expect(back.lines.map((l) => l.text)).toEqual(['  ✘  1 cart.spec.ts:3:1 › pays (1.2s)']);
  });

  test('records the verdict the shell kept with a job’s end, and never one the page before recorded', async () => {
    const storage = new Map<string, string>();
    const before = await pageWith(storage);
    const startBisect = (store: typeof before.store) =>
      store.startBisect({
        projectId: 3,
        cases: [{ filePath: 'cart.spec.ts', title: 'checks out' }],
        good: 'a'.repeat(40),
        bad: 'b'.repeat(40),
        jobRequestId: 'job-1',
      })!;
    const bisect = startBisect(before.store);
    await until(() => bisect.shellId === 41);
    before.store.keepForReload();

    // The page reloads as the bisect names its commit and ends: the next page reads both from the shell.
    const firstBad = { sha: 'c'.repeat(40), subject: 'Break the cart', author: null, date: null };
    const result = { id: 41, kind: 'bisect', line: null, code: null, bisect: { event: 'result', firstBad } };
    const after = await pageWith(storage, { running: [], ended: [{ id: 41, code: 0, events: [result] }] });
    await after.store.takeBackAfterReload();
    const back = after.store.runs.value[0]!;
    await until(() => back.status === 'passed');
    expect(back.bisect?.firstBad).toEqual(firstBad);
    await until(() => after.fetched.some((f) => f.method === 'PATCH'));
    expect(after.fetched.filter((f) => f.method === 'PATCH')).toMatchObject([
      { url: '/api/desktop/repro-requests/job-1', body: { status: 'done' } },
    ]);

    // A job the page before saw end after it kept its runs is recorded by that page alone.
    const storage2 = new Map<string, string>();
    const first = await pageWith(storage2);
    const job = startBisect(first.store);
    await until(() => job.shellId === 41);
    first.store.keepForReload();
    first.shell(exit(41, 0));
    await until(() => first.fetched.some((f) => f.method === 'PATCH'));
    const next = await pageWith(storage2, { running: [], ended: [{ id: 41, code: 0 }] });
    await next.store.takeBackAfterReload();
    expect(next.store.runs.value[0]).toMatchObject({ status: 'passed' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(next.fetched.filter((f) => f.method === 'PATCH')).toEqual([]);
  });

  test('follows the step the shell was starting as the page reloaded, between two steps', async () => {
    const storage = new Map<string, string>();
    const before = await pageWith(storage);
    const run = before.store.startRun({
      projectId: 3,
      cases: [
        { filePath: 'cart.spec.ts', title: 'checks out', projectName: 'chromium' },
        { filePath: 'cart.spec.ts', title: 'checks out', projectName: 'firefox' },
      ],
    })!;
    await until(() => run.shellId === 41);
    // The second step's start never answers this page: it reloads meanwhile.
    vi.stubGlobal('tauriCore', () => ({ invoke: () => new Promise(() => {}) }));
    before.shell(exit(41, 0));
    await until(() => run.stepIndex === 1);
    before.store.keepForReload();

    const origins = [41, 42].map((id) => ({ id, originRef: run.originRef! }));
    const after = await pageWith(storage, { running: [42], ended: [{ id: 41, code: 0 }], origins }, 42);
    await after.store.takeBackAfterReload();
    const back = after.store.runs.value[0]!;
    expect(back).toMatchObject({ status: 'running', shellId: 42, stepIndex: 1, hubRefs: ['desktop-41', 'desktop-42'] });
    after.shell(exit(42, 1));
    await until(() => back.status === 'failed');
    expect(after.invoked.filter((i) => i.cmd === 'desktop_run_local_tests')).toEqual([]);
  });

  test('keeps how far each step of a run came and the failure it named', async () => {
    const storage = new Map<string, string>();
    const before = await pageWith(storage);
    const run = before.store.startRun({ projectId: 3, cases: [{ filePath: 'cart.spec.ts', title: 'checks out' }] })!;
    await until(() => run.shellId === 41);
    const progress = { total: 2, done: 2, failed: 1, flaky: 0, skipped: 1, status: 'failed', failure: null };
    endedProgress = { 'desktop-41': progress, 'desktop-9': progress };
    endedAtStop = { 'desktop-41': 1 };
    before.store.keepForReload();

    endedProgress = {};
    endedAtStop = {};
    const after = await pageWith(storage, { running: [41], ended: [] });
    await after.store.takeBackAfterReload();
    expect(after.hub.endedProgress).toEqual({ 'desktop-41': progress });
    expect(after.hub.endedAtStop).toEqual({ 'desktop-41': 1 });
  });

  test('reads what the page before kept once, at once, and gives a run started before the take-back a key of its own', async () => {
    const storage = new Map<string, string>();
    const before = await pageWith(storage);
    const kept = before.store.startRun({ projectId: 3, cases: [{ filePath: 'cart.spec.ts', title: 'checks out' }] })!;
    await until(() => kept.shellId === 41);
    before.store.keepForReload();

    const after = await pageWith(storage, { running: [41], ended: [] }, 41);
    after.store.readKeptForReload();
    expect(storage.size).toBe(0);
    const early = after.store.startRun({ projectId: 3, cases: [{ filePath: 'b.spec.ts', title: 'checks out' }] })!;
    expect(early.key).toBeGreaterThan(kept.key);
    await after.store.takeBackAfterReload();
    expect(after.store.runs.value.map((r) => r.key).sort()).toEqual([kept.key, early.key].sort());
  });

  test('keeps nothing it cannot read, and a page with nothing kept starts empty', async () => {
    const storage = new Map([['piwi:desktop-local-runs', '{not json']]);
    const page = await pageWith(storage);
    await page.store.takeBackAfterReload();
    expect(page.store.runs.value).toEqual([]);
    // A run output window the page before had open, and no run of this page owns, closes.
    expect(page.invoked).toEqual([{ cmd: 'desktop_close_other_output_windows', args: { keep: [] } }]);
  });

  test('closes no run output window on a page the app opened anew', async () => {
    const page = await pageWith(new Map());
    await page.store.takeBackAfterReload();
    expect(page.store.runs.value).toEqual([]);
    expect(page.invoked).toEqual([]);
  });
});

describe('where a failed local run’s end leads', () => {
  test('to the failure its process named first, else the run’s first failed test, else the run’s page', async () => {
    const { store, shell } = await pageWith(new Map());
    const run = store.startRun({ projectId: 3, cases: [{ filePath: 'cart.spec.ts', title: 'checks out' }] })!;
    await until(() => run.shellId === 41);
    shell(exit(41, 1));
    await until(() => run.status === 'failed');
    run.piwiRunId = 78;
    const testCases = [
      { executionId: 5, title: 'lists', suitePath: ['cart'], status: 'failed' },
      { executionId: 6, title: 'pays', suitePath: ['checkout'], status: 'failed' },
    ];
    runDetails = (url) => (url === '/api/test-runs/78' ? { id: 78, testCases } : null);

    endedProgress = { 'desktop-41': { failure: { title: 'checkout › pays', error: 'expect failed' } } };
    expect(await store.failurePage(run)).toBe('/test-run-cases/6');
    endedProgress = {};
    expect(await store.failurePage(run)).toBe('/test-run-cases/5');
    runDetails = () => {
      throw new Error('gone');
    };
    expect(await store.failurePage(run)).toBe('/test-runs/78');
  });
});

describe('the Piwi runs of a local run of several steps', () => {
  test('links each step to its own run, and leads the end to the failure of the step that failed first', async () => {
    const { store, shell } = await pageWith(new Map());
    const run = store.startRun({
      projectId: 3,
      cases: [
        { filePath: 'cart.spec.ts', title: 'checks out', projectName: 'chromium' },
        { filePath: 'cart.spec.ts', title: 'checks out', projectName: 'firefox' },
      ],
    })!;
    await until(() => run.shellId === 41);
    shell(exit(41, 0));
    await until(() => run.shellId === 42);
    // Each step's process reports a run of its own, named after the step.
    const reported: Record<string, number> = { 'desktop-41': 80, 'desktop-42': 81 };
    latestRun = (_url, query) => {
      if (!query) return { id: 7 };
      const names = (query.run as string[] | undefined) ?? [];
      const name = Object.keys(reported).find((ref) => names.includes(ref));
      return name ? { id: reported[name], name } : null;
    };
    await store.correlatePiwiRuns();
    expect(run.piwiRunId).toBe(80);
    expect(run.piwiRunIds).toEqual({ 'desktop-41': 80, 'desktop-42': 81 });
    shell(exit(42, 1));
    await until(() => run.status === 'failed');

    const progress = (failed: number, failure: { title: string; error: string | null } | null) => ({
      total: 2,
      done: 2,
      failed,
      flaky: 0,
      skipped: 0,
      status: failed ? 'failed' : 'passed',
      failure,
    });
    endedProgress = {
      'desktop-41': progress(0, null),
      'desktop-42': progress(1, { title: 'checkout › pays', error: 'expect failed' }),
    };
    runDetails = (url) =>
      url === '/api/test-runs/81'
        ? { id: 81, testCases: [{ executionId: 9, title: 'pays', suitePath: ['checkout'], status: 'failed' }] }
        : { id: 80, testCases: [{ executionId: 4, title: 'pays', suitePath: ['checkout'], status: 'failed' }] };
    expect(await store.failurePage(run)).toBe('/test-run-cases/9');
  });
});
