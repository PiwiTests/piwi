<script setup lang="ts">
/**
 * Desktop shell only: the sidebar's way to the Local runs tray, on every page, which opens or closes it. While local
 * runs go on it is a pill that says how many, and how far their tests are; otherwise a quiet entry. Either is marked
 * with a dot while a run ended unseen with the tray closed (`unseen` of the store): red when one of them failed, green
 * when they all passed, grey otherwise. Renders nothing without the IPC bridge.
 */
const props = defineProps<{ collapsed?: boolean }>();

const store = useDesktopLocalRuns();
const { trayOpen } = store;

const available = ref(false);
onMounted(() => {
  available.value = !!tauriCore();
});

const active = computed(() => store.runs.value.filter((r) => r.status === 'running'));

/** The runs that ended while the tray was closed, still in the tray. */
const unseenRuns = computed(() => store.runs.value.filter((run) => store.unseen.value.includes(run.key)));
const unseenFailed = computed(() => unseenRuns.value.some((run) => run.status === 'failed' || run.status === 'error'));
const unseenDot = computed(() => {
  if (unseenFailed.value) return 'bg-error';
  return unseenRuns.value.every((run) => run.status === 'passed') ? 'bg-success' : 'bg-neutral-400';
});

/** What the runs that ended unseen say: empty while there is none. */
const unseenWords = computed(() => {
  const unseen = unseenRuns.value.length;
  if (unseen === 0) return '';
  if (unseen === 1) return `a run ${unseenFailed.value ? 'failed' : 'ended'} since you looked`;
  return `${unseen} runs ended since you looked${unseenFailed.value ? ', with a failure' : ''}`;
});

const label = computed(() => {
  if (active.value.length > 0) {
    const going = `${active.value.length} local run${active.value.length === 1 ? '' : 's'}`;
    return unseenWords.value ? `${going}; ${unseenWords.value}` : going;
  }
  return unseenWords.value ? `Local runs: ${unseenWords.value}` : 'Local runs';
});

const tooltip = computed(() => {
  if (props.collapsed) return label.value;
  return trayOpen.value ? 'Close the Local runs tray (g then t)' : 'Open the Local runs tray (g then t)';
});

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
  <UTooltip v-if="available" :text="tooltip">
    <UButton
      v-if="active.length > 0"
      color="info"
      variant="soft"
      size="xs"
      block
      :square="props.collapsed"
      :aria-label="label"
      :aria-expanded="trayOpen"
      :class="props.collapsed ? 'relative' : 'relative justify-start'"
      @click="trayOpen = !trayOpen"
    >
      <span class="relative flex size-2 shrink-0" aria-hidden="true">
        <span
          class="absolute inline-flex h-full w-full animate-ping rounded-full bg-info opacity-60 motion-reduce:hidden"
        />
        <span class="relative inline-flex size-2 rounded-full bg-info" />
      </span>
      <template v-if="!props.collapsed">
        <span class="truncate">{{ active.length }} local run{{ active.length === 1 ? '' : 's' }}</span>
        <span v-if="progress" class="text-muted tabular-nums">{{ progress }}</span>
      </template>
      <span
        v-if="unseenRuns.length > 0"
        class="size-2 shrink-0 rounded-full"
        :class="[unseenDot, props.collapsed ? 'absolute top-1 right-1' : 'ml-auto']"
        aria-hidden="true"
        data-testid="local-runs-unseen"
      />
    </UButton>
    <UButton
      v-else
      color="neutral"
      variant="ghost"
      size="xs"
      block
      icon="i-lucide-terminal"
      :square="props.collapsed"
      :aria-label="label"
      :aria-expanded="trayOpen"
      :class="props.collapsed ? 'relative' : 'relative justify-start'"
      data-testid="local-runs-entry"
      @click="trayOpen = !trayOpen"
    >
      <span v-if="!props.collapsed" class="truncate">Local runs</span>
      <span
        v-if="unseenRuns.length > 0"
        class="size-2 shrink-0 rounded-full"
        :class="[unseenDot, props.collapsed ? 'absolute top-1 right-1' : 'ml-auto']"
        aria-hidden="true"
        data-testid="local-runs-unseen"
      />
    </UButton>
  </UTooltip>
</template>
