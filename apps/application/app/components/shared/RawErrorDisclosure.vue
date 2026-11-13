<script setup lang="ts">
/**
 * The "Raw error ▸" disclosure both failure pages carry on their facts line: a
 * ghost trigger inline with the other facts, and — one click below — the
 * verbatim ANSI error rendered with its colors. The panel wraps to its own
 * full-width line at the bottom of the facts row (`order-last basis-full`), so
 * the trigger keeps its place among the other controls whether open or closed.
 *
 * The execution page condenses the error first and offers a copy action (the
 * `actions` slot); the cluster page shows the fingerprint signature under it
 * (the `signature` prop). `reveal()` opens and scrolls to the panel so a clue or
 * diagnosis citation can point at the raw error.
 */
import { renderAnsi } from '@piwitests/run-ui/ansi';
import { condenseErrorText } from '#shared/error-fingerprint';

const props = defineProps<{
  /** The verbatim error; the trigger renders only when there is one. */
  error?: string | null;
  /** Condense the error before rendering (the execution page's long stacks). */
  condense?: boolean;
  /** The fingerprint signature line shown under the error (the cluster page). */
  signature?: string | null;
}>();

const open = ref(false);
const panelEl = ref<HTMLElement | null>(null);

const rendered = computed(() =>
  props.error ? renderAnsi(props.condense ? condenseErrorText(props.error) : props.error) : '',
);

function reveal() {
  open.value = true;
  nextTick(() => panelEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

defineExpose({ reveal });
</script>

<template>
  <UButton
    v-if="error"
    size="xs"
    variant="ghost"
    color="neutral"
    :trailing-icon="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
    label="Raw error"
    class="shrink-0"
    :aria-expanded="open"
    @click="open = !open"
  />
  <div v-if="open && error" ref="panelEl" class="order-last basis-full mt-2 space-y-2 scroll-mt-4">
    <div v-if="$slots.actions" class="flex justify-end"><slot name="actions" /></div>
    <div
      class="text-xs font-mono whitespace-pre-wrap break-words max-h-96 overflow-y-auto rounded bg-red-50 dark:bg-red-950/20 p-3"
      v-html="rendered"
    />
    <p v-if="signature" class="font-mono text-xs break-all text-muted">{{ signature }}</p>
  </div>
</template>
