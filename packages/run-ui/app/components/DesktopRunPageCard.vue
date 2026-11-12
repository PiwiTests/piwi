<script setup lang="ts">
/**
 * Desktop shell only: the card a worker's page shows in, in the Local runs tray, as Piwi Picker's Runs window draws it.
 * Its head names it (the caption, and under it who watches the page, `watchers`) and holds the page's tools, each a
 * toggle (`tools`); then the image or the live view, with what it says of it (the default slot); and at its foot, who
 * drives the stop, with Take control or Give back (`foot`).
 */
import { desktopSay } from '../utils/run-view';

defineProps<{
  /** Who watches the page, as the run model says it; none while nobody does. */
  watchers?: string | null;
}>();

const captionId = useId();
</script>

<template>
  <figure class="m-0 overflow-hidden rounded-lg border border-default bg-default" :aria-labelledby="captionId">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 min-h-9 py-1 pl-2.5 pr-1.5 border-b border-default">
      <div class="flex flex-col min-w-0 mr-auto">
        <span :id="captionId" class="text-xs font-semibold text-muted">{{ desktopSay('runs_pageCaption') }}</span>
        <span
          v-if="watchers"
          class="flex items-center gap-1.5 text-xs text-muted"
          data-testid="desktop-worker-watchers"
        >
          <UIcon name="i-lucide-eye" class="size-3 shrink-0" aria-hidden="true" />
          {{ watchers }}
        </span>
      </div>
      <div v-if="$slots.tools" class="flex flex-wrap gap-1.5">
        <slot name="tools" />
      </div>
    </div>
    <slot />
    <div v-if="$slots.foot" class="border-t border-default px-2.5 py-1.5">
      <slot name="foot" />
    </div>
  </figure>
</template>
