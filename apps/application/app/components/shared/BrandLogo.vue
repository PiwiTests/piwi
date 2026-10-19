<script setup lang="ts">
/**
 * The Piwi lockup (the bird, "piwi" and "tests"): the navy drawing on a light page, the reversed one on a dark page.
 * Size it with a height class. Prefixing the base URL keeps the files resolvable when the demo is served from /demo/.
 */
const base = (useRuntimeConfig().app?.baseURL ?? '/').replace(/\/$/, '');
</script>

<template>
  <span class="inline-flex shrink-0">
    <img :src="`${base}/logo-wide.svg`" alt="Piwi" class="h-full w-auto dark:hidden" />
    <img :src="`${base}/logo-wide-dark.svg`" alt="Piwi" class="hidden h-full w-auto dark:block" />
  </span>
</template>
