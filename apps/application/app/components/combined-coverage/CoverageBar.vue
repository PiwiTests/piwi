<script setup lang="ts">
/**
 * The bar every coverage screen draws, in the colors the source marks use:
 * with `counts`, a commit's executable lines split by class (both kinds of
 * suite, unit only, end to end only, undetermined), the lines no suite ran
 * left as the track; with `share`, one suite's share of the lines, in its
 * kind's color.
 */
import { formatCount, formatPercent } from '~/utils/combined-coverage';

type ClassCounts = {
  executableLines: number;
  bothLines: number;
  unitOnlyLines: number;
  e2eOnlyLines: number;
  undeterminedLines: number;
};

const props = withDefaults(
  defineProps<{
    counts?: ClassCounts | null;
    /** One suite's share of the lines, 0–100, drawn in its kind's color. */
    share?: number | null;
    kind?: 'unit' | 'e2e';
    size?: 'sm' | 'md';
  }>(),
  { counts: null, share: null, kind: undefined, size: 'sm' },
);

const width = (part: number, whole: number) => `${whole > 0 ? Math.min(100, (part / whole) * 100) : 0}%`;

const segments = computed(() => {
  const c = props.counts;
  if (!c) {
    const share = Math.max(0, Math.min(100, props.share ?? 0));
    return [
      {
        key: 'share',
        class:
          props.kind === 'e2e' ? 'bg-coverage-e2e' : props.kind === 'unit' ? 'bg-coverage-unit' : 'bg-coverage-run',
        width: `${share}%`,
      },
    ];
  }
  return [
    { key: 'both', class: 'bg-coverage-run', width: width(c.bothLines, c.executableLines) },
    { key: 'unit', class: 'bg-coverage-unit', width: width(c.unitOnlyLines, c.executableLines) },
    { key: 'e2e', class: 'bg-coverage-e2e', width: width(c.e2eOnlyLines, c.executableLines) },
    { key: 'undetermined', class: 'bg-coverage-undetermined', width: width(c.undeterminedLines, c.executableLines) },
  ];
});

const title = computed(() => {
  const c = props.counts;
  if (!c) return `${formatPercent(props.share)} of lines`;
  const none = c.executableLines - c.bothLines - c.unitOnlyLines - c.e2eOnlyLines - c.undeterminedLines;
  return [
    `Both kinds of suite ${formatCount(c.bothLines)}`,
    `unit only ${formatCount(c.unitOnlyLines)}`,
    `end to end only ${formatCount(c.e2eOnlyLines)}`,
    ...(c.undeterminedLines ? [`undetermined ${formatCount(c.undeterminedLines)}`] : []),
    `no suite ${formatCount(Math.max(0, none))}`,
  ].join(' · ');
});
</script>

<template>
  <div
    class="flex overflow-hidden rounded-full bg-[var(--color-coverage-not-run)]/25"
    :class="size === 'md' ? 'h-2.5' : 'h-1.5'"
    role="img"
    :aria-label="title"
    :title="title"
    data-coverage-bar
  >
    <div
      v-for="segment in segments"
      :key="segment.key"
      class="h-full"
      :class="segment.class"
      :style="{ width: segment.width }"
    />
  </div>
</template>
