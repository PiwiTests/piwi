/**
 * Assistant conversations and their usage: list, read, start and delete a
 * conversation, store its messages, and count the tokens spent. Shared by the
 * server routes and the demo.
 *
 * A conversation belongs to its owner and every read is narrowed to them, so
 * another user's conversation reads as missing, administrators included. The
 * owner is the signed-in user's id, or null with authentication off, when every
 * visitor is the same virtual administrator.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, min, sum } from 'drizzle-orm';
import { assistantConversations, assistantMessages, assistantUsage } from '../../server/database/schema';
import {
  assistantMessageText,
  assistantTitleFrom,
  type AssistantBlock,
  type AssistantConversation,
  type AssistantConversationSummary,
  type AssistantEntityRef,
  type AssistantMessageView,
  type AssistantPageContext,
  type AssistantReply,
  type AssistantProposalOutcomeInput,
  type AssistantToolCall,
} from '#shared/assistant';
import { createKeyedLock } from '../../server/utils/keyed-lock';
import type { DrizzleDB } from './db';
import { getInstanceDecisions, resolveInstanceStates } from './setup-status';

/** Who a conversation belongs to: a user id, or null with authentication off. */
export type AssistantOwner = number | null;

/** The most conversations one list returns, newest first. */
const LIST_LIMIT = 50;

type ConversationRow = typeof assistantConversations.$inferSelect;
type MessageRow = typeof assistantMessages.$inferSelect;

function ownedBy(ownerId: AssistantOwner) {
  return ownerId === null ? isNull(assistantConversations.ownerId) : eq(assistantConversations.ownerId, ownerId);
}

const iso = (d: Date | string | number) => new Date(d).toISOString();

function toSummary(row: ConversationRow): AssistantConversationSummary {
  return { id: row.id, title: row.title, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}

function toMessageView(row: MessageRow): AssistantMessageView {
  const content = row.content as { blocks?: AssistantBlock[] } | null;
  return {
    id: row.id,
    role: row.role === 'user' ? 'user' : 'assistant',
    blocks: content?.blocks ?? [],
    context: (row.context as AssistantPageContext | null) ?? null,
    toolCalls: (row.toolCalls as AssistantToolCall[] | null) ?? [],
    provider: row.provider ?? null,
    model: row.model ?? null,
    inputTokens: row.inputTokens ?? null,
    outputTokens: row.outputTokens ?? null,
    status: row.status === 'failed' ? 'failed' : 'completed',
    error: row.error ?? null,
    createdAt: iso(row.createdAt),
  };
}

/** The owner's conversations, the most recently active first. */
export async function listAssistantConversations(
  db: DrizzleDB,
  ownerId: AssistantOwner,
): Promise<{ items: AssistantConversationSummary[] }> {
  const rows = await db
    .select()
    .from(assistantConversations)
    .where(ownedBy(ownerId))
    .orderBy(desc(assistantConversations.updatedAt), desc(assistantConversations.id))
    .limit(LIST_LIMIT);
  return { items: rows.map(toSummary) };
}

/** Start a conversation for the owner. */
export async function createAssistantConversation(
  db: DrizzleDB,
  ownerId: AssistantOwner,
  title = '',
): Promise<AssistantConversationSummary> {
  const now = new Date();
  const [row] = await db
    .insert(assistantConversations)
    .values({ ownerId, title: assistantTitleFrom(title), createdAt: now, updatedAt: now })
    .returning();
  return toSummary(row!);
}

/** The owner's conversation row, or null when it is missing or someone else's. */
export async function findAssistantConversation(
  db: DrizzleDB,
  ownerId: AssistantOwner,
  id: number,
): Promise<ConversationRow | null> {
  const [row] = await db
    .select()
    .from(assistantConversations)
    .where(and(eq(assistantConversations.id, id), ownedBy(ownerId)))
    .limit(1);
  return row ?? null;
}

/** The owner's conversation with its messages in order, or null when it is missing or someone else's. */
export async function getAssistantConversation(
  db: DrizzleDB,
  ownerId: AssistantOwner,
  id: number,
): Promise<AssistantConversation | null> {
  const row = await findAssistantConversation(db, ownerId, id);
  if (!row) return null;
  const messages = await db
    .select()
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, id))
    .orderBy(asc(assistantMessages.id));
  return { ...toSummary(row), messages: messages.map(toMessageView) };
}

