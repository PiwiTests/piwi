/**
 * Model calls with tools, one step of a multi-turn conversation at a time: the
 * conversation so far and the tools in, the streamed text and the tool calls
 * out. Anthropic uses its native tool use and OpenAI-compatible servers their
 * `tools` / `tool_calls`, both streamed. A server that refuses tools, and the
 * Claude Code CLI, use the JSON action mode: each reply is one JSON object,
 * either a tool call or the answer, asked for through the single-shot
 * `callAiProvider` and its JSON-schema ladder.
 */
import type Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_ANTHROPIC_MODEL,
  anthropicClient,
  callAiProvider,
  postOpenAiWithFallbacks,
  type OpenAiAttempt,
} from './ai-provider';
import type { ResolvedAiRole } from '~~/types/api';
import type { AssistantToolMode } from '#shared/assistant';

export interface AiToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** The raw arguments when they were not a JSON object; the call is answered with an error instead of run. */
  invalidArguments?: string;
}

export interface AiToolResult {
  callId: string;
  name: string;
  content: string;
  isError: boolean;
}

export type AiChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: AiToolCall[] }
  | { role: 'tool'; results: AiToolResult[] };

export interface AiStepRequest {
  system: string;
  messages: AiChatMessage[];
  tools: AiToolDef[];
  /** `none` asks for an answer with no further tool call. */
  toolChoice: 'auto' | 'none';
  maxTokens: number;
  signal?: AbortSignal;
}

export interface AiStepReply {
  text: string;
  toolCalls: AiToolCall[];
  model: string;
  mode: AssistantToolMode;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** The reply stopped at the output-token limit. */
  truncated: boolean;
  /** JSON action mode: why the reply was not one valid action, when it was not. */
  invalidReply?: string;
}

export type AiStepChunk = { type: 'text'; text: string } | { type: 'reply'; reply: AiStepReply };

/** An OpenAI-compatible server refused the `tools` parameter. */
export class ToolsUnsupportedError extends Error {}

/** How long one model call may take, as the single-shot calls allow. */
const CALL_TIMEOUT_MS = 120_000;

const EPHEMERAL = { type: 'ephemeral' } as const;

// ── Anthropic ─────────────────────────────────────────────────────────────────

type AnthropicBlock = Anthropic.Messages.ContentBlockParam;

function anthropicMessages(messages: AiChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = messages.map((m): Anthropic.MessageParam => {
    if (m.role === 'user') return { role: 'user', content: [{ type: 'text', text: m.text }] };
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: m.results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.callId,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      };
    }
    const content: AnthropicBlock[] = m.text ? [{ type: 'text', text: m.text }] : [];
    for (const call of m.toolCalls ?? []) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
    }
    return { role: 'assistant', content };
  });
  // A breakpoint on the newest block caches the conversation for the turn's next step.
  const last = out.at(-1)?.content;
  if (Array.isArray(last) && last.length > 0) {
    last[last.length - 1] = { ...last[last.length - 1], cache_control: EPHEMERAL } as AnthropicBlock;
  }
  return out;
}

/**
 * Request params for one step. The tool definitions and the system prompt are
 * the stable prefix of every step and carry a cache breakpoint each, as the
 * diagnosis context does; no sampling params, which current Claude models reject.
 */
export function buildAnthropicToolParams(
  config: ResolvedAiRole,
  req: AiStepRequest,
): Anthropic.Messages.MessageCreateParamsStreaming {
  const tools: Anthropic.Messages.Tool[] = req.tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
    ...(i === req.tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
  }));
  return {
    model: config.model || DEFAULT_ANTHROPIC_MODEL,
    max_tokens: req.maxTokens,
    system: [{ type: 'text', text: req.system, cache_control: EPHEMERAL }],
    messages: anthropicMessages(req.messages),
    ...(tools.length > 0 ? { tools, tool_choice: { type: req.toolChoice } } : {}),
    stream: true,
  };
}

async function* anthropicStep(config: ResolvedAiRole, req: AiStepRequest): AsyncGenerator<AiStepChunk> {
  const client = await anthropicClient(config);
  const stream = client.messages.stream(buildAnthropicToolParams(config, req), { signal: req.signal });
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield { type: 'text', text: event.delta.text };
    }
  }
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('The model declined to answer');
  const toolCalls: AiToolCall[] = [];
  let text = '';
  for (const block of msg.content) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, arguments: (block.input ?? {}) as Record<string, unknown> });
    }
  }
  yield {
    type: 'reply',
    reply: {
      text,
      toolCalls,
      model: msg.model,
      mode: 'native',
      inputTokens: msg.usage?.input_tokens ?? null,
      outputTokens: msg.usage?.output_tokens ?? null,
      costUsd: null,
      truncated: msg.stop_reason === 'max_tokens',
    },
  };
}

