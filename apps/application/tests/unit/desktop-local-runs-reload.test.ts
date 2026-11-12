import { afterEach, describe, expect, test, vi } from 'vitest';
import { computed, ref } from 'vue';

/** What the shell sends the window of a process it started (`piwi:local-run`). */
type ShellEvent = { payload: { id: number; kind: string; line: string | null; code: number | null } };

/** The shell's runs as `desktop_local_runs` answers: those still going, and the latest that ended with their codes. */
interface ShellRuns {
  running: number[];
  ended: Array<{ id: number; code: number | null }>;
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
      return Promise.resolve(++shellId);
    },
  }));
  vi.stubGlobal('tauriEvent', () => ({
    listen: async (_name: string, listener: (event: ShellEvent) => void) => {
      listeners.push(listener);
      return () => {};
    },
  }));
  vi.stubGlobal('$fetch', async (url: string) => (url.startsWith('/api/test-runs/') ? runDetails(url) : { id: 7 }));
  vi.stubGlobal('useDesktopRunHub', () => ({ state: { endedProgress } }));
  const { useDesktopLocalRuns } = await import('../../app/composables/useDesktopLocalRuns');
  const shell = (payload: ShellEvent['payload']) => {
    for (const listener of listeners) listener({ payload });
  };
  return { store: useDesktopLocalRuns(), invoked, shell };
}

/** What the hub kept of the runs that ended, and what `/api/test-runs/:id` answers, as a test sets them. */
let endedProgress: Record<string, unknown> = {};
let runDetails: (url: string) => unknown = () => {
  throw new Error('no run');
};

const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true));
const line = (id: number, text: string) => ({ id, kind: 'stdout', line: text, code: null });
const exit = (id: number, code: number) => ({ id, kind: 'exit', line: null, code });

afterEach(() => {
  endedProgress = {};
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
    const run = before.store.startRun({ projectId: 3, projectLabel: 'Shop', cases: [{ filePath: 'cart.spec.ts' }] })!;
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
    const next = after.store.startRun({ projectId: 3, cases: [{ filePath: 'cart.spec.ts' }] })!;
    expect(next.key).toBeGreaterThan(run.key);
  });

  test('ends a step that ended during the reload with its code, then runs the run’s next step', async () => {
    const storage = new Map<string, string>();
    const before = await pageWith(storage);
    const run = before.store.startRun({
      projectId: 3,
      cases: [
        { filePath: 'cart.spec.ts', projectName: 'chromium' },
        { filePath: 'cart.spec.ts', projectName: 'firefox' },
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
    const done = before.store.startRun({ projectId: 3, cases: [{ filePath: 'a.spec.ts' }] })!;
    await until(() => done.shellId === 41);
    before.shell(exit(41, 0));
    await until(() => done.status === 'passed');
    const lost = before.store.startRun({ projectId: 3, cases: [{ filePath: 'b.spec.ts' }] })!;
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

  test('keeps nothing it cannot read, and a page with nothing kept starts empty', async () => {
    const storage = new Map([['piwi:desktop-local-runs', '{not json']]);
    const page = await pageWith(storage);
    await page.store.takeBackAfterReload();
    expect(page.store.runs.value).toEqual([]);
    expect(page.invoked).toEqual([]);
  });
});

describe('where a failed local run’s end leads', () => {
  test('to the failure its process named first, else the run’s first failed test, else the run’s page', async () => {
    const { store, shell } = await pageWith(new Map());
    const run = store.startRun({ projectId: 3, cases: [{ filePath: 'cart.spec.ts' }] })!;
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
