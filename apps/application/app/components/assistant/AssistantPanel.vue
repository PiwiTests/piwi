<script setup lang="ts">
/**
 * The assistant's panel: a side panel from `sm` up, beside a page that stays
 * usable, and a full-screen sheet below it. It keeps its conversation across
 * navigation, says when the assistant cannot answer (and where AI is set up,
 * to those who can change it), lists the user's conversations, and shows the
 * open one with the answer being written and the input under it.
 */
import { assistantDraftMessage } from '~/utils/assistant/events';

const {
  open,
  view,
  status,
  statusError,
  available,
  busy,
  conversation,
  conversationError,
  messages,
  exchange,
  knownEntities,
  answerableId,
  suggestions,
  loadStatus,
  showList,
  startNewConversation,
  ask,
} = useAssistant();
const { can } = useAuth();

const scroller = useTemplateRef<HTMLElement>('scroller');
const input = useTemplateRef<{ focus: () => void }>('input');

/** The answer being written, as a message. */
const answer = computed(() =>
  exchange.value ? assistantDraftMessage(exchange.value.draft, exchange.value.question.createdAt) : null,
);
const streaming = computed(() => exchange.value?.draft.state === 'streaming');
const empty = computed(() => messages.value.length === 0 && !exchange.value);

/**
 * The panel's content props: a click or focus on the page beside it leaves it
 * open, and `data-shot` names it for the screenshot harness.
 */
const contentProps = {
  onInteractOutside: (event: Event) => event.preventDefault(),
  'data-shot': 'assistant-panel',
};

/** From this width up the panel sits beside the page; below it, it covers the page. */
const WIDE_QUERY = '(min-width: 640px)';

/** A link followed from a full-screen sheet closes it, so the page it opens shows. */
function onClick(event: MouseEvent): void {
  const link = (event.target as Element | null)?.closest?.('a[href]');
  if (!link || link.getAttribute('target') === '_blank' || window.matchMedia(WIDE_QUERY).matches) return;
  open.value = false;
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

watch(open, (isOpen) => {
  if (!isOpen) return;
  void loadStatus(!available.value);
  nextTick(() => input.value?.focus());
});
</script>

<template>
  <USlideover
    v-model:open="open"
    :modal="false"
    :overlay="false"
    title="Ask Piwi"
    description="Answers about your runs, failures and setup, from the data you can read."
    :content="contentProps"
    :ui="{
      content: 'max-w-none sm:max-w-lg',
      description: 'sr-only',
      body: 'p-0 sm:p-0 flex flex-col min-h-0 overflow-hidden',
      footer: 'flex-col items-stretch',
    }"
  >
    <template #actions>
      <div v-if="available" class="ml-auto mr-8 flex items-center gap-1">
        <UButton
          icon="i-lucide-history"
          color="neutral"
          variant="ghost"
          :aria-label="view === 'list' ? 'Back to the conversation' : 'Conversations'"
          :title="view === 'list' ? 'Back to the conversation' : 'Conversations'"
          :aria-pressed="view === 'list'"
          @click="view === 'list' ? (view = 'conversation') : showList()"
        />
        <UButton
          icon="i-lucide-square-pen"
          color="neutral"
          variant="ghost"
          aria-label="New conversation"
          title="New conversation"
          :disabled="busy"
          @click="startNewConversation()"
        />
      </div>
    </template>

    <template #body>
      <div ref="scroller" class="flex-1 overflow-y-auto p-4 sm:p-5" data-assistant-panel @click="onClick">
        <ErrorState v-if="statusError && !status" :text="statusError">
          <template #action>
            <UButton size="sm" color="neutral" variant="outline" label="Try again" @click="loadStatus(true)" />
          </template>
        </ErrorState>
        <LoadingState v-else-if="!status" />
        <div v-else-if="!available" class="space-y-3 py-6 text-center" data-assistant-unavailable>
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
              @click="open = false"
            />
            <p v-else class="text-xs text-muted">An administrator sets one up in Settings → AI.</p>
          </template>
        </div>
        <AssistantConversationList v-else-if="view === 'list'" />
        <ErrorState v-else-if="conversationError" :text="conversationError" />
        <div v-else-if="empty" class="space-y-4" data-assistant-empty>
          <p class="text-sm text-highlighted leading-relaxed">
            Ask about your runs, failures and setup. The assistant reads them with your access, through the same read
            tools coding agents use, and never changes anything.
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
        </div>
        <div v-else class="space-y-5">
          <AssistantMessage
            v-for="message in messages"
            :key="`${message.role}-${message.id}-${message.createdAt}`"
            :message="message"
            :answerable="message.id === answerableId"
            :known="knownEntities"
          />
          <template v-if="exchange && answer">
            <AssistantMessage :message="exchange.question" :known="knownEntities" />
            <AssistantMessage :message="answer" :streaming="streaming" :known="knownEntities" />
          </template>
        </div>
      </div>
    </template>

    <template v-if="available && view === 'conversation'" #footer>
      <AssistantInput ref="input" />
    </template>
  </USlideover>
</template>
