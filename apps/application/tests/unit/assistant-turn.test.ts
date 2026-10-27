/**
 * One question answered and stored (`answerQuestion`), over a database: the
 * history it carries and the entities it may name in a long conversation, the
 * tools `find_tools` adds kept for the rest of the conversation, and what a
 * Claude Code turn killed past its time limit spent counted toward the caps.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import type { AssistantBlock, AssistantEvent, AssistantToolCall } from '#shared/assistant';
import type { ResolvedAiRole } from '../../types/api';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';

delete process.env.PIWI_DATABASE_URL;
delete process.env.PIWI_DESKTOP_TOKEN;

const limits = vi.hoisted(() => ({ turnTimeoutMs: null as number | null }));
vi.mock('../../server/utils/assistant/limits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/assistant/limits')>();
  return {
    ...actual,
    // The shortest time limit the variable takes is 15 seconds; a test waits less.
    resolveAssistantLimits: () => ({
      ...actual.resolveAssistantLimits(),
      ...(limits.turnTimeoutMs ? { turnTimeoutMs: limits.turnTimeoutMs } : {}),
    }),
  };
});

vi.stubGlobal('useRuntimeConfig', () => ({
  ai: {},
  authEnabled: false,
  app: { baseURL: '/' },
  public: { appVersion: '0.59.0' },
}));

const schema = await import('../../server/database/schema.sqlite');
const handlers = await import('#shared/handlers/assistant');
const { answerQuestion } = await import('../../server/utils/assistant/turn');
const { assistantHistory } = await import('../../server/utils/assistant/loop');
const { assistantReadTools, matchTools, offeredToolNames } = await import('../../server/utils/assistant/tools');
const { resetClaudeCliCache } = await import('../../server/utils/ai-claude-cli');
type McpContext = import('../../server/utils/mcp/tools').McpContext;

const OWNER = 2;
const member: McpContext = {
  user: { id: OWNER, role: InstanceRole.MEMBER, name: 'Robin', username: 'robin' } as User,
  access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.MAINTAINER }]),
  scope: new Set([1]),
};
const openai: ResolvedAiRole = {
  provider: 'openai',
  apiKey: 'k',
  model: 'gpt-turn',
  baseUrl: 'https://llm.test/v1',
  temperature: null,
};

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.users).values([{ id: OWNER, username: 'robin', password: 'x', role: 'member' }]);
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'checkout' },
  ]);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.stubGlobal('fetch', globalThis.fetch);
  limits.turnTimeoutMs = null;
  await close();
});
afterAll(() => vi.unstubAllGlobals());

const d = () => db as never;

async function conversation(extraTools: string[] | null = null) {
  const summary = await handlers.createAssistantConversation(d(), OWNER);
  if (extraTools) {
    await db
      .update(schema.assistantConversations)
      .set({ extraTools })
      .where(eq(schema.assistantConversations.id, summary.id));
  }
  return (await handlers.findAssistantConversation(d(), OWNER, summary.id))!;
}

async function ask(row: Awaited<ReturnType<typeof conversation>>, question: string, role = openai) {
  const events: AssistantEvent[] = [];
  await answerQuestion({
    db: d(),
    ctx: member,
    ownerId: OWNER,
    role,
    conversation: row,
    question,
    context: null,
    baseUrl: 'http://127.0.0.1:3000',
    emit: (e) => events.push(e),
  });
  return events;
}

/** An OpenAI-compatible server answering each step in turn, and the bodies it was sent. */
function model(steps: Array<{ text?: string; call?: { name: string; arguments: object } }>) {
  const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const step = steps[bodies.length - 1] ?? { text: 'Done.' };
      const delta = step.call
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call_${bodies.length}`,
                function: { name: step.call.name, arguments: JSON.stringify(step.call.arguments) },
              },
            ],
          }
        : { content: step.text };
      const events = [
        { model: 'gpt-turn', choices: [{ delta }] },
        {
          choices: [{ delta: {}, finish_reason: step.call ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        },
      ];
      const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }),
  );
  return bodies;
}

describe('a long conversation', () => {
  test("carries its newest exchanges and keeps every earlier answer's entities", async () => {
    const row = await conversation();
    const project1: AssistantToolCall = {
      name: 'get_project',
      arguments: { projectId: 1 },
      summary: 'Get project (projectId 1)',
      entities: [{ type: 'project', id: 1, label: 'shop' }],
    };
    // 40 exchanges; one in three answers failed, the first read project 1.
    for (let n = 1; n <= 40; n++) {
      await handlers.addAssistantMessage(d(), row, { role: 'user', blocks: [{ kind: 'text', text: `Question ${n}` }] });
      const failed = n % 3 === 0;
      await handlers.addAssistantMessage(d(), row, {
        role: 'assistant',
        blocks: [{ kind: 'text', text: failed ? '' : `Answer ${n}` }],
        toolCalls: n === 1 ? [project1] : [],
        status: failed ? 'failed' : 'completed',
        error: failed ? 'The model returned an empty answer' : null,
      });
    }
    const stored = (await handlers.getAssistantConversation(d(), OWNER, row.id))!.messages;

    const bodies = model([
      { call: { name: 'show_entity', arguments: { id: 'shop', entity: { type: 'project', id: 1 } } } },
      { text: 'That is the shop project.' },
    ]);
    const events = await ask(row, 'Which project was it?');

    const history = assistantHistory(stored);
    expect(history).toHaveLength(20);
    expect(bodies[0]!.messages.slice(1, -1)).toEqual(
      history.map((m) => ({ role: m.role, content: 'text' in m ? m.text : '' })),
    );
    expect(bodies[0]!.messages.at(-1)).toEqual({ role: 'user', content: 'Which project was it?' });
    // Read in the first answer only, the project can still be shown.
    expect(events.find((e) => e.event === 'block')).toMatchObject({
      data: { block: { kind: 'entity', entity: { type: 'project', id: 1, label: 'shop' } } },
    });
    expect(events.at(-1)).toMatchObject({ event: 'done' });
  });
});

describe('find_tools', () => {
  test('keeps the tools it adds for the rest of the conversation, beside a stored name no longer offered', async () => {
    const readTools = await assistantReadTools(d(), member, { desktop: false });
    const query = 'coverage of a file';
    const offered = new Set(offeredToolNames(readTools, null, []));
    const added = matchTools(
      readTools.filter((t) => !offered.has(t.name)),
      query,
    )
      .slice(0, 5)
      .map((t) => t.name);
    expect(added.length).toBeGreaterThan(0);
    // As many stale names as the call adds: the stored list and the toolbox's keep the same length.
    const stale = added.map((_, n) => `retired_tool_${n}`);
    const row = await conversation(stale);

    model([{ call: { name: 'find_tools', arguments: { query } } }, { text: 'Found them.' }]);
    await ask(row, 'How covered is cart.ts?');

    const [stored] = await db
      .select({ extraTools: schema.assistantConversations.extraTools })
      .from(schema.assistantConversations)
      .where(eq(schema.assistantConversations.id, row.id));
    expect(stored!.extraTools).toEqual([...stale, ...added]);
  });
});

// A stand-in `claude` that streams two model turns with their usage, as Claude Code does, then hangs.
const HANGING_CLI = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('9.9.9 (stub)\\n'); process.exit(0); }
if (args[0] === 'auth') { process.stdout.write(JSON.stringify({ loggedIn: true })); process.exit(0); }
if (args.includes('--help')) {
  process.stdout.write('Options:\\n  --print\\n  --output-format\\n  --system-prompt\\n  --tools\\n  --strict-mcp-config\\n  --mcp-config\\n  --allowedTools\\n');
  process.exit(0);
}
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 990, output_tokens: 25 };
  line({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'piwi', status: 'connected' }] });
  line({ type: 'assistant', message: { id: 'msg_1', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Looking.' }], usage } });
  line({ type: 'assistant', message: { id: 'msg_2', model: 'claude-sonnet-5', content: [{ type: 'tool_use', name: 'x' }], usage } });
  setTimeout(() => process.exit(0), 20000);
});
`;

describe.skipIf(process.platform === 'win32')('a Claude Code turn past its time limit', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-turn-'));
    writeFileSync(join(dir, 'claude'), HANGING_CLI);
    chmodSync(join(dir, 'claude'), 0o755);
    vi.stubEnv('PIWI_CLAUDE_CLI_PATH', join(dir, 'claude'));
    resetClaudeCliCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetClaudeCliCache();
  });

  test('records what its messages spent, which the daily caps count', async () => {
    limits.turnTimeoutMs = 1500;
    const row = await conversation();
    const events = await ask(row, 'Which projects report here?', { ...openai, provider: 'claude-cli', model: '' });

    expect(events.at(-1)).toMatchObject({ event: 'error', data: { code: 'timeout' } });
    const usage = await db.select().from(schema.assistantUsage);
    expect(usage).toEqual([
      expect.objectContaining({
        ownerId: OWNER,
        provider: 'claude-cli',
        model: 'claude-sonnet-5',
        inputTokens: 2000,
        outputTokens: 50,
        status: 'failed',
      }),
    ]);
    expect(await handlers.assistantTokensSince(d(), new Date(Date.now() - 60_000), OWNER)).toBe(2050);
    const answer = (await handlers.getAssistantConversation(d(), OWNER, row.id))!.messages[1]!;
    expect(answer).toMatchObject({ status: 'failed', inputTokens: 2000, outputTokens: 50 });
    expect(answer.blocks).toEqual([{ kind: 'text', text: 'Looking.' }] satisfies AssistantBlock[]);
  });
});
