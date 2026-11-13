import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { ResolvedAiRole } from '../../types/api';

const provider = vi.hoisted(() => ({
  text: '{}',
  calls: [] as Array<{ system: string; user: string }>,
}));

vi.mock('../../server/utils/ai-provider', () => ({
  callAiProvider: async (_role: unknown, opts: { system: string; user: string }) => {
    provider.calls.push({ system: opts.system, user: opts.user });
    return { text: provider.text };
  },
}));

const { extractTestFunctionFromCode } = await import('../../server/utils/ai-function-extract');

const role: ResolvedAiRole = { provider: 'openai', apiKey: 'k', model: 'test-model', baseUrl: null, temperature: null };

const validResponse = {
  name: 'login',
  kind: 'page-object-method',
  receiver: 'loginPage',
  importName: 'LoginPage',
  params: [
    { name: 'username', type: 'string' },
    { name: 'password', type: 'string' },
  ],
  returnsPage: false,
  steps: [
    { action: 'fill', target: { role: 'textbox', name: 'Username', testId: null } },
    { action: 'fill', target: { role: 'textbox', name: 'Password', testId: null } },
    { action: 'click', target: { role: 'button', name: 'Log in', testId: null } },
  ],
  paramSources: [
    { param: 'username', stepIndex: 0, from: 'value' },
    { param: 'password', stepIndex: 1, from: 'value' },
  ],
  confidence: 0.9,
};

beforeEach(() => {
  provider.text = JSON.stringify(validResponse);
  provider.calls.length = 0;
});

describe('extractTestFunctionFromCode', () => {
  test('parses a valid response into a proposal, embedding the code in the prompt', async () => {
    const proposal = await extractTestFunctionFromCode(role, 'async login(username, password) { /* ... */ }');
    expect(proposal.name).toBe('login');
    expect(proposal.kind).toBe('page-object-method');
    expect(proposal.receiver).toBe('loginPage');
    expect(proposal.steps).toHaveLength(3);
    expect(proposal.paramSources).toHaveLength(2);
    expect(proposal.confidence).toBe(0.9);
    expect(provider.calls[0]!.user).toContain('async login(username, password)');
  });

  test('defaults confidence/paramSources/returnsPage when the model omits them', async () => {
    provider.text = JSON.stringify({
      name: 'addToCart',
      kind: 'helper',
      params: [],
      steps: [{ action: 'click', target: { role: 'button', name: 'Add to cart' } }],
    });
    const proposal = await extractTestFunctionFromCode(role, 'export async function addToCart(page) {}');
    expect(proposal.receiver).toBeNull();
    expect(proposal.importName).toBeNull();
    expect(proposal.returnsPage).toBe(false);
    expect(proposal.paramSources).toEqual([]);
    expect(proposal.confidence).toBe(0.7);
  });

  test('strips a markdown code fence around the JSON', async () => {
    provider.text = '```json\n' + JSON.stringify(validResponse) + '\n```';
    const proposal = await extractTestFunctionFromCode(role, 'async login() {}');
    expect(proposal.name).toBe('login');
  });

  test('rejects empty code before calling the AI provider at all', async () => {
    await expect(extractTestFunctionFromCode(role, '   ')).rejects.toThrow('Paste some function source code first.');
    expect(provider.calls).toHaveLength(0);
  });

  test('rejects code over the size guard before calling the AI provider', async () => {
    const huge = 'x'.repeat(20_001);
    await expect(extractTestFunctionFromCode(role, huge)).rejects.toThrow('too much code');
    expect(provider.calls).toHaveLength(0);
  });

  test('a response with no steps fails validation (min 1 step required)', async () => {
    provider.text = JSON.stringify({ ...validResponse, steps: [] });
    await expect(extractTestFunctionFromCode(role, 'x')).rejects.toThrow("couldn't produce a valid pattern");
  });

  test('an invalid action value fails schema validation', async () => {
    provider.text = JSON.stringify({
      ...validResponse,
      steps: [{ action: 'hover', target: { role: 'button' } }],
    });
    await expect(extractTestFunctionFromCode(role, 'x')).rejects.toThrow("couldn't produce a valid pattern");
  });

  test('genuinely unparseable text fails cleanly', async () => {
    provider.text = 'not json at all, sorry';
    await expect(extractTestFunctionFromCode(role, 'x')).rejects.toThrow("wasn't valid JSON");
  });
});
