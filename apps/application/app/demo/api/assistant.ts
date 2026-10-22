/**
 * The assistant in demo mode (`server/api/assistant`): the status, and the
 * conversations kept in the in-browser database through the server's shared
 * handler. The demo calls no model, so a question is answered with
 * {@link DEMO_ASSISTANT_ANSWER}, streamed in the server's event format and
 * stored like a real answer.
 */
import {
  addAssistantMessage,
  createAssistantConversation,
  deleteAssistantConversation,
  findAssistantConversation,
  getAssistantConversation,
  isAssistantDeclined,
  listAssistantConversations,
} from '#shared/handlers/assistant';
import {
  ASSISTANT_STREAM_HEADERS,
  assistantConversationCreateSchema,
  assistantFrame,
  assistantQuestionSchema,
  type AssistantStatus,
} from '#shared/assistant';
import { getDemoDb } from '../db.client';
import { demoHttpError } from './http-error';

/** The demo's reply to every question. */
const DEMO_ASSISTANT_ANSWER =
  'The live demo has no AI model behind it, so it answers a set of prepared questions about its sample data rather than free questions. On your own instance the assistant answers with the AI model you configure in **Settings → AI**, reading your runs, failures and setup with your access.';

/** The model name the demo reports. */
const DEMO_MODEL = 'demo';

/** Pause between two streamed words, so the answer reads as it would arrive from a model. */
const WORD_DELAY_MS = 30;

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

/** POST /api/assistant/conversations/:id/messages — streams {@link DEMO_ASSISTANT_ANSWER}. */
export async function apiAskAssistant(id: number, body: unknown, ownerId: number | null): Promise<Response> {
  await requireNotDeclined();
  const db = await getDemoDb();
  const conversation = await findAssistantConversation(db, ownerId, id);
  if (!conversation) throw demoHttpError(404, 'Conversation not found');
  const parsed = assistantQuestionSchema.safeParse(body);
  if (!parsed.success) throw demoHttpError(400, 'Invalid request body');

  await addAssistantMessage(db, conversation, {
    role: 'user',
    blocks: [{ kind: 'text', text: parsed.data.text }],
    context: parsed.data.context ?? null,
  });
  const messageId = await addAssistantMessage(db, conversation, {
    role: 'assistant',
    blocks: [{ kind: 'text', text: DEMO_ASSISTANT_ANSWER }],
    provider: 'demo',
    model: DEMO_MODEL,
  });

  const encoder = new TextEncoder();
  const words = DEMO_ASSISTANT_ANSWER.split(/(?<= )/);
  const stream = new ReadableStream({
    async start(controller) {
      for (const word of words) {
        controller.enqueue(encoder.encode(assistantFrame({ event: 'text', data: { text: word } })));
        await new Promise((r) => setTimeout(r, WORD_DELAY_MS));
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
