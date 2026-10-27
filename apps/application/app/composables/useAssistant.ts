import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui';
import {
  ASSISTANT_MAX_QUESTION_CHARS,
  assistantMessageText,
  assistantTitleFrom,
  type AssistantBlock,
  type AssistantConversation,
  type AssistantConversationSummary,
  type AssistantEvent,
  type AssistantGuidePlan,
  type AssistantMessageView,
  type AssistantPageContext,
  type AssistantReply,
  type AssistantStatus,
} from '#shared/assistant';
import {
  assistantDraftMessage,
  emptyAssistantDraft,
  endAssistantDraft,
  readAssistantFrames,
  reduceAssistantEvent,
  refusedAssistantDraft,
  type AssistantDraft,
} from '~/utils/assistant/events';
import { assistantActionRequest } from '#shared/assistant-actions';
import { assistantGuideRun } from '~/utils/assistant/guide';
import { assistantPageContext, renderedAnchors } from '~/utils/assistant/page-context';
import { answerableMessageId, assistantKnownEntities, type AssistantReplyQuestion } from '~/utils/assistant/replies';
import { rememberAssistantQuestion } from '~/utils/assistant/history';
import { assistantSuggestionsFor, nextAssistantQuestion } from '~/utils/assistant/suggestions';

/** A question being asked, and the answer it is getting. */
export interface AssistantExchange {
  question: AssistantMessageView;
  draft: AssistantDraft;
}

/** The panel's two views: the open conversation, or the list of the user's conversations. */
export type AssistantView = 'conversation' | 'list';

/** The status request in flight, shared by every caller. */
let statusRequest: Promise<void> | null = null;

/** The question history request in flight, shared by every caller. */
let questionsRequest: Promise<void> | null = null;

/** The last checklist tick being saved, per conversation, message and block: the next one waits for it. */
const savingTicks = new Map<string, Promise<void>>();

