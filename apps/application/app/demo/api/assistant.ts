/**
 * The assistant in demo mode (`server/api/assistant`): the status, and the
 * conversations kept in the in-browser database through the server's shared
 * handler, with the replies to questions, the checklist ticks and the
 * outcomes of proposed changes recorded on their blocks as the server records
 * them. The demo calls no model: a question gets its prepared answer
 * (`assistant-answers.ts`), computed from the seed, streamed in the server's
 * event format and stored like a real answer.
 */
import {
  addAssistantMessage,
  createAssistantConversation,
  deleteAssistantConversation,
  findAssistantConversation,
  getAssistantConversation,
  isAssistantDeclined,
  listAssistantConversations,
  recordAssistantProposalOutcome,
  recordAssistantReply,
  tickAssistantChecklist,
} from '#shared/handlers/assistant';
import {
  ASSISTANT_STREAM_HEADERS,
  assistantChecklistTickSchema,
  assistantConversationCreateSchema,
  assistantFrame,
  assistantProposalOutcomeSchema,
  assistantQuestionSchema,
  type AssistantBlock,
  type AssistantEvent,
  type AssistantStatus,
} from '#shared/assistant';
import type { AccessSummary } from '#shared/permissions';
import type { GuideApiGet } from '../../utils/guides/resolvers';
import { getDemoDb } from '../db.client';
import { answerDemoQuestion, type DemoAnswer, type DemoReply } from './assistant-answers';
import { demoHttpError } from './http-error';

/** Who asks: the acting user's conversations, access and readable projects, and the demo's API as they read it. */
export interface DemoAsker {
  ownerId: number | null;
  access: AccessSummary;
  scope: 'all' | Set<number>;
  get: GuideApiGet;
}

/** The model name the demo reports. */
const DEMO_MODEL = 'demo';

/** Pause between two streamed chunks of words, so the answer reads as it would arrive from a model. */
const CHUNK_DELAY_MS = 30;

/** Words per streamed chunk. */
const CHUNK_WORDS = 4;

/** Pause after a tool's line and after a block, as a model's reads and block calls take a moment. */
const STEP_DELAY_MS = 150;

async function requireNotDeclined(): Promise<void> {
  if (await isAssistantDeclined(await getDemoDb())) {
    throw demoHttpError(403, 'The assistant is declined on this instance');
  }
}

/** GET /api/assistant/status */
export async function apiAssistantStatus(): Promise<AssistantStatus> {
  const declined = await isAssistantDeclined(await getDemoDb());
  return declined
    ? { available: false, reason: 'declined', provider: null, model: null, toolMode: null }
    : { available: true, reason: null, provider: 'demo', model: DEMO_MODEL, toolMode: null };
}

/** GET /api/assistant/conversations */
export async function apiListAssistantConversations(ownerId: number | null) {
  await requireNotDeclined();
  return listAssistantConversations(await getDemoDb(), ownerId);
}

/** POST /api/assistant/conversations */
export async function apiCreateAssistantConversation(body: unknown, ownerId: number | null) {
  await requireNotDeclined();
  const parsed = assistantConversationCreateSchema.safeParse(body ?? {});
  if (!parsed.success) throw demoHttpError(400, 'Invalid request body');
  return createAssistantConversation(await getDemoDb(), ownerId, parsed.data.title ?? '');
}

/** GET /api/assistant/conversations/:id */
export async function apiGetAssistantConversation(id: number, ownerId: number | null) {
  await requireNotDeclined();
  const conversation = await getAssistantConversation(await getDemoDb(), ownerId, id);
  if (!conversation) throw demoHttpError(404, 'Conversation not found');
  return conversation;
}

/** DELETE /api/assistant/conversations/:id */
export async function apiDeleteAssistantConversation(id: number, ownerId: number | null) {
  await requireNotDeclined();
  if (!(await deleteAssistantConversation(await getDemoDb(), ownerId, id))) {
    throw demoHttpError(404, 'Conversation not found');
  }
  return { success: true };
}

/** The blocks an answer is stored with: its text parts joined as the panel joins streamed text, its blocks in order. */
function storedBlocks(answer: DemoAnswer): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  for (const part of answer.parts) {
    const last = blocks.at(-1);
    if (part.kind === 'text' && last?.kind === 'text') last.text += part.text;
    else if (part.kind === 'text') blocks.push({ kind: 'text', text: part.text });
    else if (part.kind === 'block') blocks.push(part.block);
  }
  return blocks;
}

