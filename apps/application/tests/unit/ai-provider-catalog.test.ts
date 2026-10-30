import { describe, expect, test } from 'vitest';
import { CONTEXT_LIMIT_FIELDS } from '#shared/ai-context-limits';
import { CONTEXT_LIMIT_GROUPS } from '~/utils/ai-context-groups';
import { PROVIDER_TILES, isPrivateUrl, providerLabel, suggestedModel, tileFor } from '~/utils/ai-provider-catalog';

describe('provider tiles', () => {
  test('a stored config reads back as the tile that wrote it', () => {
    for (const tile of PROVIDER_TILES) {
      expect(tileFor(tile.provider, tile.baseUrl)).toBe(tile.id);
    }
  });

  test('an OpenAI-compatible address no tile knows is the OpenAI-compatible tile', () => {
    expect(tileFor('openai', 'https://llm.example.com/v1')).toBe('openai-compatible');
    expect(tileFor('openai', 'https://api.openai.com/v1/')).toBe('openai');
    expect(tileFor('openai', '')).toBe('openai-compatible');
  });

  test('a provider no tile offers has no tile and keeps its own name', () => {
    expect(tileFor('demo', null)).toBeNull();
    expect(tileFor(null)).toBeNull();
    expect(providerLabel('demo')).toBe('demo');
    expect(providerLabel('openai', 'https://api.mistral.ai/v1')).toBe('Mistral AI');
  });

  test('only tiles that answer the embeddings API suggest an embedding model', () => {
    for (const tile of PROVIDER_TILES) {
      if (!tile.embeddings) expect(suggestedModel(tile.id, 'embed')).toBe('');
    }
    expect(suggestedModel('anthropic', 'fast')).toBe('claude-haiku-4-5');
  });

  test('a local or private address keeps the evidence on the network', () => {
    expect(isPrivateUrl('http://localhost:11434/v1')).toBe(true);
    expect(isPrivateUrl('http://192.168.1.20:1234/v1')).toBe(true);
    expect(isPrivateUrl('http://gpu.internal/v1')).toBe(true);
    expect(isPrivateUrl('https://api.openai.com/v1')).toBe(false);
    expect(isPrivateUrl('not a url')).toBe(false);
  });
});

describe('context limit groups', () => {
  test('every context limit is in exactly one group', () => {
    const grouped = CONTEXT_LIMIT_GROUPS.flatMap((g) => g.fields);
    expect([...grouped].sort()).toEqual(CONTEXT_LIMIT_FIELDS.map((f) => f.key).sort());
  });
});