/** The most questions the history returns. */
const QUESTION_HISTORY_LIMIT = 50;

/** The newest messages the history reads to find them; replies and repeats are left out. */
const QUESTION_HISTORY_SCAN = 400;

/** Whether an answer holds a `question` or `options` block that was answered: the next question is that reply. */
function wasReplied(message: AssistantMessageView): boolean {
  return message.blocks.some(
    (block) => (block.kind === 'question' && block.answer) || (block.kind === 'options' && block.picked),
  );
}

/**
 * The questions the owner typed, newest first, each once, across their
 * conversations: what the panel's Up arrow brings back. A question that
 * replied to a `question` or `options` block is left out, as the answered
 * block it follows shows; the panel sends those from the block.
 */
export async function listAssistantQuestions(db: DrizzleDB, ownerId: AssistantOwner): Promise<{ items: string[] }> {
  const rows = await db
    .select({ message: assistantMessages })
    .from(assistantMessages)
    .innerJoin(assistantConversations, eq(assistantConversations.id, assistantMessages.conversationId))
    .where(ownedBy(ownerId))
    .orderBy(desc(assistantMessages.id))
    .limit(QUESTION_HISTORY_SCAN);
  const messages = rows.map((row) => ({
    conversationId: row.message.conversationId,
    view: toMessageView(row.message),
  }));
  const items: string[] = [];
  const seen = new Set<string>();
  for (const [index, { conversationId, view }] of messages.entries()) {
    if (view.role !== 'user') continue;
    const before = messages.slice(index + 1).find((m) => m.conversationId === conversationId);
    if (before?.view.role === 'assistant' && wasReplied(before.view)) continue;
    const text = assistantMessageText(view.blocks).trim();
    const key = text.replace(/\s+/g, ' ').toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    items.push(text);
    if (items.length === QUESTION_HISTORY_LIMIT) break;
  }
  return { items };
}

/** The messages of a conversation that is the owner's. */
function ownedMessages(ownerId: AssistantOwner, conversationId: number) {
  return and(eq(assistantMessages.conversationId, conversationId), ownedBy(ownerId));
}

/** The newest `limit` messages of the owner's conversation, oldest first; none when it is missing or someone else's. */
export async function listRecentAssistantMessages(
  db: DrizzleDB,
  ownerId: AssistantOwner,
  conversationId: number,
  limit: number,
): Promise<AssistantMessageView[]> {
  const rows = await db
    .select({ message: assistantMessages })
    .from(assistantMessages)
    .innerJoin(assistantConversations, eq(assistantConversations.id, assistantMessages.conversationId))
    .where(ownedMessages(ownerId, conversationId))
    .orderBy(desc(assistantMessages.id))
    .limit(limit);
  return rows.reverse().map((row) => toMessageView(row.message));
}

/** The entities the stored tool calls of the owner's conversation named, oldest first, without reading any blocks. */
export async function listAssistantConversationEntities(
  db: DrizzleDB,
  ownerId: AssistantOwner,
  conversationId: number,
): Promise<AssistantEntityRef[]> {
  const rows = await db
    .select({ toolCalls: assistantMessages.toolCalls })
    .from(assistantMessages)
    .innerJoin(assistantConversations, eq(assistantConversations.id, assistantMessages.conversationId))
    .where(and(ownedMessages(ownerId, conversationId), isNotNull(assistantMessages.toolCalls)))
    .orderBy(asc(assistantMessages.id));
  return rows.flatMap((row) =>
    ((row.toolCalls as AssistantToolCall[] | null) ?? []).flatMap((call) => call.entities ?? []),
  );
}

