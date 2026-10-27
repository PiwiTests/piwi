<script setup lang="ts">
/**
 * Where a question is typed: Enter asks it, Shift+Enter starts a new line.
 * Up on the first line brings back the user's earlier questions, Down on the
 * last line moves back toward what was being typed. While the field is
 * empty its placeholder offers the next question (the last answer's
 * suggestion, else one of the page's), which the Right arrow takes. While an
 * answer is written, **Stop** (or Escape) ends it. What is typed stays when
 * the panel closes. A line warns when a limit is nearly spent, and a spent
 * allowance stops the input from asking; the line under it names the model
 * that answers, says that the question and what the assistant reads are sent
 * to it, and holds the usage gauge.
 */
import { ASSISTANT_MAX_QUESTION_CHARS } from '#shared/assistant';
import {
  caretOnFirstLine,
  caretOnLastLine,
  stepAssistantHistory,
  type AssistantHistoryIndex,
} from '~/utils/assistant/history';
import { assistantTime, assistantUsageView } from '~/utils/assistant/usage';

const { status, busy, ask, stop, draft, questions, loadQuestions, nextQuestion } = useAssistant();
const config = useRuntimeConfig();

const textarea = useTemplateRef<{ textareaRef?: HTMLTextAreaElement }>('textarea');
const hintId = useId();

/** Where Up and Down stand in the history, and what was being typed when they were first pressed. */
const historyIndex = ref<AssistantHistoryIndex>(-1);
const typed = ref('');

const usage = computed(() => assistantUsageView(status.value, (iso) => assistantTime(iso)));
const canAsk = computed(() => !busy.value && !usage.value.blocked && draft.value.trim().length > 0);
const suggestion = computed(() => (draft.value || busy.value ? null : nextQuestion.value));

const placeholder = computed(() => {
  if (busy.value) return 'Type your next question';
  return suggestion.value ?? 'Ask about your runs, failures or setup';
});

const notice = computed(() => {
  if (config.public.demoMode) return 'The demo has no model: it answers prepared questions from its sample data.';
  const model = status.value?.model;
  return model
    ? `${model} writes the answers. Your question and what the assistant reads are sent to it.`
    : 'Your question and what the assistant reads are sent to the AI model configured in Settings → AI.';
});

function submit(): void {
  if (!canAsk.value) return;
  const question = draft.value;
  draft.value = '';
  historyIndex.value = -1;
  void ask(question);
}

/** Shows the history entry `index` (-1: what was being typed), with the caret at its end. */
function showHistory(index: AssistantHistoryIndex): void {
  if (historyIndex.value === -1) typed.value = draft.value;
  historyIndex.value = index;
  draft.value = index === -1 ? typed.value : (questions.value[index] ?? '');
  nextTick(() => {
    const el = textarea.value?.textareaRef;
    el?.setSelectionRange(el.value.length, el.value.length);
  });
}

/** Up and Down through the history, when the caret is on the first or the last line. */
function browseHistory(event: KeyboardEvent, direction: 'older' | 'newer'): void {
  const el = event.target as HTMLTextAreaElement;
  const onEdge =
    direction === 'older'
      ? caretOnFirstLine(el.value, el.selectionStart, el.selectionEnd)
      : caretOnLastLine(el.value, el.selectionStart, el.selectionEnd);
  if (!onEdge) return;
  void loadQuestions();
  const index = stepAssistantHistory(questions.value, historyIndex.value, direction);
  if (index === null) return;
  event.preventDefault();
  showHistory(index);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  } else if (event.key === 'Escape' && busy.value) {
    event.preventDefault();
    event.stopPropagation();
    void stop();
  } else if (event.key === 'ArrowRight' && suggestion.value && !event.shiftKey) {
    event.preventDefault();
    draft.value = suggestion.value;
    historyIndex.value = -1;
  } else if (event.key === 'ArrowUp' && !event.shiftKey) {
    browseHistory(event, 'older');
  } else if (event.key === 'ArrowDown' && !event.shiftKey) {
    browseHistory(event, 'newer');
  }
}

/** Typing leaves the history: the text shown becomes what is being typed. */
function onInput(): void {
  historyIndex.value = -1;
}

/** Puts the caret in the field, at the end of what is typed. */
function focus(): void {
  const el = textarea.value?.textareaRef;
  el?.focus();
  el?.setSelectionRange(el.value.length, el.value.length);
}

/** Whether the caret is in the field. */
function focused(): boolean {
  const el = textarea.value?.textareaRef;
  return Boolean(el) && document.activeElement === el;
}

onMounted(() => void loadQuestions());

defineExpose({ focus, focused });
</script>

<template>
  <form
    class="w-full space-y-1.5"
    data-assistant-input
    data-tour="assistant-input"
    data-shot="assistant-input"
    @submit.prevent="submit"
  >
    <p
      v-if="usage.blocked || usage.warning"
      role="status"
      class="flex items-start gap-1.5 text-xs leading-relaxed"
      :class="usage.blocked ? 'text-error' : 'text-warning'"
      data-assistant-usage-warning
    >
      <UIcon name="i-lucide-gauge" class="size-3.5 mt-0.5 shrink-0" aria-hidden="true" />
      <span>{{ usage.blocked ?? usage.warning }}</span>
    </p>
    <div class="flex items-end gap-2">
      <UTextarea
        ref="textarea"
        v-model="draft"
        :rows="1"
        :maxrows="6"
        autoresize
        :maxlength="ASSISTANT_MAX_QUESTION_CHARS"
        :placeholder="placeholder"
        aria-label="Your question"
        :aria-describedby="suggestion ? hintId : undefined"
        class="flex-1 min-w-0"
        :ui="{ base: suggestion ? 'pe-10' : undefined }"
        data-assistant-question
        @keydown="onKeydown"
        @input="onInput"
      >
        <template v-if="suggestion" #trailing>
          <UKbd value="→" title="Use the suggested question (Right arrow)" data-assistant-suggestion-key />
        </template>
      </UTextarea>
      <span v-if="suggestion" :id="hintId" class="sr-only">Press the Right arrow to use the suggested question.</span>
      <UButton
        v-if="busy"
        icon="i-lucide-square"
        color="neutral"
        variant="outline"
        aria-label="Stop"
        title="Stop (Esc)"
        data-assistant-stop
        @click="stop()"
      />
      <UButton v-else type="submit" icon="i-lucide-arrow-up" aria-label="Ask" title="Ask (Enter)" :disabled="!canAsk" />
    </div>
    <div class="flex items-start gap-2">
      <p class="flex-1 min-w-0 text-xs text-muted">{{ notice }}</p>
      <AssistantUsage v-if="usage.meters.length" :usage="usage" />
    </div>
  </form>
</template>
