<script setup lang="ts">
/**
 * Desktop shell only: a run's number on the instance it reports to and **Open**, once its own process named its page
 * (`HubSession.page`). A page on this app's own server opens in the window; one on a team instance (a run it asked
 * for) opens in the browser, as every link to another origin does in the shell.
 */
import type { RunPage } from '@piwitests/core/run-channel';

const props = defineProps<{ page: RunPage }>();

/** The page as a path of this window when it is this app's own, else its whole address. */
const target = computed(() => {
  if (!import.meta.client) return { href: props.page.url };
  try {
    const url = new URL(props.page.url);
    return url.origin === window.location.origin ? { to: `${url.pathname}${url.search}` } : { href: props.page.url };
  } catch {
    return { href: props.page.url };
  }
});
</script>

<template>
  <p class="flex items-center gap-1.5 text-xs text-muted" data-testid="desktop-run-page">
    <span class="font-semibold text-highlighted">Run #{{ page.id }}</span>
    <span aria-hidden="true">·</span>
    <ULink
      v-bind="target"
      :target="'href' in target ? '_blank' : undefined"
      class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
      :aria-label="`Open run #${page.id}`"
      >Open</ULink
    >
  </p>
</template>