/** Delete the owner's conversation and its messages; false when it is missing or someone else's. */
export async function deleteAssistantConversation(
  db: DrizzleDB,
  ownerId: AssistantOwner,
  id: number,
): Promise<boolean> {
  const row = await findAssistantConversation(db, ownerId, id);
  if (!row) return false;
  // Messages first: the demo's database does not enforce the foreign key's cascade.
  await db.delete(assistantMessages).where(eq(assistantMessages.conversationId, id));
  await db.delete(assistantConversations).where(eq(assistantConversations.id, id));
  return true;
}

/** Delete every conversation a user owns, with their messages (the user is being deleted). */
export async function deleteAssistantConversationsOf(db: DrizzleDB, ownerId: number): Promise<void> {
  const owned = db
    .select({ id: assistantConversations.id })
    .from(assistantConversations)
    .where(eq(assistantConversations.ownerId, ownerId));
  await db.delete(assistantMessages).where(inArray(assistantMessages.conversationId, owned));
  await db.delete(assistantConversations).where(eq(assistantConversations.ownerId, ownerId));
}

export interface NewAssistantMessage {
  role: 'user' | 'assistant';
  blocks: AssistantBlock[];
  context?: AssistantPageContext | null;
  toolCalls?: AssistantToolCall[];
  provider?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  status?: 'completed' | 'failed';
  error?: string | null;
  durationMs?: number | null;
}

/**
 * Store one message of a conversation and mark the conversation active. A
 * conversation still without a title takes its first question's.
 */
export async function addAssistantMessage(
  db: DrizzleDB,
  conversation: Pick<ConversationRow, 'id' | 'title'>,
  message: NewAssistantMessage,
): Promise<number> {
  const now = new Date();
  const [row] = await db
    .insert(assistantMessages)
    .values({
      conversationId: conversation.id,
      role: message.role,
      content: { blocks: message.blocks },
      context: message.context ?? null,
      toolCalls: message.toolCalls?.length ? message.toolCalls : null,
      provider: message.provider ?? null,
      model: message.model ?? null,
      inputTokens: message.inputTokens ?? null,
      outputTokens: message.outputTokens ?? null,
      status: message.status ?? 'completed',
      error: message.error ?? null,
      durationMs: message.durationMs ?? null,
      createdAt: now,
    })
    .returning({ id: assistantMessages.id });
  const title =
    !conversation.title && message.role === 'user'
      ? assistantTitleFrom(assistantMessageText(message.blocks))
      : undefined;
  await db
    .update(assistantConversations)
    .set({ updatedAt: now, ...(title ? { title } : {}) })
    .where(eq(assistantConversations.id, conversation.id));
  return row!.id;
}

/** One of the owner's answers in one of their conversations, or null when it is missing or someone else's. */
async function findOwnedAnswer(
  db: DrizzleDB,
  ownerId: AssistantOwner,
  conversationId: number,
  messageId: number,
): Promise<{ id: number; blocks: AssistantBlock[] } | null> {
  if (!(await findAssistantConversation(db, ownerId, conversationId))) return null;
  const [row] = await db
    .select()
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.id, messageId),
        eq(assistantMessages.conversationId, conversationId),
        eq(assistantMessages.role, 'assistant'),
      ),
    )
    .limit(1);
  return row ? { id: row.id, blocks: toMessageView(row).blocks } : null;
}

async function saveBlocks(db: DrizzleDB, messageId: number, blocks: AssistantBlock[]): Promise<void> {
  await db.update(assistantMessages).set({ content: { blocks } }).where(eq(assistantMessages.id, messageId));
}

/**
 * The changes to one answer's blocks run one at a time, by its message id:
 * each reads the blocks, changes one and writes them all back.
 */
const answerLock = createKeyedLock<number>();

/** A choice the user picked, as the model reads it: its id, its label, and the entity it stands for. */
interface AssistantReplyPick {
  id: string;
  label: string;
  entity?: AssistantEntityRef;
}

/** A reply as recorded on its block, for the model: the block's prompt, the choices picked, the "Other" text. */
export interface AssistantRecordedReply {
  prompt: string;
  picked: AssistantReplyPick[];
  other?: string;
}

type AssistantReplyOutcome =
  | { ok: true; reply: AssistantRecordedReply }
  | { ok: false; status: 400 | 404; message: string };

