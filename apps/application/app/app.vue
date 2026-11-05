<script setup lang="ts">
const config = useRuntimeConfig();
const colorMode = useColorMode();
const route = useRoute();
// Desktop shell only: the Local runs tray loads once the page has the shell's bridge, never in another build.
const desktopBridge = ref(false);
onMounted(() => {
  desktopBridge.value = !!tauriCore();
});

// Matches --ui-bg-canvas (zinc-950 / zinc-100) so mobile browser chrome
// blends with the page background.
const color = computed(() => (colorMode.value === 'dark' ? '#09090b' : '#f4f4f5'));
// Prepend the app base URL so the favicon resolves correctly in demo mode
// (where baseURL is /demo/) and in normal mode (where it is /). Its `favicon`
// key lets a page watching a run swap in a progress badge (useTabRunIndicator).
const iconHref = (config.app?.baseURL ?? '/').replace(/\/$/, '') + '/logo.svg';

useHead({
  meta: [
    { charset: 'utf-8' },
    { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    { key: 'theme-color', name: 'theme-color', content: color },
  ],
  link: [{ key: 'favicon', rel: 'icon', type: 'image/svg+xml', href: iconHref }],
  htmlAttrs: {
    lang: 'en',
  },
});

const title = 'Piwi Dashboard';
const description = 'Your Playwright results, kept and explained.';

// The public demo's title, description and link-preview cards live in its
// static shell (nuxt.config.ts), which is what search engines index.
if (!config.public.demoMode) {
  useSeoMeta({
    title,
    description,
    ogTitle: title,
    ogDescription: description,
    twitterCard: 'summary_large_image',
  });
}
</script>

<template>
  <UApp>
    <DemoInitScreen />
    <DemoBanner />
    <NuxtLoadingIndicator />

    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>

    <!-- Desktop shell: the Local runs tray, outside the layouts so a layout change keeps its runs and their windows.
         A page without a layout (a run's output window) has none. -->
    <LazyDesktopLocalRunsTray v-if="desktopBridge && route.meta.layout !== false" />

    <LazyDemoTour v-if="config.public.demoTour" />
  </UApp>
</template>
