/**
 * `PATCH /api/assistant/conversations/:id/messages/:messageId/proposal`:
 * records what became of a proposed change on its block, for the
 * conversation's owner only. Another user's conversation, administrators
 * included, and a block it does not hold are a 404; a change already applied
 * or dismissed is a 409, while a failed one can be applied again.
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

const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));

interface FakeEvent {
  body?: unknown;
  params?: Record<string, string>;
}

vi.stubGlobal('useRuntimeConfig', () => ({ ai: {}, authEnabled: true, public: { appVersion: '0.59.0' } }));
vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params?.[name]);
vi.stubGlobal('apiError', apiError);

const handlers = await import('#shared/handlers/assistant');
const route = (await import('../../server/api/assistant/conversations/[id]/messages/[messageId]/proposal.patch'))
  .default as unknown as (event: FakeEvent) => Promise<{ block: AssistantBlock }>;

const ALICE = { id: 1, username: 'alice', role: 'member' } as User;
const BOB = { id: 2, username: 'bob', role: 'administrator' } as User;
const as = (user: User) => {
  state.caller = { user, access: buildAccessSummary(user.role as InstanceRole, []) };
};

const PROPOSAL: AssistantBlock = {
  kind: 'proposal',
  id: 'resolve',
  action: 'resolve-cluster',
  title: 'Resolve the cart cluster',
  change: 'It leaves the inbox.',
  target: { type: 'cluster', id: 4, label: 'Cart total is stale' },
  projectId: 1,
  params: {},
};

let db: TempDb;
let close: () => Promise<void>;
let conversationId = 0;
let messageId = 0;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.users).values([
    { id: 1, username: 'alice', password: 'x', role: 'member' },
    { id: 2, username: 'bob', password: 'x', role: 'administrator' },
  ]);
  const summary = await handlers.createAssistantConversation(db as never, ALICE.id);
  const row = (await handlers.findAssistantConversation(db as never, ALICE.id, summary.id))!;
  conversationId = summary.id;
  await handlers.addAssistantMessage(db as never, row, {
    role: 'user',
    blocks: [{ kind: 'text', text: 'Resolve it' }],
  });
  messageId = await handlers.addAssistantMessage(db as never, row, {
    role: 'assistant',
    blocks: [{ kind: 'text', text: 'Here it is:' }, PROPOSAL],
  });
});
afterEach(async () => {
  await close();
});
afterAll(() => vi.unstubAllGlobals());

const patch = (body: unknown, ids: { id?: number; messageId?: number } = {}) =>
  route({
    params: { id: String(ids.id ?? conversationId), messageId: String(ids.messageId ?? messageId) },
    body,
  });

async function storedProposal() {
  const conversation = await handlers.getAssistantConversation(db as never, ALICE.id, conversationId);
  return conversation!.messages[1]!.blocks.find((b) => b.kind === 'proposal');
}

describe('the proposal outcome route', () => {
  test('is for any signed-in user, and records the outcome on the block', async () => {
    expect(state.routePermission).toEqual(['signed-in']);
    as(ALICE);
    const { block } = await patch({ blockId: 'resolve', status: 'applied' });
    expect(block).toMatchObject({ ...PROPOSAL, outcome: { status: 'applied', at: expect.any(String) } });
    expect(await storedProposal()).toEqual(block);
  });

  test("answers 404 for another user's conversation, an administrator included", async () => {
    as(BOB);
    await expect(patch({ blockId: 'resolve', status: 'dismissed' })).rejects.toMatchObject({ statusCode: 404 });
    expect(await storedProposal()).not.toHaveProperty('outcome');
  });

  test('answers 404 for a block the message does not hold, or one that is not a proposal', async () => {
    as(ALICE);
    await expect(patch({ blockId: 'nope', status: 'applied' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(patch({ blockId: 'resolve', status: 'applied' }, { messageId: messageId - 1 })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(patch({ blockId: 'resolve', status: 'applied' }, { id: conversationId + 1 })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  test('answers 400 for a status it does not know', async () => {
    as(ALICE);
    await expect(patch({ blockId: 'resolve', status: 'done' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(patch({ blockId: 'resolve', status: 'failed', result: 'x'.repeat(301) })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test('a failed apply keeps why and can be applied again; an applied or dismissed one cannot change', async () => {
    as(ALICE);
    const failed = await patch({ blockId: 'resolve', status: 'failed', result: 'Insufficient permissions' });
    expect(failed.block).toMatchObject({ outcome: { status: 'failed', result: 'Insufficient permissions' } });
    const applied = await patch({ blockId: 'resolve', status: 'applied' });
    expect(applied.block).toMatchObject({ outcome: { status: 'applied' } });
    expect(applied.block).not.toHaveProperty('outcome.result');
    await expect(patch({ blockId: 'resolve', status: 'dismissed' })).rejects.toMatchObject({
      statusCode: 409,
      message: 'This change was already applied',
    });
    expect(await storedProposal()).toMatchObject({ outcome: { status: 'applied' } });
  });

  test('answers 403 while the assistant is declined', async () => {
    as(ALICE);
    const { setInstanceDecisions } = await import('#shared/handlers/capabilities');
    await setInstanceDecisions(db as never, { assistant: 'declined' });
    await expect(patch({ blockId: 'resolve', status: 'dismissed' })).rejects.toMatchObject({ statusCode: 403 });
  });
});
