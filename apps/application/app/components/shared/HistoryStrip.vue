<script setup lang="ts">
/**
 * A test's recent executions as a row of squares, oldest to newest, colored by
 * outcome with the current execution ringed, each naming its run and outcome on
 * hover. Each square links to its execution, unless `linked` is false: then the
 * squares are drawn only. Linked, the row is one keyboard stop, a toolbar: Tab
 * reaches the current execution's square (else the newest), the Left and Right
 * arrow keys, Home and End move between the squares. No chart, no table: the full history
 * lives on the test page.
 */
import type { TestCaseHistoryPoint } from '~~/types/api';
import { HISTORY_STRIP_LENGTH } from '~/utils/history-streak';

const props = withDefaults(
  defineProps<{
    history: TestCaseHistoryPoint[];
    /** The current execution's id: ringed in the strip, and its square the row's keyboard stop. */
    currentId?: number | null;
    /** Each square links to its execution; false draws the squares only. */
    linked?: boolean;
    /** The row's accessible name, linked. */
    label?: string;
  }>(),
  { currentId: null, linked: true, label: 'Recent executions of this test, oldest to newest' },
);

/** Oldest → newest, capped at `HISTORY_STRIP_LENGTH`, for the strip. */
const strip = computed(() => props.history.slice(0, HISTORY_STRIP_LENGTH).slice().reverse());

const SQUARE_CLASS = 'size-3.5 rounded-sm inline-block';

/** A square's name: its run and outcome, and, linked, that it opens the execution. */
function pointLabel(point: TestCaseHistoryPoint): string {
  const outcome = formatExecutionStatus(point.status, point.passedAfterFailure);
  return props.linked ? `Execution in run #${point.runId}: ${outcome}` : `Run #${point.runId}: ${outcome}`;
}

// The row's one keyboard stop: the execution focused last, else the current one, else the newest.
const focusedId = ref<number | null>(null);
const stop = computed(() => {
  const focused = strip.value.findIndex((point) => point.id === focusedId.value);
  if (focused >= 0) return focused;
  const current = strip.value.findIndex((point) => point.id === props.currentId);
  return current >= 0 ? current : strip.value.length - 1;
});

const rowEl = ref<HTMLElement | null>(null);

/** Left and Right, Home and End move the focus along the row; a key held with a modifier is the browser's. */
function onKeydown(event: KeyboardEvent, index: number): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const last = strip.value.length - 1;
  const next =
    event.key === 'ArrowRight'
      ? Math.min(last, index + 1)
      : event.key === 'ArrowLeft'
        ? Math.max(0, index - 1)
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? last
            : null;
  if (next == null) return;
  event.preventDefault();
  focusedId.value = strip.value[next]!.id;
  rowEl.value?.querySelectorAll<HTMLElement>('a')[next]?.focus();
}
</script>

<template>
  <div
    v-if="strip.length"
    ref="rowEl"
    class="flex items-center gap-1 flex-wrap"
    :role="linked ? 'toolbar' : undefined"
    :aria-label="linked ? label : undefined"
  >
    <UTooltip v-for="(point, index) in strip" :key="point.id" :text="pointLabel(point)">
      <NuxtLink
        v-if="linked"
        :to="`/test-run-cases/${point.id}`"
        :aria-label="pointLabel(point)"
        :aria-current="point.id === currentId ? 'true' : undefined"
        :tabindex="index === stop ? 0 : -1"
        class="transition-opacity hover:opacity-80 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        :class="[
          SQUARE_CLASS,
          statusPalette(point.status, point.passedAfterFailure).bg,
          point.id === currentId ? CURRENT_ITEM_RING_CLASS : '',
        ]"
        @focus="focusedId = point.id"
        @keydown="onKeydown($event, index)"
      />
      <span
        v-else
        :class="[
          SQUARE_CLASS,
          statusPalette(point.status, point.passedAfterFailure).bg,
          point.id === currentId ? CURRENT_ITEM_RING_CLASS : '',
        ]"
      />
    </UTooltip>
  </div>
</template>
