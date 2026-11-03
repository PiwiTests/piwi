import { afterEach, describe, expect, test, vi } from 'vitest';
import { computed, ref } from 'vue';

/** A promise and the function that settles it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * The local runs store with its Nuxt auto-imports and the desktop bridge stubbed. `latestRun` answers the project's
 * baseline lookup (no query), `linkedRun` the lookup by origin and reference, and `onSpawn` runs when the shell
 * starts a process.
 */
async function storeWith(input: {
  latestRun: () => Promise<{ id: number } | null>;
  linkedRun: () => { id: number };
  onSpawn?: () => void;
}) {
  const invoked: string[] = [];
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()));
  vi.stubGlobal('useToast', () => ({ add: () => {} }));
  vi.stubGlobal('useRouter', () => ({ push: () => {} }));
  vi.stubGlobal('tauriCore', () => ({
    invoke: (cmd: string) => {
      invoked.push(cmd);
      input.onSpawn?.();
      return new Promise(() => {});
    },
  }));
  vi.stubGlobal('tauriEvent', () => ({ listen: async () => () => {} }));
  vi.stubGlobal('$fetch', (url: string, options?: { query?: Record<string, string> }) => {
    if (!url.endsWith('/latest-run')) throw new Error(`unexpected request ${url}`);
    return options?.query ? Promise.resolve(input.linkedRun()) : input.latestRun();
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

    const run = store.startRun({ projectId: 3, cases: [{ filePath: 'cart.spec.ts' }] })!;
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

    const run = store.startRun({ projectId: 3, cases: [{ filePath: 'cart.spec.ts' }] })!;
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

    const run = store.startReproduce({ projectId: 3, cases: [{ filePath: 'cart.spec.ts' }], commit: 'abc1234' })!;
    await store.stopRun(run);
    lookup.resolve({ id: 7 });

    await until(() => run.status === 'stopped');
    expect(invoked).toEqual([]);
  });

  test('starts a run no Piwi run is linked to without waiting for a lookup', async () => {
    const { store, invoked } = await storeWith({
      latestRun: () => new Promise(() => {}),
      linkedRun: () => ({ id: 8 }),
    });

    const run = store.startFlakeLab({
      projectId: 3,
      testCaseId: 12,
      options: { suspect: null, all: false, runs: null, budgetMinutes: null },
    })!;

    await until(() => invoked.length === 1);
    expect(run.piwiRunBaseline).toBeNull();
  });
});
