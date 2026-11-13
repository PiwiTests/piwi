import { describe, it, expect } from 'vitest';
import { buildOpenAiBody, type AiCallOptions, type OpenAiAttempt } from '../../server/utils/ai-provider';
import { parseEnvTemperature, rolesFromLegacy } from '../../server/utils/ai-settings';
import type { ResolvedAiRole } from '~~/types/api';

function role(temperature: number | null): ResolvedAiRole {
  return { provider: 'openai', apiKey: '', model: 'gpt-test', baseUrl: 'http://localhost:1234/v1', temperature };
}

const opts: AiCallOptions = { system: 'system prompt', user: 'user prompt' };
const attempt: OpenAiAttempt = { strictFormat: true, withImages: false, completionTokenParameter: 'max_tokens' };

describe('buildOpenAiBody temperature', () => {
  it('omits temperature entirely when unset — required so reasoning models (o1/o3/GPT-5-class) do not reject the request', () => {
    const body = buildOpenAiBody(role(null), opts, attempt);
    expect('temperature' in body).toBe(false);
  });

  it('sends the exact configured value when set', () => {
    const body = buildOpenAiBody(role(0.3), opts, attempt);
    expect(body.temperature).toBe(0.3);
  });

  it('sends an explicit 0 when configured (a valid value for non-reasoning models)', () => {
    const body = buildOpenAiBody(role(0), opts, attempt);
    expect(body.temperature).toBe(0);
  });
});

describe('parseEnvTemperature', () => {
  it('reads a string or a number, including an explicit 0', () => {
    expect(parseEnvTemperature('0.3')).toBe(0.3);
    expect(parseEnvTemperature(0.3)).toBe(0.3);
    expect(parseEnvTemperature('0')).toBe(0);
    expect(parseEnvTemperature(0)).toBe(0);
  });

  it('is undefined when unset, empty or not a number', () => {
    expect(parseEnvTemperature(undefined)).toBeUndefined();
    expect(parseEnvTemperature(null)).toBeUndefined();
    expect(parseEnvTemperature('')).toBeUndefined();
    expect(parseEnvTemperature('warm')).toBeUndefined();
  });

  it('keeps an explicit 0 on the roles built from the runtime config', () => {
    const roles = rolesFromLegacy({
      provider: 'openai',
      model: 'gpt-test',
      temperature: 0,
      researchModel: 'research-model',
      researchTemperature: 0.5,
    });

    expect(roles.diagnosis?.temperature).toBe(0);
    expect(roles.research?.temperature).toBe(0.5);
  });
});
