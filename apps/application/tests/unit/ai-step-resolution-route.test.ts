import { describe, test, expect, vi } from 'vitest';
import { apiError } from '../../server/utils/api-error';

/**
 * The AI step-resolution route bounds every field of a request, and holds one
 * caller to 300 calls in five minutes.
 */

const calls = vi.hoisted(() => ({ resolved: 0, caller: 4 }));

vi.mock('../../server/database', () => ({ getDatabase: async () => ({}) }));
vi.mock('../../server/utils/auth', () => ({ requireAuth: async () => ({ id: calls.caller }) }));
vi.mock('../../server/utils/ai-provider', () => ({
  resolveAiConfig: async () => ({ roles: { research: { provider: 'mock' } } }),
}));
vi.mock('../../server/utils/ai-step-resolver', () => ({
  resolveStep: async () => {
    calls.resolved += 1;
    return { decision: { element: { role: 'button', name: 'Save' } } };
  },
}));

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: { body: unknown }) => event.body);
vi.stubGlobal('apiError', apiError);

const route = (await import('../../server/api/ai/step-resolution.post')).default as unknown as (
  event: unknown,
) => Promise<unknown>;

const event = (body: Record<string, unknown>) => ({
  body: { kind: 'locator', template: 'the Save button', ...body },
  context: {},
  node: { req: { headers: {}, socket: { remoteAddress: '10.2.2.2' } }, res: { setHeader: () => {} } },
});

describe('POST /api/ai/step-resolution', () => {
  test.each([
    ['a template over 4,000 characters', { template: 'x'.repeat(4_001) }],
    ['more than 200 history items', { kind: 'run', history: Array.from({ length: 201 }, () => ({ action: 'click' })) }],
    ['a history value over 4,000 characters', { kind: 'run', history: [{ action: 'fill', value: 'x'.repeat(4_001) }] }],
    ['more than 200 observed responses', { kind: 'wait', observedResponses: Array(201).fill('https://a.test/x') }],
    ['an observed response over 4,000 characters', { kind: 'wait', observedResponses: ['x'.repeat(4_001)] }],
    ['a screenshot over 5,000,000 characters', { screenshot: { mediaType: 'image/png', data: 'x'.repeat(5_000_001) } }],
  ])('refuses %s', async (_label, body) => {
    calls.caller = 4;
    await expect(route(event(body))).rejects.toMatchObject({ statusCode: 400 });
  });

  test('a caller makes 300 calls in five minutes, then waits', async () => {
    calls.caller = 5;
    calls.resolved = 0;
    for (let i = 0; i < 300; i++) await route(event({}));
    await expect(route(event({}))).rejects.toMatchObject({ statusCode: 429 });
    expect(calls.resolved).toBe(300);
    // Another caller is not held by the first one's calls.
    calls.caller = 6;
    await expect(route(event({}))).resolves.toBeTruthy();
  });
});
