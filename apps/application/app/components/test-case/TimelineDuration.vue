<script setup lang="ts">
/**
 * The duration of a step or a request on the execution timeline: the number,
 * its share of the test and a bar placed on the test's clock. It takes the one
 * warning tone (`app/utils/duration-tone.ts`) only when it stands out
 * (`durationStandout`): in the test, or against its usual time, which then
 * shows under it (`usually 600ms`). It says why on hover. Otherwise it stays
 * neutral, the bar of a failed step or request in the failed outcome color.
 * The time the test stood paused at a breakpoint during it is said under it
 * (`paused 4.0s`) and left out of the share and the rule: the number and the
 * bar keep the clock time.
 */
import { durationStandout, shareOfTestLabel, standoutReasonText } from '#shared/duration-standout';

const props = defineProps<{
  /** The duration, in ms. */
  ms: number;
  /** The test's duration, in ms — the share and the rule read against it. */
  testMs: number | null;
  /** The usual duration of the same step or request over the last passing runs, in ms. */
  usualMs?: number | null;
  /** Where the bar sits on its track, in percent; no bar when null. */
  bar: { left: number; width: number } | null;
  /** A group (a `test.step`, a setup section) holds other rows' time: it never stands out. */
  group?: boolean;
  /** The step or request failed: its bar keeps the failed outcome color unless the duration stands out. */
  failed?: boolean;
  /** How much of `ms` the test stood paused at Piwi's pause bar, in ms. */
  pausedMs?: number | null;
}>();

/** The time of its own: the duration less the time paused, which the share and the rule read. */
const ownMs = computed(() => Math.max(0, props.ms - (props.pausedMs ?? 0)));
const standout = computed(() =>
  props.group ? null : durationStandout({ ms: ownMs.value, testMs: props.testMs, usualMs: props.usualMs }),
);
const share = computed(() => shareOfTestLabel(ownMs.value, props.testMs));
const title = computed(() =>
  standout.value ? `${formatDuration(ownMs.value)}, ${standoutReasonText(standout.value, formatDuration)}` : undefined,
);
const barClass = computed(() =>
  standout.value ? STANDOUT_BAR_CLASS : props.failed ? STATUS_PALETTE.failed.bg : DURATION_BAR_CLASS,
);
</script>

<template>
  <div :data-standout="standout?.reason" :title="title">
    <div class="flex items-center justify-between gap-2">
      <DurationValue
        :ms="ms"
        :class="['text-sm', standout ? STANDOUT_TEXT_CLASS : DURATION_TEXT_CLASS]"
        unit-class="opacity-60"
        :no-title="Boolean(standout)"
      />
      <span v-if="share" class="text-xs tabular-nums text-muted">{{ share }}</span>
    </div>
    <p v-if="standout?.reason === 'usual'" class="text-xs text-muted" data-testid="usual-duration">
      usually <DurationValue :ms="standout.usual" unit-class="opacity-60" no-title />
    </p>
    <p v-if="pausedMs" class="text-xs text-muted" data-testid="paused-duration">
      paused <DurationValue :ms="pausedMs" unit-class="opacity-60" no-title />
    </p>
    <div v-if="bar" class="relative mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
      <div
        class="absolute inset-y-0 rounded-full"
        :class="barClass"
        :style="{ left: `${bar.left}%`, width: `${bar.width}%` }"
      />
    </div>
  </div>
</template>
