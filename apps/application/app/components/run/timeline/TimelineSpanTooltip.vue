<script setup lang="ts">
/**
 * What an object kept open for nothing was, under the pointer: what it was,
 * where it was opened, the test it outlived or lingered in, how long it stayed
 * open for nothing, and the line that last used it, where its close belongs.
 */
import { computed } from 'vue';
import { formatCpuTime, VERDICT_LABEL } from '#shared/resource-copy';
import type { SpanTail } from '~/utils/resource-spans';

const props = defineProps<{
  state: { tail: SpanTail | null; pos: { x: number; y: number } };
}>();

const KIND_LABEL: Record<SpanTail['kind'], string> = {
  browser: 'browser',
  context: 'context',
  page: 'page',
  request: 'API context',
};

const rows = computed(() => {
  const tail = props.state.tail;
  if (!tail) return null;
  const held = formatCpuTime(tail.end - tail.start);
  const past = tail.scope === 'describe' ? 'its describe block' : 'its test';
  const open =
    tail.verdict === 'lingering'
      ? `${held} after its last use, before its test closed it`
      : tail.untilWorkerEnd
        ? `${held} past ${past}, until the worker shut down`
        : `${held} past ${past}`;
  return {
    title: `${VERDICT_LABEL[tail.verdict]} ${KIND_LABEL[tail.kind]}`,
    facts: [
      { label: 'Opened', value: tail.where, mono: true },
      ...(tail.test
        ? [{ label: tail.verdict === 'lingering' ? 'In' : 'By', value: `“${tail.test.title}”`, mono: false }]
        : []),
      { label: 'Open', value: open, mono: false },
      ...(tail.pages > 0 && tail.kind !== 'page'
        ? [{ label: 'Pages', value: `${tail.pages} open in it`, mono: false }]
        : []),
      ...(tail.lastUse ? [{ label: 'Last used', value: tail.lastUse, mono: true }] : []),
    ],
    hint: tail.lastUse ? 'Its close belongs right after its last use.' : null,
  };
});

const TOOLTIP_MAX_WIDTH = 360;
const positionStyle = computed(() => {
  const { x, y } = props.state.pos;
  if (typeof window === 'undefined') return { left: `${x + 12}px`, top: `${y + 12}px` };
  const flipX = x + 12 + TOOLTIP_MAX_WIDTH > window.innerWidth;
  return {
    left: flipX ? undefined : `${x + 12}px`,
    right: flipX ? `${window.innerWidth - x + 12}px` : undefined,
    top: `${y + 12}px`,
  };
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="rows"
      class="fixed z-[9999] pointer-events-none rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs shadow-lg max-w-90"
      :style="positionStyle"
      data-testid="timeline-span-tooltip"
    >
      <div class="mb-1 font-medium text-gray-900 dark:text-white">
        {{ rows.title }}
        <span class="font-normal text-gray-500"> · {{ state.tail!.rowName }}</span>
      </div>
      <dl class="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-0.5">
        <template v-for="fact in rows.facts" :key="fact.label">
          <dt class="text-gray-500">{{ fact.label }}</dt>
          <dd class="text-gray-900 dark:text-white break-words" :class="{ 'font-mono': fact.mono }">
            {{ fact.value }}
          </dd>
        </template>
      </dl>
      <p v-if="rows.hint" class="mt-1 text-gray-500">{{ rows.hint }}</p>
    </div>
  </Teleport>
</template>
