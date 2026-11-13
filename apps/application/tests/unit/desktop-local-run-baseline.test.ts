import { afterEach, describe, expect, test, vi } from 'vitest';
import { computed, ref } from 'vue';

/** A promise and the function that settles it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** What the shell sends the window of a process it started (`piwi:local-run`). */
type ShellEvent = { payload: { id: number; kind: string; line: string | null; code: number | null } };

/**
 * The local runs store with its Nuxt auto-imports and the desktop bridge stubbed. `latestRun` answers the project's
 * baseline lookup (no query), `linkedRun` the lookup by origin and reference, and `onSpawn` runs when the shell
 * starts a process. With `shellIds`, the shell answers each start with the next id, and the process runs until
 * `onListen`'s listener hears its exit.
 */
async function storeWith(input: {
  latestRun: () => Promise<{ id: number } | null>;
  linkedRun: (query: Record<string, string | string[]>) => { id: number; name?: string | null } | null;
  onSpawn?: () => void;
  shellIds?: boolean;
  onListen?: (listener: (event: ShellEvent) => void) => void;
}) {
  let shellId = 0;
  const invoked: string[] = [];
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()));
  vi.stubGlobal('useToast', () => ({ add: () => {} }));
  vi.stubGlobal('useRouter', () => ({ push: () => {} }));
  vi.stubGlobal('tauriCore', () => ({
    invoke: (cmd: string) => {
      invoked.push(cmd);
      input.onSpawn?.();
      return input.shellIds ? Promise.resolve(++shellId) : new Promise(() => {});
    },
  }));
  vi.stubGlobal('tauriEvent', () => ({
    listen: async (_name: string, listener: (event: ShellEvent) => void) => {
      input.onListen?.(listener);
      return () => {};
    },
  }));
  vi.stubGlobal('$fetch', (url: string, options?: { query?: Record<string, string | string[]> }) => {
    if (!url.endsWith('/latest-run')) throw new Error(`unexpected request ${url}`);
    return options?.query ? Promise.resolve(input.linkedRun(options.query)) : input.latestRun();
  });
  const { useDesktopLocalRuns } = await import('../../app/composables/useDesktopLocalRuns');
  return { store: useDesktopLocalRuns(), invoked };
}

const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('a desktop local run and the Piwi run it produces', () => {
  test('starts the process only once the baseline lookup has answered', async () => {
    const lookup = deferred<{ id: number } | null>();
    const { store, invoked } = await storeWith({ latestRun: () => lookup.promise, linkedRun: () => ({ id: 8 }) });

    const run = store.startRun({ projectId: 3, cases: [{ filePath: 'cart.spec.ts', title: 'checks out' }] })!;
    await new Promise((r) => setTimeout(r, 20));
    expect(invoked).toEqual([]);

    lookup.resolve({ id: 7 });
    await until(() => invoked.length === 1);
    expect(run.piwiRunBaseline).toBe(7);
  });

  test('links the run its process reports at once, while the lookup is still pending', async () => {
    const lookup = deferred<void>();
    let latest = 7;
    const { store, invoked } = await storeWith({
      latestRun: () => lookup.promise.then(() => ({ id: latest })),
      linkedRun: () => ({ id: latest }),
      onSpawn: () => (latest = 8),
    });

    const run = store.startRun({ projectId: 3, cases: [{ filePath: 'cart.spec.ts', title: 'checks out' }] })!;
    await new Promise((r) => setTimeout(r, 20));
    lookup.resolve();
    await until(() => invoked.length === 1);
    await store.correlatePiwiRuns();

    expect(run.piwiRunBaseline).toBe(7);
    expect(run.piwiRunId).toBe(8);
  });

  test('starts nothing when stopped before the lookup answered', async () => {
    const lookup = deferred<{ id: number } | null>();
    const { store, invoked } = await storeWith({ latestRun: () => lookup.promise, linkedRun: () => ({ id: 8 }) });

    const run = store.startReproduce({
      projectId: 3,
      cases: [{ filePath: 'cart.spec.ts', title: 'checks out' }],
      commit: 'abc1234',
    })!;
    await store.stopRun(run);
    lookup.resolve({ id: 7 });

    await until(() => run.status === 'stopped');
    expect(invoked).toEqual([]);
  });

  test('starts a run no Piwi run is linked to without waiting for a lookup, and takes its baseline meanwhile', async () => {
    const lookup = deferred<{ id: number } | null>();
    const { store, invoked } = await storeWith({ latestRun: () => lookup.promise, linkedRun: () => ({ id: 8 }) });

    const run = store.startFlakeLab({
      projectId: 3,
      testCaseId: 12,
      options: { suspect: null, all: false, runs: null, budgetMinutes: null },
    })!;

    await until(() => invoked.length === 1);
    expect(run.piwiRunBaseline).toBeNull();
    // The baseline its stop takes its lab runs off the OS progress by.
    lookup.resolve({ id: 7 });
    await until(() => run.piwiRunBaseline === 7);
  });
});