/**
 * Record a reply on the `question` or `options` block it answers, in one of
 * the owner's earlier answers of this conversation: the choice ids as the
 * question's `answer`, the option id as the options' `picked`. Another
 * conversation's message, or another user's, is a 404; picks the block does
 * not offer are a 400.
 */
export function recordAssistantReply(
  db: DrizzleDB,
  ownerId: AssistantOwner,
  conversationId: number,
  reply: AssistantReply,
): Promise<AssistantReplyOutcome> {
  return answerLock(reply.messageId, async () => {
    const refuse = (status: 400 | 404, message: string): AssistantReplyOutcome => ({ ok: false, status, message });
    const message = await findOwnedAnswer(db, ownerId, conversationId, reply.messageId);
    if (!message) return refuse(404, 'Message not found');
    const index = message.blocks.findIndex((b) => b.kind !== 'text' && b.id === reply.blockId);
    const block = message.blocks[index];
    if (!block) return refuse(404, 'Block not found');
    const choiceIds = [...new Set(reply.choiceIds)];
    const other = reply.other?.trim() || undefined;

    if (block.kind === 'options') {
      const option = block.options.find((o) => o.id === choiceIds[0]);
      if (choiceIds.length !== 1 || !option) return refuse(400, 'Pick exactly one of the options');
      if (other) return refuse(400, 'An options block has no "Other" field');
      message.blocks[index] = { ...block, picked: option.id };
      await saveBlocks(db, message.id, message.blocks);
      return { ok: true, reply: { prompt: block.prompt, picked: [{ id: option.id, label: option.title }] } };
    }
    if (block.kind !== 'question') return refuse(400, 'Only a question or an options block takes a reply');

    const unknown = choiceIds.find((id) => !block.choices.some((c) => c.id === id));
    if (unknown) return refuse(400, `The question has no choice "${unknown}"`);
    if (!block.multiple && choiceIds.length > 1) return refuse(400, 'The question takes one choice');
    if (other && !block.other) return refuse(400, 'The question has no "Other" field');
    if (choiceIds.length === 0 && !other) return refuse(400, 'Pick a choice, or fill in "Other"');
    message.blocks[index] = { ...block, answer: { choiceIds, ...(other ? { other } : {}) } };
    await saveBlocks(db, message.id, message.blocks);
    const picked = choiceIds.map((id) => {
      const choice = block.choices.find((c) => c.id === id)!;
      return { id, label: choice.label, ...(choice.entity ? { entity: choice.entity } : {}) };
    });
    return { ok: true, reply: { prompt: block.prompt, picked, ...(other ? { other } : {}) } };
  });
}

/**
 * Tick or untick one step of a `checklist` block of one of the owner's
 * answers; the block as it now stands, or null when the message, the block or
 * the step is missing, or the conversation is someone else's.
 */
export function tickAssistantChecklist(
  db: DrizzleDB,
  ownerId: AssistantOwner,
  conversationId: number,
  messageId: number,
  tick: { blockId: string; stepId: string; done: boolean },
): Promise<Extract<AssistantBlock, { kind: 'checklist' }> | null> {
  return answerLock(messageId, async () => {
    const message = await findOwnedAnswer(db, ownerId, conversationId, messageId);
    const index = message?.blocks.findIndex((b) => b.kind === 'checklist' && b.id === tick.blockId) ?? -1;
    const block = message?.blocks[index];
    if (!message || block?.kind !== 'checklist' || !block.steps.some((s) => s.id === tick.stepId)) return null;
    const ticked = {
      ...block,
      steps: block.steps.map((s) => {
        if (s.id !== tick.stepId) return s;
        const { done: _done, ...step } = s;
        return tick.done ? { ...step, done: true } : step;
      }),
    };
    message.blocks[index] = ticked;
    await saveBlocks(db, message.id, message.blocks);
    return ticked;
  });
}

type ProposalBlock = Extract<AssistantBlock, { kind: 'proposal' }>;

type AssistantProposalRecord = { ok: true; block: ProposalBlock } | { ok: false; status: 404 | 409; message: string };

