/**
 * One assistant turn: the system prompt, the conversation so far and the new
 * question go to the model with the offered tools; each tool call it makes is
 * run and its result handed back, until it answers or a limit stops it. The
 * turn emits its events as it goes (`text`, `tool`, then `done` or `error`)
 * and returns what to store.
 *
 * Limits: at most `maxToolCalls` tool calls, after which the model is asked to
 * answer with what it has; `maxOutputTokens` per model call; `turnTimeoutMs`
 * for the whole turn; and the tokens the daily caps leave, checked before each
 * model call.
 */
import type {
  AssistantErrorCode,
  AssistantEvent,
  AssistantMessageView,
  AssistantToolCall,
  AssistantToolMode,
} from '#shared/assistant';
import { assistantMessageText } from '#shared/assistant';
import type { ResolvedAiRole } from '~~/types/api';
import {
  toolStep,
  type AiChatMessage,
  type AiStepChunk,
  type AiStepReply,
  type AiStepRequest,
  type AiToolResult,
} from '../ai-tool-calls';
import type { AssistantLimits } from './limits';
import type { AssistantToolbox } from './tools';

/** The most earlier exchanges a question carries, newest kept. */
const HISTORY_EXCHANGES = 10;

/** The most characters of one earlier answer a question carries. */
const HISTORY_ANSWER_CHARS = 4000;

/**
 * A conversation's earlier exchanges as model messages: each question with its
 * answer, the latest {@link HISTORY_EXCHANGES}. A question whose answer failed
 * is left out with it; tool results are not carried, the model calls again.
 */
export function assistantHistory(messages: readonly AssistantMessageView[]): AiChatMessage[] {
  const pairs: AiChatMessage[][] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const question = messages[i]!;
    const answer = messages[i + 1]!;
    if (question.role !== 'user' || answer.role !== 'assistant') continue;
    const text = assistantMessageText(answer.blocks);
    if (answer.status !== 'completed' || !text) continue;
    pairs.push([
      { role: 'user', text: assistantMessageText(question.blocks) },
      { role: 'assistant', text: text.slice(0, HISTORY_ANSWER_CHARS) },
    ]);
  }
  return pairs.slice(-HISTORY_EXCHANGES).flat();
}

export interface AssistantTurnOptions {
  role: ResolvedAiRole;
  system: string;
  history: AiChatMessage[];
  question: string;
  toolbox: AssistantToolbox;
  limits: Pick<AssistantLimits, 'maxToolCalls' | 'maxOutputTokens' | 'turnTimeoutMs'>;
  /** Tokens the daily caps leave for this turn, null when uncapped, and the message that names the cap reached. */
  allowance: { remaining: number | null; message: string };
  emit: (event: AssistantEvent) => void;
  /** One model call; the provider's tool calling by default. */
  step?: (role: ResolvedAiRole, req: AiStepRequest) => AsyncGenerator<AiStepChunk>;
}

export interface AssistantTurnResult {
  status: 'completed' | 'failed';
  text: string;
  toolCalls: AssistantToolCall[];
  provider: string;
  model: string | null;
  toolMode: AssistantToolMode | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  error: { code: AssistantErrorCode; message: string } | null;
  durationMs: number;
}

const plus = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