// ── OpenAI-compatible ─────────────────────────────────────────────────────────

type OpenAiMessage = Record<string, unknown>;

function openAiMessages(system: string, messages: AiChatMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'tool') {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.callId, content: r.content });
    } else {
      const calls = m.toolCalls ?? [];
      out.push({
        role: 'assistant',
        content: m.text || null,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.invalidArguments ?? JSON.stringify(c.arguments) },
              })),
            }
          : {}),
      });
    }
  }
  return out;
}

/** The chat-completions body of one streamed step with tools. */
export function buildOpenAiToolBody(
  config: ResolvedAiRole,
  req: AiStepRequest,
  attempt: OpenAiAttempt,
): Record<string, unknown> {
  return {
    model: config.model,
    [attempt.completionTokenParameter]: req.maxTokens,
    ...(config.temperature != null ? { temperature: config.temperature } : {}),
    messages: openAiMessages(req.system, req.messages),
    ...(req.tools.length > 0
      ? {
          tools: req.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
          tool_choice: req.toolChoice,
        }
      : {}),
    stream: true,
    stream_options: { include_usage: true },
  };
}

/** What a server calls tools: the parameter, tool use, calling or choice, function calling. */
const TOOLS = String.raw`(?:tools?|tool[ _-]?(?:use|calling|choice)|functions?(?:[ _-]?calling)?)`;

/**
 * The ways a server says it takes no tools at all: "does not support tools",
 * "Function calling is not enabled", "Unrecognized request argument supplied:
 * tools", "tool choice requires --enable-auto-tool-choice"; not a 400 about
 * one tool's schema or a tool call's id.
 */
const TOOLS_UNSUPPORTED = new RegExp(
  [
    String.raw`\b(?:does not|doesn't|do not|don't|cannot|can't)\s+support\s+${TOOLS}\b`,
    String.raw`\b${TOOLS}\b['"\`]?\s+(?:is|are)(?:\s+currently)?\s+not\s+(?:supported|enabled|available|allowed)\b`,
    String.raw`\b(?:unsupported|unrecognized|unknown)\s+(?:request\s+)?(?:argument|parameter|field)s?\b[^.]{0,30}?\b(?:tools|tool_choice|functions)\b`,
    String.raw`\b${TOOLS}\b[^.]{0,40}?\brequires\s+--`,
  ].join('|'),
  'i',
);

/** A 400 saying the server or the model does not take tools. */
function rejectsTools(status: number, body: string): boolean {
  return status === 400 && TOOLS_UNSUPPORTED.test(body);
}

/** The arguments of a streamed tool call, or why they are not a JSON object. */
function parseToolArguments(raw: string): { arguments: Record<string, unknown>; invalid?: string } {
  if (!raw.trim()) return { arguments: {} };
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { arguments: value as Record<string, unknown> };
    }
  } catch {
    // Reported below.
  }
  return { arguments: {}, invalid: raw.slice(0, 2000) };
}

type OpenAiUsage = { prompt_tokens?: number; completion_tokens?: number };

interface OpenAiStreamChunk {
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAiUsage;
  x_groq?: { usage?: OpenAiUsage };
}

