<script setup lang="ts">
/**
 * A run, execution, cluster, test or project an answer names, as a compact
 * card drawn from the tool result: a dot in its outcome's color (the Test
 * outcome colors), its name linking to its page, and what it is.
 */
import { assistantEntityKey, assistantEntityRoute, type AssistantEntityRef } from '#shared/assistant';
import { ASSISTANT_ENTITY_LABELS, assistantOutcome } from '~/utils/assistant/display';
import { STATUS_PALETTE } from '~/utils/status-palette';

const props = defineProps<{
  entity: AssistantEntityRef;
  status?: string;
  detail?: string;
  /** `assistantEntityKey` of each entity this conversation's tool results named; only those link. */
  known: ReadonlySet<string>;
}>();

const outcome = computed(() => assistantOutcome(props.status));
const linked = computed(() => props.known.has(assistantEntityKey(props.entity)));
const statusLabel = computed(() => {
  if (!props.status) return null;
  if (outcome.value) return statusChipLabel(props.status);
  return props.status.charAt(0).toUpperCase() + props.status.slice(1);
});
const facts = computed(() =>
  [ASSISTANT_ENTITY_LABELS[props.entity.type], statusLabel.value, props.detail].filter(Boolean).join(' · '),
);
</script>

<template>
  <div class="flex items-start gap-2.5 rounded-lg border border-default px-3 py-2 min-w-0" data-assistant-entity>
    <span
      class="mt-1.5 size-2 rounded-full shrink-0"
      :class="outcome ? STATUS_PALETTE[outcome].bg : 'bg-(--ui-border-accented)'"
      aria-hidden="true"
    />
    <div class="min-w-0">
      <NuxtLink
        v-if="linked"
        :to="assistantEntityRoute(entity)"
        class="text-sm font-semibold text-highlighted break-words underline decoration-dotted underline-offset-2 hover:decoration-solid"
      >
        {{ entity.label }}
      </NuxtLink>
      <p v-else class="text-sm font-semibold text-highlighted break-words">{{ entity.label }}</p>
      <p class="text-xs text-muted">{{ facts }}</p>
    </div>
  </div>
</template>
