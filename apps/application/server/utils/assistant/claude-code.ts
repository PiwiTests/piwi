/**
 * One assistant turn run by the Claude Code CLI, when the installed CLI can
 * (`claudeCliRunsAgents`): a single `claude -p` calls the model and the tools
 * itself. Its one MCP server is the turn's endpoint (`turn-mcp.ts`), which
 * serves the turn's toolbox, authenticated by a token minted for the asking
 * user, the conversation and the turn and revoked when the turn ends
 * (`turn-token.ts`); its tools are the only ones it may call. The endpoint's
 * calls go through the same answer as the step-by-step loop's (`answer.ts`):
 * the same `tool` and `block` events, the same tool-call limit, and nothing
 * added after a question or options block. The CLI's text streams as `text`
 * events; its usage and cost come with `done`.
 *
 * Limits: the read-call limit at the endpoint, and `--max-turns`
 * ({@link claudeCodeMaxTurns}) behind it; the turn's time limit, after which
 * the CLI is killed; the tokens the daily caps leave, checked before the run.
 */
import { ASSISTANT_BLOCK_LIMITS } from '#shared/assistant-blocks';
import type { AiChatMessage } from '../ai-tool-calls';
import { runClaudeCliAgent } from '../ai-claude-cli';
import { createAssistantAnswer, turnTimeoutError, type AssistantTurnResult, type AssistantTurnUsage } from './answer';
import type { AssistantTurnOptions } from './loop';
import { mintAssistantTurnToken } from './turn-token';

/**
 * The model turns of a run: one per read tool call the limit allows, one per
 * block an answer can hold (each card, question, checklist or guide is a call
 * of its own), one for a block call fixed after its check refused it, and one
 * for the answer.
 */
export function claudeCodeMaxTurns(maxToolCalls: number): number {
  return maxToolCalls + ASSISTANT_BLOCK_LIMITS.maxBlocks + 2;
}

/** How long a turn's token outlives its time limit, while the killed CLI exits. */
const TOKEN_GRACE_MS = 30_000;

/** The system prompt of a run: the assistant's, and where its tools are. */
export function claudeCodeSystem(system: string): string {
  return `${system}

## Your tools
The tools named here are those of the MCP server "piwi" (find_anchors is mcp__piwi__find_anchors, and so on). They are all the tools you have.`;
}

/** The question as the CLI reads it, after the conversation so far. */
export function claudeCodePrompt(history: readonly AiChatMessage[], question: string): string {
  const earlier = history
    .map((m) => (m.role === 'user' ? `### User\n${m.text}` : m.role === 'assistant' ? `### Assistant\n${m.text}` : ''))
    .filter(Boolean);
  if (earlier.length === 0) return question;
  return `The conversation so far:\n\n${earlier.join('\n\n')}\n\n### User (answer this)\n${question}`;
}

export interface ClaudeCodeTurnOptions extends AssistantTurnOptions {
  conversationId: number;
  /** The asking user's id; null with authentication off. */
  ownerId: number | null;
  /**
   * Where the CLI calls the endpoint: this server on the loopback address,
   * under the app's base path (`assistantLoopbackBaseUrl`).
   */
  baseUrl: string;
  /** The tools the endpoint may come to serve, `find_tools` additions included: the ones the CLI is allowed. */
  allowedTools: readonly string[];
  /** The CLI run; `runClaudeCliAgent` by default. */
  run?: typeof runClaudeCliAgent;
}

export async function runClaudeCodeTurn(opts: ClaudeCodeTurnOptions): Promise<AssistantTurnResult> {
  const { maxToolCalls, turnTimeoutMs } = opts.limits;
  const answer = createAssistantAnswer({
    toolbox: opts.toolbox,
    maxToolCalls,
    provider: opts.role.provider,
    emit: opts.emit,
  });
  const usage: AssistantTurnUsage = {
    model: null,
    toolMode: 'native',
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
  if (opts.allowance.remaining !== null && opts.allowance.remaining <= 0) {
    return answer.finish({ code: 'limit', message: opts.allowance.message }, { ...usage, toolMode: null });
  }

  const turn = mintAssistantTurnToken(
    {
      conversationId: opts.conversationId,
      ownerId: opts.ownerId,
      tools: {
        definitions: () => opts.toolbox.definitions(),
        async call(call) {
          const result = await answer.call(call);
          answer.afterTools();
          return result;
        },
      },
    },
    turnTimeoutMs + TOKEN_GRACE_MS,
  );
  try {
    const run = await (opts.run ?? runClaudeCliAgent)(opts.role, {
      system: claudeCodeSystem(opts.system),
      prompt: claudeCodePrompt(opts.history, opts.question),
      server: { url: `${opts.baseUrl}/api/assistant/conversations/${opts.conversationId}/mcp`, token: turn.token },
      tools: opts.allowedTools,
      maxTurns: claudeCodeMaxTurns(maxToolCalls),
      timeoutMs: turnTimeoutMs,
      onText: (text) => answer.write(text),
    });
    Object.assign(usage, {
      model: run.model || null,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      costUsd: run.costUsd,
    });
    switch (run.outcome) {
      case 'timeout':
        return answer.finish(turnTimeoutError(turnTimeoutMs), usage);
      case 'max-turns':
        return answer.finish({ code: 'limit', message: answer.limitMessage }, usage);
      case 'failed':
        return answer.finish({ code: 'provider', message: `[${opts.role.provider}] ${run.error ?? 'failed'}` }, usage);
      case 'answered':
        return answer.answered()
          ? answer.finish(null, usage)
          : answer.finish({ code: 'provider', message: 'The model returned an empty answer' }, usage);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return answer.finish({ code: 'provider', message: `[${opts.role.provider}] ${message.slice(0, 500)}` }, usage);
  } finally {
    turn.revoke();
  }
}
