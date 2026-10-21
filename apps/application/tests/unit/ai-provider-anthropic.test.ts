import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ResolvedAiRole } from '../../types/api';

delete process.env.PIWI_DATABASE_URL;

const { callAiProvider } = await import('../../server/utils/ai-provider');

const claude: ResolvedAiRole = {
  provider: 'anthropic',
  apiKey: 'k',
  model: 'claude-test',
  baseUrl: 'https://api.anthropic.test',
  temperature: null,
};

const message = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  content: [{ type: 'text', text: 'A timing issue' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 4 },
};

function json(status: number, body: object): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Answers the first request with a 400 carrying `rejection`, then with `message`; records each request body. */
function rejectFirst(rejection: string): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? json(400, { type: 'error', error: { type: 'invalid_request_error', message: rejection } })
        : json(200, message);
    }),
  );
  return bodies;
}

afterEach(() => vi.unstubAllGlobals());

describe('callAiProvider with Anthropic', () => {
  test('asks again without thinking when the model rejects it', async () => {
    const bodies = rejectFirst('thinking is not supported by this model');
    const result = await callAiProvider(claude, { system: 's', user: 'u', adaptiveThinking: true });
    expect(result).toMatchObject({ text: 'A timing issue', model: 'claude-test', inputTokens: 12, outputTokens: 4 });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveProperty('thinking');
    expect(bodies[1]).not.toHaveProperty('thinking');
  });

  test('does not ask again after another rejection', async () => {
    const bodies = rejectFirst('max_tokens is too large');
    await expect(callAiProvider(claude, { system: 's', user: 'u', adaptiveThinking: true })).rejects.toThrow(
      /max_tokens is too large/,
    );
    expect(bodies).toHaveLength(1);
  });
});
