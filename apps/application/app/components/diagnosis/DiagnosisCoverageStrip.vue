<script setup lang="ts">
/**
 * Compact one-line preview of which evidence sections will be sent to the model,
 * with the token estimate — so the coverage is visible without opening the
 * context modal. Present sections render as clickable chips (focus that section
 * in the modal); truncated ones are flagged. The trailing summary opens the full
 * modal.
 */
import type { ContextSection } from '~/composables/useClusterDiagnosis';
import { DIAGNOSIS_SECTIONS, DIAGNOSIS_SECTION_SHORT } from '#shared/diagnosis-sections';

const props = defineProps<{
  sections: ContextSection[];
  tokenEstimate: number;
  loading?: boolean;
}>();

const emit = defineEmits<{
  'view-section': [id: string];
  open: [];
}>();

const presentChips = computed(() =>
  props.sections.map((s) => ({
    id: s.id,
    short: DIAGNOSIS_SECTION_SHORT[s.id] ?? s.title ?? s.id,
    truncated: s.truncated,
  })),
);

const notIncludedCount = computed(() => Math.max(0, DIAGNOSIS_SECTIONS.length - props.sections.length));

const tokenLabel = computed(() => {
  const n = props.tokenEstimate;
  if (!n) return '';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
});
</script>

<template>
  <div class="rounded-lg border border-default bg-elevated/30 px-2.5 py-2" data-tour="diagnosis-context-strip">
    <div v-if="loading && !sections.length" class="flex items-center gap-2 text-xs text-gray-400">
      <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" />
      Building context…
    </div>
    <div v-else class="flex flex-wrap items-center gap-1.5">
      <span class="text-xs font-medium text-gray-500 inline-flex items-center gap-1">
        <UIcon name="i-lucide-layers" class="size-3.5" />
        Context
        <HelpHint topic="cluster.coverage" />
      </span>
      <button
        v-for="chip in presentChips"
        :key="chip.id"
        type="button"
        class="inline-flex items-center gap-1 rounded-full border border-default bg-default px-2 py-0.5 text-xs hover:border-primary/50 transition-colors"
        :title="chip.truncated ? `${chip.short} (truncated)` : chip.short"
        @click="emit('view-section', chip.id)"
      >
        <UIcon
          :name="chip.truncated ? 'i-lucide-scissors' : 'i-lucide-check'"
          class="size-3"
          :class="chip.truncated ? 'text-warning' : 'text-success'"
        />
        {{ chip.short }}
      </button>
      <span v-if="!presentChips.length" class="text-xs text-gray-400">No evidence sections yet</span>
      <button
        type="button"
        class="ml-auto text-xs text-gray-400 hover:text-primary transition-colors whitespace-nowrap"
        @click="emit('open')"
      >
        <template v-if="notIncludedCount">{{ notIncludedCount }} not included · </template>
        <template v-if="tokenLabel">~{{ tokenLabel }} tokens</template>
        <UIcon name="i-lucide-arrow-right" class="size-3 inline align-text-bottom" />
      </button>
    </div>
  </div>
</template>
