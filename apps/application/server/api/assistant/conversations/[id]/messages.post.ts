import { getDatabase } from '../../../../database';
import { requireAuth } from '../../../../utils/auth';
import { requireRouteId } from '../../../../utils/project-access';
import { requestMcpContext } from '../../../../utils/mcp/catalog';
import { answerQuestion, assistantAvailability, assistantOwnerOf } from '../../../../utils/assistant/turn';
import { assistantLoopbackBaseUrl } from '../../../../utils/assistant/turn-token';
import { findAssistantConversation, recordAssistantReply } from '#shared/handlers/assistant';
import { ASSISTANT_STREAM_HEADERS, assistantFrame, assistantQuestionSchema } from '#shared/assistant';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: 'Ask the assistant a question',
    description:
      "Asks a question in one of the caller's conversations and streams the answer as Server-Sent Events. The body is `{ text, context?, reply? }`: the question (at most 4,000 characters); the page it was asked on (`route`, `page` — the `app/pages` pattern, `params`, `query`, `projectId`, and `anchors`, the guide anchor ids rendered on it: at most 300, each at most 60 characters), which the model reads as data; and, when the question answers a `question` or `options` block of an earlier answer of this conversation, the `reply` (`{ messageId, blockId, choiceIds, other? }`), recorded on that block (a question's `answer`, the options' `picked`) and handed to the model as data. The model reads through the MCP read tools with the caller's access and never writes: a change it proposes is a `proposal` block the user applies from the dashboard, with their own session. With the Claude Code CLI as the provider (and a CLI that can), one CLI run writes the answer and calls the tools through `POST /api/assistant/conversations/:id/mcp`. Events: `text` (`{ text }`, Markdown as it is written; an entity link is `[label](piwi:<type>/<id>)`), `tool` (`{ name, summary, entities? }`, a tool called and the entities its result named, `{ type, id, label }` with `type` one of `project`, `run`, `execution`, `cluster`, `test-case`), `block` (`{ block }`, a whole block other than text, checked by the server: `code`, `command`, `patch`, `entity`, `options`, `question`, `checklist`, `guide`, `navigate`, `proposal`), then one `done` (`{ messageId, provider, model, toolMode, inputTokens, outputTokens, costUsd }`) or `error` (`{ code, message, messageId }`, `code` one of `limit`, `timeout`, `provider`, `invalid-reply`). A `question` or `options` block ends the answer. The question and the answer are stored in the conversation, a failed answer with its error. A daily token cap or the tool-call limit reached ends the stream with an `error` event. 404 for another user's conversation, or a `reply` to a message of another conversation; 400 for a reply the block does not take; 403 when the assistant is declined, 503 when no AI provider is configured, 409 while the conversation is answering another question.",
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
  answering.add(id);
  try {
    const recorded = parsed.data.reply ? await recordAssistantReply(db, ownerId, id, parsed.data.reply) : null;
    if (recorded && !recorded.ok) throw apiError({ statusCode: recorded.status, message: recorded.message });
    const ctx = await requestMcpContext(event, db, user);
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
            reply: recorded?.ok ? recorded.reply : null,
            baseUrl: await assistantLoopbackBaseUrl(event),
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
  } catch (err) {
    // Refused or failed before the answer started: the stream frees the conversation once an answer runs.
    answering.delete(id);
    throw err;
  }
});
