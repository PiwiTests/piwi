<script setup lang="ts">
/**
 * What the assistant's panel shows, docked or over the page: why the
 * assistant cannot answer (and where AI is set up, to those who can change
 * it), the user's conversations, or the open one with the answer being
 * written, kept in view as it grows. Its empty state, and the one saying the
 * assistant cannot answer, list the authored guides, which need no model;
 * starting one closes a panel that covers the page. The last answer, when it
 * failed, offers to ask its question again.
 */
import { assistantDraftMessage } from '~/utils/assistant/events';

const {
  open,
  view,
  status,
  statusError,
  available,
  conversation,
  conversationError,
  messages,
  exchange,
  knownEntities,
  answerableId,
  suggestions,
  loadStatus,
  ask,
} = useAssistant();
const { can } = useAuth();
const { docked } = useAssistantDock();

const scroller = useTemplateRef<HTMLElement>('scroller');

/** The answer being written, as a message. */
const answer = computed(() =>
  exchange.value ? assistantDraftMessage(exchange.value.draft, exchange.value.question.createdAt) : null,
);
const streaming = computed(() => exchange.value?.draft.state === 'streaming');
const empty = computed(() => messages.value.length === 0 && !exchange.value);

/** From this width up the panel sits beside the page or over part of it; below it, it covers the page. */
const WIDE_QUERY = '(min-width: 640px)';

/** A link followed from a full-screen sheet closes it, so the page it opens shows. */
function onClick(event: MouseEvent): void {
  const link = (event.target as Element | null)?.closest?.('a[href]');
  if (!link || link.getAttribute('target') === '_blank' || window.matchMedia(WIDE_QUERY).matches) return;
  open.value = false;
}

/** Starting an authored guide, or leaving for Settings, closes a panel that covers the page. */
function closeIfOverPage(): void {
  if (!docked.value) open.value = false;
}

/** Keeps the end of the conversation in view while the answer grows, unless the reader scrolled up. */
function followEnd(): void {
  const el = scroller.value;
  if (!el) return;
  const nearEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  if (nearEnd) nextTick(() => el.scrollTo({ top: el.scrollHeight }));
}

watch(() => [answer.value?.blocks, answer.value?.toolCalls.length, messages.value.length], followEnd, {
  deep: true,
  flush: 'pre',
});

watch(
  () => [exchange.value?.question, conversation.value?.id],
  () => nextTick(() => scroller.value?.scrollTo({ top: scroller.value.scrollHeight })),
);

onMounted(() => scroller.value?.scrollTo({ top: scroller.value.scrollHeight }));
</script>

<template>
  <div ref="scroller" class="overflow-y-auto p-4 sm:p-5" data-assistant-panel @click="onClick">
    <ErrorState v-if="statusError && !status" :text="statusError">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" label="Try again" @click="loadStatus(true)" />
      </template>
    </ErrorState>
    <LoadingState v-else-if="!status" />
    <div v-else-if="!available" class="space-y-4" data-assistant-unavailable>
      <div class="space-y-3 py-6 text-center">
        <template v-if="status.reason === 'declined'">
          <p class="text-sm text-highlighted leading-relaxed">The assistant is turned off on this instance.</p>
        </template>
        <template v-else>
          <p class="text-sm text-highlighted leading-relaxed">
            The assistant answers with an AI model, and none is configured on this instance yet.
          </p>
          <UButton
            v-if="can('settings:manage')"
            to="/settings/ai"
            color="neutral"
            variant="outline"
            label="Set up AI in Settings"
            trailing-icon="i-lucide-arrow-right"
            @click="closeIfOverPage"
          />
          <p v-else class="text-xs text-muted">An administrator sets one up in Settings → AI.</p>
        </template>
      </div>
      <AuthoredGuideList @start="closeIfOverPage" />
    </div>
    <AssistantConversationList v-else-if="view === 'list'" />
    <ErrorState v-else-if="conversationError" :text="conversationError" />
    <div v-else-if="empty" class="space-y-4" data-assistant-empty>
      <p class="text-sm text-highlighted leading-relaxed">
        Ask about your runs, failures and setup. The assistant reads them with your access, through the same read tools
        coding agents use, and changes nothing unless you apply a change it proposes.
      </p>
      <div class="space-y-1.5">
        <p class="text-sm font-semibold text-highlighted">Ask about this page</p>
        <div class="flex flex-col items-start gap-1.5">
          <UButton
            v-for="suggestion in suggestions"
            :key="suggestion"
            size="sm"
            color="neutral"
            variant="outline"
            :label="suggestion"
            class="text-left"
            @click="ask(suggestion)"
          />
        </div>
      </div>
      <AuthoredGuideList @start="closeIfOverPage" />
    </div>
    <div v-else class="space-y-5">
      <AssistantMessage
        v-for="(message, index) in messages"
        :key="`${message.role}-${message.id}-${message.createdAt}`"
        :message="message"
        :answerable="message.id === answerableId"
        :retryable="!exchange && index === messages.length - 1"
        :known="knownEntities"
      />
      <template v-if="exchange && answer">
        <AssistantMessage :message="exchange.question" :known="knownEntities" />
        <AssistantMessage
          :message="answer"
          :streaming="streaming"
          :retryable="exchange.draft.state === 'failed'"
          :known="knownEntities"
        />
      </template>
    </div>
  </div>
</template>
