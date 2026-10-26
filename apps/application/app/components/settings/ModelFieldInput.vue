<script setup lang="ts">
import type { ModelInfo } from '~~/types/api';

const props = defineProps<{
  providerResolved: string;
  models: ModelInfo[];
  loadingModels: boolean;
  placeholderAnthropic: string;
  placeholderOpenai: string;
}>();

const emit = defineEmits<{ loadModels: [] }>();

const model = defineModel<string>({ required: true });

const pickerOpen = ref(false);

const placeholder = computed(() => {
  if (props.providerResolved === 'deepseek-cli') return 'Model ID, or blank for deepseek-flash';
  if (props.providerResolved === 'codex-cli') return 'Model ID, or blank for gpt-5.4';
  if (props.providerResolved === 'anthropic') return props.placeholderAnthropic;
  if (props.providerResolved === 'claude-cli') return 'opus, sonnet… or blank for the CLI default';
  return props.placeholderOpenai;
});
</script>

<template>
  <div class="flex gap-2">
    <UInput v-model="model" :placeholder="placeholder" class="flex-1" />
    <UButton
      v-if="providerResolved && providerResolved !== 'codex-cli' && providerResolved !== 'deepseek-cli'"
      size="sm"
      variant="soft"
      @click="
        emit('loadModels');
        pickerOpen = true;
      "
    >
      Choose model…
    </UButton>
  </div>

  <ModelPickerModal
    v-model:open="pickerOpen"
    :models="models"
    :selected="model"
    :loading="loadingModels"
    @select="(id: string) => (model = id)"
  />
</template>