async function* openAiStep(config: ResolvedAiRole, req: AiStepRequest): AsyncGenerator<AiStepChunk> {
  const url = `${(config.baseUrl || '').replace(/\/$/, '')}/chat/completions`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey) headers['authorization'] = `Bearer ${config.apiKey}`;
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;

  const { res, errorBody } = await postOpenAiWithFallbacks(
    (attempt) =>
      fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildOpenAiToolBody(config, req, attempt)),
        signal,
      }),
    { system: '', user: '' },
    config.model,
  );
  if (!res.ok) {
    if (req.tools.length > 0 && rejectsTools(res.status, errorBody)) {
      throw new ToolsUnsupportedError(`${config.model} refused tools: ${errorBody.slice(0, 200)}`);
    }
    throw new Error(`openai provider returned HTTP ${res.status}: ${errorBody.slice(0, 300)}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Response body is not readable');

  const decoder = new TextDecoder();
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let buffer = '';
  let text = '';
  let model = config.model;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6).trim();
      if (data === '[DONE]') continue;
      let parsed: OpenAiStreamChunk;
      try {
        parsed = JSON.parse(data) as OpenAiStreamChunk;
      } catch {
        continue;
      }
      if (parsed.model) model = parsed.model;
      // Groq reports a stream's usage under `x_groq.usage`, not `usage`.
      const usage = parsed.usage ?? parsed.x_groq?.usage;
      if (usage?.prompt_tokens != null) inputTokens = usage.prompt_tokens;
      if (usage?.completion_tokens != null) outputTokens = usage.completion_tokens;
      const choice = parsed.choices?.[0];
      if (choice?.finish_reason === 'length') truncated = true;
      if (choice?.delta?.content) {
        text += choice.delta.content;
        yield { type: 'text', text: choice.delta.content };
      }
      for (const delta of choice?.delta?.tool_calls ?? []) {
        const index = delta.index ?? 0;
        const call = calls.get(index) ?? { id: '', name: '', args: '' };
        if (delta.id) call.id = delta.id;
        if (delta.function?.name) call.name += delta.function.name;
        if (delta.function?.arguments) call.args += delta.function.arguments;
        calls.set(index, call);
      }
    }
  }

  const toolCalls: AiToolCall[] = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, c]) => c.name)
    .map(([index, c]) => {
      const parsed = parseToolArguments(c.args);
      return {
        id: c.id || `call_${index}`,
        name: c.name,
        arguments: parsed.arguments,
        ...(parsed.invalid !== undefined ? { invalidArguments: parsed.invalid } : {}),
      };
    });
  yield {
    type: 'reply',
    reply: { text, toolCalls, model, mode: 'native', inputTokens, outputTokens, costUsd: null, truncated },
  };
}

// ── JSON action mode ──────────────────────────────────────────────────────────

/** The schema of one JSON action: a tool call, or the answer. */
const JSON_ACTION_SCHEMA = {
  type: 'object',
  properties: {
    tool: { type: 'string', description: 'The tool to call' },
    arguments: { type: 'object', description: "The tool's arguments" },
    answer: { type: 'string', description: 'The final answer, in Markdown' },
  },
};

export type JsonAction =
  | { kind: 'answer'; text: string }
  | { kind: 'tool'; name: string; arguments: Record<string, unknown> }
  | { kind: 'invalid'; reason: string };

/** A reply that is one fenced block, and what it holds. */
const WHOLE_FENCE = /^```[a-z]*[ \t]*\n([\s\S]*?)\n?```$/i;

/** A fenced JSON object in a reply. */
const FENCED_OBJECT = /```(?:json)?[ \t]*\n(\{[\s\S]*?\})[ \t]*\n?```/gi;

/**
 * Read one JSON action from a reply: `{ "tool": name, "arguments": {...} }` or
 * `{ "answer": "markdown" }`. The reply is an action when it is that one
 * object, bare or in a Markdown fence, or when prose holds it in a fence of
 * its own; any other reply is prose, taken as the answer, braces and JSON
 * snippets in it included.
 */
export function parseJsonAction(raw: string): JsonAction {
  const text = raw.trim();
  if (!text) return { kind: 'invalid', reason: 'The reply was empty.' };
  const whole = (WHOLE_FENCE.exec(text)?.[1] ?? text).trim();
  if (whole.startsWith('{')) return readJsonAction(whole);
  for (const [, fenced] of text.matchAll(FENCED_OBJECT)) {
    const action = readJsonAction(fenced!);
    if (action.kind !== 'invalid') return action;
  }
  return { kind: 'answer', text };
}

/** One JSON object read as an action, or why it is not one. */
function readJsonAction(json: string): JsonAction {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { kind: 'invalid', reason: 'The reply was not valid JSON.' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'invalid', reason: 'The reply was not a JSON object.' };
  }
  const action = value as { tool?: unknown; arguments?: unknown; answer?: unknown };
  const hasTool = typeof action.tool === 'string' && action.tool.trim() !== '';
  const hasAnswer = typeof action.answer === 'string' && action.answer.trim() !== '';
  if (hasTool && hasAnswer) return { kind: 'invalid', reason: 'The reply had both "tool" and "answer"; send one.' };
  if (hasAnswer) return { kind: 'answer', text: (action.answer as string).trim() };
  if (!hasTool) return { kind: 'invalid', reason: 'The reply had neither "tool" nor "answer".' };
  const args = action.arguments ?? {};
  if (typeof args !== 'object' || Array.isArray(args) || args === null) {
    return { kind: 'invalid', reason: '"arguments" must be a JSON object.' };
  }
  return { kind: 'tool', name: (action.tool as string).trim(), arguments: args as Record<string, unknown> };
}

function jsonActionSystem(req: AiStepRequest): string {
  const tools = req.tools
    .map((t) => `- ${t.name}: ${t.description}\n  arguments: ${JSON.stringify(t.inputSchema)}`)
    .join('\n');
  return `${req.system}

## How to reply
Every reply is exactly one JSON object and nothing else:
- {"tool": "<tool name>", "arguments": {...}} calls one tool; its result comes back in the next message.
- {"answer": "<Markdown>"} is your final answer to the user.

## Tools
${tools || '(none)'}`;
}

function jsonActionTranscript(req: AiStepRequest): string {
  const parts: string[] = [];
  for (const m of req.messages) {
    if (m.role === 'user') parts.push(`### User\n${m.text}`);
    else if (m.role === 'assistant') {
      if (m.text) parts.push(`### Assistant\n${m.text}`);
      for (const c of m.toolCalls ?? []) {
        parts.push(`### Assistant (tool call)\n${JSON.stringify({ tool: c.name, arguments: c.arguments })}`);
      }
    } else {
      for (const r of m.results) {
        parts.push(
          `### Tool result (${r.name}${r.isError ? ', error' : ''})\n<tool_result name="${r.name}">\n${r.content}\n</tool_result>`,
        );
      }
    }
  }
  const ask =
    req.toolChoice === 'none'
      ? 'Reply now with {"answer": "..."}: no further tool call.'
      : 'Reply with one JSON object: a tool call, or your answer.';
  return `${parts.join('\n\n')}\n\n${ask}`;
}

