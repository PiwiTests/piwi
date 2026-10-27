<script setup lang="ts">
/**
 * Steps to do in order. Each tick is saved with the conversation; a step can
 * carry the command it runs and a **Show me** that plays its guide.
 */
import type { AssistantBlock, AssistantChecklistStep } from '#shared/assistant';
import { assistantGuideId } from '~/utils/assistant/guide';

const props = defineProps<{
  block: Extract<AssistantBlock, { kind: 'checklist' }>;
  /** The stored answer's id; 0 while the answer is not stored, when nothing can be ticked. */
  messageId: number;
}>();

const { tick, showGuide } = useAssistant();

const doneCount = computed(() => props.block.steps.filter((step) => step.done).length);

function play(step: AssistantChecklistStep): void {
  if (step.guide) showGuide(step.guide, assistantGuideId(props.messageId, props.block.id, step.id));
}
</script>

<template>
  <div class="space-y-2 min-w-0" data-assistant-block="checklist">
    <div class="flex items-baseline justify-between gap-2">
      <p class="text-sm font-semibold text-highlighted">{{ block.title }}</p>
      <p class="text-xs text-muted shrink-0">{{ doneCount }} of {{ block.steps.length }} done</p>
    </div>
    <ol class="space-y-2.5">
      <li v-for="step in block.steps" :key="step.id" class="space-y-1.5">
        <UCheckbox
          :model-value="step.done === true"
          :label="step.text"
          :disabled="messageId <= 0"
          @update:model-value="tick(messageId, block.id, step.id, $event === true)"
        />
        <div v-if="step.command" class="pl-6">
          <AssistantCommandCode :command="step.command" />
        </div>
        <div v-if="step.guide" class="pl-6">
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-lucide-compass"
            label="Show me"
            :title="step.guide.title"
            @click="play(step)"
          />
        </div>
      </li>
    </ol>
  </div>
</template>
