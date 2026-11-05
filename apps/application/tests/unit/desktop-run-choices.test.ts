import { afterEach, describe, expect, test, vi } from 'vitest';
import { computed, ref, type Ref } from 'vue';
import { desktopRunHolds } from '../../app/utils/desktop-run-view';

/**
 * The local runs store of one window, as each Local runs tray of it calls it, with Nuxt's `useState` kept by key for
 * the window, as Nuxt keeps it.
 */
async function windowStore() {
  const states = new Map<string, Ref<unknown>>();
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('useState', (key: string, init: () => unknown) => {
    if (!states.has(key)) states.set(key, ref(init()));
    return states.get(key);
  });
  vi.stubGlobal('useToast', () => ({ add: () => {} }));
  vi.stubGlobal('useRouter', () => ({ push: () => {} }));
  const { useDesktopLocalRuns } = await import('../../app/composables/useDesktopLocalRuns');
  return useDesktopLocalRuns;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('desktopRunHolds', () => {
  test('holds as the person chose, else as the run’s kind does, and never a run nobody attends', () => {
    const reproduction = { key: 1, kind: 'reproduce' as const };
    const tests = { key: 2, kind: 'tests' as const };
    expect(desktopRunHolds(reproduction, { hold: {} }, false)).toBe(true);
    expect(desktopRunHolds(tests, { hold: {} }, false)).toBe(false);
    expect(desktopRunHolds(reproduction, { hold: { 1: false } }, false)).toBe(false);
    expect(desktopRunHolds(tests, { hold: { 2: true } }, false)).toBe(true);
    expect(desktopRunHolds(tests, { hold: { 2: true } }, true)).toBe(false);
  });
});

describe('the choices made on the runs of the Local runs tray', () => {
  test('are the window’s: a tray mounted later (an error page’s) holds, shows and expands the runs as left', async () => {
    const useDesktopLocalRuns = await windowStore();
    const reproduction = { key: 1, kind: 'reproduce' as const };
    const tests = { key: 2, kind: 'tests' as const };

    const first = useDesktopLocalRuns().choices;
    first.value = {
      hold: { [reproduction.key]: false, [tests.key]: true },
      separate: { [tests.key]: true },
      expanded: { [reproduction.key]: false },
    };

    const next = useDesktopLocalRuns().choices;
    expect(desktopRunHolds(reproduction, next.value, false)).toBe(false);
    expect(desktopRunHolds(tests, next.value, false)).toBe(true);
    expect(next.value.separate[tests.key]).toBe(true);
    expect(next.value.expanded[reproduction.key]).toBe(false);
  });
});
