<script setup lang="ts">
/** One numbered step of the connect wizard: its number on a rail, a label, then what to copy. */
defineProps<{
  n: number;
  title: string;
  /** The last step draws no rail below its number. */
  last?: boolean;
}>();
</script>

<template>
  <li class="flex gap-3 sm:gap-4">
    <div class="flex flex-col items-center shrink-0">
      <span
        class="flex size-7 items-center justify-center rounded-md border border-default bg-elevated font-mono text-xs text-muted"
        aria-hidden="true"
        >{{ String(n).padStart(2, '0') }}</span
      >
      <span v-if="!last" class="w-px flex-1 mt-2 bg-accented" aria-hidden="true" />
    </div>
    <div class="flex-1 min-w-0 space-y-2 pt-0.5">
      <h3 class="text-sm font-semibold text-highlighted">{{ title }}</h3>
      <slot />
    </div>
  </li>
</template>
