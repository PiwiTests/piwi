<script setup lang="ts">
/** One block of an answer, rendered by the component of its kind. */
import type { AssistantBlock } from '#shared/assistant';

defineProps<{
  block: AssistantBlock;
  /** The stored answer's id; 0 while it is not stored. */
  messageId: number;
  /** Its `question` and `options` blocks can still be answered. */
  answerable: boolean;
  known: ReadonlySet<string>;
}>();
</script>

<template>
  <AssistantTextBlock v-if="block.kind === 'text'" :text="block.text" :known="known" />
  <AssistantCodeBlock
    v-else-if="block.kind === 'code'"
    :code="block.code"
    :language="block.language"
    :title="block.title"
  />
  <AssistantCommandBlock v-else-if="block.kind === 'command'" :command="block.command" :title="block.title" />
  <AssistantPatchBlock
    v-else-if="block.kind === 'patch'"
    :patch="block.patch"
    :validation="block.validation"
    :title="block.title"
  />
  <AssistantEntityCard
    v-else-if="block.kind === 'entity'"
    :entity="block.entity"
    :status="block.status"
    :detail="block.detail"
    :known="known"
  />
  <AssistantOptions
    v-else-if="block.kind === 'options'"
    :block="block"
    :message-id="messageId"
    :answerable="answerable"
  />
  <AssistantQuestion
    v-else-if="block.kind === 'question'"
    :block="block"
    :message-id="messageId"
    :answerable="answerable"
  />
  <AssistantChecklist v-else-if="block.kind === 'checklist'" :block="block" :message-id="messageId" />
  <AssistantGuideBlock
    v-else-if="block.kind === 'guide'"
    :guide="block.guide"
    :block-id="block.id"
    :message-id="messageId"
  />
  <AssistantNavigateBlock v-else-if="block.kind === 'navigate'" :route="block.route" :label="block.label" />
</template>