describe('two local runs with the same origin reference', () => {
  /** The Piwi runs reported for failure cluster 42, newest last; `name` is the `PIWI_RUN_REF` the reporter recorded. */
  function reported(runs: Array<{ id: number; name?: string }>) {
    return (query: Record<string, string | string[]>) => {
      expect(query).toMatchObject({ origin: 'reproduce', ref: '42' });
      const names = query.run === undefined ? null : ([] as string[]).concat(query.run);
      const found = runs.findLast((r) => !names || r.name === undefined || names.includes(r.name));
      return found ? { id: found.id, name: found.name ?? null } : null;
    };
  }

  async function startTwo(linked: { current: ReturnType<typeof reported> }) {
    const { store, invoked } = await storeWith({
      latestRun: async () => ({ id: 7 }),
      linkedRun: (query) => linked.current(query),
      shellIds: true,
    });
    const input = {
      projectId: 3,
      cases: [{ filePath: 'cart.spec.ts', title: 'checks out' }],
      commit: 'abc1234',
      clusterId: 42,
    };
    const first = store.startReproduce(input)!;
    const second = store.startReproduce(input)!;
    await until(() => invoked.length === 2 && first.hubRefs.length === 1 && second.hubRefs.length === 1);
    return { store, first, second };
  }

  test('each links the Piwi run its own process produced, both reported before the lookup', async () => {
    const linked = { current: reported([]) };
    const { store, first, second } = await startTwo(linked);
    expect(first.originRef).toBe('42');
    expect(second.originRef).toBe('42');

    // The second process reports first: Piwi run 8 is the second's, 9 the first's.
    const [firstName, secondName] = [first.hubRefs[0]!, second.hubRefs[0]!];
    linked.current = reported([
      { id: 8, name: secondName },
      { id: 9, name: `${firstName}-unattended` },
    ]);
    await store.correlatePiwiRuns();

    expect(first.piwiRunId).toBe(9);
    expect(second.piwiRunId).toBe(8);
  });

  test('links neither to a Piwi run the reporter recorded no name for, which could be either one', async () => {
    const linked = { current: reported([]) };
    const { store, first, second } = await startTwo(linked);

    linked.current = reported([{ id: 8 }, { id: 9 }]);
    await store.correlatePiwiRuns();

    expect(first.piwiRunId).toBeNull();
    expect(second.piwiRunId).toBeNull();
  });
});

describe('the end of a local run', () => {
  test('is heard before the tray drops it, when the fifteen runs it keeps ended after it started', async () => {
    let shell: (event: ShellEvent) => void = () => {};
    const { store } = await storeWith({
      latestRun: async () => ({ id: 7 }),
      linkedRun: () => null,
      shellIds: true,
      onListen: (listener) => (shell = listener),
    });
    const heard: string[] = [];
    store.onRunEnded((run) => heard.push(`${run.kind}:${run.status}`));
    const exit = (id: number | null, code: number) => shell({ payload: { id: id!, kind: 'exit', line: null, code } });

    const bisect = store.startBisect({
      projectId: 3,
      cases: [{ filePath: 'cart.spec.ts', title: 'checks out' }],
      good: 'a'.repeat(40),
      bad: 'b'.repeat(40),
    })!;
    await until(() => bisect.shellId != null);
    const newer = Array.from({ length: 15 }, () =>
      store.startRun({ projectId: 3, cases: [{ filePath: 'cart.spec.ts', title: 'checks out' }] })!,
    );
    await until(() => newer.every((run) => run.shellId != null));
    for (const run of newer) exit(run.shellId, 0);
    await until(() => newer.every((run) => run.status === 'passed'));
    expect(heard).toHaveLength(15);

    exit(bisect.shellId, 1);
    await until(() => heard.includes('bisect:failed'));
    expect(store.runs.value.includes(bisect)).toBe(false);
  });
});
