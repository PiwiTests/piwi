<script setup lang="ts">
/**
 * The Piwi logo, the navy drawing on a light page and the reversed one on a dark page. `lockup` is the bird, "piwi" and
 * "tests"; `nav` drops "tests" for the sidebar; `mark` is the bird alone in violet, for the collapsed rail.
 * Size it with a height class. Prefixing the base URL keeps the files resolvable when the demo is served from /demo/.
 */
const props = withDefaults(defineProps<{ variant?: 'lockup' | 'nav' | 'mark' }>(), { variant: 'lockup' });

const base = (useRuntimeConfig().app?.baseURL ?? '/').replace(/\/$/, '');
const FILES = { lockup: 'logo-wide', nav: 'logo-nav', mark: 'logo-mark' } as const;
const file = computed(() => FILES[props.variant]);
</script>

<template>
  <span class="inline-flex shrink-0">
    <img :src="`${base}/${file}.svg`" alt="Piwi" class="h-full w-auto dark:hidden" />
    <img :src="`${base}/${file}-dark.svg`" alt="Piwi" class="hidden h-full w-auto dark:block" />
  </span>
</template>
