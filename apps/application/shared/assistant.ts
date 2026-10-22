/**
 * The in-app assistant's wire shapes, shared by the server routes, the demo and
 * the dashboard: what a question carries (its text and the page it was asked
 * on), the events a turn streams, and a conversation as the routes return it.
 */
import { z } from 'zod';

/** The longest question the assistant accepts, in characters. */
export const ASSISTANT_MAX_QUESTION_CHARS = 4000;

const shortRecord = z
  .record(z.string().max(60), z.string().max(200))
  .refine((record) => Object.keys(record).length <= 20, 'At most 20 entries');

/**
 * The page a question was asked on, as the browser sends it: the route, the
 * `app/pages` pattern it matched, the route parameters (the entity ids), the
 * query (tab, evidence, filters) and the project the page shows, when it shows
 * one. The server hands it to the model as data and picks the page's tools by
 * its pattern.
 */
export const assistantPageContextSchema = z.object({
  route: z.string().max(500),
  page: z.string().max(200).nullish(),
  params: shortRecord.optional(),
  query: shortRecord.optional(),
  projectId: z.number().int().positive().nullish(),
});

export type AssistantPageContext = z.infer<typeof assistantPageContextSchema>;

/** The body of a question. */
export const assistantQuestionSchema = z.object({
  text: z.string().trim().min(1).max(ASSISTANT_MAX_QUESTION_CHARS),
  context: assistantPageContextSchema.nullish(),
});

/** The body that starts a conversation; the title defaults to the first question. */
export const assistantConversationCreateSchema = z.object({
  title: z.string().trim().max(200).optional(),
});

/**
 * One block of a message. An answer's text streams as `text` events and is
 * stored as a text block; every other kind of block arrives whole, as a `block`
 * event, and is stored as it arrived.
 */
export type AssistantBlock = { kind: 'text'; text: string };

/** A tool the assistant called for an answer, as stored with it and shown under "What it read". */
export interface AssistantToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** One line for a person; never the tool's result. */
  summary: string;
  /** The refusal or failure the tool answered with, when it had one. */
  error?: string;
}

/** How the model calls tools: its provider's native tool calls, or one JSON object per reply. */
export type AssistantToolMode = 'native' | 'json-action';

/** Why a turn stopped without an answer. */
export type AssistantErrorCode = 'limit' | 'timeout' | 'provider' | 'invalid-reply';

/** What the `done` event carries: the stored answer, its model and its tokens. */
export interface AssistantDone {
  /** The stored answer's id; null when the answer could not be stored. */
  messageId: number | null;
  provider: string | null;
  model: string | null;
  toolMode: AssistantToolMode | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Dollar cost the provider reported (the Claude Code CLI), else null. */
  costUsd: number | null;
}

/**
 * The events of a turn's Server-Sent Events stream: `text` (Markdown, as it is
 * written) and `tool` (a tool called, with a one-line summary) while the answer
 * is written, `block` for a whole block of another kind, then exactly one
 * `done` or `error`. An `error` after some text keeps that text as a failed answer.
 */
export type AssistantEvent =
  | { event: 'text'; data: { text: string } }
  | { event: 'tool'; data: { name: string; summary: string } }
  | { event: 'block'; data: { block: AssistantBlock } }
  | { event: 'done'; data: AssistantDone }
  | { event: 'error'; data: { code: AssistantErrorCode; message: string; messageId: number | null } };

/** One event as a Server-Sent Events frame. */
export function assistantFrame(event: AssistantEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** The headers of a turn's event stream. */
export const ASSISTANT_STREAM_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

export interface AssistantConversationSummary {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantMessageView {
  id: number;
  role: 'user' | 'assistant';
  blocks: AssistantBlock[];
  /** The page a question was asked on. */
  context: AssistantPageContext | null;
  /** The tools an answer called. */
  toolCalls: AssistantToolCall[];
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  status: 'completed' | 'failed';
  error: string | null;
  createdAt: string;
}

export interface AssistantConversation extends AssistantConversationSummary {
  messages: AssistantMessageView[];
}

/** Whether the assistant can answer here, and with what. */
export interface AssistantStatus {
  available: boolean;
  /** Why it cannot: no AI provider configured, or the capability declined. */
  reason: 'not-configured' | 'declined' | null;
  provider: string | null;
  model: string | null;
  /** How the model calls tools, once known: always for Anthropic and the Claude Code CLI, after a first answer otherwise. */
  toolMode: AssistantToolMode | null;
}

/** A message's text: its text blocks, joined. */
export function assistantMessageText(blocks: readonly AssistantBlock[]): string {
  return blocks
    .filter((b) => b.kind === 'text')
    .map((b) => b.text)
    .join('\n\n');
}

/** A conversation title from its first question: one line, at most 80 characters. */
export function assistantTitleFrom(question: string): string {
  const line = question.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
