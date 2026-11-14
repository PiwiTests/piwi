import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { computed, ref, toValue, type MaybeRefOrGetter, type Ref } from 'vue';

/**
 * The capability states keep what they show when a later read fails (a proxy's 502 while the instance restarts): a
 * declined capability's surfaces stay hidden.
 */

type Answer = () => Promise<{ items: Array<{ id: string; module: string; state: string }> }>;

/**
 * `useAsyncData` as Nuxt runs it for these reads: the handler's answer becomes the key's data and its payload entry,
 * on each refresh too.
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
  vi.stubGlobal('useRequestFetch', () => () => answer());
  vi.stubGlobal('reuseWithinRender', () => undefined);
  vi.stubGlobal(
    'useAsyncData',
    async (keyOf: MaybeRefOrGetter<string>, handler: () => Promise<unknown>, options: { default: () => unknown }) => {
      const key = toValue(keyOf);
      if (!keys.has(key)) {
        const data = ref(options.default());
        const refresh = async () => {
          data.value = payload.data[key] = await handler();
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

  test('a first read that fails reads every capability as undecided', async () => {
    answer = badGateway;
    const { useInstanceCapabilities } = await import('../../app/composables/useInstanceCapabilities');
    const capabilities = await useInstanceCapabilities();
    expect(capabilities.state('quarantine')).toBe('undecided');
  });
});
