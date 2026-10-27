<script setup lang="ts">
/**
 * Two to four ways to solve the problem, each with its title, one line, its
 * trade-off and its effort, one marked recommended. **Choose** sends the pick
 * back as the next question; an option carrying a guide plays it with
 * **Show me** instead. Once picked, the block shows the pick and takes no
 * other.
 */
import type { AssistantBlock, AssistantOption } from '#shared/assistant';
import { assistantGuideId } from '~/utils/assistant/guide';
import { optionReply } from '~/utils/assistant/replies';

const props = defineProps<{
  block: Extract<AssistantBlock, { kind: 'options' }>;
  messageId: number;
  /** The block can still be answered: its answer is the conversation's last message. */
  answerable: boolean;
}>();

const { sendReply, showGuide } = useAssistant();

const EFFORT_LABELS: Record<NonNullable<AssistantOption['effort']>, string> = {
  small: 'Small effort',
  medium: 'Medium effort',
  large: 'Large effort',
};

const open = computed(() => props.answerable && !props.block.picked);

function facts(option: AssistantOption): string {
  return [option.tradeoff, option.effort ? EFFORT_LABELS[option.effort] : null].filter(Boolean).join(' · ');
}

function choose(option: AssistantOption): void {
  void sendReply(optionReply(props.messageId, props.block, option.id));
}

function play(option: AssistantOption): void {
  if (option.guide) showGuide(option.guide, assistantGuideId(props.messageId, props.block.id, option.id));
}
</script>

<template>
  <div class="space-y-2 min-w-0" data-assistant-block="options">
    <p class="text-sm text-highlighted leading-relaxed">{{ block.prompt }}</p>
    <ul class="space-y-2">
      <li
        v-for="option in block.options"
        :key="option.id"
        class="rounded-lg border px-3 py-2.5"
        :class="[
          block.picked === option.id ? 'border-(--ui-border-inverted)' : 'border-default',
          block.picked && block.picked !== option.id ? 'opacity-60' : '',
        ]"
      >
        <div class="flex items-start justify-between gap-2">
          <p class="text-sm font-semibold text-highlighted">{{ option.title }}</p>
          <UBadge v-if="option.recommended" color="neutral" variant="subtle" size="sm" class="shrink-0">
            Recommended
          </UBadge>
        </div>
        <p class="text-sm text-highlighted leading-relaxed">{{ option.summary }}</p>
        <p v-if="facts(option)" class="text-xs text-muted mt-0.5">{{ facts(option) }}</p>
        <div v-if="open || option.guide" class="mt-2 flex flex-wrap gap-2">
          <UButton
            v-if="option.guide"
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-compass"
            label="Show me"
            :title="option.guide.title"
            @click="play(option)"
          />
          <UButton
            v-else-if="open"
            size="sm"
            color="neutral"
            variant="outline"
            label="Choose"
            :aria-label="`Choose ${option.title}`"
            @click="choose(option)"
          />
        </div>
        <p v-if="block.picked === option.id" class="mt-1 flex items-center gap-1 text-xs text-muted">
          <UIcon name="i-lucide-check" class="size-3.5" aria-hidden="true" />
          Your choice
        </p>
      </li>
    </ul>
  </div>
</template>
