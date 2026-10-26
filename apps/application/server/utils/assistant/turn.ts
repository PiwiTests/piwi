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
  isAssistantDeclined,
  listAssistantConversationEntities,
  listRecentAssistantMessages,
  recordAssistantUsage,
  setAssistantExtraTools,
  type AssistantOwner,
} from '#shared/handlers/assistant';
import type { AssistantRecordedReply } from '#shared/handlers/assistant';
import type { AssistantEvent, AssistantPageContext, AssistantStatus } from '#shared/assistant';
import type { ResolvedAiRole } from '~~/types/api';
import type { DbClient } from '../../database';
import type { User } from '../../database/schema';
import { claudeCliRunsAgents } from '../ai-claude-cli';
import { runCodexCliAgent } from '../ai-codex-cli';
import { assistantRole, resolveAiConfig } from '../ai-provider';
import { knownToolMode } from '../ai-tool-calls';
import { apiError } from '../api-error';
import { isAuthEnabled } from '../auth';
import type { McpContext } from '../mcp/tools';
import { runClaudeCodeTurn } from './claude-code';
import { readAssistantHistory, runAssistantTurn, type AssistantTurnOptions } from './loop';
import { resolveAssistantLimits, type AssistantLimits } from './limits';
import { assistantQuestionText, buildAssistantSystemPrompt, loadAssistantPromptParts } from './prompt';
import { assistantReadTools, assistantToolNames, createAssistantToolbox } from './tools';

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

/**
 * Whether a turn runs in the Claude Code CLI, which then calls the model and
 * the tools itself (`claude-code.ts`): a `claude-cli` role whose installed CLI
 * can. Otherwise the CLI answers step by step in the JSON action mode.
 */
async function runsInClaudeCode(role: ResolvedAiRole): Promise<boolean> {
  return role.provider === 'codex-cli' || (role.provider === 'claude-cli' && (await claudeCliRunsAgents()));
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
      toolMode: (await runsInClaudeCode(role)) ? 'native' : knownToolMode(role),
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
 * then the answer (its blocks, the tools it called with the entities they
 * named, its model and tokens, or the error that stopped it), with what it
 * spent recorded for the daily caps. A question that replies to an earlier
 * question or options block carries the picks, already recorded on the block,
 * to the model as data. The entities the conversation's earlier answers read
 * stay usable in this one. The events stream through `emit` as the answer is
 * written; the final `done` or `error` carries the stored answer's id. With
 * the Claude Code CLI the answer runs in one CLI run, which calls the turn's
 * tools on this server at `baseUrl` (`assistantLoopbackBaseUrl`).
 */
export async function answerQuestion(opts: {
  db: DbClient;
  ctx: McpContext;
  ownerId: AssistantOwner;
  role: ResolvedAiRole;
  conversation: ConversationRow;
  question: string;
  context: AssistantPageContext | null;
  reply?: AssistantRecordedReply | null;
  baseUrl: string;
  emit: (event: AssistantEvent) => void;
}): Promise<void> {
  const { db, ctx, ownerId, conversation, context } = opts;
  // The history reads the newest messages only; the entities come from every earlier answer's tool calls.
  const [history, earlierEntities] = await Promise.all([
    readAssistantHistory((limit) => listRecentAssistantMessages(db, ownerId, conversation.id, limit)),
    listAssistantConversationEntities(db, ownerId, conversation.id),
  ]);
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
  const toolbox = createAssistantToolbox({
    db,
    ctx,
    readTools,
    page: context?.page ?? null,
    extraTools,
    context,
    entities: earlierEntities,
  });

  let final: Extract<AssistantEvent, { event: 'done' | 'error' }> | null = null;
  const turn: AssistantTurnOptions = {
    role: opts.role,
    system: buildAssistantSystemPrompt(promptParts),
    history,
    question: assistantQuestionText(opts.question, opts.reply ?? null),
    toolbox,
    limits,
    allowance,
    emit: (event) => {
      if (event.event === 'done' || event.event === 'error') final = event;
      else opts.emit(event);
    },
  };
  const result = (await runsInClaudeCode(opts.role))
    ? await runClaudeCodeTurn({
        ...turn,
        ...(opts.role.provider === 'codex-cli' ? { run: runCodexCliAgent } : {}),
        conversationId: conversation.id,
        ownerId,
        baseUrl: opts.baseUrl,
        allowedTools: assistantToolNames(readTools),
      })
    : await runAssistantTurn(turn);

  const messageId = await addAssistantMessage(db, conversation, {
    role: 'assistant',
    blocks: result.blocks,
    toolCalls: result.toolCalls,
    provider: result.provider,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    status: result.status,
    error: result.error?.message ?? null,
    durationMs: result.durationMs,
  });
  // What a turn reports spending counts, a timed-out one's included; one stopped before any model call reports none.
  if (result.model !== null || result.inputTokens !== null || result.outputTokens !== null) {
    await recordAssistantUsage(db, {
      ownerId,
      provider: result.provider,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      status: result.status,
    });
  }
  // The tools `find_tools` added in this answer stay offered for the rest of the conversation.
  const added = toolbox.extraTools().filter((name) => !extraTools.includes(name));
  if (added.length > 0) await setAssistantExtraTools(db, conversation.id, [...extraTools, ...added]);

  const last = final as Extract<AssistantEvent, { event: 'done' | 'error' }> | null;
  if (last?.event === 'done') opts.emit({ event: 'done', data: { ...last.data, messageId } });
  else if (last?.event === 'error') opts.emit({ event: 'error', data: { ...last.data, messageId } });
}
