/**
 * The in-app assistant's wire shapes, shared by the server routes, the demo and
 * the dashboard: what a question carries (its text and the page it was asked
 * on), the events a turn streams, and a conversation as the routes return it.
 */
import { z } from 'zod';
import type { PatchValidation } from '#shared/patch';
import type { AssistantActionId } from '#shared/assistant-actions';

/** The longest question the assistant accepts, in characters. */
export const ASSISTANT_MAX_QUESTION_CHARS = 4000;

const shortRecord = z
  .record(z.string().max(60), z.string().max(200))
  .refine((record) => Object.keys(record).length <= 20, 'At most 20 entries');

/** The most guide anchors a question's context lists, and the longest id it takes. */
export const ASSISTANT_MAX_PAGE_ANCHORS = 300;
export const ASSISTANT_MAX_ANCHOR_CHARS = 60;

/**
 * The page a question was asked on, as the browser sends it: the route, the
 * `app/pages` pattern it matched, the route parameters (the entity ids), the
 * query (tab, evidence, filters), the project the page shows, when it shows
 * one, and the guide anchors rendered on it (the `data-tour` values visible
 * when the question was asked). The server hands it to the model as data,
 * picks the page's tools by its pattern and ranks the page's anchors first.
 */
export const assistantPageContextSchema = z.object({
  route: z.string().max(500),
  page: z.string().max(200).nullish(),
  params: shortRecord.optional(),
  query: shortRecord.optional(),
  projectId: z.number().int().positive().nullish(),
  anchors: z.array(z.string().max(ASSISTANT_MAX_ANCHOR_CHARS)).max(ASSISTANT_MAX_PAGE_ANCHORS).optional(),
});

export type AssistantPageContext = z.infer<typeof assistantPageContextSchema>;

/**
 * An answer to a `question` or `options` block of an earlier answer: the
 * choices picked, by id, and what the user typed in the block's "Other" field.
 * The question's `text` says the same thing in words, for the conversation.
 */
export const assistantReplySchema = z.object({
  messageId: z.number().int().positive(),
  blockId: z.string().max(60),
  choiceIds: z.array(z.string().max(60)).max(20),
  other: z.string().trim().max(500).optional(),
});

export type AssistantReply = z.infer<typeof assistantReplySchema>;

/** The body of a question. */
export const assistantQuestionSchema = z.object({
  text: z.string().trim().min(1).max(ASSISTANT_MAX_QUESTION_CHARS),
  context: assistantPageContextSchema.nullish(),
  reply: assistantReplySchema.optional(),
});

/** The body that ticks or unticks one step of a `checklist` block of an answer. */
export const assistantChecklistTickSchema = z.object({
  blockId: z.string().max(60),
  stepId: z.string().max(60),
  done: z.boolean(),
});

/** What became of a `proposal` block: applied (its route answered), dismissed, or failed (the route refused it). */
export type AssistantProposalStatus = 'applied' | 'dismissed' | 'failed';

/** The body that records what became of a `proposal` block of an answer. */
export const assistantProposalOutcomeSchema = z.object({
  blockId: z.string().max(60),
  status: z.enum(['applied', 'dismissed', 'failed']),
  /** What the route answered, in one line: why it refused, for a failed apply. */
  result: z.string().trim().max(300).optional(),
});

export type AssistantProposalOutcomeInput = z.infer<typeof assistantProposalOutcomeSchema>;

/** The body that starts a conversation; the title defaults to the first question. */
export const assistantConversationCreateSchema = z.object({
  title: z.string().trim().max(200).optional(),
});

/** The kinds of entity an answer can name: a link in its text, a card, a choice. */
export type AssistantEntityType = 'project' | 'run' | 'execution' | 'cluster' | 'test-case';

/** An entity an answer names, as a tool result returned it. */
export interface AssistantEntityRef {
  type: AssistantEntityType;
  id: number;
  /** What a person calls it: the project's name, the test's title, the run's number. */
  label: string;
}

/** A shell command, in bash and, when it differs, in PowerShell. */
export interface AssistantCommand {
  bash: string;
  powershell?: string;
}

/** One stop of a composed guide, as the server checked it: a registry anchor, the route it opens, its words. */
export interface AssistantGuideStop {
  /** A guide anchor id (`shared/guide-anchors/`). */
  anchor: string;
  /** The route the stop opens, from the app's root, with real ids; omitted, the anchor's main page or the current one. */
  route?: string;
  /** At most 60 characters; `**bold**` is the only markup. */
  title: string;
  /** At most 360 characters; `**bold**` is the only markup. */
  body: string;
}

/** A guide the model composed from registry anchors, checked by the server before it is sent. */
export interface AssistantGuidePlan {
  /** At most 60 characters. */
  title: string;
  /** One to seven stops. */
  stops: AssistantGuideStop[];
}

