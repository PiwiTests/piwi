<script setup lang="ts">
/**
 * A run's Stop, the same in every view of a run the shell starts (the dashboard's Local runs tray, its run page and
 * output window, Piwi Runner's window). **Stop** emits `stop`: the host asks the shell to stop the process as Ctrl+C
 * would. While the run winds down (`stopping`), the button gives way to **Force stop**, which emits `force` (the host
 * asks again, and the shell kills the process), described by the seconds left before the shell kills it anyway. A press
 * on Stop shows the run stopping at once, before the host says so, and moves the keyboard to Force stop, which takes no
 * press for a moment after the stop was asked (`runForceStopGuarded`, `aria-disabled` so it keeps the focus), so a
 * double-click on Stop only stops. `since` is when the stop was asked, else when this button first saw the run
 * stopping. The clock runs in the browser alone.
 */
const props = defineProps<{
  /** The run was asked to stop and still runs. */
  stopping: boolean;
  /** When the stop was asked, in ms since the epoch. */
  since?: number | null;
  /** Stop cannot be asked yet (the shell has not named the run's process). */
  disabled?: boolean;
}>();
const emit = defineEmits<{ stop: []; force: [] }>();

/** How long a press on Stop shows the run stopping while the host has not said so. */
const PRESS_SHOWN_MS = 3_000;

const { t } = useRunUiWords();
const countdownId = useId();
const forceButton = useTemplateRef<{ $el: HTMLElement }>('force');

/** The clock, which ticks in the browser while the run shows stopping; null before the button is mounted. */
const nowMs = ref<number | null>(null);
const ticker = useIntervalFn(() => (nowMs.value = Date.now()), 250, { immediate: false });

/** When Stop was pressed here, and when this button first saw the run stopping. */
const pressedAt = ref<number | null>(null);
const seenStopping = ref<number | null>(null);
watch(
  () => props.stopping,
  (stopping) => {
    seenStopping.value = stopping ? (seenStopping.value ?? pressedAt.value ?? nowMs.value) : null;
  },
);

const shownStopping = computed(
  () =>
    props.stopping ||
    (pressedAt.value !== null && nowMs.value !== null && nowMs.value - pressedAt.value < PRESS_SHOWN_MS),
);
const askedAt = computed(() => props.since ?? seenStopping.value ?? pressedAt.value);
const guarded = computed(
  () => askedAt.value !== null && nowMs.value !== null && runForceStopGuarded(askedAt.value, nowMs.value),
);
const secondsLeft = computed(() =>
  askedAt.value === null || nowMs.value === null ? 0 : runStopSecondsLeft(askedAt.value, nowMs.value),
);

onMounted(() => {
  nowMs.value = Date.now();
  if (props.stopping) seenStopping.value ??= nowMs.value;
  watch(
    shownStopping,
    (shown) => {
      if (shown) {
        nowMs.value = Date.now();
        ticker.resume();
        return;
      }
      ticker.pause();
      pressedAt.value = null;
    },
    { immediate: true },
  );
});

async function stop() {
  if (pressedAt.value !== null) return;
  const hadFocus = document.activeElement instanceof HTMLElement && document.activeElement.closest('button') !== null;
  nowMs.value = Date.now();
  pressedAt.value = nowMs.value;
  emit('stop');
  if (!hadFocus) return;
  await nextTick();
  forceButton.value?.$el?.focus();
}

function force() {
  if (!guarded.value) emit('force');
}
</script>

<template>
  <span v-if="shownStopping" class="inline-flex shrink-0 items-center gap-2" data-testid="run-stopping">
    <span
      v-if="secondsLeft > 0"
      :id="countdownId"
      class="text-xs text-muted tabular-nums"
      :title="t('runui_runStopsWithinHint')"
      data-testid="run-stops-within"
      >{{ t('runui_runStopsWithin', { seconds: secondsLeft }) }}</span
    >
    <UTooltip :text="t('runui_runForceStopHint')">
      <UButton
        ref="force"
        size="xs"
        color="error"
        variant="outline"
        icon="i-lucide-square"
        :aria-disabled="guarded || undefined"
        :aria-describedby="secondsLeft > 0 ? countdownId : undefined"
        :class="guarded ? 'cursor-not-allowed opacity-75' : ''"
        @click="force"
      >
        {{ t('runui_runForceStop') }}
      </UButton>
    </UTooltip>
  </span>
  <UButton
    v-else
    size="xs"
    color="neutral"
    variant="outline"
    icon="i-lucide-square"
    class="shrink-0"
    :disabled="disabled"
    @click="stop"
  >
    {{ t('runui_runStop') }}
  </UButton>
</template>
