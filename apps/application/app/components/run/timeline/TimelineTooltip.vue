<script setup lang="ts">
import { computed } from 'vue';
import { isGapKind, isHookKind, type TimelineItem } from '~/composables/useTimelineModel';
import {
  TIMELINE_WAIT_COLORS,
  timelineStatusColor,
  timelineHookColors,
  timelineStepColor,
  formatTimelineTime,
} from '~/utils/timeline';
import { stepHookName } from '#shared/step-tree';

const props = defineProps<{
  /** The hover state the timeline shares with its focus overlay: the hovered item and the pointer. */
  state: { item: TimelineItem | null; pos: { x: number; y: number } };
  /** Lock name → color, so the tooltip swatches match the brackets. */
  lockColorMap?: Map<string, string>;
  /** Every attempt of a test that ran more than once, first attempt first; empty otherwise. */
  attempts?: (item: TimelineItem) => TimelineItem[];
}>();

const item = computed(() => props.state.item);

const swatchStyle = computed(() => {
  const hovered = item.value;
  if (!hovered) return {};
  if (hovered.kind === 'test') return { backgroundColor: timelineStatusColor(hovered.status, hovered.retries) };
  if (hovered.kind === 'step')
    return { backgroundColor: timelineStepColor(hovered.category ?? 'other', hovered.status === 'failed') };
  if (hovered.kind === 'wait') {
    return { backgroundColor: TIMELINE_WAIT_COLORS.swatch + '66', borderColor: TIMELINE_WAIT_COLORS.swatch };
  }
  if (isGapKind(hovered.kind)) return { borderColor: '#9ca3af' };
  const hook = timelineHookColors(hovered.status);
  return { backgroundColor: hook.fill, opacity: Math.max(hook.opacity, 0.5) };
});

/** The small uppercase label before the title: a hook section's side, else the bar's kind. */
const kindLabel = computed(() => {
  const hovered = item.value;
  if (!hovered) return '';
  if (hovered.kind === 'step') return hovered.category ?? 'step';
  return hovered.section ?? hovered.kind;
});

/** A hook section's hooks and fixtures by short name (`beforeAll`, `fixture "db"`). */
const hookRows = computed(() =>
  (item.value?.hooks ?? []).map((hook) => ({
    name: stepHookName(hook) ?? hook.title,
    duration: hook.duration,
    failed: hook.failed === true,
  })),
);

const isGap = computed(() => (item.value ? isGapKind(item.value.kind) : false));

/** Every attempt of the hovered test, when Playwright ran it more than once. */
const attemptList = computed<TimelineItem[]>(() => {
  const hovered = item.value;
  if (!hovered || hovered.kind !== 'test' || !props.attempts) return [];
  const attempts = props.attempts(hovered);
  return attempts.length > 1 ? attempts : [];
});

/** One row per attempt: its own status, when it started on the run's axis, how long it took and where. */
const attemptRows = computed(() =>
  attemptList.value.map((attempt) => {
    const color = timelineStatusColor(attempt.status, attempt.retries);
    return {
      key: attempt.key,
      label: `Attempt ${(attempt.retries ?? 0) + 1}`,
      status: formatStatusLabel(attempt.status),
      // A retried attempt's dot is an outline, like its bar.
      dot: attempt.retried ? { borderColor: color, borderWidth: '1.5px' } : { backgroundColor: color },
      facts: `at ${formatTimelineTime(attempt.start)} · ${formatTimelineTime(attempt.duration)} · Worker ${attempt.slot ?? attempt.workerIndex}`,
      current: attempt.key === item.value?.key,
    };
  }),
);

/** What the attempts came to: the last one decides the test's outcome. */
const attemptsOutcome = computed(() => {
  const last = attemptList.value[attemptList.value.length - 1];
  if (!last) return null;
  const number = (last.retries ?? 0) + 1;
  switch (statusPaletteKey(last.status, last.retries)) {
    case 'flaky':
      return `Passed on attempt ${number}`;
    case 'failed':
      return `Failed all ${number} attempts`;
    default:
      return `Attempt ${number} ${formatStatusLabel(last.status)}`;
  }
});

/** The worker process, named when it differs from the lane's worker number. */
const processLabel = computed(() => {
  const hovered = item.value;
  if (!hovered || hovered.slot == null || hovered.slot === hovered.workerIndex) return null;
  return `process ${hovered.workerIndex}`;
});

/** What an empty stretch of the lane was: idle time, or a new worker process starting. */
const gapText = computed<string[]>(() => {
  const hovered = item.value;
  if (!hovered?.gap) return [];
  const { after, before } = hovered.gap;
  if (hovered.kind === 'restart' && after && before) {
    const ended = isFailedStatus(after.status)
      ? `Process ${after.workerIndex} ended after “${after.title}” failed: Playwright replaces a worker process after a failure.`
      : `Process ${after.workerIndex} ended after “${after.title}”. Playwright starts a new worker process after a failure, and for tests that need another project or different worker options.`;
    return [ended, `This is the old process shutting down and process ${before.workerIndex} starting up.`];
  }
  if (after && before) return [`No test ran on this worker between “${after.title}” and “${before.title}”.`];
  if (before) return [`No test ran on this worker before “${before.title}”.`];
  if (after) return [`No test ran on this worker after “${after.title}”: it had none left while the others finished.`];
  return [];
});

