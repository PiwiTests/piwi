/**
 * What the panel sends back for a `question` or `options` block: the next
 * question, whose text says the picks in words and whose `reply` carries the
 * ids, and what the panel reads from a conversation (the entities its tool
 * results named, the answer a block can still take).
 */
import {
  ASSISTANT_MAX_QUESTION_CHARS,
  type AssistantBlock,
  type AssistantMessageView,
  type AssistantReply,
  type AssistantToolCall,
  assistantEntityKey,
} from '#shared/assistant';

type QuestionBlock = Extract<AssistantBlock, { kind: 'question' }>;
type OptionsBlock = Extract<AssistantBlock, { kind: 'options' }>;

/** The longest "Other" answer the reply schema takes. */
const MAX_OTHER = 500;

/** A question that answers a block: its text and its reply. */
export interface AssistantReplyQuestion {
  text: string;
  reply: AssistantReply;
}

/** `items` as a sentence's list: "A", "A and B", "A, B and C". */
export function listInWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * The question answering `block` of message `messageId` with the choices
 * `choiceIds` and the "Other" text `other`: the picks in the block's order
 * (one at most when the question takes one), the "Other" text only when the
 * block offers the field. Null when nothing is picked or typed.
 */
export function questionReply(
  messageId: number,
  block: QuestionBlock,
  choiceIds: readonly string[],
  other?: string,
): AssistantReplyQuestion | null {
  const picked = block.choices.filter((choice) => choiceIds.includes(choice.id)).slice(0, block.multiple ? 20 : 1);
  const typed = block.other ? (other ?? '').trim().slice(0, MAX_OTHER) : '';
  if (picked.length === 0 && !typed) return null;
  const words = [...picked.map((choice) => choice.label), ...(typed ? [typed] : [])];
  return {
    text: listInWords(words).slice(0, ASSISTANT_MAX_QUESTION_CHARS),
    reply: {
      messageId,
      blockId: block.id,
      choiceIds: picked.map((choice) => choice.id),
      ...(typed ? { other: typed } : {}),
    },
  };
}

/** The question picking option `optionId` of `block`, said with the option's title; null for an unknown option. */
export function optionReply(messageId: number, block: OptionsBlock, optionId: string): AssistantReplyQuestion | null {
  const option = block.options.find((o) => o.id === optionId);
  if (!option) return null;
  return { text: option.title, reply: { messageId, blockId: block.id, choiceIds: [option.id] } };
}

/** The keys (`assistantEntityKey`) of every entity the tool results of `messages` named. */
export function assistantKnownEntities(messages: readonly { toolCalls: readonly AssistantToolCall[] }[]): Set<string> {
  const known = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls) {
      for (const entity of call.entities ?? []) known.add(assistantEntityKey(entity));
    }
  }
  return known;
}

/**
 * The answer whose `question` and `options` blocks can still be answered: the
 * conversation's last message when it is a stored answer. A later question
 * moves the conversation on, and the blocks before it stay as they were.
 */
export function answerableMessageId(messages: readonly AssistantMessageView[]): number | null {
  const last = messages.at(-1);
  return last?.role === 'assistant' && last.id > 0 ? last.id : null;
}
