<script setup lang="ts">
/**
 * Streaming output pane for one local run: monospace lines in their ANSI
 * colors, stderr in red, pinned to the bottom while new lines arrive unless the
 * user scrolled up. `fill` makes it take its container's height (a window of
 * its own) instead of its fixed one.
 */
import type { LocalRunLine } from '~/composables/useDesktopLocalRuns';
import { renderAnsi } from '~/utils';

const props = defineProps<{ lines: LocalRunLine[]; fill?: boolean }>();

const el = ref<HTMLElement | null>(null);
const pinned = ref(true);

/** Each colored line's HTML, rendered once. */
const rendered = new WeakMap<LocalRunLine, string>();
function coloredHtml(line: LocalRunLine): string {
  let html = rendered.get(line);
  if (html === undefined) {
    html = renderAnsi(line.ansi ?? line.text, { onDark: true });
    rendered.set(line, html);
  }
  return html;
}

function onScroll() {
  const node = el.value;
  if (!node) return;
  pinned.value = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
}

// The newest line, not the count: a run at its line cap drops one line for each it adds.
watch(
  () => props.lines.at(-1)?.id,
  async () => {
    if (!pinned.value) return;
    await nextTick();
    el.value?.scrollTo({ top: el.value.scrollHeight });
  },
);

onMounted(() => {
  el.value?.scrollTo({ top: el.value.scrollHeight });
});
</script>

<template>
  <div
    ref="el"
    class="overflow-y-auto rounded-md bg-zinc-950 p-3"
    :class="fill ? 'h-full' : 'h-56'"
    @scroll.passive="onScroll"
  >
    <template v-for="line in lines" :key="line.id">
      <!-- eslint-disable-next-line vue/no-v-html — renderAnsi escapes the text before wrapping it in styled spans -->
      <p
        v-if="line.ansi"
        class="font-mono text-xs whitespace-pre-wrap"
        :class="line.error ? 'text-red-400' : 'text-zinc-300'"
        v-html="coloredHtml(line)"
      />
      <p v-else class="font-mono text-xs whitespace-pre-wrap" :class="line.error ? 'text-red-400' : 'text-zinc-300'">
        {{ line.text || ' ' }}
      </p>
    </template>
    <p v-if="lines.length === 0" class="font-mono text-xs text-zinc-500">Waiting for output…</p>
  </div>
</template>
