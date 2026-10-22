import { getDatabase } from '../../../../database';
import { requireAuth } from '../../../../utils/auth';
import { requireRouteId } from '../../../../utils/project-access';
import { requestMcpContext } from '../../../../utils/mcp/catalog';
import { answerQuestion, assistantAvailability, assistantOwnerOf } from '../../../../utils/assistant/turn';
import { findAssistantConversation } from '#shared/handlers/assistant';
import { ASSISTANT_STREAM_HEADERS, assistantFrame, assistantQuestionSchema } from '#shared/assistant';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: 'Ask the assistant a question',
    description:
      "Asks a question in one of the caller's conversations and streams the answer as Server-Sent Events. The body is `{ text, context? }`: the question (at most 4,000 characters) and the page it was asked on (`route`, `page` — the `app/pages` pattern, `params`, `query`, `projectId`), which the model reads as data. The model reads through the MCP read tools with the caller's access and never writes. Events: `text` (`{ text }`, Markdown as it is written), `tool` (`{ name, summary }`, a tool called), `block` (`{ block }`, a whole block other than text), then one `done` (`{ messageId, provider, model, toolMode, inputTokens, outputTokens, costUsd }`) or `error` (`{ code, message, messageId }`, `code` one of `limit`, `timeout`, `provider`, `invalid-reply`). The question and the answer are stored in the conversation, a failed answer with its error. A daily token cap or the tool-call limit reached ends the stream with an `error` event. 404 for another user's conversation, 403 when the assistant is declined, 503 when no AI provider is configured, 409 while the conversation is answering another question.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'signed-in',
  },
});

/** Conversations answering a question in this process; one question at a time each. */
const answering = new Set<number>();

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const id = requireRouteId(event, 'id', 'conversation ID');
  const db = await getDatabase();

  const { status, role } = await assistantAvailability(db);
  if (status.reason === 'declined') {
    throw apiError({ statusCode: 403, message: 'The assistant is declined on this instance' });
  }
  if (!role) throw apiError({ statusCode: 503, errorCode: 'AI_NOT_CONFIGURED', message: 'AI is not configured' });

  const ownerId = assistantOwnerOf(event, user);
  const conversation = await findAssistantConversation(db, ownerId, id);
  if (!conversation) throw apiError({ statusCode: 404, message: 'Conversation not found' });

  const parsed = assistantQuestionSchema.safeParse(await readBody(event).catch(() => null));
  if (!parsed.success) throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  if (answering.has(id)) throw apiError({ statusCode: 409, message: 'The conversation is answering another question' });

  const ctx = await requestMcpContext(event, db, user);
  answering.add(id);
  setResponseHeaders(event, ASSISTANT_STREAM_HEADERS);

  // The answer runs to its end and is stored even when the browser leaves; only the sending stops.
  let clientGone = false;
  event.node.res.on('close', () => {
    clientGone = true;
  });
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const send = (frame: string) => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          clientGone = true;
        }
      };
      try {
        await answerQuestion({
          db,
          ctx,
          ownerId,
          role,
          conversation,
          question: parsed.data.text,
          context: parsed.data.context ?? null,
          emit: (e) => send(assistantFrame(e)),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(assistantFrame({ event: 'error', data: { code: 'provider', message, messageId: null } }));
      } finally {
        answering.delete(id);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });
});
