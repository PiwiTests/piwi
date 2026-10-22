/**
 * The assistant's entry points for its routes: whether it can answer on this
 * instance, whose conversations a request reads, and one question answered
 * and stored with the asking user's access.
 */
import type { H3Event } from 'h3';
import {
  addAssistantMessage,
  assistantTokensSince,
  findAssistantConversation,
  getAssistantConversation,
  isAssistantDeclined,
  recordAssistantUsage,
  setAssistantExtraTools,
  type AssistantOwner,
} from '#shared/handlers/assistant';
import type { AssistantEvent, AssistantPageContext, AssistantStatus } from '#shared/assistant';
import type { ResolvedAiRole } from '~~/types/api';
import type { DbClient } from '../../database';
import type { User } from '../../database/schema';
import { assistantRole, resolveAiConfig } from '../ai-provider';
import { knownToolMode } from '../ai-tool-calls';
import { apiError } from '../api-error';
import { isAuthEnabled } from '../auth';
import type { McpContext } from '../mcp/tools';
import { assistantHistory, runAssistantTurn } from './loop';
import { resolveAssistantLimits, type AssistantLimits } from './limits';
import { buildAssistantSystemPrompt, loadAssistantPromptParts } from './prompt';
import { assistantReadTools, createAssistantToolbox } from './tools';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whose conversations a request reads: the signed-in user's, or the virtual administrator's (null) with authentication off. */
export function assistantOwnerOf(event: H3Event, user: User): AssistantOwner {
  return isAuthEnabled(event) ? user.id : null;
}

/** Refuse with 403 when the assistant is declined on this instance: its routes answer as unavailable. */
export async function requireAssistantNotDeclined(db: DbClient): Promise<void> {
  if (await isAssistantDeclined(db)) {
    throw apiError({ statusCode: 403, message: 'The assistant is declined on this instance' });
  }
}

/** Whether the assistant can answer here, with the role it would answer with. */
export async function assistantAvailability(
  db: DbClient,
): Promise<{ status: AssistantStatus; role: ResolvedAiRole | null }> {
  const unavailable = (reason: AssistantStatus['reason']) => ({
    status: { available: false, reason, provider: null, model: null, toolMode: null },
    role: null,
  });
  if (await isAssistantDeclined(db)) return unavailable('declined');
  const config = await resolveAiConfig(db);
  if (!config) return unavailable('not-configured');
  const role = assistantRole(config);
  return {
    status: {
      available: true,
      reason: null,
      provider: role.provider,
      model: role.model || null,
      toolMode: knownToolMode(role),
    },
    role,
  };
}

/**
 * The tokens the daily caps leave for one owner's next turn: the smaller of
 * what the per-user cap and the instance cap leave over the last 24 hours, with
 * the message naming the cap that binds. `remaining` is null when neither is set.
 */
export async function assistantAllowance(
  db: DbClient,
  ownerId: AssistantOwner,
  limits: Pick<AssistantLimits, 'dailyTokensPerUser' | 'dailyTokens'>,
  now = new Date(),
): Promise<{ remaining: number | null; message: string }> {
  const since = new Date(now.getTime() - DAY_MS);
  const tokens = (n: number) => n.toLocaleString('en-US');
  let remaining: number | null = null;
  let message = '';
  if (limits.dailyTokensPerUser !== null) {
    remaining = limits.dailyTokensPerUser - (await assistantTokensSince(db, since, ownerId));
    message = `You reached your assistant allowance of ${tokens(limits.dailyTokensPerUser)} tokens in 24 hours (PIWI_AI_ASSISTANT_DAILY_TOKENS_PER_USER). It frees up as your earlier answers pass 24 hours.`;
  }
  if (limits.dailyTokens !== null) {
    const left = limits.dailyTokens - (await assistantTokensSince(db, since));
    if (remaining === null || left < remaining) {
      remaining = left;
      message = `This instance reached its assistant allowance of ${tokens(limits.dailyTokens)} tokens in 24 hours (PIWI_AI_ASSISTANT_DAILY_TOKENS). It frees up as earlier answers pass 24 hours.`;
    }
  }
  return { remaining: remaining === null ? null : Math.max(0, remaining), message };
}

type ConversationRow = NonNullable<Awaited<ReturnType<typeof findAssistantConversation>>>;

/**
 * Answer one question in a conversation and store both: the question first,
 * then the answer (its text, the tools it called, its model and tokens, or the
 * error that stopped it), with what it spent recorded for the daily caps. The
 * events stream through `emit` as the answer is written; the final `done` or
 * `error` carries the stored answer's id.
 */
export async function answerQuestion(opts: {
  db: DbClient;
  ctx: McpContext;
  ownerId: AssistantOwner;
  role: ResolvedAiRole;
  conversation: ConversationRow;
  question: string;
  context: AssistantPageContext | null;
  emit: (event: AssistantEvent) => void;
}): Promise<void> {
  const { db, ctx, ownerId, conversation, context } = opts;
  const earlier = (await getAssistantConversation(db, ownerId, conversation.id))?.messages ?? [];
  await addAssistantMessage(db, conversation, {
    role: 'user',
    blocks: [{ kind: 'text', text: opts.question }],
    context,
  });

  const limits = resolveAssistantLimits();
  const [allowance, readTools, promptParts] = await Promise.all([
    assistantAllowance(db, ownerId, limits),
    assistantReadTools(db, ctx),
    loadAssistantPromptParts(db, ctx, isAuthEnabled(), context),
  ]);
  const extraTools = Array.isArray(conversation.extraTools) ? (conversation.extraTools as string[]) : [];
  const toolbox = createAssistantToolbox({ db, ctx, readTools, page: context?.page ?? null, extraTools });

  let final: Extract<AssistantEvent, { event: 'done' | 'error' }> | null = null;
  const result = await runAssistantTurn({
    role: opts.role,
    system: buildAssistantSystemPrompt(promptParts),
    history: assistantHistory(earlier),
    question: opts.question,
    toolbox,
    limits,
    allowance,
    emit: (event) => {
      if (event.event === 'done' || event.event === 'error') final = event;
      else opts.emit(event);
    },
  });

  const messageId = await addAssistantMessage(db, conversation, {
    role: 'assistant',
    blocks: result.text ? [{ kind: 'text', text: result.text }] : [],
    toolCalls: result.toolCalls,
    provider: result.provider,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    status: result.status,
    error: result.error?.message ?? null,
    durationMs: result.durationMs,
  });
  // A turn stopped before any model call spent nothing.
  if (result.model !== null) {
    await recordAssistantUsage(db, {
      ownerId,
      provider: result.provider,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      status: result.status,
    });
  }
  const nowExtra = toolbox.extraTools();
  if (nowExtra.length !== extraTools.length) await setAssistantExtraTools(db, conversation.id, nowExtra);

  const last = final as Extract<AssistantEvent, { event: 'done' | 'error' }> | null;
  if (last?.event === 'done') opts.emit({ event: 'done', data: { ...last.data, messageId } });
  else if (last?.event === 'error') opts.emit({ event: 'error', data: { ...last.data, messageId } });
}
