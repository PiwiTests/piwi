<script setup lang="ts">
import type { BadgeProps } from '@nuxt/ui';

/**
 * Status verdict for detail summaries: icon and label in a single subtle
 * badge, the label in sentence case ("Didn't run"). The icon spins while the
 * status is in flight. Given an execution's verdict, a pass after a failed
 * attempt reads "Passed on retry" in the flaky color and icon.
 */
const props = defineProps<{
  status: string;
  /** The execution passed after an earlier attempt failed or timed out (`passedAfterFailure`). */
  flaky?: boolean | null;
  size?: BadgeProps['size'];
}>();

const key = computed(() => (statusPaletteKey(props.status, props.flaky) === 'flaky' ? 'flaky' : props.status));
</script>

<template>
  <UBadge :color="getStatusColor(key)" :size="size" variant="subtle" class="gap-1 items-center font-semibold shrink-0">
    <UIcon :name="getStatusIcon(key)" class="size-3.5 shrink-0" :class="{ 'animate-spin': isStatusInFlight(status) }" />
    {{ statusChipLabel(status, flaky) }}
  </UBadge>
</template>
