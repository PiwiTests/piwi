/**
 * One assistant turn: the system prompt, the conversation so far and the new
 * question go to the model with the offered tools; each tool call it makes is
 * run and its result handed back, until it answers or a limit stops it. The
 * turn emits its events as it goes (`text`, `tool`, `block`, then `done` or
 * `error`) and returns what to store: the answer's blocks in the order they
 * were written. A question or options block ends the answer, with the text
 * written before it.
 *
 * Limits: at most `maxToolCalls` read tool calls, after which the model is
 * asked to answer with what it has (block tools make the answer and do not
 * count); `maxOutputTokens` per model call; `turnTimeoutMs` for the whole
 * turn; and the tokens the daily caps leave, checked before each model call.
 */
import type { AssistantBlock, AssistantEvent, AssistantMessageView, AssistantProposalStatus } from '#shared/assistant';
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
import { createAssistantAnswer, turnTimeoutError, type AssistantTurnResult, type AssistantTurnUsage } from './answer';
import type { AssistantLimits } from './limits';
import type { AssistantToolbox } from './tools';

/** The most earlier exchanges a question carries, newest kept. */
const HISTORY_EXCHANGES = 10;

/** The most characters of one earlier answer a question carries. */
const HISTORY_ANSWER_CHARS = 4000;

/** What became of a proposal, as the history says it. */
const PROPOSAL_OUTCOMES: Record<AssistantProposalStatus, string> = {
  applied: 'the user applied it',
  dismissed: 'the user dismissed it',
  failed: 'applying it failed',
};

/** A block other than text, in a line the model reads in the history: what it showed, and the user's pick. */
function blockLine(block: AssistantBlock): string {
  switch (block.kind) {
    case 'text':
      return block.text;
    case 'question': {
      const picked = block.answer
        ? [
            ...block.choices.filter((c) => block.answer!.choiceIds.includes(c.id)).map((c) => c.label),
            ...(block.answer.other ? [`Other: ${block.answer.other}`] : []),
          ]
        : [];
      const choices = block.choices.map((c) => c.label).join(' / ');
      return `[Asked: ${block.prompt} (${choices})${picked.length ? `; the user picked: ${picked.join('; ')}` : ''}]`;
    }
    case 'options': {
      const picked = block.options.find((o) => o.id === block.picked);
      const options = block.options.map((o) => o.title).join(' / ');
      return `[Offered: ${block.prompt} (${options})${picked ? `; the user picked: ${picked.title}` : ''}]`;
    }
    case 'checklist':
      return `[Checklist: ${block.title}: ${block.steps.map((s) => `${s.done ? '[x]' : '[ ]'} ${s.text}`).join('; ')}]`;
    case 'guide':
      return `[Guide: ${block.guide.title}]`;
    case 'command':
      return `[Command: ${block.command.bash}]`;
    case 'code':
      return `[Code${block.title ? `: ${block.title}` : ''}]`;
    case 'patch':
      return `[Patch${block.title ? `: ${block.title}` : ''}]`;
    case 'entity':
      return `[Card: ${block.entity.label}]`;
    case 'navigate':
      return `[Link: ${block.label} (${block.route})]`;
    case 'proposal': {
      const on = block.target ? ` on ${block.target.label}` : '';
      const failure = block.outcome?.status === 'failed' && block.outcome.result ? `: ${block.outcome.result}` : '';
      const outcome = block.outcome ? `${PROPOSAL_OUTCOMES[block.outcome.status]}${failure}` : 'not applied yet';
      return `[Proposed: ${block.title} (${block.action}${on}); ${outcome}]`;
    }
  }
}

/** An earlier answer as the model reads it: its text, each other block in one line. */
function historyAnswer(blocks: readonly AssistantBlock[]): string {
  return blocks
    .map(blockLine)
    .filter((line) => line.trim())
    .join('\n\n');
}

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
    const text = historyAnswer(answer.blocks);
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

const plus = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

export async function runAssistantTurn(opts: AssistantTurnOptions): Promise<AssistantTurnResult> {
  const step = opts.step ?? toolStep;
  const { maxToolCalls, maxOutputTokens, turnTimeoutMs } = opts.limits;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('turn timeout')), turnTimeoutMs);

  const messages: AiChatMessage[] = [...opts.history, { role: 'user', text: opts.question }];
  const usage: AssistantTurnUsage = {
    model: null,
    toolMode: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
  const answer = createAssistantAnswer({
    toolbox: opts.toolbox,
    maxToolCalls,
    provider: opts.role.provider,
    emit: opts.emit,
  });
  let retriedInvalid = false;
  let toolChoice: 'auto' | 'none' = 'auto';

  const finish = (error: AssistantTurnResult['error']): AssistantTurnResult => {
    clearTimeout(timer);
    return answer.finish(error, usage);
  };

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
          answer.write(chunk.text);
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
      if (!streamed) answer.write(reply.text);

      if (reply.truncated) {
        return finish({
          code: 'limit',
          message: `The answer reached the limit of ${maxOutputTokens} output tokens for one model call (PIWI_AI_ASSISTANT_MAX_OUTPUT_TOKENS).`,
        });
      }
      if (reply.toolCalls.length === 0) {
        return answer.answered()
          ? finish(null)
          : finish({ code: 'provider', message: 'The model returned an empty answer' });
      }
      if (toolChoice === 'none') return finish({ code: 'limit', message: answer.limitMessage });

      messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls });
      const results: AiToolResult[] = [];
      for (const call of reply.toolCalls) {
        if (controller.signal.aborted) throw controller.signal.reason;
        results.push(await answer.call(call));
        if (answer.ended) return finish(null);
      }
      messages.push({ role: 'tool', results });
      if (answer.readsLeft <= 0) toolChoice = 'none';
      answer.afterTools();
    }
  } catch (err) {
    if (controller.signal.aborted) return finish(turnTimeoutError(turnTimeoutMs));
    const message = err instanceof Error ? err.message : String(err);
    return finish({ code: 'provider', message: `[${opts.role.provider}] ${message.slice(0, 500)}` });
  }
}
