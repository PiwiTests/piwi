/**
 * Assistant conversations belong to their owner: no read, list or delete
 * reaches another user's, administrators included, nor a reply or a
 * checklist tick. Usage outlives a deleted conversation, feeds the daily caps
 * and the AI usage summary, and the retention sweep prunes both on their own
 * horizon.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import type { AssistantBlock } from '#shared/assistant';

delete process.env.PIWI_DATABASE_URL;
vi.stubGlobal('useRuntimeConfig', () => ({ ai: {}, authEnabled: false, public: { appVersion: '0.59.0' } }));

const handlers = await import('#shared/handlers/assistant');
const { getAiUsageSummary } = await import('#shared/handlers/ai-usage');
const { setInstanceDecisions } = await import('#shared/handlers/capabilities');
const { deleteUserRecord } = await import('#shared/handlers/users');
const { pruneAssistantConversations } = await import('../../server/utils/retention');
const { assistantAllowance, assistantAvailability } = await import('../../server/utils/assistant/turn');
const { setAppSetting } = await import('../../server/utils/app-settings');

const ALICE = 1;
const BOB = 2;
const HOUR = 60 * 60 * 1000;

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.users).values([
    { id: ALICE, username: 'alice', password: 'x', role: 'member' },
    { id: BOB, username: 'bob', password: 'x', role: 'administrator' },
  ]);
});
afterEach(async () => {
  await close();
});
afterAll(() => vi.unstubAllGlobals());

const d = () => db as never;

async function conversationWithExchange(ownerId: number | null, question = 'Why did run 4 fail?') {
  const summary = await handlers.createAssistantConversation(d(), ownerId);
  const row = (await handlers.findAssistantConversation(d(), ownerId, summary.id))!;
  await handlers.addAssistantMessage(d(), row, {
    role: 'user',
    blocks: [{ kind: 'text', text: question }],
    context: { route: '/test-runs/4', page: '/test-runs/[id]', params: { id: '4' } },
  });
  await handlers.addAssistantMessage(d(), row, {
    role: 'assistant',
    blocks: [{ kind: 'text', text: 'A timeout.' }],
    toolCalls: [{ name: 'get_run', arguments: { runId: 4 }, summary: 'Get run (runId 4)' }],
    provider: 'openai',
    model: 'gpt-test',
    inputTokens: 1200,
    outputTokens: 80,
  });
  return summary.id;
}

describe('ownership', () => {
  test('a conversation reads back with its messages, titled by its first question', async () => {
    const id = await conversationWithExchange(ALICE);
    const conversation = await handlers.getAssistantConversation(d(), ALICE, id);
    expect(conversation).toMatchObject({ id, title: 'Why did run 4 fail?' });
    expect(conversation!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(conversation!.messages[0]).toMatchObject({
      blocks: [{ kind: 'text', text: 'Why did run 4 fail?' }],
      context: { route: '/test-runs/4', page: '/test-runs/[id]' },
    });
    expect(conversation!.messages[1]).toMatchObject({
      toolCalls: [{ name: 'get_run', arguments: { runId: 4 } }],
      model: 'gpt-test',
      inputTokens: 1200,
      status: 'completed',
    });
  });

  test('another user, an administrator included, neither lists, reads nor deletes it', async () => {
    const id = await conversationWithExchange(ALICE);
    expect((await handlers.listAssistantConversations(d(), BOB)).items).toEqual([]);
    expect(await handlers.getAssistantConversation(d(), BOB, id)).toBeNull();
    expect(await handlers.findAssistantConversation(d(), BOB, id)).toBeNull();
    expect(await handlers.deleteAssistantConversation(d(), BOB, id)).toBe(false);
    // With authentication off the virtual administrator owns its own list, not the users'.
    expect(await handlers.getAssistantConversation(d(), null, id)).toBeNull();
    expect((await handlers.listAssistantConversations(d(), ALICE)).items.map((c) => c.id)).toEqual([id]);
  });

  test('a turn reads the newest messages and the entities named, of the owner only', async () => {
    const id = await conversationWithExchange(ALICE);
    const row = (await handlers.findAssistantConversation(d(), ALICE, id))!;
    await handlers.addAssistantMessage(d(), row, { role: 'user', blocks: [{ kind: 'text', text: 'And run 5?' }] });
    await handlers.addAssistantMessage(d(), row, {
      role: 'assistant',
      blocks: [{ kind: 'text', text: 'A crash.' }],
      toolCalls: [
        {
          name: 'get_run',
          arguments: { runId: 5 },
          summary: 'Get run (runId 5)',
          entities: [{ type: 'run', id: 5, label: 'Run #5' }],
        },
      ],
    });

    const recent = await handlers.listRecentAssistantMessages(d(), ALICE, id, 3);
    expect(recent.map((m) => m.blocks)).toEqual([
      [{ kind: 'text', text: 'A timeout.' }],
      [{ kind: 'text', text: 'And run 5?' }],
      [{ kind: 'text', text: 'A crash.' }],
    ]);
    expect(await handlers.listAssistantConversationEntities(d(), ALICE, id)).toEqual([
      { type: 'run', id: 5, label: 'Run #5' },
    ]);
    expect(await handlers.listRecentAssistantMessages(d(), BOB, id, 10)).toEqual([]);
    expect(await handlers.listAssistantConversationEntities(d(), BOB, id)).toEqual([]);
  });

  test('the owner deletes it with its messages', async () => {
    const id = await conversationWithExchange(ALICE);
    expect(await handlers.deleteAssistantConversation(d(), ALICE, id)).toBe(true);
    expect(await db.select().from(schema.assistantMessages)).toEqual([]);
    expect(await handlers.getAssistantConversation(d(), ALICE, id)).toBeNull();
  });

  test('conversations without a user belong to the virtual administrator', async () => {
    const id = await conversationWithExchange(null);
    expect((await handlers.listAssistantConversations(d(), null)).items.map((c) => c.id)).toEqual([id]);
    expect(await handlers.getAssistantConversation(d(), ALICE, id)).toBeNull();
  });

  test('the most recently active conversation lists first', async () => {
    const older = await conversationWithExchange(ALICE, 'First');
    const newer = await conversationWithExchange(ALICE, 'Second');
    expect((await handlers.listAssistantConversations(d(), ALICE)).items.map((c) => c.id)).toEqual([newer, older]);
  });

  test('deleting a user deletes their conversations, not the others', async () => {
    await conversationWithExchange(ALICE);
    const kept = await conversationWithExchange(BOB);
    await deleteUserRecord(d(), ALICE);
    const left = await db.select({ id: schema.assistantConversations.id }).from(schema.assistantConversations);
    expect(left.map((r) => r.id)).toEqual([kept]);
  });
});

describe('usage and the daily caps', () => {
  async function spend(ownerId: number | null, tokens: number, at = new Date()) {
    await db.insert(schema.assistantUsage).values({
      ownerId,
      provider: 'openai',
      model: 'gpt-test',
      inputTokens: tokens - 10,
      outputTokens: 10,
      status: 'completed',
      createdAt: at,
    });
  }

  test('counts one owner or the whole instance over a window', async () => {
    await spend(ALICE, 500);
    await spend(BOB, 300);
    await spend(ALICE, 1000, new Date(Date.now() - 30 * HOUR));
    const since = new Date(Date.now() - 24 * HOUR);
    expect(await handlers.assistantTokensSince(d(), since, ALICE)).toBe(500);
    expect(await handlers.assistantTokensSince(d(), since, null)).toBe(0);
    expect(await handlers.assistantTokensSince(d(), since)).toBe(800);
  });

  test('the allowance is the smaller of what the two caps leave, and names the one that binds', async () => {
    await spend(ALICE, 600);
    await spend(BOB, 3000);
    const perUser = await assistantAllowance(d(), ALICE, { dailyTokensPerUser: 1000, dailyTokens: 10_000 });
    expect(perUser.remaining).toBe(400);
    expect(perUser.message).toContain('PIWI_AI_ASSISTANT_DAILY_TOKENS_PER_USER');
    const instance = await assistantAllowance(d(), ALICE, { dailyTokensPerUser: 1000, dailyTokens: 3500 });
    expect(instance).toMatchObject({ remaining: 0 });
    expect(instance.message).toContain('PIWI_AI_ASSISTANT_DAILY_TOKENS)');
    expect(await assistantAllowance(d(), ALICE, { dailyTokensPerUser: null, dailyTokens: null })).toMatchObject({
      remaining: null,
    });
  });

  test('deleting a conversation does not give its tokens back', async () => {
    const id = await conversationWithExchange(ALICE);
    await spend(ALICE, 1280);
    await handlers.deleteAssistantConversation(d(), ALICE, id);
    expect(await handlers.assistantTokensSince(d(), new Date(Date.now() - HOUR), ALICE)).toBe(1280);
  });

  test('the AI usage summary counts assistant answers as their own kind', async () => {
    await spend(ALICE, 1000);
    await spend(BOB, 500);
    const summary = await getAiUsageSummary(d(), 30);
    expect(summary.totals).toMatchObject({ diagnoses: 0, assistantTurns: 2, inputTokens: 1480, outputTokens: 20 });
    expect(summary.byModel).toEqual([
      expect.objectContaining({ provider: 'openai', model: 'gpt-test', assistantTurns: 2, diagnoses: 0 }),
    ]);
  });
});

describe('retention', () => {
  test('prunes conversations idle past the horizon with their messages, and older usage', async () => {
    const old = await conversationWithExchange(ALICE, 'Old');
    const recent = await conversationWithExchange(ALICE, 'Recent');
    const longAgo = new Date(Date.now() - 100 * 24 * HOUR);
    await db
      .update(schema.assistantConversations)
      .set({ updatedAt: longAgo })
      .where(eq(schema.assistantConversations.id, old));
    await handlers.recordAssistantUsage(d(), {
      ownerId: ALICE,
      provider: 'openai',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      status: 'completed',
    });
    await db.update(schema.assistantUsage).set({ createdAt: longAgo });

    expect(await pruneAssistantConversations(db as never, 90)).toBe(1);
    const left = await db.select({ id: schema.assistantConversations.id }).from(schema.assistantConversations);
    expect(left.map((r) => r.id)).toEqual([recent]);
    const messages = await db.select().from(schema.assistantMessages);
    expect(new Set(messages.map((m) => m.conversationId))).toEqual(new Set([recent]));
    expect(await db.select().from(schema.assistantUsage)).toEqual([]);
  });
});

describe('availability', () => {
  test('unavailable without AI, then answering with the diagnosis model, then declined', async () => {
    expect((await assistantAvailability(d())).status).toEqual({
      available: false,
      reason: 'not-configured',
      provider: null,
      model: null,
      toolMode: null,
    });
    await setAppSetting(d(), 'ai', {
      roles: { diagnosis: { provider: 'openai', model: 'gpt-test', baseUrl: 'http://llm.test/v1' } },
    });
    const { status, role } = await assistantAvailability(d());
    expect(status).toMatchObject({ available: true, reason: null, provider: 'openai', model: 'gpt-test' });
    expect(role?.baseUrl).toBe('http://llm.test/v1');
    await setInstanceDecisions(d(), { assistant: 'declined' });
    expect((await assistantAvailability(d())).status).toMatchObject({ available: false, reason: 'declined' });
  });
});

describe('the capability', () => {
  test('declining the assistant, or AI, turns it off; a stored question does not turn it back on', async () => {
    expect(await handlers.isAssistantDeclined(d())).toBe(false);
    await conversationWithExchange(ALICE);
    await setInstanceDecisions(d(), { assistant: 'declined' });
    expect(await handlers.isAssistantDeclined(d())).toBe(true);
    await setInstanceDecisions(d(), { assistant: null, ai: 'declined' });
    expect(await handlers.isAssistantDeclined(d())).toBe(true);
    await setInstanceDecisions(d(), { ai: null });
    expect(await handlers.isAssistantDeclined(d())).toBe(false);
  });
});

describe('replies and checklist ticks', () => {
  const question: AssistantBlock = {
    kind: 'question',
    id: 'which-test',
    prompt: 'Which test should I look at?',
    multiple: true,
    choices: [
      { id: 'cart', label: 'adds to cart', entity: { type: 'test-case', id: 9, label: 'adds to cart' } },
      { id: 'pay', label: 'pays' },
    ],
    other: true,
  };
  const radio: AssistantBlock = { ...question, id: 'one-test', multiple: false, other: false };
  const options: AssistantBlock = {
    kind: 'options',
    id: 'fix',
    prompt: 'How do you want to fix it?',
    options: [
      { id: 'wait', title: 'Wait for the quote', summary: 'Waits for the request.' },
      { id: 'retry', title: 'Retry the click', summary: 'Retries.' },
    ],
  };
  const checklist: AssistantBlock = {
    kind: 'checklist',
    id: 'setup',
    title: 'Report a first run',
    steps: [
      { id: 'install', text: 'Install the reporter' },
      { id: 'run', text: 'Run the tests' },
    ],
  };

  /** A conversation whose answer carries the blocks; the answer's id with the conversation's. */
  async function answered(ownerId: number | null, blocks: AssistantBlock[]) {
    const summary = await handlers.createAssistantConversation(d(), ownerId);
    const row = (await handlers.findAssistantConversation(d(), ownerId, summary.id))!;
    await handlers.addAssistantMessage(d(), row, { role: 'user', blocks: [{ kind: 'text', text: 'Help' }] });
    const messageId = await handlers.addAssistantMessage(d(), row, {
      role: 'assistant',
      blocks: [{ kind: 'text', text: 'Pick:' }, ...blocks],
    });
    return { conversationId: summary.id, messageId };
  }
  const stored = async (ownerId: number | null, conversationId: number) =>
    (await handlers.getAssistantConversation(d(), ownerId, conversationId))!.messages[1]!.blocks;

  test("stores a question's picks on its block and hands back the prompt, the labels and the Other text", async () => {
    const { conversationId, messageId } = await answered(ALICE, [checklist, question]);
    const outcome = await handlers.recordAssistantReply(d(), ALICE, conversationId, {
      messageId,
      blockId: 'which-test',
      choiceIds: ['pay', 'cart'],
      other: '  the login test  ',
    });
    expect(outcome).toEqual({
      ok: true,
      reply: {
        prompt: 'Which test should I look at?',
        picked: [
          { id: 'pay', label: 'pays' },
          { id: 'cart', label: 'adds to cart', entity: { type: 'test-case', id: 9, label: 'adds to cart' } },
        ],
        other: 'the login test',
      },
    });
    const blocks = await stored(ALICE, conversationId);
    expect(blocks[2]).toMatchObject({
      id: 'which-test',
      answer: { choiceIds: ['pay', 'cart'], other: 'the login test' },
    });
    expect(blocks[1]).toEqual(checklist);
  });

  test('stores the option picked on an options block', async () => {
    const { conversationId, messageId } = await answered(ALICE, [options]);
    const outcome = await handlers.recordAssistantReply(d(), ALICE, conversationId, {
      messageId,
      blockId: 'fix',
      choiceIds: ['retry'],
    });
    expect(outcome).toEqual({
      ok: true,
      reply: { prompt: 'How do you want to fix it?', picked: [{ id: 'retry', label: 'Retry the click' }] },
    });
    expect((await stored(ALICE, conversationId))[1]).toMatchObject({ id: 'fix', picked: 'retry' });
  });

  test("refuses a reply on another user's or another conversation's message as missing", async () => {
    const alice = await answered(ALICE, [question]);
    const bob = await answered(BOB, [question]);
    const reply = { messageId: alice.messageId, blockId: 'which-test', choiceIds: ['pay'] };
    expect(await handlers.recordAssistantReply(d(), BOB, alice.conversationId, reply)).toEqual({
      ok: false,
      status: 404,
      message: 'Message not found',
    });
    expect(await handlers.recordAssistantReply(d(), BOB, bob.conversationId, reply)).toMatchObject({ status: 404 });
    expect(
      await handlers.recordAssistantReply(d(), ALICE, alice.conversationId, {
        ...reply,
        messageId: alice.messageId - 1,
      }),
    ).toMatchObject({ status: 404 });
    expect(
      await handlers.recordAssistantReply(d(), ALICE, alice.conversationId, { ...reply, blockId: 'nope' }),
    ).toMatchObject({ status: 404, message: 'Block not found' });
    expect((await stored(ALICE, alice.conversationId))[1]).not.toHaveProperty('answer');
  });

  test('refuses picks the block does not offer', async () => {
    const { conversationId, messageId } = await answered(ALICE, [radio, options, checklist]);
    const reply = (blockId: string, choiceIds: string[], other?: string) =>
      handlers.recordAssistantReply(d(), ALICE, conversationId, { messageId, blockId, choiceIds, other });
    expect(await reply('one-test', ['nope'])).toMatchObject({
      status: 400,
      message: 'The question has no choice "nope"',
    });
    expect(await reply('one-test', ['cart', 'pay'])).toMatchObject({
      status: 400,
      message: 'The question takes one choice',
    });
    expect(await reply('one-test', [], 'mine')).toMatchObject({ status: 400 });
    expect(await reply('one-test', [])).toMatchObject({ status: 400 });
    expect(await reply('fix', ['wait', 'retry'])).toMatchObject({ status: 400 });
    expect(await reply('setup', ['install'])).toMatchObject({ status: 400 });
    expect(await reply('one-test', ['cart'])).toMatchObject({ ok: true });
  });

  test("ticks and unticks one step of the owner's checklist, and nobody else's", async () => {
    const { conversationId, messageId } = await answered(ALICE, [checklist]);
    const tick = { blockId: 'setup', stepId: 'run', done: true };
    expect(await handlers.tickAssistantChecklist(d(), ALICE, conversationId, messageId, tick)).toMatchObject({
      steps: [{ id: 'install' }, { id: 'run', done: true }],
    });
    expect((await stored(ALICE, conversationId))[1]).toMatchObject({
      steps: [{ id: 'install' }, { id: 'run', done: true }],
    });
    const unticked = await handlers.tickAssistantChecklist(d(), ALICE, conversationId, messageId, {
      ...tick,
      done: false,
    });
    expect(unticked!.steps[1]).toEqual({ id: 'run', text: 'Run the tests' });

    expect(await handlers.tickAssistantChecklist(d(), BOB, conversationId, messageId, tick)).toBeNull();
    expect(
      await handlers.tickAssistantChecklist(d(), ALICE, conversationId, messageId, { ...tick, stepId: 'x' }),
    ).toBeNull();
    expect(
      await handlers.tickAssistantChecklist(d(), ALICE, conversationId, messageId, { ...tick, blockId: 'x' }),
    ).toBeNull();
  });

  test('changes of one message made at the same time all land, and a second Apply is still refused', async () => {
    const proposal: AssistantBlock = {
      kind: 'proposal',
      id: 'resolve',
      action: 'resolve-cluster',
      title: 'Resolve the cart cluster',
      change: 'It leaves the inbox.',
      target: { type: 'cluster', id: 4, label: 'Cart total is stale' },
      projectId: 1,
      params: {},
    };
    const { conversationId, messageId } = await answered(ALICE, [checklist, options, proposal]);
    const tick = (stepId: string) =>
      handlers.tickAssistantChecklist(d(), ALICE, conversationId, messageId, { blockId: 'setup', stepId, done: true });
    const apply = () =>
      handlers.recordAssistantProposalOutcome(d(), ALICE, conversationId, messageId, {
        blockId: 'resolve',
        status: 'applied',
      });
    const outcomes = await Promise.all([
      tick('install'),
      apply(),
      tick('run'),
      handlers.recordAssistantReply(d(), ALICE, conversationId, { messageId, blockId: 'fix', choiceIds: ['wait'] }),
      apply(),
    ]);

    expect(outcomes[1]).toMatchObject({ ok: true });
    expect(outcomes[4]).toEqual({ ok: false, status: 409, message: 'This change was already applied' });
    const blocks = await stored(ALICE, conversationId);
    expect(blocks[1]).toMatchObject({
      steps: [
        { id: 'install', done: true },
        { id: 'run', done: true },
      ],
    });
    expect(blocks[2]).toMatchObject({ id: 'fix', picked: 'wait' });
    expect(blocks[3]).toMatchObject({ id: 'resolve', outcome: { status: 'applied' } });
  });
});
