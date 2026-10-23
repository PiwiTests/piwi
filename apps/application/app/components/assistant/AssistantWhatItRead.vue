<script setup lang="ts">
/**
 * Under an answer: **What it read**, folded, the tools it called with their
 * one-line summaries and the refusals they answered with, and the model that
 * wrote it.
 */
import type { AssistantToolCall } from '#shared/assistant';

const props = defineProps<{ toolCalls: readonly AssistantToolCall[]; model: string | null }>();

const unfolded = ref(false);
const count = computed(() => (props.toolCalls.length === 1 ? '1 tool' : `${props.toolCalls.length} tools`));
const listId = useId();
</script>

<template>
  <div class="space-y-1.5" data-assistant-read>
    <div class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
      <button
        v-if="toolCalls.length"
        type="button"
        class="inline-flex items-center gap-0.5 rounded hover:text-highlighted focus-visible:outline-2 focus-visible:outline-primary"
        :aria-expanded="unfolded"
        :aria-controls="listId"
        @click="unfolded = !unfolded"
      >
        <UIcon
          name="i-lucide-chevron-right"
          class="size-3.5 transition-transform"
          :class="unfolded && 'rotate-90'"
          aria-hidden="true"
        />
        What it read · {{ count }}
      </button>
      <span v-else>It read no data for this answer</span>
      <template v-if="model">
        <span aria-hidden="true">·</span>
        <span>{{ model }}</span>
      </template>
    </div>
    <ul v-if="unfolded" :id="listId" class="space-y-1 pl-4">
      <li v-for="(call, index) in toolCalls" :key="index" class="text-xs text-muted">
        {{ call.summary }}
        <span class="font-mono">· {{ call.name }}</span>
        <span v-if="call.error" class="block text-error">{{ call.error }}</span>
      </li>
    </ul>
  </div>
</template>
