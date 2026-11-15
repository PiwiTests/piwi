<script setup lang="ts">
import type { ModelInfo } from '~~/types/api';
import { foldText } from '#shared/utils/fold-text';

function fmtTokens(n?: number): string {
  if (!n) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

const props = defineProps<{
  models: ModelInfo[];
  selected: string;
  loading: boolean;
}>();

const emit = defineEmits<{ select: [id: string] }>();

const open = defineModel<boolean>('open', { required: true });

const searchInput = ref<HTMLInputElement | null>(null);
const search = ref('');

watch(open, (val) => {
  if (val) {
    nextTick(() => searchInput.value?.focus());
  }
});
const filtered = computed(() => {
  const q = foldText(search.value.trim());
  return q
    ? props.models.filter((m) => foldText(m.id).includes(q) || foldText(m.label ?? '').includes(q))
    : props.models;
});

const MODALITY_META: Record<string, { icon: string; label: string }> = {
  image: { icon: 'i-lucide-image', label: 'Image input' },
  pdf: { icon: 'i-lucide-file-text', label: 'PDF input' },
  code: { icon: 'i-lucide-code', label: 'Code execution' },
  thinking: { icon: 'i-lucide-brain', label: 'Extended thinking' },
  json: { icon: 'i-lucide-braces', label: 'Structured output' },
  text: { icon: 'i-lucide-type', label: 'Text' },
  audio: { icon: 'i-lucide-music', label: 'Audio' },
};

interface ModalityGroup {
  inputs: string[];
  outputs: string[];
}

function parseModalities(mods: string[]): ModalityGroup[] {
  return mods.map((m) => {
    const arrowIdx = m.indexOf('→');
    if (arrowIdx !== -1) {
      const before = m.slice(0, arrowIdx);
      const after = m.slice(arrowIdx + 1);
      return {
        inputs: before.split('+').filter(Boolean),
        outputs: after.split('+').filter(Boolean),
      };
    }
    return { inputs: [m], outputs: [] };
  });
}

function pick(id: string) {
  emit('select', id);
  open.value = false;
  search.value = '';
}
</script>

<template>
  <UModal v-model:open="open" title="Select a model" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="space-y-3">
        <!-- Its own field: the picker opens from inside the Model field, whose id would otherwise go to this input. -->
        <UFormField label="Search models" :ui="{ label: 'sr-only' }">
          <UInput ref="searchInput" v-model="search" placeholder="Search models…" icon="i-lucide-search" size="sm" />
        </UFormField>
        <div v-if="models.length === 0 && loading" class="flex items-center justify-center gap-2 py-8 text-gray-400">
          <UIcon name="i-lucide-loader-2" class="size-4 animate-spin" />
          <span class="text-sm">Loading models…</span>
        </div>
        <div v-else-if="models.length === 0" class="py-8 text-center text-sm text-gray-400">
          No models available — check your provider configuration
        </div>
        <div v-else class="max-h-96 overflow-y-auto space-y-px">
          <button
            v-for="m in filtered"
            :key="m.id"
            class="w-full text-left px-4 py-3 rounded-lg hover:bg-elevated transition-colors border border-transparent hover:border-default flex items-start gap-4"
            :class="selected === m.id ? 'bg-primary/10 ring-1 ring-inset ring-primary/30 border-primary/30' : ''"
            @click="pick(m.id)"
          >
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium leading-snug truncate">
                {{ m.id }}
                <span v-if="m.label && m.label !== m.id" class="text-gray-500 font-normal"> — {{ m.label }}</span>
              </p>
              <p class="text-xs text-gray-400 leading-snug mt-0.5">
                <template v-if="m.contextLength">{{ fmtTokens(m.contextLength) }} ctx</template>
                <template v-if="m.maxTokens"> · up to {{ fmtTokens(m.maxTokens) }} out</template>
                <template v-if="m.pricing?.prompt">
                  · ${{ m.pricing.prompt }} / ${{ m.pricing.completion ?? '?' }} per 1M</template
                >
                <template v-if="!m.contextLength && !m.maxTokens && !m.pricing?.prompt">
                  <span class="italic text-gray-500">No additional info</span>
                </template>
              </p>
            </div>
            <div v-if="m.modalities?.length" class="flex items-center gap-1 shrink-0 pt-0.5">
              <template
                v-for="group in parseModalities(m.modalities)"
                :key="group.inputs.join() + '→' + group.outputs.join()"
              >
                <span
                  v-for="mod in group.inputs"
                  :key="'in-' + mod"
                  :title="MODALITY_META[mod]?.label ?? mod"
                  class="inline-flex items-center justify-center size-6 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-500 hover:text-primary transition-colors"
                >
                  <UIcon :name="MODALITY_META[mod]?.icon ?? 'i-lucide-cpu'" class="size-3.5" />
                </span>
                <UIcon v-if="group.outputs.length" name="i-lucide-arrow-right" class="size-3 text-gray-400 shrink-0" />
                <span
                  v-for="mod in group.outputs"
                  :key="'out-' + mod"
                  :title="MODALITY_META[mod]?.label ?? mod"
                  class="inline-flex items-center justify-center size-6 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-500 hover:text-primary transition-colors"
                >
                  <UIcon :name="MODALITY_META[mod]?.icon ?? 'i-lucide-cpu'" class="size-3.5" />
                </span>
              </template>
            </div>
          </button>
          <div v-if="filtered.length === 0" class="py-8 text-center text-sm text-gray-400">
            No models match "{{ search }}"
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
