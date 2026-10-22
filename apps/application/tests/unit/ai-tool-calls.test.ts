/**
 * Model calls with tools: the OpenAI-compatible streamed tool calls, the step
 * down to the JSON action mode when a server refuses tools, the JSON action
 * parser, and the cache breakpoints of an Anthropic step.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ResolvedAiRole } from '../../types/api';

delete process.env.PIWI_DATABASE_URL;

const { buildAnthropicToolParams, knownToolMode, parseJsonAction, toolStep } =
  await import('../../server/utils/ai-tool-calls');
type AiStepRequest = import('../../server/utils/ai-tool-calls').AiStepRequest;
type AiStepChunk = import('../../server/utils/ai-tool-calls').AiStepChunk;

const role = (model: string): ResolvedAiRole => ({
  provider: 'openai',
  apiKey: 'k',
  model,
  baseUrl: 'https://llm.test/v1',
  temperature: null,
});

const request: AiStepRequest = {
  system: 'You answer questions.',
  messages: [{ role: 'user', text: 'Which projects are there?' }],
  tools: [
    { name: 'list_projects', description: 'List the projects', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'get_run',
      description: 'Get a run',
      inputSchema: { type: 'object', properties: { runId: { type: 'number' } } },
    },
  ],
  toolChoice: 'auto',
  maxTokens: 1024,
};

function sse(events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function json(status: number, body: object): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function collect(gen: AsyncGenerator<AiStepChunk>) {
  const chunks: AiStepChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI-compatible tool calls', () => {
  test('streams the text and accumulates tool-call arguments split across deltas', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sse([
          { model: 'gpt-test', choices: [{ delta: { content: 'Let me look.' } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: 'call_a', function: { name: 'get_run', arguments: '{"run' } }],
                },
              },
            ],
          },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Id": 42}' } }] } }] },
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 120, completion_tokens: 9 },
          },
        ]);
      }),
    );
    const chunks = await collect(toolStep(role('gpt-native'), request));
    expect(chunks[0]).toEqual({ type: 'text', text: 'Let me look.' });
    expect(chunks.at(-1)).toMatchObject({
      type: 'reply',
      reply: {
        text: 'Let me look.',
        toolCalls: [{ id: 'call_a', name: 'get_run', arguments: { runId: 42 } }],
        mode: 'native',
        inputTokens: 120,
        outputTokens: 9,
      },
    });
    expect(bodies[0]).toMatchObject({
      tool_choice: 'auto',
      stream: true,
      tools: [{ type: 'function', function: { name: 'list_projects' } }, { function: { name: 'get_run' } }],
    });
    expect(knownToolMode(role('gpt-native'))).toBe('native');
  });

  test('marks arguments that are not a JSON object instead of guessing them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'get_run', arguments: 'run 42' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    const chunks = await collect(toolStep(role('gpt-sloppy'), request));
    expect(chunks.at(-1)).toMatchObject({
      reply: { toolCalls: [{ id: 'call_0', name: 'get_run', arguments: {}, invalidArguments: 'run 42' }] },
    });
  });

  test('steps down to the JSON action mode when the server refuses tools, and remembers it', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if (body.tools) return json(400, { error: { message: 'This model does not support tools' } });
        return json(200, {
          model: 'small-local',
          choices: [{ message: { content: '{"tool": "get_run", "arguments": {"runId": 7}}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 300, completion_tokens: 20 },
        });
      }),
    );
    const local = role('small-local');
    const chunks = await collect(toolStep(local, request));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: 'reply',
      reply: { mode: 'json-action', text: '', toolCalls: [{ name: 'get_run', arguments: { runId: 7 } }] },
    });
    // The JSON action request names the tools in the system prompt and asks for one JSON object.
    const action = bodies[1] as { messages: Array<{ content: string }>; response_format?: unknown };
    expect(action.response_format).toBeDefined();
    expect(action.messages[0]!.content).toContain('- get_run: Get a run');
    expect(knownToolMode(local)).toBe('json-action');

    // The next step goes straight to the JSON action mode.
    bodies.length = 0;
    await collect(toolStep(local, request));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.tools).toBeUndefined();
  });

  test('another 400 is an error, not a step down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(400, { error: { message: 'Invalid API key' } })),
    );
    await expect(collect(toolStep(role('gpt-bad-key'), request))).rejects.toThrow(/HTTP 400/);
    expect(knownToolMode(role('gpt-bad-key'))).toBeNull();
  });
});

describe('the JSON action mode', () => {
  test('reads a tool call, with or without arguments', () => {
    expect(parseJsonAction('{"tool": "list_projects"}')).toEqual({
      kind: 'tool',
      name: 'list_projects',
      arguments: {},
    });
    expect(parseJsonAction('```json\n{"tool": "get_run", "arguments": {"runId": 3}}\n```')).toEqual({
      kind: 'tool',
      name: 'get_run',
      arguments: { runId: 3 },
    });
  });

  test('reads the answer', () => {
    expect(parseJsonAction('{"answer": "Run **4** failed."}')).toEqual({ kind: 'answer', text: 'Run **4** failed.' });
  });

  test('takes plain prose as the answer', () => {
    expect(parseJsonAction('Run 4 failed on a timeout.')).toEqual({
      kind: 'answer',
      text: 'Run 4 failed on a timeout.',
    });
  });

  test('refuses what is not one action', () => {
    expect(parseJsonAction('')).toMatchObject({ kind: 'invalid' });
    expect(parseJsonAction('{"tool": "get_run", ')).toMatchObject({ kind: 'invalid' });
    expect(parseJsonAction('{"tool": "x", "answer": "y"}')).toMatchObject({ kind: 'invalid' });
    expect(parseJsonAction('{"note": "hi"}')).toMatchObject({ kind: 'invalid' });
    expect(parseJsonAction('{"tool": "get_run", "arguments": [1]}')).toMatchObject({ kind: 'invalid' });
  });

  test('the Claude Code CLI always uses it', () => {
    expect(knownToolMode({ ...role(''), provider: 'claude-cli' })).toBe('json-action');
    expect(knownToolMode({ ...role('claude'), provider: 'anthropic' })).toBe('native');
  });
});

describe('Anthropic tool calls', () => {
  test('cache the tool definitions, the system prompt and the newest message', () => {
    const params = buildAnthropicToolParams(
      { provider: 'anthropic', apiKey: 'k', model: 'claude-test', baseUrl: null, temperature: null },
      {
        ...request,
        messages: [
          { role: 'user', text: 'Why did run 4 fail?' },
          { role: 'assistant', text: '', toolCalls: [{ id: 'tu_1', name: 'get_run', arguments: { runId: 4 } }] },
          {
            role: 'tool',
            results: [{ callId: 'tu_1', name: 'get_run', content: '{"status":"failed"}', isError: false }],
          },
        ],
      },
    );
    expect(params.tools?.at(-1)).toMatchObject({ name: 'get_run', cache_control: { type: 'ephemeral' } });
    expect(params.tools?.[0]).not.toHaveProperty('cache_control');
    expect(params.system).toEqual([{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }]);
    expect(params.tool_choice).toEqual({ type: 'auto' });
    expect(params.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'get_run', input: { runId: 4 } }],
    });
    expect(params.messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: '{"status":"failed"}',
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
  });
});
