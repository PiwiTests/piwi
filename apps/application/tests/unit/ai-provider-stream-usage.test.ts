import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ResolvedAiRole } from '../../types/api';

delete process.env.PIWI_DATABASE_URL;

const { streamAiProvider } = await import('../../server/utils/ai-provider');

const groq: ResolvedAiRole = {
  provider: 'openai',
  apiKey: 'k',
  model: 'llama-3.3-70b-versatile',
  baseUrl: 'https://api.groq.com/openai/v1',
  temperature: null,
};

/** A chat-completions stream answering with these SSE data lines. */
function sseResponse(events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('streamAiProvider usage', () => {
  test('reads the token counts Groq reports under x_groq.usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          { model: groq.model, choices: [{ delta: { content: 'Hello' } }] },
          {
            model: groq.model,
            choices: [{ delta: {}, finish_reason: 'stop' }],
            x_groq: { usage: { prompt_tokens: 120, completion_tokens: 7 } },
          },
        ]),
      ),
    );
    const chunks = [];
    for await (const chunk of streamAiProvider(groq, { system: 's', user: 'u' })) chunks.push(chunk);
    expect(chunks.at(-1)).toMatchObject({ type: 'done', data: { inputTokens: 120, outputTokens: 7 } });
  });

  test('reads the standard usage field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          { choices: [{ delta: { content: 'Hi' } }] },
          {
            choices: [],
            usage: { prompt_tokens: 50, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 20 } },
          },
        ]),
      ),
    );
    const chunks = [];
    for await (const chunk of streamAiProvider(groq, { system: 's', user: 'u' })) chunks.push(chunk);
    expect(chunks.at(-1)).toMatchObject({
      type: 'done',
      data: { inputTokens: 50, outputTokens: 3, cacheReadInputTokens: 20 },
    });
  });
});
