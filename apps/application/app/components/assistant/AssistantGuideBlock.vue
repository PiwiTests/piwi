<script setup lang="ts">
/** A guide the assistant composed from the dashboard's anchors, played on the real screens with **Show me**. */
import type { AssistantGuidePlan } from '#shared/assistant';
import { assistantGuideId } from '~/utils/assistant/guide';

const props = defineProps<{ guide: AssistantGuidePlan; blockId: string; messageId: number }>();

const { showGuide } = useAssistant();

const stops = computed(() => (props.guide.stops.length === 1 ? '1 stop' : `${props.guide.stops.length} stops`));
</script>

<template>
  <div
    class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-default px-3 py-2 min-w-0"
    data-assistant-block="guide"
  >
    <div class="min-w-0">
      <p class="text-sm font-semibold text-highlighted">{{ guide.title }}</p>
      <p class="text-xs text-muted">A guide on your screens · {{ stops }}</p>
    </div>
    <UButton
      size="sm"
      color="neutral"
      variant="outline"
      icon="i-lucide-compass"
      label="Show me"
      @click="showGuide(guide, assistantGuideId(messageId, blockId))"
    />
  </div>
</template>
