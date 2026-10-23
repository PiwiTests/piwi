<script setup lang="ts">
/**
 * Where a question is typed: Enter asks it, Shift+Enter starts a new line.
 * The line under it names the model that answers and says that the question
 * and what the assistant reads are sent to it.
 */
import { ASSISTANT_MAX_QUESTION_CHARS } from '#shared/assistant';

const { status, busy, ask } = useAssistant();
const config = useRuntimeConfig();

const text = ref('');
const textarea = useTemplateRef<{ textareaRef?: HTMLTextAreaElement }>('textarea');

const canAsk = computed(() => !busy.value && text.value.trim().length > 0);

const notice = computed(() => {
  if (config.public.demoMode) return 'The demo has no model: it answers prepared questions from its sample data.';
  const model = status.value?.model;
  return model
    ? `${model} writes the answers. Your question and what the assistant reads are sent to it.`
    : 'Your question and what the assistant reads are sent to the AI model configured in Settings → AI.';
});

function submit(): void {
  if (!canAsk.value) return;
  const question = text.value;
  text.value = '';
  void ask(question);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  submit();
}

/** Puts the caret in the field. */
function focus(): void {
  textarea.value?.textareaRef?.focus();
}

defineExpose({ focus });
</script>

<template>
  <form class="w-full space-y-1.5" data-assistant-input data-tour="assistant-input" @submit.prevent="submit">
    <div class="flex items-end gap-2">
      <UTextarea
        ref="textarea"
        v-model="text"
        :rows="1"
        :maxrows="6"
        autoresize
        :maxlength="ASSISTANT_MAX_QUESTION_CHARS"
        placeholder="Ask about your runs, failures or setup"
        aria-label="Your question"
        class="flex-1 min-w-0"
        @keydown="onKeydown"
      />
      <UButton type="submit" icon="i-lucide-arrow-up" aria-label="Ask" title="Ask (Enter)" :disabled="!canAsk" />
    </div>
    <p class="text-xs text-muted">{{ notice }}</p>
  </form>
</template>
