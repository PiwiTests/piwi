import type { InjectionKey, MaybeRefOrGetter, Ref } from 'vue';
import { makeTagKeyMatcher } from '#shared/integrations/tag-keys';
import {
  createTestCaseKeyLoader,
  type CatalogCasesResponse,
  type TestCaseKeyState,
} from '~/utils/test-case-key-loader';
import type { TestManagementKeyConfig } from '#shared/handlers/test-management-summary';

export interface TestManagementKeys {
  /** The key of the bound test management project, such as `SHOP`; null until the settings are read. */
  projectKey: () => string | null;
  /** The test case key behind a tag, or null when tags are not a key source or the tag is not a key. */
  keyForTag: (tag: string) => string | null;
  /** The test case key an external ID is, or null when external IDs are not a key source or it is not a key. */
  keyForExternalId: (externalId: string) => string | null;
  /** What the catalog holds for `key`; asks for it once, in one request with the keys asked in the same tick. */
  state: (key: string) => TestCaseKeyState | undefined;
  load: (key: string) => void;
}

const TEST_MANAGEMENT_KEYS: InjectionKey<TestManagementKeys> = Symbol('testManagementKeys');

/**
 * Let the tags and external IDs below this component show the test case behind a key on hover. Reads the project's
 * key settings once; nothing else is fetched until a card is opened, and then every key asked for in the same tick goes
 * in one request, each key once per page. A page showing one project's tests provides it once, next to
 * `provideExternalIdUrl`.
 */
export function provideTestManagementKeys(projectId: MaybeRefOrGetter<number | null | undefined>): void {
  const config: Ref<TestManagementKeyConfig | null> = shallowRef(null);
  const states = reactive<Record<string, TestCaseKeyState>>({});

  watch(
    () => toValue(projectId) ?? null,
    async (id) => {
      config.value = null;
      for (const key of Object.keys(states)) delete states[key];
      if (id === null || !import.meta.client) return;
      try {
        config.value = await $fetch<TestManagementKeyConfig>(`/api/projects/${id}/test-management/key-config`);
      } catch {
        config.value = null; // no card: the chips keep working as they did
      }
    },
    { immediate: true },
  );

  const matcher = computed(() => (config.value?.bound ? makeTagKeyMatcher(config.value.pattern) : () => false));

  const loader = createTestCaseKeyLoader({
    states,
    fetchCases: (keys) =>
      $fetch<CatalogCasesResponse>(`/api/projects/${toValue(projectId)}/test-management/cases`, {
        query: { keys: keys.join(',') },
      }),
  });

  provide(TEST_MANAGEMENT_KEYS, {
    projectKey: () => (config.value?.bound ? config.value.projectKey : null),
    keyForTag: (tag) => {
      if (!config.value?.bound || !config.value.keySources.tags || !matcher.value(tag)) return null;
      return tag.startsWith('@') ? tag.slice(1) : tag;
    },
    keyForExternalId: (externalId) =>
      config.value?.bound && config.value.keySources.externalId && matcher.value(externalId) ? externalId : null,
    state: (key) => states[key],
    load: loader.load,
  });
}

/** What a parent provided, or `null` on a page that shows no one project's tests. */
export function useTestManagementKeys(): TestManagementKeys | null {
  return inject(TEST_MANAGEMENT_KEYS, null);
}