/** The events that write an answer: its reads, its text a few words at a time, its blocks. */
function answerEvents(answer: DemoAnswer): Array<{ event: AssistantEvent; delay: number }> {
  const events: Array<{ event: AssistantEvent; delay: number }> = [];
  for (const part of answer.parts) {
    if (part.kind === 'tool') {
      const { name, summary, entities } = part.call;
      events.push({
        event: { event: 'tool', data: { name, summary, ...(entities ? { entities } : {}) } },
        delay: STEP_DELAY_MS,
      });
    } else if (part.kind === 'block') {
      events.push({ event: { event: 'block', data: { block: part.block } }, delay: STEP_DELAY_MS });
    } else {
      const words = part.text.split(/(?<= )/);
      for (let i = 0; i < words.length; i += CHUNK_WORDS) {
        const text = words.slice(i, i + CHUNK_WORDS).join('');
        events.push({ event: { event: 'text', data: { text } }, delay: CHUNK_DELAY_MS });
      }
    }
  }
  return events;
}

/** POST /api/assistant/conversations/:id/messages — streams the question's prepared answer. */
export async function apiAskAssistant(id: number, body: unknown, asker: DemoAsker): Promise<Response> {
  await requireNotDeclined();
  const db = await getDemoDb();
  const conversation = await findAssistantConversation(db, asker.ownerId, id);
  if (!conversation) throw demoHttpError(404, 'Conversation not found');
  const parsed = assistantQuestionSchema.safeParse(body);
  if (!parsed.success) throw demoHttpError(400, 'Invalid request body');
  const earlier = (await getAssistantConversation(db, asker.ownerId, id))?.messages ?? [];
  let reply: DemoReply | null = null;
  if (parsed.data.reply) {
    const recorded = await recordAssistantReply(db, asker.ownerId, id, parsed.data.reply);
    if (!recorded.ok) throw demoHttpError(recorded.status, recorded.message);
    const answered = earlier.find((message) => message.id === parsed.data.reply!.messageId);
    if (answered) reply = { blockId: parsed.data.reply.blockId, picked: recorded.reply.picked, answer: answered };
  }

  const started = Date.now();
  const answer = await answerDemoQuestion(
    { text: parsed.data.text, context: parsed.data.context ?? null, reply, earlier },
    { db, access: asker.access, scope: asker.scope, get: asker.get },
  );
  await addAssistantMessage(db, conversation, {
    role: 'user',
    blocks: [{ kind: 'text', text: parsed.data.text }],
    context: parsed.data.context ?? null,
  });
  const messageId = await addAssistantMessage(db, conversation, {
    role: 'assistant',
    blocks: storedBlocks(answer),
    toolCalls: answer.parts.flatMap((part) => (part.kind === 'tool' ? [part.call] : [])),
    provider: 'demo',
    model: DEMO_MODEL,
    durationMs: Date.now() - started,
  });

  const encoder = new TextEncoder();
  const events = answerEvents(answer);
  const stream = new ReadableStream({
    async start(controller) {
      for (const { event, delay } of events) {
        controller.enqueue(encoder.encode(assistantFrame(event)));
        await new Promise((r) => setTimeout(r, delay));
      }
      controller.enqueue(
        encoder.encode(
          assistantFrame({
            event: 'done',
            data: {
              messageId,
              provider: 'demo',
              model: DEMO_MODEL,
              toolMode: null,
              inputTokens: null,
              outputTokens: null,
              costUsd: null,
            },
          }),
        ),
      );
      controller.close();
    },
  });
  return new Response(stream, { headers: ASSISTANT_STREAM_HEADERS });
}

/** PATCH /api/assistant/conversations/:id/messages/:messageId/checklist */
export async function apiTickAssistantChecklist(id: number, messageId: number, body: unknown, ownerId: number | null) {
  await requireNotDeclined();
  const parsed = assistantChecklistTickSchema.safeParse(body);
  if (!parsed.success) throw demoHttpError(400, 'Invalid request body');
  const block = await tickAssistantChecklist(await getDemoDb(), ownerId, id, messageId, parsed.data);
  if (!block) throw demoHttpError(404, 'Checklist step not found');
  return { block };
}

/** PATCH /api/assistant/conversations/:id/messages/:messageId/proposal */
export async function apiRecordAssistantProposal(id: number, messageId: number, body: unknown, ownerId: number | null) {
  await requireNotDeclined();
  const parsed = assistantProposalOutcomeSchema.safeParse(body);
  if (!parsed.success) throw demoHttpError(400, 'Invalid request body');
  const recorded = await recordAssistantProposalOutcome(await getDemoDb(), ownerId, id, messageId, parsed.data);
  if (!recorded.ok) throw demoHttpError(recorded.status, recorded.message);
  return { block: recorded.block };
}
