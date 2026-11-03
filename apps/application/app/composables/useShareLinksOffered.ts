import type { ComputedRef } from 'vue';
import { shareLinksOffered, type ShareLinkSettings } from '~/utils/share-links';
import { reuseWithinRender } from '~/utils/shared-fetch';

const SETTINGS_URL = '/api/share-links/settings';

/**
 * Whether this dashboard offers share links (`shareLinksOffered`), for what a
 * page shows on its first screen: the **Share** button, a menu's *Live
 * dashboard links*. Await it at the top of `<script setup>`: the settings are
 * read during the server render, so a hidden button never flashes in. The
 * desktop app and the demo read nothing, and a failed read offers none.
 */
export async function useShareLinksOffered(): Promise<ComputedRef<boolean>> {
  const desktop = useIsDesktop();
  const demo = Boolean(useRuntimeConfig().public.demoMode);
  const requestFetch = useRequestFetch();
  const { data } = await useAsyncData<ShareLinkSettings | null>(
    'share-links-settings',
    () => (desktop || demo ? Promise.resolve(null) : requestFetch<ShareLinkSettings>(SETTINGS_URL).catch(() => null)),
    { default: () => null, dedupe: 'defer', getCachedData: reuseWithinRender },
  );
  return computed(() => shareLinksOffered({ enabled: data.value?.enabled === true, desktop, demo }));
}

/**
 * The same rule for a form that loads its options when it opens (a report
 * schedule, an issue, a project's issue tracker): `load()` reads the settings
 * the first time it is called (never in the desktop app or the demo), and
 * `offered` stays false until they arrive.
 */
export function useShareLinksOfferedOnOpen(): { offered: ComputedRef<boolean>; load: () => Promise<void> } {
  const desktop = useIsDesktop();
  const demo = Boolean(useRuntimeConfig().public.demoMode);
  const settings = ref<ShareLinkSettings | null>(null);
  let loading: Promise<void> | null = null;

  function load(): Promise<void> {
    if (desktop || demo) return Promise.resolve();
    loading ??= $fetch<ShareLinkSettings>(SETTINGS_URL)
      .then((answer) => {
        settings.value = answer;
      })
      .catch(() => {
        settings.value = null;
      });
    return loading;
  }

  const offered = computed(() => shareLinksOffered({ enabled: settings.value?.enabled === true, desktop, demo }));
  return { offered, load };
}