/** One way to solve the problem, in an `options` block. */
export interface AssistantOption {
  id: string;
  /** At most 60 characters. */
  title: string;
  /** One line. */
  summary: string;
  /** What it costs or risks, in one line. */
  tradeoff?: string;
  effort?: 'small' | 'medium' | 'large';
  /** At most one option of a block is recommended. */
  recommended?: boolean;
  /** Picking it plays this guide instead of asking the next question. */
  guide?: AssistantGuidePlan;
}

/** One choice of a `question` block. */
export interface AssistantChoice {
  id: string;
  label: string;
  detail?: string;
  /** The entity the choice stands for, when it is one (a test, a cluster). */
  entity?: AssistantEntityRef;
  /** Ticked when the question appears. */
  checked?: boolean;
}

/** What became of a proposal, once the user applied or dismissed it. */
export interface AssistantProposalOutcome {
  status: AssistantProposalStatus;
  /** What the route answered, in one line: why it refused, for a failed apply. */
  result?: string;
  /** When it was recorded, as an ISO timestamp. */
  at: string;
}

/** One step of a `checklist` block. */
export interface AssistantChecklistStep {
  id: string;
  text: string;
  command?: AssistantCommand;
  guide?: AssistantGuidePlan;
  /** Ticked by the user; kept with the conversation. */
  done?: boolean;
}

/**
 * One block of a message. An answer's text streams as `text` events and is
 * stored as a text block; every other kind of block arrives whole, as a `block`
 * event, checked by the server against its limits, and is stored as it
 * arrived. Text is Markdown; an entity link in it is written
 * `[label](piwi:<type>/<id>)` and renders as a link only when a tool result of
 * the conversation named that entity. Block ids are kebab-case, unique within
 * their message. A `question` or `options` block ends the answer: the user's
 * pick comes back as the next question's `reply`, and is stored on the block.
 * A `proposal` is a change the user applies with a click: the panel calls its
 * action's route (`shared/assistant-actions.ts`) and stores the outcome on the
 * block; the model never applies it.
 */
export type AssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'code'; id: string; language: string; code: string; title?: string }
  | { kind: 'command'; id: string; command: AssistantCommand; title?: string }
  | { kind: 'patch'; id: string; patch: string; validation: PatchValidation | null; title?: string }
  | { kind: 'entity'; id: string; entity: AssistantEntityRef; status?: string; detail?: string }
  | { kind: 'options'; id: string; prompt: string; options: AssistantOption[]; picked?: string }
  | {
      kind: 'question';
      id: string;
      prompt: string;
      multiple: boolean;
      choices: AssistantChoice[];
      /** Offers an "Other" field. */
      other: boolean;
      answer?: { choiceIds: string[]; other?: string };
    }
  | { kind: 'checklist'; id: string; title: string; steps: AssistantChecklistStep[] }
  | { kind: 'guide'; id: string; guide: AssistantGuidePlan }
  | { kind: 'navigate'; id: string; route: string; label: string }
  | {
      kind: 'proposal';
      id: string;
      action: AssistantActionId;
      /** At most 60 characters. */
      title: string;
      /** What changes, in one or two sentences. */
      change: string;
      /** The entity it changes, from a tool result; null for an instance-wide change. */
      target: AssistantEntityRef | null;
      /** The target's project, which the action's route may name; null for an instance-wide change. */
      projectId: number | null;
      /** The action's parameters, checked against its schema. */
      params: Record<string, unknown>;
      outcome?: AssistantProposalOutcome;
    };

/** The route of an entity's page. */
export function assistantEntityRoute(entity: Pick<AssistantEntityRef, 'type' | 'id'>): string {
  const base: Record<AssistantEntityType, string> = {
    project: '/projects',
    run: '/test-runs',
    execution: '/test-run-cases',
    cluster: '/failure-clusters',
    'test-case': '/test-cases',
  };
  return `${base[entity.type]}/${entity.id}`;
}

const ENTITY_LINK = /^piwi:(project|run|execution|cluster|test-case)\/(\d+)$/;

/** The entity an answer's `piwi:<type>/<id>` link names, or null for any other href. */
export function parseAssistantLink(href: string): Pick<AssistantEntityRef, 'type' | 'id'> | null {
  const match = ENTITY_LINK.exec(href.trim());
  return match ? { type: match[1] as AssistantEntityType, id: Number(match[2]) } : null;
}

/** The key of an entity in a set of the entities a conversation's tool results named. */
export function assistantEntityKey(entity: Pick<AssistantEntityRef, 'type' | 'id'>): string {
  return `${entity.type}:${entity.id}`;
}

/** A tool the assistant called for an answer, as stored with it and shown under "What it read". */
export interface AssistantToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** One line for a person; never the tool's result. */
  summary: string;
  /** The refusal or failure the tool answered with, when it had one. */
  error?: string;
  /** The entities its result named, which the answer may link to. */
  entities?: AssistantEntityRef[];
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
  | { event: 'tool'; data: { name: string; summary: string; entities?: AssistantEntityRef[] } }
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
    .filter((b): b is Extract<AssistantBlock, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.text)
    .join('\n\n');
}

/** A conversation title from its first question: one line, at most 80 characters. */
export function assistantTitleFrom(question: string): string {
  const line = question.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