/** Wait for `promise`, or reject as soon as `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** One step in the JSON action mode, through the single-shot call of any provider. */
export async function jsonActionStep(config: ResolvedAiRole, req: AiStepRequest): Promise<AiStepReply> {
  const result = await abortable(
    callAiProvider(config, {
      system: jsonActionSystem(req),
      user: jsonActionTranscript(req),
      jsonSchema: JSON_ACTION_SCHEMA,
      maxTokens: req.maxTokens,
    }),
    req.signal,
  );
  const action = parseJsonAction(result.text);
  const base = {
    model: result.model,
    mode: 'json-action' as const,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd ?? null,
    truncated: false,
  };
  if (action.kind === 'answer') return { ...base, text: action.text, toolCalls: [] };
  if (action.kind === 'tool') {
    const id = `action_${req.messages.length}`;
    return { ...base, text: '', toolCalls: [{ id, name: action.name, arguments: action.arguments }] };
  }
  return { ...base, text: result.text, toolCalls: [], invalidReply: action.reason };
}

// ── Choosing the mode ─────────────────────────────────────────────────────────

/** What an OpenAI-compatible model's calls showed, per endpoint and model, since the server started. */
const learnedModes = new Map<string, AssistantToolMode>();

const modeKey = (config: ResolvedAiRole) => `${config.baseUrl ?? ''}\u0000${config.model}`;

/**
 * How a role's model calls tools, when known: natively for Anthropic, in the
 * JSON action mode for the Claude Code CLI, and for an OpenAI-compatible model
 * whatever its first call showed.
 */
export function knownToolMode(config: ResolvedAiRole): AssistantToolMode | null {
  if (config.provider === 'anthropic') return 'native';
  if (config.provider === 'claude-cli') return 'json-action';
  return learnedModes.get(modeKey(config)) ?? null;
}

/**
 * One step with tools in the model's mode. An OpenAI-compatible server that
 * refuses tools is asked again in the JSON action mode, and remembered for the
 * steps that follow.
 */
export async function* toolStep(config: ResolvedAiRole, req: AiStepRequest): AsyncGenerator<AiStepChunk> {
  const mode = knownToolMode(config);
  if (mode === 'json-action') {
    yield { type: 'reply', reply: await jsonActionStep(config, req) };
    return;
  }
  if (config.provider === 'anthropic') {
    yield* anthropicStep(config, req);
    return;
  }
  try {
    yield* openAiStep(config, req);
    learnedModes.set(modeKey(config), 'native');
  } catch (err) {
    if (!(err instanceof ToolsUnsupportedError)) throw err;
    console.warn(`[ai-tool-calls] ${err.message} — using the JSON action mode`);
    learnedModes.set(modeKey(config), 'json-action');
    yield { type: 'reply', reply: await jsonActionStep(config, req) };
  }
}
