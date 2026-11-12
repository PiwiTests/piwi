<script setup lang="ts">
/**
 * The lane panel's page text, line by line: what the search finds marked, and the lines naming the element the shown
 * call targets ringed. A component of its own, so the panel's images, a few a second, never render its lines again. It
 * scrolls to its first match as the search or the text changes, else to the target's first line as a text comes.
 */
import { markedParts, type LaneTextLine } from '~/utils/live-layers';

const props = defineProps<{
  lines: LaneTextLine[];
  /** Each line's matches, as `laneTextMatches` finds them; null with no search. */
  ranges: Array<Array<[number, number]>> | null;
  /** The lines naming the target, by their place from 0. */
  targets: ReadonlySet<number>;
}>();

const box = ref<HTMLElement | null>(null);
function showFirst(): void {
  const first = box.value?.querySelector<HTMLElement>(props.ranges ? 'mark' : '[data-target]');
  if (box.value && first) box.value.scrollTop = Math.max(0, first.offsetTop - box.value.clientHeight / 3);
}
onMounted(showFirst);
watch([() => props.ranges, () => props.lines], showFirst, { flush: 'post' });
</script>

<template>
  <div
    ref="box"
    role="region"
    tabindex="0"
    aria-label="The page’s text, as roles and names"
    class="relative max-h-72 overflow-auto rounded-md border border-default bg-elevated px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words text-highlighted @3xl:max-h-[min(32rem,60svh)]"
    data-testid="live-text"
  >
    <div
      v-for="(line, i) in lines"
      :key="i"
      class="min-h-4"
      :class="targets.has(i) ? 'rounded-sm bg-warning/10 ring-1 ring-warning/50 ring-inset' : ''"
      :data-target="targets.has(i) || undefined"
    >
      <template v-for="(part, j) in markedParts(line.text, ranges?.[i])" :key="j">
        <mark
          v-if="part.marked"
          class="rounded-[2px] bg-yellow-200 text-current dark:bg-yellow-400/30"
          v-text="part.text"
        />
        <span v-else v-text="part.text" />
      </template>
    </div>
  </div>
</template>