export async function runAssistantTurn(opts: AssistantTurnOptions): Promise<AssistantTurnResult> {
  const started = Date.now();
  const step = opts.step ?? toolStep;
  const { maxToolCalls, maxOutputTokens, turnTimeoutMs } = opts.limits;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('turn timeout')), turnTimeoutMs);

  const messages: AiChatMessage[] = [...opts.history, { role: 'user', text: opts.question }];
  const toolCalls: AssistantToolCall[] = [];
  const usage = {
    model: null as string | null,
    toolMode: null as AssistantToolMode | null,
    inputTokens: null as number | null,
    outputTokens: null as number | null,
    costUsd: null as number | null,
  };
  let text = '';
  let breakBeforeText = false;
  let callsMade = 0;
  let retriedInvalid = false;
  let toolChoice: 'auto' | 'none' = 'auto';

  const write = (delta: string) => {
    if (!delta) return;
    if (breakBeforeText) {
      breakBeforeText = false;
      text += '\n\n';
      opts.emit({ event: 'text', data: { text: '\n\n' } });
    }
    text += delta;
    opts.emit({ event: 'text', data: { text: delta } });
  };

  const finish = (error: AssistantTurnResult['error']): AssistantTurnResult => {
    clearTimeout(timer);
    const result: AssistantTurnResult = {
      status: error ? 'failed' : 'completed',
      text,
      toolCalls,
      provider: opts.role.provider,
      ...usage,
      error,
      durationMs: Date.now() - started,
    };
    if (error) opts.emit({ event: 'error', data: { ...error, messageId: null } });
    else {
      opts.emit({
        event: 'done',
        data: {
          messageId: null,
          provider: result.provider,
          model: result.model,
          toolMode: result.toolMode,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
        },
      });
    }
    return result;
  };

  const toolLimitMessage = `This question reached the limit of ${maxToolCalls} tool calls (PIWI_AI_ASSISTANT_MAX_TOOL_CALLS).`;

  try {
    while (true) {
      const spent = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      if (opts.allowance.remaining !== null && spent >= opts.allowance.remaining) {
        return finish({ code: 'limit', message: opts.allowance.message });
      }

      let streamed = false;
      let reply: AiStepReply | null = null;
      for await (const chunk of step(opts.role, {
        system: opts.system,
        messages,
        tools: opts.toolbox.definitions(),
        toolChoice,
        maxTokens: maxOutputTokens,
        signal: controller.signal,
      })) {
        if (chunk.type === 'text') {
          streamed = true;
          write(chunk.text);
        } else reply = chunk.reply;
      }
      if (!reply) throw new Error('The model sent no reply');

      usage.model = reply.model || usage.model;
      usage.toolMode = reply.mode;
      usage.inputTokens = plus(usage.inputTokens, reply.inputTokens);
      usage.outputTokens = plus(usage.outputTokens, reply.outputTokens);
      usage.costUsd = reply.costUsd === null ? usage.costUsd : (usage.costUsd ?? 0) + reply.costUsd;

      if (reply.invalidReply) {
        if (retriedInvalid) {
          return finish({
            code: 'invalid-reply',
            message: `The model's reply could not be read: ${reply.invalidReply}`,
          });
        }
        retriedInvalid = true;
        messages.push(
          { role: 'assistant', text: reply.text },
          {
            role: 'user',
            text: `Your last reply could not be read: ${reply.invalidReply} Reply again with exactly one JSON object.`,
          },
        );
        continue;
      }

      // The JSON action mode's answer arrives whole rather than streamed.
      if (!streamed) write(reply.text);

      if (reply.truncated) {
        return finish({
          code: 'limit',
          message: `The answer reached the limit of ${maxOutputTokens} output tokens for one model call (PIWI_AI_ASSISTANT_MAX_OUTPUT_TOKENS).`,
        });
      }
      if (reply.toolCalls.length === 0) {
        return text.trim() ? finish(null) : finish({ code: 'provider', message: 'The model returned an empty answer' });
      }
      if (toolChoice === 'none') return finish({ code: 'limit', message: toolLimitMessage });

      messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls });
      const results: AiToolResult[] = [];
      for (const call of reply.toolCalls) {
        if (callsMade >= maxToolCalls) {
          results.push({
            callId: call.id,
            name: call.name,
            content: `Not run: ${toolLimitMessage} Answer with what the results so far show, and say what is missing.`,
            isError: true,
          });
          continue;
        }
        if (controller.signal.aborted) throw controller.signal.reason;
        callsMade++;
        const outcome = await opts.toolbox.run(call);
        toolCalls.push(outcome.record);
        opts.emit({ event: 'tool', data: { name: outcome.record.name, summary: outcome.record.summary } });
        results.push({ callId: call.id, name: call.name, content: outcome.content, isError: outcome.isError });
      }
      messages.push({ role: 'tool', results });
      if (callsMade >= maxToolCalls) toolChoice = 'none';
      if (text) breakBeforeText = true;
    }
  } catch (err) {
    if (controller.signal.aborted) {
      return finish({
        code: 'timeout',
        message: `The answer took longer than ${Math.round(turnTimeoutMs / 1000)} seconds (PIWI_AI_ASSISTANT_TURN_TIMEOUT_SECONDS).`,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    return finish({ code: 'provider', message: `[${opts.role.provider}] ${message.slice(0, 500)}` });
  }
}
