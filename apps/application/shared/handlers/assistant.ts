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
import { and, asc, desc, eq, gte, inArray, isNull, sum } from 'drizzle-orm';
import { assistantConversations, assistantMessages, assistantUsage } from '../../server/database/schema';
import {
  assistantMessageText,
  assistantTitleFrom,
  type AssistantBlock,
  type AssistantConversation,
  type AssistantConversationSummary,
  type AssistantMessageView,
  type AssistantPageContext,
  type AssistantToolCall,
} from '#shared/assistant';
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
  const recent = gte(assistantUsage.createdAt, since);
  const owner =
    ownerId === undefined
      ? undefined
      : ownerId === null
        ? isNull(assistantUsage.ownerId)
        : eq(assistantUsage.ownerId, ownerId);
  const [row] = await db
    .select({ input: sum(assistantUsage.inputTokens), output: sum(assistantUsage.outputTokens) })
    .from(assistantUsage)
    .where(owner ? and(recent, owner) : recent);
  return Number(row?.input ?? 0) + Number(row?.output ?? 0);
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
