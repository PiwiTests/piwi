<script setup lang="ts">
import { beforeFirstTestText, type BeforeFirstTest } from '~/utils/run-before-tests';

/** A run's Tests list before its first test: its global setup, or its tests starting, and for how long. */
const props = defineProps<{
  /** When the run began. */
  since: string | Date;
  /** Where the run stands, as the page knows it. */
  run: BeforeFirstTest;
}>();

// The time counts once mounted, so the server and the browser render the same text.
const now = ref<number | null>(null);
let clock: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  now.value = Date.now();
  clock = setInterval(() => (now.value = Date.now()), 1000);
});
onBeforeUnmount(() => {
  if (clock) clearInterval(clock);
});
const text = computed(() =>
  beforeFirstTestText(props.run, now.value === null ? null : now.value - new Date(props.since).getTime()),
);
</script>

<template>
  <EmptyState icon="i-lucide-hourglass" :text="text" data-testid="before-first-test" />
</template>