/**
 * Record what became of a `proposal` block of one of the owner's answers:
 * applied, dismissed, or failed with the route's answer. Another user's
 * conversation, and a message or block it does not hold, are a 404; a
 * proposal already applied or dismissed is a 409, while a failed one can be
 * applied again.
 */
export function recordAssistantProposalOutcome(
  db: DrizzleDB,
  ownerId: AssistantOwner,
  conversationId: number,
  messageId: number,
  outcome: AssistantProposalOutcomeInput,
): Promise<AssistantProposalRecord> {
  return answerLock(messageId, async () => {
    const message = await findOwnedAnswer(db, ownerId, conversationId, messageId);
    const index = message?.blocks.findIndex((b) => b.kind === 'proposal' && b.id === outcome.blockId) ?? -1;
    const block = message?.blocks[index];
    if (!message || block?.kind !== 'proposal') return { ok: false, status: 404, message: 'Proposal not found' };
    if (block.outcome && block.outcome.status !== 'failed') {
      return { ok: false, status: 409, message: `This change was already ${block.outcome.status}` };
    }
    const recorded: ProposalBlock = {
      ...block,
      outcome: {
        status: outcome.status,
        ...(outcome.result ? { result: outcome.result } : {}),
        at: new Date().toISOString(),
      },
    };
    message.blocks[index] = recorded;
    await saveBlocks(db, message.id, message.blocks);
    return { ok: true, block: recorded };
  });
}

/** Remember the tools `find_tools` added, offered for the rest of the conversation. */
export async function setAssistantExtraTools(db: DrizzleDB, conversationId: number, names: string[]): Promise<void> {
  await db
    .update(assistantConversations)
    .set({ extraTools: names })
    .where(eq(assistantConversations.id, conversationId));
}

/** Record what one answer spent, for the daily caps and the AI usage summary. */
export async function recordAssistantUsage(
  db: DrizzleDB,
  usage: {
    ownerId: AssistantOwner;
    provider: string | null;
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    status: 'completed' | 'failed';
  },
): Promise<void> {
  await db.insert(assistantUsage).values({
    ownerId: usage.ownerId,
    provider: usage.provider,
    model: usage.model,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    status: usage.status,
    createdAt: new Date(),
  });
}

/**
 * Tokens (input and output) the assistant spent since `since`: one owner's
 * answers when `ownerId` is given (null for the virtual administrator), every
 * answer on the instance when it is left out.
 */
export async function assistantTokensSince(db: DrizzleDB, since: Date, ownerId?: AssistantOwner): Promise<number> {
  const [row] = await db
    .select({ input: sum(assistantUsage.inputTokens), output: sum(assistantUsage.outputTokens) })
    .from(assistantUsage)
    .where(usageSince(since, ownerId));
  return Number(row?.input ?? 0) + Number(row?.output ?? 0);
}

/** When the oldest answer counted since `since` was written, one owner's or the instance's as above; null when none was. */
export async function oldestAssistantUsageSince(
  db: DrizzleDB,
  since: Date,
  ownerId?: AssistantOwner,
): Promise<Date | null> {
  const [row] = await db
    .select({ oldest: min(assistantUsage.createdAt) })
    .from(assistantUsage)
    .where(usageSince(since, ownerId));
  return row?.oldest == null ? null : new Date(row.oldest);
}

/** The usage rows since `since`: one owner's when `ownerId` is given, every one when it is left out. */
function usageSince(since: Date, ownerId?: AssistantOwner) {
  const recent = gte(assistantUsage.createdAt, since);
  if (ownerId === undefined) return recent;
  return and(recent, ownerId === null ? isNull(assistantUsage.ownerId) : eq(assistantUsage.ownerId, ownerId));
}

/**
 * True when the assistant capability is declined on this instance, or rides on
 * a declined AI capability. The evidence probes run only when one of the two
 * carries a stored decline.
 */
export async function isAssistantDeclined(db: DrizzleDB): Promise<boolean> {
  const decisions = await getInstanceDecisions(db);
  if (decisions.assistant !== 'declined' && decisions.ai !== 'declined') return false;
  return (await resolveInstanceStates(db)).assistant === 'declined';
}
