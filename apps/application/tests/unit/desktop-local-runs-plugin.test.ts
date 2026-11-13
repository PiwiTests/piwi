import { afterEach, describe, expect, test, vi } from 'vitest';

/**
 * The desktop window's Local runs across a reload of its page (`plugins/desktop-local-runs.client.ts`): what it keeps
 * as the page goes, reads as the next one starts, and drops when a page shows again.
 */
async function plugin(label: string | null = 'main') {
  vi.resetModules();
  const calls: string[] = [];
  const listeners: Record<string, (event: { persisted?: boolean }) => void> = {};
  let resolved: (() => void) | null = null;
  vi.stubGlobal('defineNuxtPlugin', (setup: unknown) => setup);
  vi.stubGlobal('tauriCore', () => ({ invoke: async () => null }));
  vi.stubGlobal('tauriWindowLabel', () => label);
  vi.stubGlobal('window', {
    addEventListener: (name: string, listener: (event: { persisted?: boolean }) => void) => {
      listeners[name] = listener;
    },
  });
  vi.stubGlobal('useDesktopLocalRuns', () => ({
    readKeptForReload: () => calls.push('read'),
    keepForReload: () => calls.push('keep'),
    forgetKeptForReload: () => calls.push('forget'),
    takeBackAfterReload: async () => void calls.push('take back'),
  }));
  const { default: setup } = await import('../../app/plugins/desktop-local-runs.client');
  (setup as unknown as (app: unknown) => void)({
    hooks: { hookOnce: (_name: string, hook: () => void) => (resolved = hook) },
  });
  return { calls, listeners, hydrate: () => resolved?.() };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('a window’s Local runs across a reload', () => {
  test('reads what the page before kept as it starts, and takes it back once it hydrated', async () => {
    const { calls, hydrate } = await plugin();
    expect(calls).toEqual(['read']);
    hydrate();
    expect(calls).toEqual(['read', 'take back']);
  });

  test('keeps its runs as the page goes for good, never as it is kept for Back, and drops them as it shows again', async () => {
    const { calls, listeners } = await plugin();
    listeners.pagehide!({ persisted: true });
    expect(calls).toEqual(['read']);
    listeners.pageshow!({ persisted: true });
    listeners.pagehide!({ persisted: false });
    expect(calls).toEqual(['read', 'forget', 'keep']);
  });

  test('keeps nothing in a run’s output window or a worker’s window', async () => {
    for (const label of ['output-piwi-run-output-3_1', 'worker-desktop-41-0_1']) {
      const { calls, listeners } = await plugin(label);
      expect(calls).toEqual([]);
      expect(listeners).toEqual({});
    }
  });
});
