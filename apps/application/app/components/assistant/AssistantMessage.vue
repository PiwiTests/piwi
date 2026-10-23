<script setup lang="ts">
/**
 * One message of a conversation: a question as the user wrote it, or an
 * answer's blocks in order, then what it read and its model. While an answer
 * is written, each tool it calls shows as a line; a failed answer keeps what
 * it wrote and says why it stopped.
 */
import { assistantMessageText, type AssistantMessageView } from '#shared/assistant';

const props = defineProps<{
  message: AssistantMessageView;
  /** The answer is still being written. */
  streaming?: boolean;
  /** Its `question` and `options` blocks can still be answered. */
  answerable?: boolean;
  known: ReadonlySet<string>;
}>();

const question = computed(() => (props.message.role === 'user' ? assistantMessageText(props.message.blocks) : ''));
</script>

<template>
  <div v-if="message.role === 'user'" class="flex justify-end" data-assistant-message="user">
    <p
      class="max-w-[85%] rounded-lg bg-elevated px-3 py-2 text-sm text-highlighted leading-relaxed whitespace-pre-wrap break-words"
    >
      {{ question }}
    </p>
  </div>
  <div v-else class="space-y-3 min-w-0" data-assistant-message="assistant" :aria-busy="streaming || undefined">
    <ul v-if="streaming && message.toolCalls.length" class="space-y-1" aria-label="Tools called">
      <li
        v-for="(call, index) in message.toolCalls"
        :key="index"
        class="flex items-center gap-1.5 text-xs text-muted"
        data-assistant-tool
      >
        <UIcon name="i-lucide-check" class="size-3.5 shrink-0" aria-hidden="true" />
        <span class="min-w-0 truncate">{{ call.summary }}</span>
      </li>
    </ul>
    <AssistantBlockView
      v-for="(block, index) in message.blocks"
      :key="'id' in block ? block.id : `text-${index}`"
      :block="block"
      :message-id="message.id"
      :answerable="answerable === true"
      :known="known"
    />
    <p v-if="streaming" role="status" class="flex items-center gap-1.5 text-xs text-muted">
      <UIcon name="i-lucide-loader-2" class="size-3.5 animate-spin" aria-hidden="true" />
      {{ message.blocks.length ? 'Writing…' : 'Reading…' }}
    </p>
    <p v-else-if="message.status === 'failed'" role="alert" class="text-sm text-error leading-relaxed">
      {{ message.error || 'The answer stopped before it was complete.' }}
    </p>
    <AssistantWhatItRead
      v-if="!streaming && (message.toolCalls.length || message.model)"
      :tool-calls="message.toolCalls"
      :model="message.model"
    />
  </div>
</template>
