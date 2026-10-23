/**
 * `POST /api/assistant/conversations/:id/messages`: a conversation answers one
 * question at a time. A second question while one is being answered is a 409,
 * however close together the two arrive, and the conversation takes the next
 * question once the answer ends, or once a question is refused before its
 * answer starts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import type { AssistantBlock } from '#shared/assistant';
import { buildAccessSummary, InstanceRole } from '#shared/permissions';
import { recordRouteMeta, type RouteAccessState } from './route-access';

delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(
  () =>
    ({
      db: null,
      caller: null,
      routePermission: [],
      answers: [],
      contextDelayMs: 0,
      contextError: null,
    }) as unknown as RouteAccessState & {
      answers: Array<{ question: string; end: () => void }>;
      contextDelayMs: number;
      contextError: Error | null;
    },
);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));
vi.mock('../../server/utils/mcp/catalog', () => ({
  requestMcpContext: async (_event: unknown, _db: unknown, user: User) => {
    await new Promise((resolve) => setTimeout(resolve, state.contextDelayMs));
    if (state.contextError) throw state.contextError;
    return { user, access: buildAccessSummary(InstanceRole.MEMBER, []), scope: new Set<number>() };
  },
}));
vi.mock('../../server/utils/assistant/turn', () => ({
  assistantOwnerOf: (_event: unknown, user: User) => user.id,
  assistantAvailability: async () => ({
    status: { available: true, reason: null, provider: 'openai', model: 'gpt-test', toolMode: 'native' },
    role: { provider: 'openai', apiKey: 'k', model: 'gpt-test', baseUrl: 'https://llm.test/v1', temperature: null },
  }),
  // Each answer runs until the test ends it.
  answerQuestion: (opts: { question: string }) =>
    new Promise<void>((resolve) => state.answers.push({ question: opts.question, end: resolve })),
}));

interface FakeEvent {
  body?: unknown;
  params?: Record<string, string>;
  node: { req: { socket: { localPort: number } }; res: { on: () => void } };
}

vi.stubGlobal('useRuntimeConfig', () => ({ ai: {}, authEnabled: true, app: { baseURL: '/' }, public: {} }));
vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params?.[name]);
vi.stubGlobal('setResponseHeaders', () => {});
vi.stubGlobal('apiError', apiError);

const handlers = await import('#shared/handlers/assistant');
const route = (await import('../../server/api/assistant/conversations/[id]/messages.post')).default as unknown as (
  event: FakeEvent,
) => Promise<ReadableStream<Uint8Array>>;

const ALICE = { id: 1, username: 'alice', role: 'member' } as User;

const QUESTION: AssistantBlock = {
  kind: 'question',
  id: 'which',
  prompt: 'Which test?',
  multiple: false,
  choices: [{ id: 'cart', label: 'adds to cart' }],
};

let db: TempDb;
let close: () => Promise<void>;
let conversationId = 0;
let messageId = 0;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.answers = [];
  state.contextDelayMs = 0;
  state.contextError = null;
  state.caller = { user: ALICE, access: buildAccessSummary(InstanceRole.MEMBER, []) };
  await db.insert(schema.users).values([{ id: 1, username: 'alice', password: 'x', role: 'member' }]);
  const summary = await handlers.createAssistantConversation(db as never, ALICE.id);
  const row = (await handlers.findAssistantConversation(db as never, ALICE.id, summary.id))!;
  conversationId = summary.id;
  await handlers.addAssistantMessage(db as never, row, { role: 'user', blocks: [{ kind: 'text', text: 'Help' }] });
  messageId = await handlers.addAssistantMessage(db as never, row, { role: 'assistant', blocks: [QUESTION] });
});
afterEach(async () => {
  for (const answer of state.answers) answer.end();
  await close();
});
afterAll(() => vi.unstubAllGlobals());

const ask = (body: unknown) =>
  route({
    params: { id: String(conversationId) },
    body,
    node: { req: { socket: { localPort: 3000 } }, res: { on: () => {} } },
  });

/** Ends the answer being written and reads its stream to the end. */
async function finish(stream: ReadableStream<Uint8Array>): Promise<void> {
  await vi.waitFor(() => expect(state.answers.length).toBeGreaterThan(0));
  state.answers.shift()!.end();
  const reader = stream.getReader();
  while (!(await reader.read()).done);
}

describe('one question at a time', () => {
  test('two questions sent together: the first is answered, the second is a 409', async () => {
    // The caller's tool context takes a moment to read, as it does from the database.
    state.contextDelayMs = 20;
    const [first, second] = await Promise.allSettled([ask({ text: 'Why?' }), ask({ text: 'And this?' })]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: { statusCode: 409 } });
    await finish((first as PromiseFulfilledResult<ReadableStream<Uint8Array>>).value);
    // The answer ended: the conversation takes the next question.
    await finish(await ask({ text: 'And now?' }));
  });

  test('a reply refused before its answer starts frees the conversation for the next question', async () => {
    const reply = { messageId, blockId: 'which', choiceIds: ['nope'] };
    await expect(ask({ text: 'This one', reply })).rejects.toMatchObject({ statusCode: 400 });
    await expect(ask({ text: 'This one', reply: { ...reply, messageId: messageId + 7 } })).rejects.toMatchObject({
      statusCode: 404,
    });
    state.contextError = new Error('The database is gone');
    await expect(ask({ text: 'Why?' })).rejects.toThrow('The database is gone');
    state.contextError = null;
    await finish(await ask({ text: 'Why?' }));
  });
});