/** What clicking the bar does, for the bars whose click is not obvious. */
const clickHint = computed(() => {
  const hovered = item.value;
  if (!hovered || hovered.testCaseId == null || !isHookKind(hovered.kind)) return null;
  return 'Click to open the steps on this hook';
});

// Anchor right/bottom of the cursor by default, flipping near the viewport
// edges so the tooltip never overflows off-screen.
const TOOLTIP_MAX_WIDTH = 340;
const positionStyle = computed(() => {
  const { x, y } = props.state.pos;
  if (typeof window === 'undefined') return { left: `${x + 12}px`, top: `${y - 10}px` };
  const flipX = x + 12 + TOOLTIP_MAX_WIDTH > window.innerWidth;
  const extraRows =
    hookRows.value.length + gapText.value.length * 2 + (attemptRows.value.length ? attemptRows.value.length + 1 : 0);
  const flipY = y + 90 + extraRows * 16 > window.innerHeight;
  return {
    left: flipX ? undefined : `${x + 12}px`,
    right: flipX ? `${window.innerWidth - x + 12}px` : undefined,
    top: flipY ? undefined : `${y - 10}px`,
    bottom: flipY ? `${window.innerHeight - y + 10}px` : undefined,
  };
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="item"
      data-testid="timeline-tooltip"
      class="fixed z-[9999] pointer-events-none rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs shadow-lg"
      :style="positionStyle"
    >
      <div class="flex items-center gap-2 mb-1">
        <span
          class="inline-block size-2.5 rounded-full shrink-0"
          :class="{ 'border border-dashed': item.kind === 'wait' || isGap }"
          :style="swatchStyle"
        />
        <span class="font-medium text-gray-900 dark:text-white max-w-64 truncate">
          <span
            v-if="item.kind !== 'test' && !isGap"
            class="uppercase text-[10px] tracking-wider mr-1"
            :class="item.kind === 'wait' ? 'text-amber-500' : 'text-gray-500'"
          >
            {{ kindLabel }}
          </span>
          {{ item.title }}
        </span>
      </div>
      <div v-if="item.subtitle" class="mb-1 font-mono text-[11px] text-gray-400 truncate max-w-72">
        {{ item.subtitle }}
      </div>
      <div class="flex items-center gap-3 text-gray-500">
        <span v-if="!isGap">{{ statusChipLabel(item.status, item.retries) }}</span>
        <span>{{ formatTimelineTime(item.duration) }}</span>
        <span>
          Worker {{ item.slot ?? item.workerIndex }}<template v-if="processLabel"> · {{ processLabel }}</template>
        </span>
        <span v-if="item.parentTitle" class="italic truncate max-w-48"> for {{ item.parentTitle }} </span>
      </div>
      <p v-for="(line, i) in gapText" :key="i" class="mt-1 text-gray-500 dark:text-gray-400 max-w-72">{{ line }}</p>
      <div v-if="item.reportedDuration != null" class="mt-1 text-gray-400 max-w-72">
        Playwright reports {{ formatTimelineTime(item.reportedDuration) }}; the rest ran in hooks it does not count
        (beforeAll, afterAll, worker fixtures).
      </div>
      <ul v-if="hookRows.length" class="mt-1.5 space-y-0.5 max-w-72" data-testid="timeline-tooltip-hooks">
        <li
          v-for="(hook, i) in hookRows"
          :key="i"
          class="flex items-center gap-2"
          :class="hook.failed ? 'text-red-500 font-medium' : 'text-gray-600 dark:text-gray-300'"
        >
          <UIcon :name="hook.failed ? 'i-lucide-x' : 'i-lucide-dot'" class="size-3 shrink-0" />
          <span class="truncate">{{ hook.name }}</span>
          <span class="ml-auto pl-2 tabular-nums text-gray-400">{{ formatTimelineTime(hook.duration) }}</span>
        </li>
      </ul>
      <div v-if="attemptRows.length" class="mt-1.5 max-w-80" data-testid="timeline-tooltip-attempts">
        <p class="text-gray-600 dark:text-gray-300">{{ attemptsOutcome }}</p>
        <ul class="mt-0.5 space-y-0.5">
          <li
            v-for="row in attemptRows"
            :key="row.key"
            class="flex items-center gap-2"
            :class="row.current ? 'font-medium text-gray-900 dark:text-white' : 'text-gray-500'"
            :data-current="row.current ? '' : undefined"
          >
            <span class="inline-block size-2 rounded-full shrink-0 border-solid" :style="row.dot" />
            <span class="shrink-0">{{ row.label }}</span>
            <span class="shrink-0">{{ row.status }}</span>
            <span class="ml-auto pl-2 tabular-nums whitespace-nowrap">{{ row.facts }}</span>
          </li>
        </ul>
      </div>
      <div v-if="item.error" class="mt-1 text-red-500 line-clamp-2 break-words max-w-72">{{ item.error }}</div>
      <div v-if="clickHint" class="mt-1 text-[11px] text-gray-400">{{ clickHint }}</div>
      <div v-if="item.locks?.length" class="flex items-center gap-2 flex-wrap mt-1 text-gray-500">
        <UIcon name="i-lucide-lock" class="size-3 shrink-0" />
        <span v-for="lock in item.locks" :key="lock" class="inline-flex items-center gap-1">
          <span
            class="inline-block size-2 rounded-sm shrink-0"
            :style="{ backgroundColor: lockColorMap?.get(lock) ?? '#a1a1aa' }"
          />
          {{ lock }}
        </span>
      </div>
    </div>
  </Teleport>
</template>
