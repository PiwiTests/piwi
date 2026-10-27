/**
 * The answer one assistant turn writes, whichever way the model is driven:
 * step by step (`loop.ts`) or by the Claude Code CLI, which calls the tools
 * itself (`claude-code.ts`). It holds the answer's blocks in the order they
 * were written and the read calls made, runs each tool call through the
 * toolbox, and emits the events as it goes: `text`, `tool`, `block`, then
 * `done` or `error`.
 *
 * Read calls past `maxToolCalls` are refused with a result telling the model
 * to answer with what it has; block tools make the answer and do not count. A
 * question or options block ends the answer: nothing is added after it. So
 * does the next question, which is refused until the answer holds something.
 */
import type {
  AssistantBlock,
  AssistantErrorCode,
  AssistantEvent,
  AssistantToolCall,
  AssistantToolMode,
} from '#shared/assistant';
import { assistantMessageText } from '#shared/assistant';
import { endsAssistantAnswer } from '#shared/assistant-blocks';
import type { AiToolCall, AiToolResult } from '../ai-tool-calls';
import type { AssistantToolbox } from './tools';

export interface AssistantTurnResult {
  status: 'completed' | 'failed';
  /** The answer's blocks in the order they were written: its text, and the blocks between. */
  blocks: AssistantBlock[];
  /** The answer's text blocks, joined. */
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

/** What a turn's model calls spent, added up. */
export interface AssistantTurnUsage {
  model: string | null;
  toolMode: AssistantToolMode | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

/** The error of a turn past its time limit. */
export function turnTimeoutError(turnTimeoutMs: number): NonNullable<AssistantTurnResult['error']> {
  return {
    code: 'timeout',
    message: `The answer took longer than ${Math.round(turnTimeoutMs / 1000)} seconds (PIWI_AI_ASSISTANT_TURN_TIMEOUT_SECONDS).`,
  };
}

/** The error of a turn the user stopped. */
export function turnStoppedError(): NonNullable<AssistantTurnResult['error']> {
  return { code: 'stopped', message: 'You stopped this answer.' };
}

export function createAssistantAnswer(opts: {
  toolbox: AssistantToolbox;
  maxToolCalls: number;
  provider: string;
  emit: (event: AssistantEvent) => void;
}) {
  const started = Date.now();
  const blocks: AssistantBlock[] = [];
  const toolCalls: AssistantToolCall[] = [];
  let breakBeforeText = false;
  let reads = 0;
  let ended = false;
  const hasContent = () => blocks.some((b) => b.kind !== 'text' || b.text.trim());

  const limitMessage = `This question reached the limit of ${opts.maxToolCalls} tool calls (PIWI_AI_ASSISTANT_MAX_TOOL_CALLS).`;

  return {
    blocks,
    toolCalls,
    /** The message of a turn stopped by the tool-call limit. */
    limitMessage,
    /** Whether a question or options block ended the answer. */
    get ended() {
      return ended;
    },
    /** Read calls the limit still allows. */
    get readsLeft() {
      return opts.maxToolCalls - reads;
    },

    /** Text continues the answer's last text block, after a paragraph break when a tool call came between. */
    write(delta: string) {
      if (!delta || ended) return;
      const last = blocks.at(-1);
      if (last?.kind !== 'text') blocks.push({ kind: 'text', text: delta });
      else {
        if (breakBeforeText) {
          last.text += '\n\n';
          opts.emit({ event: 'text', data: { text: '\n\n' } });
        }
        last.text += delta;
      }
      breakBeforeText = false;
      opts.emit({ event: 'text', data: { text: delta } });
    },

    /** Run one tool call: refused once the answer ended or past the read limit, else run and its record and block written. */
    async call(call: AiToolCall): Promise<AiToolResult> {
      const result = (content: string, isError: boolean): AiToolResult => ({
        callId: call.id,
        name: call.name,
        content,
        isError,
      });
      if (ended) return result('Not run: your answer has ended. Stop here.', true);
      if (call.name === 'suggest_next' && !hasContent()) {
        return result('Not shown: write your answer first, then suggest the next question last.', true);
      }
      const isBlock = opts.toolbox.isBlockTool(call.name);
      if (!isBlock && reads >= opts.maxToolCalls) {
        return result(
          `Not run: ${limitMessage} Answer with what the results so far show, and say what is missing.`,
          true,
        );
      }
      if (!isBlock) reads++;
      const outcome = await opts.toolbox.run(call);
      if (outcome.record) {
        toolCalls.push(outcome.record);
        const { name, summary, entities } = outcome.record;
        opts.emit({ event: 'tool', data: { name, summary, ...(entities?.length ? { entities } : {}) } });
      }
      // A call run alongside the one that ended the answer.
      if (outcome.block && ended) return result('Not shown: your answer has ended. Stop here.', true);
      if (outcome.block) {
        blocks.push(outcome.block);
        opts.emit({ event: 'block', data: { block: outcome.block } });
        if (endsAssistantAnswer(outcome.block)) ended = true;
      }
      return result(outcome.content, outcome.isError);
    },

    /** After a step's tool results: the next text starts a new paragraph. */
    afterTools() {
      if (blocks.at(-1)?.kind === 'text') breakBeforeText = true;
    },

    /** Whether anything but blank text was written. */
    answered(): boolean {
      return hasContent();
    },

    /** The turn's result, with its `done` or `error` event. */
    finish(error: AssistantTurnResult['error'], usage: AssistantTurnUsage): AssistantTurnResult {
      const turn: AssistantTurnResult = {
        status: error ? 'failed' : 'completed',
        blocks,
        text: assistantMessageText(blocks),
        toolCalls,
        provider: opts.provider,
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
            provider: turn.provider,
            model: turn.model,
            toolMode: turn.toolMode,
            inputTokens: turn.inputTokens,
            outputTokens: turn.outputTokens,
            costUsd: turn.costUsd,
          },
        });
      }
      return turn;
    },
  };
}
