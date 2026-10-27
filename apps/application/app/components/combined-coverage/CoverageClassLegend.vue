<script setup lang="ts">
/**
 * The key to the coverage colors, the same on the bars and on the source
 * marks: both kinds of suite, unit only, end to end only, undetermined, and
 * no suite. `kinds` keeps to the classes a view shows.
 */
import { LINE_CLASS_MARKS, type LineClassKind } from '~/utils/coverage-view';

const props = defineProps<{ kinds?: LineClassKind[] }>();

const items = computed(() =>
  (Object.keys(LINE_CLASS_MARKS) as LineClassKind[])
    .filter((kind) => !props.kinds || props.kinds.includes(kind))
    .map((kind) => ({ kind, ...LINE_CLASS_MARKS[kind] })),
);
</script>

<template>
  <p
    class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted"
    data-class-legend
    data-tour="coverage-class-legend"
  >
    <span v-for="item in items" :key="item.kind" class="inline-flex items-center gap-1.5">
      <span class="inline-block h-2.5 w-2.5 rounded-sm" :class="item.legend" aria-hidden="true" />{{ item.label }}
    </span>
    <HelpHint topic="coverage.combined-marks" />
  </p>
</template>
