/**
 * The assistant in demo mode (`server/api/assistant`): the status, the
 * visitor's question history, and the conversations kept in the in-browser
 * database through the server's shared handler, with the replies to
 * questions, the checklist ticks and the outcomes of proposed changes
 * recorded on their blocks as the server records them. The demo calls no
 * model: a question gets its prepared answer (`assistant-answers.ts`),
 * computed from the seed, streamed in the server's event format, stopped by
 * **Stop** like a real one, and stored like a real answer.
 */
import {
  addAssistantMessage,
  createAssistantConversation,
  deleteAssistantConversation,
  findAssistantConversation,
  getAssistantConversation,
  isAssistantDeclined,
  listAssistantConversations,
  listAssistantQuestions,
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
  type AssistantToolCall,
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
  const status: AssistantStatus = declined
    ? { available: false, reason: 'declined', provider: null, model: null, toolMode: null }
    : { available: true, reason: null, provider: 'demo', model: DEMO_MODEL, toolMode: null };
  return { ...status, allowance: null, subscription: null };
}

/** GET /api/assistant/questions */
export async function apiListAssistantQuestions(ownerId: number | null) {
  await requireNotDeclined();
  return listAssistantQuestions(await getDemoDb(), ownerId);
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

/** One event of a streamed answer, the pause after it, and the read it reports. */
interface DemoAnswerEvent {
  event: AssistantEvent;
  delay: number;
  call?: AssistantToolCall;
}

/** The events that write an answer: its reads, its text a few words at a time, its blocks. */
function answerEvents(answer: DemoAnswer): DemoAnswerEvent[] {
  const events: DemoAnswerEvent[] = [];
  for (const part of answer.parts) {
    if (part.kind === 'tool') {
      const { name, summary, entities } = part.call;
      events.push({
        event: { event: 'tool', data: { name, summary, ...(entities ? { entities } : {}) } },
        delay: STEP_DELAY_MS,
        call: part.call,
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

/** The blocks the streamed events wrote, as the panel joins them: consecutive text in one block, the blocks in order. */
function blocksOf(events: readonly DemoAnswerEvent[]): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  for (const { event } of events) {
    const last = blocks.at(-1);
    if (event.event === 'text' && last?.kind === 'text') last.text += event.data.text;
    else if (event.event === 'text') blocks.push({ kind: 'text', text: event.data.text });
    else if (event.event === 'block') blocks.push(event.data.block);
  }
  return blocks;
}

/** The conversations answering in this tab, and those whose answer the visitor stopped. */
const answering = new Set<number>();
const stopRequested = new Set<number>();

/** POST /api/assistant/conversations/:id/stop */
export async function apiStopAssistantAnswer(id: number, ownerId: number | null) {
  await requireNotDeclined();
  if (!(await findAssistantConversation(await getDemoDb(), ownerId, id))) {
    throw demoHttpError(404, 'Conversation not found');
  }
  const stopped = answering.has(id);
  if (stopped) stopRequested.add(id);
  return { stopped };
}

/**
 * POST /api/assistant/conversations/:id/messages — streams the question's
 * prepared answer and stores what it streamed: the whole answer, or what was
 * written before the visitor stopped it, as a failed answer.
 */
export async function apiAskAssistant(id: number, body: unknown, asker: DemoAsker): Promise<Response> {
  await requireNotDeclined();
  const db = await getDemoDb();
  const conversation = await findAssistantConversation(db, asker.ownerId, id);
  if (!conversation) throw demoHttpError(404, 'Conversation not found');
  const parsed = assistantQuestionSchema.safeParse(body);
  if (!parsed.success) throw demoHttpError(400, 'Invalid request body');
  if (answering.has(id)) throw demoHttpError(409, 'The conversation is answering another question');
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

  answering.add(id);
  stopRequested.delete(id);
  const encoder = new TextEncoder();
  const events = answerEvents(answer);
  const stream = new ReadableStream({
    async start(controller) {
      // A tab that left stops reading: the answer is still written to its end and stored.
      let reading = true;
      const send = (event: AssistantEvent) => {
        if (!reading) return;
        try {
          controller.enqueue(encoder.encode(assistantFrame(event)));
        } catch {
          reading = false;
        }
      };
      const sent: DemoAnswerEvent[] = [];
      let stopped = false;
      try {
        for (const item of events) {
          if (stopRequested.has(id)) {
            stopped = true;
            break;
          }
          send(item.event);
          sent.push(item);
          if (reading) await new Promise((r) => setTimeout(r, item.delay));
        }
        const error = stopped ? 'You stopped this answer.' : null;
        const messageId = await addAssistantMessage(db, conversation, {
          role: 'assistant',
          blocks: blocksOf(sent),
          toolCalls: sent.flatMap((item) => (item.call ? [item.call] : [])),
          provider: 'demo',
          model: DEMO_MODEL,
          status: stopped ? 'failed' : 'completed',
          error,
          durationMs: Date.now() - started,
        });
        send(
          error
            ? { event: 'error', data: { code: 'stopped', message: error, messageId } }
            : {
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
              },
        );
      } finally {
        answering.delete(id);
        stopRequested.delete(id);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
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
