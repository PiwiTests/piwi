/**
 * An answer as the assistant's event stream writes it: the Server-Sent Events
 * frames of a turn parsed into events, and the events folded into the message
 * being written.
 */
import type {
  AssistantBlock,
  AssistantDone,
  AssistantErrorCode,
  AssistantEvent,
  AssistantMessageView,
  AssistantToolCall,
} from '#shared/assistant';

/** The answer being written. */
export interface AssistantDraft {
  /** In the order the stream wrote them; consecutive `text` events join one text block. */
  blocks: AssistantBlock[];
  /** The tools called, as their `tool` events named them. */
  toolCalls: AssistantToolCall[];
  state: 'streaming' | 'completed' | 'failed';
  /** Why the answer stopped, when it failed. */
  error: string | null;
  errorCode: AssistantErrorCode | null;
  /** What the `done` event said: the model and the tokens. */
  done: AssistantDone | null;
  /** The stored answer's id, once the `done` or `error` event gave it. */
  messageId: number | null;
}

/** What a draft says when its stream ended without a `done` or an `error` event. */
export const ASSISTANT_STREAM_CUT = 'The answer stopped before it was complete. Ask again to get a full answer.';

export function emptyAssistantDraft(): AssistantDraft {
  return {
    blocks: [],
    toolCalls: [],
    state: 'streaming',
    error: null,
    errorCode: null,
    done: null,
    messageId: null,
  };
}

const EVENT_NAMES: ReadonlySet<string> = new Set(['text', 'tool', 'block', 'done', 'error']);

/** One frame (`event: …` and `data: …` lines) as an event, or null for a comment, an unknown event or bad JSON. */
function parseFrame(frame: string): AssistantEvent | null {
  let name = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) name = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) data.push(line.slice('data:'.length).replace(/^ /, ''));
  }
  if (!EVENT_NAMES.has(name) || data.length === 0) return null;
  try {
    return { event: name, data: JSON.parse(data.join('\n')) } as AssistantEvent;
  } catch {
    return null;
  }
}

/**
 * The events of the complete frames at the start of `buffer` (the text read
 * so far), and the rest of it: a frame still being received, to read again
 * once more text has arrived.
 */
export function readAssistantFrames(buffer: string): { events: AssistantEvent[]; rest: string } {
  const frames = buffer.replace(/\r\n?/g, '\n').split('\n\n');
  const rest = frames.pop() ?? '';
  const events = frames.map(parseFrame).filter((event): event is AssistantEvent => event !== null);
  return { events, rest };
}

/**
 * `draft` with `event` applied: text appended to the text block it ends with
 * (or a new one after another kind of block), a tool line, a whole block, then
 * the `done` that completes it or the `error` that fails it, keeping what was
 * written. Events after the end change nothing.
 */
export function reduceAssistantEvent(draft: AssistantDraft, event: AssistantEvent): AssistantDraft {
  if (draft.state !== 'streaming') return draft;
  switch (event.event) {
    case 'text': {
      const last = draft.blocks.at(-1);
      const blocks: AssistantBlock[] =
        last?.kind === 'text'
          ? [...draft.blocks.slice(0, -1), { kind: 'text', text: last.text + event.data.text }]
          : [...draft.blocks, { kind: 'text', text: event.data.text }];
      return { ...draft, blocks };
    }
    case 'tool': {
      const { name, summary, entities } = event.data;
      const call: AssistantToolCall = { name, arguments: {}, summary, ...(entities?.length ? { entities } : {}) };
      return { ...draft, toolCalls: [...draft.toolCalls, call] };
    }
    case 'block':
      return { ...draft, blocks: [...draft.blocks, event.data.block] };
    case 'done':
      return { ...draft, state: 'completed', done: event.data, messageId: event.data.messageId };
    case 'error':
      return {
        ...draft,
        state: 'failed',
        error: event.data.message,
        errorCode: event.data.code,
        messageId: event.data.messageId,
      };
    default:
      return draft;
  }
}

/** `draft` once its stream has ended: failed with {@link ASSISTANT_STREAM_CUT} when it was still being written. */
export function endAssistantDraft(draft: AssistantDraft): AssistantDraft {
  return draft.state === 'streaming' ? { ...draft, state: 'failed', error: ASSISTANT_STREAM_CUT } : draft;
}

/** `draft` failed before any event arrived: the question was refused, or the request did not reach the server. */
export function refusedAssistantDraft(draft: AssistantDraft, error: string): AssistantDraft {
  return { ...draft, state: 'failed', error };
}

/** A finished draft as a message of its conversation; its id is 0 when the answer was not stored. */
export function assistantDraftMessage(draft: AssistantDraft, createdAt: string): AssistantMessageView {
  return {
    id: draft.messageId ?? 0,
    role: 'assistant',
    blocks: draft.blocks,
    context: null,
    toolCalls: draft.toolCalls,
    provider: draft.done?.provider ?? null,
    model: draft.done?.model ?? null,
    inputTokens: draft.done?.inputTokens ?? null,
    outputTokens: draft.done?.outputTokens ?? null,
    status: draft.state === 'failed' ? 'failed' : 'completed',
    error: draft.error,
    createdAt,
  };
}
