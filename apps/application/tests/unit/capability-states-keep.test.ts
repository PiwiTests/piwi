import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { computed, ref, toValue, type MaybeRefOrGetter, type Ref } from 'vue';

/**
 * The capability states keep what they show when a later read fails (a proxy's 502 while the instance restarts): a
 * declined capability's surfaces stay hidden.
 */

type Answer = () => Promise<{ items: Array<{ id: string; module: string; state: string }> }>;

/**
 * `useAsyncData` as Nuxt runs it for these reads: the handler's answer becomes the key's data and its payload entry,
 * on each refresh too; a handler that throws resets the data to its default and leaves the payload entry as it is.
 */
const keys = new Map<string, { data: Ref<unknown>; refresh: () => Promise<void> }>();
const payload = { data: {} as Record<string, unknown> };
let answer: Answer;

beforeEach(() => {
  keys.clear();
  payload.data = {};
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('useNuxtApp', () => ({ payload }));
  vi.stubGlobal('useAuth', () => ({ can: () => true, canSeeAdmin: ref(true) }));
  vi.stubGlobal('useIsDesktop', () => false);
  vi.stubGlobal('useRouter', () => ({ currentRoute: ref({ path: '/projects/4' }) }));
  vi.stubGlobal('useRequestFetch', () => () => answer());
  vi.stubGlobal('reuseWithinRender', () => undefined);
  vi.stubGlobal(
    'useAsyncData',
    async (keyOf: MaybeRefOrGetter<string>, handler: () => Promise<unknown>, options: { default: () => unknown }) => {
      const key = toValue(keyOf);
      if (!keys.has(key)) {
        const data = ref(options.default());
        const refresh = async () => {
          try {
            data.value = payload.data[key] = await handler();
          } catch {
            data.value = options.default();
          }
        };
        keys.set(key, { data, refresh });
        await refresh();
      }
      return { data: keys.get(key)!.data };
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

const declinedQuarantine: Answer = async () => ({
  items: [{ id: 'quarantine', module: 'workflow', state: 'declined' }],
});
const nothingDeclined: Answer = async () => ({ items: [] });
const badGateway: Answer = () => Promise.reject(Object.assign(new Error('502 Bad Gateway'), { status: 502 }));

describe('capability states', () => {
  test('the instance’s keep the states shown when a later read fails', async () => {
    answer = declinedQuarantine;
    const { useInstanceCapabilities } = await import('../../app/composables/useInstanceCapabilities');
    const capabilities = await useInstanceCapabilities();
    expect(capabilities.isHidden('quarantine')).toBe(true);

    answer = badGateway;
    await keys.get('capabilities-instance')!.refresh();
    expect(capabilities.isHidden('quarantine')).toBe(true);
    expect(capabilities.state('quarantine')).toBe('declined');
  });

  test('a project’s keep the states shown when a later read fails', async () => {
    answer = declinedQuarantine;
    const { useProjectCapabilities } = await import('../../app/composables/useProjectCapabilities');
    const capabilities = await useProjectCapabilities(4);
    expect(capabilities.isHidden('quarantine')).toBe(true);

    answer = badGateway;
    await keys.get('capabilities-project-4')!.refresh();
    expect(capabilities.isHidden('quarantine')).toBe(true);
  });

  test('a project’s keep a decision written since the last read when a later read fails', async () => {
    answer = nothingDeclined;
    vi.stubGlobal('$fetch', async () => await declinedQuarantine());
    const { useProjectCapabilities } = await import('../../app/composables/useProjectCapabilities');
    const capabilities = await useProjectCapabilities(4);
    expect(capabilities.state('quarantine')).toBe('undecided');

    await capabilities.decide('quarantine', 'declined');
    answer = badGateway;
    await keys.get('capabilities-project-4')!.refresh();
    expect(capabilities.state('quarantine')).toBe('declined');
  });

  test('the layout holds no states for a project until a read of them succeeds, then keeps them', async () => {
    answer = badGateway;
    const { useProjectCapabilities, useLoadedProjectCapabilities } =
      await import('../../app/composables/useProjectCapabilities');
    await useProjectCapabilities(4);
    const loaded = useLoadedProjectCapabilities();
    expect(loaded.isHidden(4, 'quarantine')).toBeNull();

    answer = declinedQuarantine;
    await keys.get('capabilities-project-4')!.refresh();
    expect(loaded.isHidden(4, 'quarantine')).toBe(true);

    answer = badGateway;
    await keys.get('capabilities-project-4')!.refresh();
    expect(loaded.isHidden(4, 'quarantine')).toBe(true);
    expect(loaded.isHidden(5, 'quarantine')).toBeNull();
  });

  test('a first read that fails reads every capability as undecided', async () => {
    answer = badGateway;
    const { useInstanceCapabilities } = await import('../../app/composables/useInstanceCapabilities');
    const capabilities = await useInstanceCapabilities();
    expect(capabilities.state('quarantine')).toBe('undecided');
  });
});
