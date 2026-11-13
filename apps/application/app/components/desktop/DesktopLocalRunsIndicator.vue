<script setup lang="ts">
/**
 * Desktop shell only: ambient sidebar pill shown while local test runs are
 * active, so a run started on one page stays visible (and reachable) from
 * every other. Clicking opens the Local runs tray. Renders nothing without
 * the IPC bridge or when no run is active.
 */
const props = defineProps<{ collapsed?: boolean }>();

const store = useDesktopLocalRuns();

const available = ref(false);
onMounted(() => {
  available.value = !!tauriCore();
});

const active = computed(() => store.runs.value.filter((r) => r.status === 'running'));
const label = computed(() => `${active.value.length} local run${active.value.length === 1 ? '' : 's'}`);

const { count } = useDesktopRunBadge();

/**
 * "7/12" across every active run that knows its tests: as its own process counts them, else as Playwright's output
 * announced them.
 */
const progress = computed(() => {
  const known = active.value
    .map((run) => count(run) ?? (run.progressTotal ? { done: run.progressDone, total: run.progressTotal } : null))
    .filter((known) => known !== null);
  if (known.length === 0) return '';
  const done = known.reduce((sum, r) => sum + r.done, 0);
  const total = known.reduce((sum, r) => sum + r.total, 0);
  return `${done}/${total}`;
});
</script>

<template>
  <UTooltip v-if="available && active.length > 0" :text="props.collapsed ? label : 'Open the Local runs tray'">
    <UButton
      color="info"
      variant="soft"
      size="xs"
      block
      :square="props.collapsed"
      :aria-label="label"
      :class="props.collapsed ? '' : 'justify-start'"
      @click="store.trayOpen.value = true"
    >
      <span class="relative flex size-2 shrink-0" aria-hidden="true">
        <span
          class="absolute inline-flex h-full w-full animate-ping rounded-full bg-info opacity-60 motion-reduce:hidden"
        />
        <span class="relative inline-flex size-2 rounded-full bg-info" />
      </span>
      <template v-if="!props.collapsed">
        <span class="truncate">{{ label }}</span>
        <span v-if="progress" class="text-muted tabular-nums">{{ progress }}</span>
      </template>
    </UButton>
  </UTooltip>
</template>
