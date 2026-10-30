<script setup lang="ts">
/**
 * One row of the Features card of Settings → AI: the feature's name, help and
 * one-line description, its control on the right (a switch or a state), and
 * its settings below while it is on.
 */
import type { HelpTopicKey } from '~/utils/help-content';

defineProps<{ title: string; description: string; help?: HelpTopicKey }>();
</script>

<template>
  <div class="space-y-3 py-4 first:pt-0 last:pb-0">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <p class="inline-flex items-center gap-1 text-sm font-semibold text-highlighted">
          {{ title }} <HelpHint v-if="help" :topic="help" />
        </p>
        <p class="text-xs text-muted">{{ description }}</p>
      </div>
      <div class="shrink-0 pt-0.5">
        <slot name="control" />
      </div>
    </div>
    <div v-if="$slots.default" class="space-y-3">
      <slot />
    </div>
  </div>
</template>
