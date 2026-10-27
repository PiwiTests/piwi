<script setup lang="ts">
/**
 * A question of an answer, with radio buttons (one choice) or checkboxes
 * (several) and, when the answer offers it, an "Other" field. **Answer** sends
 * the picks back as the next question: in words as its text, by id as its
 * reply. Once answered, or once the conversation has moved on, the choices
 * show read-only.
 */
import type { AssistantBlock } from '#shared/assistant';
import { questionReply } from '~/utils/assistant/replies';

const props = defineProps<{
  block: Extract<AssistantBlock, { kind: 'question' }>;
  messageId: number;
  /** The block can still be answered: its answer is the conversation's last message. */
  answerable: boolean;
}>();

const { sendReply } = useAssistant();

const initial = props.block.answer?.choiceIds ?? props.block.choices.filter((c) => c.checked).map((c) => c.id);
const picks = ref<string[]>(props.block.multiple ? initial : initial.slice(0, 1));
const other = ref(props.block.answer?.other ?? '');

watch(
  () => props.block.answer,
  (answer) => {
    if (!answer) return;
    picks.value = [...answer.choiceIds];
    other.value = answer.other ?? '';
  },
);

const open = computed(() => props.answerable && !props.block.answer);
const reply = computed(() => questionReply(props.messageId, props.block, picks.value, other.value));

const radioItems = computed(() =>
  props.block.choices.map((choice) => ({
    label: choice.label,
    description: choice.detail,
    value: choice.id,
  })),
);

const single = computed({
  get: () => picks.value[0],
  set: (value: string | undefined) => {
    picks.value = value ? [value] : [];
  },
});

function toggle(id: string, on: boolean | 'indeterminate'): void {
  picks.value = on === true ? [...picks.value.filter((p) => p !== id), id] : picks.value.filter((p) => p !== id);
}

function submit(): void {
  if (open.value) void sendReply(reply.value);
}
</script>

<template>
  <form class="space-y-2.5 min-w-0" data-assistant-block="question" @submit.prevent="submit">
    <p class="text-sm text-highlighted leading-relaxed">{{ block.prompt }}</p>
    <URadioGroup
      v-if="!block.multiple"
      v-model="single"
      :items="radioItems"
      :disabled="!open"
      :aria-label="block.prompt"
    />
    <div v-else class="space-y-2" role="group" :aria-label="block.prompt">
      <UCheckbox
        v-for="choice in radioItems"
        :key="choice.value"
        :model-value="picks.includes(choice.value)"
        :label="choice.label"
        :description="choice.description"
        :disabled="!open"
        @update:model-value="toggle(choice.value, $event)"
      />
    </div>
    <UInput
      v-if="block.other && (open || other)"
      v-model="other"
      placeholder="Other"
      aria-label="Other"
      :disabled="!open"
      class="w-full"
    />
    <div v-if="open" class="flex justify-end">
      <UButton type="submit" size="sm" color="neutral" variant="outline" label="Answer" :disabled="!reply" />
    </div>
    <p v-else-if="block.answer" class="flex items-center gap-1 text-xs text-muted">
      <UIcon name="i-lucide-check" class="size-3.5" aria-hidden="true" />
      Answered
    </p>
  </form>
</template>
