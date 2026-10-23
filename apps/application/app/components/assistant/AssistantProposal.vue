<script setup lang="ts">
/**
 * A change the assistant proposes: the action, its title, what changes and
 * the entity it changes, linked. **Apply** calls the action's own route with
 * the user's session, as the dashboard's button for it does, and **Dismiss**
 * declines it; either is kept with the conversation. Once applied or dismissed
 * the card says so and takes no other click; a failed apply says why and can
 * be applied again.
 */
import { assistantEntityKey, assistantEntityRoute, type AssistantBlock } from '#shared/assistant';
import { ASSISTANT_ACTIONS } from '#shared/assistant-actions';
import { ASSISTANT_ENTITY_LABELS } from '~/utils/assistant/display';

const props = defineProps<{
  block: Extract<AssistantBlock, { kind: 'proposal' }>;
  /** The stored answer's id; 0 while the answer is not stored, when nothing can be applied. */
  messageId: number;
  /** `assistantEntityKey` of each entity this conversation's tool results named; only those link. */
  known: ReadonlySet<string>;
}>();

const { applyProposal, dismissProposal } = useAssistant();

const pending = ref<'apply' | 'dismiss' | null>(null);
const action = computed(() => ASSISTANT_ACTIONS[props.block.action]);
const status = computed(() => props.block.outcome?.status ?? null);
const open = computed(() => status.value === null || status.value === 'failed');
const target = computed(() => props.block.target);
const linked = computed(() => target.value !== null && props.known.has(assistantEntityKey(target.value)));

async function run(kind: 'apply' | 'dismiss'): Promise<void> {
  if (pending.value || !open.value) return;
  pending.value = kind;
  try {
    await (kind === 'apply' ? applyProposal : dismissProposal)(props.messageId, props.block);
  } finally {
    pending.value = null;
  }
}
</script>

<template>
  <div
    class="space-y-2 rounded-lg border border-default px-3 py-2.5 min-w-0"
    :class="status === 'dismissed' && 'opacity-60'"
    data-assistant-block="proposal"
    :data-proposal-status="status ?? 'open'"
  >
    <div class="space-y-1 min-w-0">
      <p class="text-xs text-muted">{{ action.label }}</p>
      <p class="text-sm font-semibold text-highlighted break-words">{{ block.title }}</p>
      <p class="text-sm text-default leading-relaxed">{{ block.change }}</p>
      <p v-if="target" class="text-xs text-muted break-words">
        {{ ASSISTANT_ENTITY_LABELS[target.type] }} ·
        <NuxtLink
          v-if="linked"
          :to="assistantEntityRoute(target)"
          class="text-highlighted underline decoration-dotted underline-offset-2 hover:decoration-solid"
        >
          {{ target.label }}
        </NuxtLink>
        <span v-else class="text-highlighted">{{ target.label }}</span>
      </p>
    </div>
    <p v-if="status === 'failed'" role="alert" class="text-xs text-error leading-relaxed">
      {{ block.outcome?.result || 'The change could not be applied.' }}
    </p>
    <div v-if="open" class="flex flex-wrap justify-end gap-2">
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        label="Dismiss"
        :disabled="messageId <= 0 || pending !== null"
        :loading="pending === 'dismiss'"
        @click="run('dismiss')"
      />
      <UButton
        size="sm"
        color="primary"
        :label="status === 'failed' ? 'Apply again' : 'Apply'"
        :disabled="messageId <= 0 || pending !== null"
        :loading="pending === 'apply'"
        @click="run('apply')"
      />
    </div>
    <p v-else role="status" class="flex items-center gap-1 text-xs text-muted">
      <UIcon :name="status === 'applied' ? 'i-lucide-check' : 'i-lucide-x'" class="size-3.5" aria-hidden="true" />
      {{ status === 'applied' ? 'Applied' : 'Dismissed' }}
    </p>
  </div>
</template>
