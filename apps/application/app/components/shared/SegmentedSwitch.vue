<script setup lang="ts" generic="K extends string">
/**
 * The segmented switch between the views of one tab (the Failures tab's
 * Clusters, Flaky and Quarantine; the Coverage tab's Gaps, Map and Code): one
 * pressed button per view, with an optional count after its label. A view can be off (`disabled`), with a `title` that
 * says why.
 */
import { SEGMENTED_SELECTED_CLASS } from '~/utils';

defineProps<{ items: Array<{ key: K; label: string; count?: number | null; disabled?: boolean; title?: string }> }>();
const selected = defineModel<K>({ required: true });
</script>

<template>
  <div class="flex">
    <div class="inline-flex rounded-lg border border-default p-0.5 bg-elevated/40">
      <button
        v-for="item in items"
        :key="item.key"
        type="button"
        class="px-3 py-1.5 text-sm font-medium rounded-md transition-colors"
        :class="[
          selected === item.key ? SEGMENTED_SELECTED_CLASS : 'text-muted hover:text-highlighted',
          item.disabled ? 'cursor-not-allowed opacity-50 hover:text-muted' : '',
        ]"
        :aria-pressed="selected === item.key"
        :aria-disabled="item.disabled ? 'true' : undefined"
        :title="item.title"
        @click="!item.disabled && (selected = item.key)"
      >
        {{ item.label }}<span v-if="item.count != null" class="tabular-nums text-muted"> ({{ item.count }})</span>
      </button>
    </div>
  </div>
</template>