/** The message of an API error response, else a sentence naming its status. */
function refusalText(status: number, body: string): string {
  try {
    const message = (JSON.parse(body) as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  } catch {
    // Not JSON: the status says enough.
  }
  return `The question could not be asked (HTTP ${status}).`;
}

/** `messages` with the block `blockId` of message `messageId` replaced by `change(block)`. */
function withBlock(
  messages: readonly AssistantMessageView[],
  messageId: number,
  blockId: string,
  change: (block: AssistantBlock) => AssistantBlock,
): AssistantMessageView[] {
  return messages.map((message) =>
    message.id !== messageId
      ? message
      : {
          ...message,
          blocks: message.blocks.map((block) => ('id' in block && block.id === blockId ? change(block) : block)),
        },
  );
}

/** `block` with the answer `reply` gives it: a question's picks, an options block's pick. */
function answered(block: AssistantBlock, reply: AssistantReply): AssistantBlock {
  if (block.kind === 'question') {
    return { ...block, answer: { choiceIds: reply.choiceIds, ...(reply.other ? { other: reply.other } : {}) } };
  }
  if (block.kind === 'options') return { ...block, picked: reply.choiceIds[0] };
  return block;
}

type ProposalBlock = Extract<AssistantBlock, { kind: 'proposal' }>;

/** What became of a proposal, as the panel records it. */
type ProposalOutcome = { status: 'applied' | 'dismissed' | 'failed'; result?: string };

/** `block` with checklist step `stepId` ticked or not. */
function ticked(block: AssistantBlock, stepId: string, done: boolean): AssistantBlock {
  if (block.kind !== 'checklist') return block;
  return { ...block, steps: block.steps.map((step) => (step.id === stepId ? { ...step, done } : step)) };
}

/**
 * The in-app assistant's panel state, kept across navigation: whether the
 * panel is open, the assistant's status (with what its limits leave), the
 * user's conversations, the open conversation, the answer being written, the
 * question being typed and the user's earlier questions. Asking sends the
 * question with the page it was asked on and reads the answer's Server-Sent
 * Events with `fetch` and a reader (the demo's service worker answers it the
 * same way), applying the events once per frame; **Stop** asks the server to
 * end it, and **Try again** asks a failed answer's question again. Replies to
 * `question` and `options` blocks, checklist ticks, the **Show me** of a
 * composed guide and the **Apply** and **Dismiss** of a proposed change go
 * through here too.
 */
export function useAssistant() {
  const config = useRuntimeConfig();
  const router = useRouter();
  const toast = useToast();
  const guide = useGuide();
  const { docked } = useAssistantDock();

  const open = useState('assistant-open', () => false);
  const view = useState<AssistantView>('assistant-view', () => 'conversation');
  const status = useState<AssistantStatus | null>('assistant-status', () => null);
  const statusError = useState<string | null>('assistant-status-error', () => null);
  const conversations = useState<AssistantConversationSummary[] | null>('assistant-conversations', () => null);
  const conversationsError = useState<string | null>('assistant-conversations-error', () => null);
  const conversation = useState<AssistantConversation | null>('assistant-conversation', () => null);
  const conversationError = useState<string | null>('assistant-conversation-error', () => null);
  const exchange = useState<AssistantExchange | null>('assistant-exchange', () => null);
  /** The question being typed, kept while the panel is closed and across navigation. */
  const draft = useState('assistant-draft', () => '');
  /** The user's earlier questions, newest first: the ones read from the server and those asked since. */
  const questions = useState<string[]>('assistant-questions', () => []);
  const questionsRead = useState('assistant-questions-read', () => false);

  const available = computed(() => status.value?.available === true);
  const busy = computed(() => exchange.value?.draft.state === 'streaming');
  const messages = computed<AssistantMessageView[]>(() => conversation.value?.messages ?? []);
  /** The entities this conversation's tool results named, the only ones its answers link to. */
  const knownEntities = computed(() =>
    assistantKnownEntities(exchange.value ? [...messages.value, exchange.value.draft] : messages.value),
  );
  /** The answer whose questions can still be answered; none while a question is being asked. */
  const answerableId = computed(() => (busy.value ? null : answerableMessageId(messages.value)));

  /** The `app/pages` pattern of the current page, for its suggestions. */
  const currentPage = computed(() => pageContext().page ?? null);
  const suggestions = computed(() => assistantSuggestionsFor(currentPage.value, Boolean(config.public.demoMode)));
  /** The question the empty input offers next; none while an answer is written. */
  const nextQuestion = computed(() =>
    exchange.value ? null : nextAssistantQuestion(messages.value, suggestions.value),
  );

  function apiUrl(path: string): string {
    return `${(config.app.baseURL || '/').replace(/\/$/, '')}${path}`;
  }

  /** The page the question is asked on. */
  function pageContext(): AssistantPageContext {
    const current = router.currentRoute.value;
    return assistantPageContext({
      path: current.path,
      fullPath: current.fullPath,
      recordPath: current.matched.at(-1)?.path,
      params: current.params,
      query: current.query,
    });
  }

  /** Loads the status once, or again with `force`. */
  async function loadStatus(force = false): Promise<void> {
    if (import.meta.server || (status.value && !force)) return;
    statusRequest ??= $fetch<AssistantStatus>('/api/assistant/status')
      .then((result) => {
        status.value = result;
        statusError.value = null;
      })
      .catch((error: unknown) => {
        statusError.value = errorMessage(error, 'The assistant’s status could not be read.');
      })
      .finally(() => {
        statusRequest = null;
      });
    await statusRequest;
  }

  /**
   * Reads the user's earlier questions once, for the input's Up arrow, keeping
   * the ones asked meanwhile first. A failed read is tried again next time.
   */
  async function loadQuestions(): Promise<void> {
    if (import.meta.server || questionsRead.value) return;
    questionsRequest ??= $fetch<{ items: string[] }>('/api/assistant/questions')
      .then((result) => {
        questions.value = rememberAll(result.items, questions.value);
        questionsRead.value = true;
      })
      .catch(() => {
        // The history stays what this tab asked.
      })
      .finally(() => {
        questionsRequest = null;
      });
    await questionsRequest;
  }

  /** `read` with the questions asked since, `asked` (newest first), put first. */
  function rememberAll(read: readonly string[], asked: readonly string[]): string[] {
    return [...asked].reverse().reduce((list, question) => rememberAssistantQuestion(list, question), [...read]);
  }

  async function loadConversations(): Promise<void> {
    try {
      const result = await $fetch<{ items: AssistantConversationSummary[] }>('/api/assistant/conversations');
      conversations.value = result.items;
      conversationsError.value = null;
    } catch (error) {
      conversationsError.value = errorMessage(error, 'Your conversations could not be listed.');
    }
  }

  /** Opens the panel; with `question`, asks it in a conversation of its own when the assistant can answer. */
  async function openPanel(question?: string): Promise<void> {
    open.value = true;
    await loadStatus(!available.value);
    if (!question || busy.value || !available.value) return;
    startNewConversation();
    await ask(question);
  }

  function closePanel(): void {
    open.value = false;
  }

  function showList(): void {
    view.value = 'list';
    void loadConversations();
  }

  /** An empty conversation, started on the server with its first question. */
  function startNewConversation(): void {
    if (busy.value) return;
    conversation.value = null;
    conversationError.value = null;
    exchange.value = null;
    view.value = 'conversation';
  }

  async function openConversation(id: number): Promise<void> {
    if (busy.value) return;
    view.value = 'conversation';
    exchange.value = null;
    conversationError.value = null;
    try {
      conversation.value = await $fetch<AssistantConversation>(`/api/assistant/conversations/${id}`);
    } catch (error) {
      conversation.value = null;
      conversationError.value = errorMessage(error, 'The conversation could not be opened.');
    }
  }

  async function deleteConversation(id: number): Promise<void> {
    try {
      await $fetch(`/api/assistant/conversations/${id}`, { method: 'DELETE' });
      conversations.value = (conversations.value ?? []).filter((c) => c.id !== id);
      if (conversation.value?.id === id) startNewConversation();
    } catch (error) {
      toast.add({ title: 'The conversation could not be deleted', description: errorMessage(error), color: 'error' });
    }
  }

  /** The open conversation, started on the server first when the panel has none. */
  async function ensureConversation(question: string): Promise<AssistantConversation> {
    if (conversation.value) return conversation.value;
    const created = await $fetch<AssistantConversationSummary>('/api/assistant/conversations', {
      method: 'POST',
      body: {},
    });
    const summary = { ...created, title: created.title || assistantTitleFrom(question) };
    const started: AssistantConversation = { ...summary, messages: [] };
    conversation.value = started;
    if (conversations.value) conversations.value = [summary, ...conversations.value];
    return started;
  }

  /** Records the answer the exchange got in the open conversation, as the server stored it. */
  function settle(conversationId: number): void {
    const current = exchange.value;
    const target = conversation.value;
    if (!current || target?.id !== conversationId) return;
    const now = new Date().toISOString();
    const draft = endAssistantDraft(current.draft);
    conversation.value = {
      ...target,
      updatedAt: now,
      messages: [...target.messages, current.question, assistantDraftMessage(draft, now)],
    };
    exchange.value = null;
    if (conversations.value) {
      const summary = { id: target.id, title: target.title, createdAt: target.createdAt, updatedAt: now };
      conversations.value = [summary, ...conversations.value.filter((c) => c.id !== conversationId)];
    }
    // What the answer spent changes what the limits leave.
    void loadStatus(true);
  }

  /** Fails the exchange before its stream started: the question was refused or did not reach the server. */
  function refuse(error: string): void {
    const current = exchange.value;
    if (current) exchange.value = { ...current, draft: refusedAssistantDraft(current.draft, error) };
  }

  /** Posts the question and folds its event stream into the exchange, once per frame. */
  async function stream(conversationId: number, body: Record<string, unknown>, undo: () => void): Promise<void> {
    let response: Response;
    try {
      response = await fetch(apiUrl(`/api/assistant/conversations/${conversationId}/messages`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      undo();
      refuse(errorMessage(error, 'The question could not be sent.'));
      return;
    }
    if (!response.ok || !response.body) {
      undo();
      refuse(refusalText(response.status, await response.text().catch(() => '')));
      if (response.status === 403 || response.status === 503) void loadStatus(true);
      return;
    }

    let queued: AssistantEvent[] = [];
    let frame = 0;
    const flush = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      const current = exchange.value;
      if (current && queued.length) {
        exchange.value = { ...current, draft: queued.reduce((d, e) => reduceAssistantEvent(d, e), current.draft) };
      }
      queued = [];
    };
    const queue = (events: AssistantEvent[]) => {
      if (!events.length) return;
      queued.push(...events);
      frame ||= requestAnimationFrame(flush);
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const read = readAssistantFrames(buffer + decoder.decode(value, { stream: true }));
        buffer = read.rest;
        queue(read.events);
      }
      queue(readAssistantFrames(`${buffer}${decoder.decode()}\n\n`).events);
    } catch {
      // The connection dropped: the answer ends as it stands.
    }
    flush();
    settle(conversationId);
  }

  /**
   * Asks `text` in the open conversation (starting one when there is none),
   * with the page it is asked on, or `asked` when it is asked again; `reply`
   * makes it the answer to a block, shown answered at once. A question the
   * user typed or picked joins their history; a reply does not.
   */
  async function ask(text: string, reply?: AssistantReply, asked?: AssistantPageContext | null): Promise<void> {
    const question = text.trim().slice(0, ASSISTANT_MAX_QUESTION_CHARS);
    if (!question || busy.value) return;
    const anchors = asked ? [] : renderedAnchors(document);
    const context: AssistantPageContext = asked ?? { ...pageContext(), ...(anchors.length ? { anchors } : {}) };
    if (!reply) questions.value = rememberAssistantQuestion(questions.value, question);
    view.value = 'conversation';
    exchange.value = {
      question: {
        id: 0,
        role: 'user',
        blocks: [{ kind: 'text', text: question }],
        context,
        toolCalls: [],
        provider: null,
        model: null,
        inputTokens: null,
        outputTokens: null,
        status: 'completed',
        error: null,
        createdAt: new Date().toISOString(),
      },
      draft: emptyAssistantDraft(),
    };

    let undo = () => {};
    if (reply && conversation.value) {
      const before = conversation.value.messages;
      conversation.value = {
        ...conversation.value,
        messages: withBlock(before, reply.messageId, reply.blockId, (block) => answered(block, reply)),
      };
      undo = () => {
        if (conversation.value) conversation.value = { ...conversation.value, messages: before };
      };
    }

    let target: AssistantConversation;
    try {
      target = await ensureConversation(question);
    } catch (error) {
      undo();
      refuse(errorMessage(error, 'The conversation could not be started.'));
      return;
    }
    await stream(target.id, { text: question, context, ...(reply ? { reply } : {}) }, undo);
  }

  /** Sends a reply built by `questionReply` or `optionReply`. */
  async function sendReply(reply: AssistantReplyQuestion | null): Promise<void> {
    if (reply) await ask(reply.text, reply.reply);
  }

  /**
   * **Stop**: asks the server to end the answer being written; its stream
   * then ends with what it wrote, stored as a stopped answer.
   */
  async function stop(): Promise<void> {
    const target = conversation.value;
    if (!busy.value || !target) return;
    try {
      await $fetch(`/api/assistant/conversations/${target.id}/stop`, { method: 'POST' });
    } catch (error) {
      toast.add({ title: 'The answer could not be stopped', description: errorMessage(error), color: 'error' });
    }
  }

  /**
   * **Try again**: asks the question of the last answer again, when that
   * answer failed or never started, on the page it was first asked on.
   */
  async function retry(): Promise<void> {
    if (busy.value) return;
    const failed = exchange.value?.draft.state === 'failed' ? exchange.value.question : null;
    const last = messages.value.at(-1);
    const question =
      failed ?? (last?.role === 'assistant' && last.status === 'failed' ? messages.value.at(-2) : undefined);
    if (question?.role !== 'user') return;
    await ask(assistantMessageText(question.blocks), undefined, question.context);
  }

  /** Changes block `blockId` of message `messageId` in the open conversation, when it is still `conversationId`. */
  function changeBlock(
    conversationId: number,
    messageId: number,
    blockId: string,
    change: (block: AssistantBlock) => AssistantBlock,
  ): void {
    if (conversation.value?.id !== conversationId) return;
    conversation.value = {
      ...conversation.value,
      messages: withBlock(conversation.value.messages, messageId, blockId, change),
    };
  }

  /**
   * Ticks or unticks a checklist step at once, and saves it with the
   * conversation once the block's earlier ticks are saved; the block the
   * server returns replaces it only when no later tick is waiting. A refused
   * tick is undone.
   */
  async function tick(messageId: number, blockId: string, stepId: string, done: boolean): Promise<void> {
    const target = conversation.value;
    if (!target || messageId <= 0) return;
    const update = (change: (block: AssistantBlock) => AssistantBlock) =>
      changeBlock(target.id, messageId, blockId, change);
    update((block) => ticked(block, stepId, done));
    const key = `${target.id}/${messageId}/${blockId}`;
    const saving: Promise<void> = (savingTicks.get(key) ?? Promise.resolve()).then(async () => {
      try {
        const saved = await $fetch<{ block: Extract<AssistantBlock, { kind: 'checklist' }> }>(
          `/api/assistant/conversations/${target.id}/messages/${messageId}/checklist`,
          { method: 'PATCH', body: { blockId, stepId, done } },
        );
        if (saved?.block && savingTicks.get(key) === saving) update(() => saved.block);
      } catch (error) {
        update((block) => ticked(block, stepId, !done));
        toast.add({ title: 'The step could not be saved', description: errorMessage(error), color: 'error' });
      }
    });
    savingTicks.set(key, saving);
    await saving;
    if (savingTicks.get(key) === saving) savingTicks.delete(key);
  }

  /**
   * Shows `outcome` on a proposal at once and saves it with the conversation.
   * A dismissal the server refused is undone; a change already applied stays
   * shown as applied, and the toast says the conversation could not keep it.
   */
  async function recordProposal(messageId: number, block: ProposalBlock, outcome: ProposalOutcome): Promise<void> {
    const target = conversation.value;
    if (!target || messageId <= 0) return;
    const update = (change: (block: AssistantBlock) => AssistantBlock) =>
      changeBlock(target.id, messageId, block.id, change);
    update((b) => (b.kind === 'proposal' ? { ...b, outcome: { ...outcome, at: new Date().toISOString() } } : b));
    try {
      const saved = await $fetch<{ block: ProposalBlock }>(
        `/api/assistant/conversations/${target.id}/messages/${messageId}/proposal`,
        { method: 'PATCH', body: { blockId: block.id, ...outcome } },
      );
      if (saved?.block) update(() => saved.block);
    } catch (error) {
      if (outcome.status === 'dismissed') update(() => block);
      toast.add({
        title: outcome.status === 'dismissed' ? 'The proposal could not be dismissed' : 'The outcome was not saved',
        description: errorMessage(error),
        color: 'error',
      });
    }
  }

  /**
   * **Apply**: calls the proposed change's own route with the user's session,
   * as the dashboard's button for it does, records the outcome (applied, or
   * failed with what the route answered) and, once applied, refreshes the
   * page's data so it shows the change.
   */
  async function applyProposal(messageId: number, block: ProposalBlock): Promise<void> {
    if (messageId <= 0) return;
    const request = assistantActionRequest(block);
    let outcome: ProposalOutcome;
    try {
      await $fetch(request.path, { method: request.method, ...(request.body ? { body: request.body } : {}) });
      outcome = { status: 'applied' };
    } catch (error) {
      outcome = { status: 'failed', result: errorMessage(error, 'The change could not be applied.').slice(0, 300) };
    }
    await recordProposal(messageId, block, outcome);
    if (outcome.status === 'applied') await refreshNuxtData();
  }

  /** **Dismiss**: records that the user declined the proposed change; nothing is called. */
  async function dismissProposal(messageId: number, block: ProposalBlock): Promise<void> {
    await recordProposal(messageId, block, { status: 'dismissed' });
  }

  /** **Show me**: closes the panel when it covers the page, and plays the composed guide `plan`. */
  function showGuide(plan: AssistantGuidePlan, id: string): void {
    if (!docked.value) open.value = false;
    void guide.start(assistantGuideRun(plan, id));
  }

  /**
   * The command palette's assistant items: **Ask Piwi**, which opens the panel
   * with `term` (the palette's search text) as the question, and the current
   * page's suggestions. None once the assistant is declined.
   */
  function paletteGroups(term: string): CommandPaletteGroup[] {
    if (status.value?.reason === 'declined') return [];
    const question = term.trim();
    const askItem: CommandPaletteItem = {
      id: 'assistant-ask',
      label: 'Ask Piwi',
      description: question || undefined,
      icon: 'i-lucide-sparkles',
      onSelect: () => void openPanel(question || undefined),
    };
    return [
      { id: 'assistant', label: 'Assistant', ignoreFilter: true, items: [askItem] },
      {
        id: 'assistant-page',
        label: 'Ask about this page',
        items: suggestions.value.map((suggestion, index) => ({
          id: `assistant-suggestion-${index}`,
          label: suggestion,
          icon: 'i-lucide-message-circle-question',
          onSelect: () => void openPanel(suggestion),
        })),
      },
    ];
  }

  return {
    open,
    view,
    status: computed(() => status.value),
    statusError: readonly(statusError),
    available,
    busy,
    conversations: computed(() => conversations.value),
    conversationsError: readonly(conversationsError),
    conversation: computed(() => conversation.value),
    conversationError: readonly(conversationError),
    messages,
    exchange: computed(() => exchange.value),
    knownEntities,
    answerableId,
    suggestions,
    nextQuestion,
    draft,
    questions: readonly(questions),
    loadStatus,
    loadQuestions,
    loadConversations,
    openPanel,
    closePanel,
    showList,
    startNewConversation,
    openConversation,
    deleteConversation,
    ask,
    sendReply,
    stop,
    retry,
    tick,
    applyProposal,
    dismissProposal,
    showGuide,
    paletteGroups,
  };
}
