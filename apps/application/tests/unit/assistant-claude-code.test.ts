/**
 * The assistant turn the Claude Code CLI runs: the token minted for one turn
 * (its user, its conversation, the turn itself; refused after it, for another
 * conversation, on any other route and from another machine), the desktop
 * guard letting that one route through on that token alone, the turn's MCP
 * endpoint (its tools are the toolbox; a read runs with the asking user's
 * context, a block tool sends its block), the CLI's arguments, and the turn
 * end to end with a scripted CLI run.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createServer, type AddressInfo } from 'node:net';
import { getRequestHeader, type H3Event } from 'h3';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import type { AssistantEvent } from '#shared/assistant';
import type { ResolvedAiRole } from '../../types/api';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import { ASSISTANT_BLOCK_LIMITS } from '#shared/assistant-blocks';

delete process.env.PIWI_DATABASE_URL;
delete process.env.PIWI_DESKTOP_TOKEN;

const RUNTIME_CONFIG = () => ({ ai: {}, authEnabled: false, app: { baseURL: '/' }, public: { appVersion: '0.59.0' } });
vi.stubGlobal('useRuntimeConfig', RUNTIME_CONFIG);
// Nitro auto-imports it into the server code these tests load.
vi.stubGlobal('getRequestHeader', getRequestHeader);

const tokens = await import('../../server/utils/assistant/turn-token');
const { answerTurnMcp } = await import('../../server/utils/assistant/turn-mcp');
const { createAssistantAnswer } = await import('../../server/utils/assistant/answer');
const { claudeCodeMaxTurns, claudeCodePrompt, runClaudeCodeTurn } =
  await import('../../server/utils/assistant/claude-code');
const { resolveAssistantLimits } = await import('../../server/utils/assistant/limits');
const { agentMcpConfig, buildAgentArgs, withLoopbackNoProxy } = await import('../../server/utils/ai-claude-cli');
const tools = await import('../../server/utils/assistant/tools');
const schema = await import('../../server/database/schema.sqlite');
const { extractApiKey } = await import('../../server/utils/auth');
const { presentsDesktopToken } = await import('../../server/utils/desktop-access');
type McpContext = import('../../server/utils/mcp/tools').McpContext;
type AssistantTurnTools = import('../../server/utils/assistant/turn-token').AssistantTurnTools;
type ClaudeCliAgentRun = import('../../server/utils/ai-claude-cli').ClaudeCliAgentRun;
type ClaudeCliAgentResult = import('../../server/utils/ai-claude-cli').ClaudeCliAgentResult;

const DESKTOP_TOKEN = 'pd_desktop_token';
const ENDPOINT = '/api/assistant/conversations/7/mcp';

/** A request as the CLI sends it: from this machine, to the loopback origin. */
function request(opts: {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  peer?: string;
  /** The port the request arrived on, when its socket knows one. */
  localPort?: number;
  /** The address it arrived on; the IPv4 loopback for a socket with a port, by default. */
  localAddress?: string;
  body?: unknown;
  params?: Record<string, string>;
}): H3Event {
  return {
    method: opts.method ?? 'POST',
    path: opts.path,
    context: { params: opts.params ?? {} },
    body: opts.body,
    node: {
      req: {
        headers: { host: '127.0.0.1:3000', ...opts.headers },
        socket: {
          remoteAddress: opts.peer ?? '127.0.0.1',
          localPort: opts.localPort,
          localAddress: opts.localAddress ?? (opts.localPort ? '127.0.0.1' : undefined),
        },
      },
      res: { setHeader: () => {}, getHeader: () => undefined },
    },
  } as unknown as H3Event;
}

/** A port nothing listens on: one the system just handed out and took back. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const noTools: AssistantTurnTools = {
  definitions: () => [],
  call: async (call) => ({ callId: call.id, name: call.name, content: 'ok', isError: false }),
};

const rpc = (id: number | null, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, params });

describe('the turn token', () => {
  test('opens the turn it was minted for: its user, its conversation, that turn only', () => {
    const first = tokens.mintAssistantTurnToken({ conversationId: 7, ownerId: 2, tools: noTools }, 60_000);
    const second = tokens.mintAssistantTurnToken({ conversationId: 7, ownerId: 2, tools: noTools }, 60_000);
    expect(first.token).toMatch(/^pwt_[0-9a-f]{64}$/);
    expect(second.token).not.toBe(first.token);
    expect(tokens.liveAssistantTurn(first.token, 7)).toMatchObject({ conversationId: 7, ownerId: 2 });
    expect(tokens.liveAssistantTurn(first.token, 8)).toBeNull();

    first.revoke();
    expect(tokens.liveAssistantTurn(first.token, 7)).toBeNull();
    expect(tokens.liveAssistantTurn(second.token, 7)).not.toBeNull();
    second.revoke();
    expect(tokens.liveAssistantTurn('pwt_unknown', 7)).toBeNull();
    expect(tokens.liveAssistantTurn(null, 7)).toBeNull();
  });

  test("is refused once the turn's time limit passes, even before the turn revokes it", () => {
    const now = Date.now();
    const turn = tokens.mintAssistantTurnToken({ conversationId: 7, ownerId: null, tools: noTools }, 1000, now);
    expect(tokens.liveAssistantTurn(turn.token, 7, now + 999)).not.toBeNull();
    expect(tokens.liveAssistantTurn(turn.token, 7, now + 1000)).toBeNull();
    expect(tokens.liveAssistantTurn(turn.token, 7, now)).toBeNull();
  });

  test('is no API key, session or desktop token, and opens no route but its endpoint', () => {
    const turn = tokens.mintAssistantTurnToken({ conversationId: 7, ownerId: 2, tools: noTools }, 60_000);
    const bearer = { authorization: `Bearer ${turn.token}` };
    expect(extractApiKey(request({ path: '/api/projects', headers: bearer }))).toBeNull();
    expect(extractApiKey(request({ path: '/api/projects', headers: { 'x-api-key': turn.token } }))).toBeNull();
    expect(presentsDesktopToken(request({ path: '/api/projects', headers: bearer }), DESKTOP_TOKEN)).toBe(false);

    expect(tokens.assistantTurnRouteConversation('POST', ENDPOINT)).toBe(7);
    expect(tokens.assistantTurnRouteConversation('POST', `${ENDPOINT}?x=1`)).toBe(7);
    for (const [method, path] of [
      ['GET', ENDPOINT],
      ['POST', '/api/assistant/conversations/7/messages'],
      ['POST', '/api/assistant/conversations/7/mcp/x'],
      ['POST', '/mcp'],
      ['POST', '/api/projects'],
    ] as const) {
      expect(tokens.assistantTurnRouteConversation(method, path), `${method} ${path}`).toBeNull();
    }

    expect(tokens.presentsAssistantTurnToken(request({ path: ENDPOINT, headers: bearer }))).toBe(true);
    expect(tokens.presentsAssistantTurnToken(request({ path: '/api/projects', headers: bearer }))).toBe(false);
    expect(tokens.presentsAssistantTurnToken(request({ path: '/mcp', headers: bearer }))).toBe(false);
    expect(
      tokens.presentsAssistantTurnToken(request({ path: '/api/assistant/conversations/8/mcp', headers: bearer })),
    ).toBe(false);
    turn.revoke();
    expect(tokens.presentsAssistantTurnToken(request({ path: ENDPOINT, headers: bearer }))).toBe(false);
  });

  test('opens the endpoint from this machine only: a loopback host, origin and peer', () => {
    const local = (headers: Record<string, string>, peer?: string) =>
      tokens.isLoopbackRequest(request({ path: ENDPOINT, headers, peer }));
    expect(local({})).toBe(true);
    expect(local({ host: 'localhost:3000' })).toBe(true);
    expect(local({ host: '[::1]:3000' })).toBe(true);
    expect(local({ origin: 'http://127.0.0.1:3000' })).toBe(true);
    expect(local({}, '::ffff:127.0.0.1')).toBe(true);
    expect(local({ host: 'piwi.example.com' })).toBe(false);
    expect(local({ host: '127.0.0.1.example.com' })).toBe(false);
    expect(local({ origin: 'https://piwi.example.com' })).toBe(false);
    expect(local({ origin: 'null' })).toBe(false);
    expect(local({}, '10.0.0.5')).toBe(false);
  });

  test('the CLI calls this server on the loopback address, at the port the request arrived on, never a host it named', async () => {
    vi.stubEnv('NITRO_PORT', String(await closedPort()));
    const named = { path: '/', headers: { host: 'piwi.example.com' } };
    try {
      expect(await tokens.assistantLoopbackBaseUrl(request({ ...named, localPort: 8080 }))).toBe(
        'http://127.0.0.1:8080',
      );
      const mapped = request({ ...named, localPort: 8080, localAddress: '::ffff:127.0.0.1' });
      expect(await tokens.assistantLoopbackBaseUrl(mapped)).toBe('http://127.0.0.1:8080');
      const v6 = request({ ...named, localPort: 8080, localAddress: '::1' });
      expect(await tokens.assistantLoopbackBaseUrl(v6)).toBe('http://[::1]:8080');
      // A socket with no port (a dev server's worker): the port the environment names, on the
      // IPv4 loopback when nothing answers there.
      expect(await tokens.assistantLoopbackBaseUrl(request(named))).toBe(`http://127.0.0.1:${process.env.NITRO_PORT}`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('the loopback address is the one a server answers on, as nuxt dev on Windows answers on ::1 alone', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      // `::1` refuses (or has no IPv6 at all), so the next address that answers is the one.
      expect(await tokens.answeringLoopbackHost(port, ['::1', '127.0.0.1'])).toBe('127.0.0.1');
      // Found once, it is kept for the port.
      expect(await tokens.answeringLoopbackHost(port, ['::1'])).toBe('127.0.0.1');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // With nothing answering, the first address: the CLI then reports it could not reach it.
    expect(await tokens.answeringLoopbackHost(await closedPort(), ['127.0.0.1', '::1'])).toBe('127.0.0.1');
  });
});

describe('the desktop guard', () => {
  let guard: (event: H3Event) => void;

  beforeAll(async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler);
    vi.stubGlobal('apiError', (opts: { statusCode: number; statusMessage?: string; message?: string }) =>
      Object.assign(new Error(opts.statusMessage ?? opts.message), opts),
    );
    guard = (await import('../../server/middleware/desktop-guard')).default as unknown as typeof guard;
  });
  afterEach(() => vi.unstubAllEnvs());

  test("lets a running answer's endpoint through on that answer's token alone, and nothing else", () => {
    vi.stubEnv('PIWI_DESKTOP_TOKEN', DESKTOP_TOKEN);
    const turn = tokens.mintAssistantTurnToken({ conversationId: 7, ownerId: null, tools: noTools }, 60_000);
    const bearer = { authorization: `Bearer ${turn.token}` };
    const refused = /Desktop access token required/;

    expect(() => guard(request({ path: ENDPOINT, headers: bearer }))).not.toThrow();
    for (const path of [
      '/api/projects',
      '/mcp',
      '/api/assistant/conversations/7/messages',
      '/api/assistant/conversations/8/mcp',
    ]) {
      expect(() => guard(request({ path, headers: bearer })), path).toThrow(refused);
    }
    expect(() => guard(request({ method: 'GET', path: ENDPOINT, headers: bearer }))).toThrow(refused);
    expect(() => guard(request({ path: ENDPOINT, headers: { ...bearer, host: 'piwi.example.com' } }))).toThrow(refused);
    expect(() => guard(request({ path: ENDPOINT, headers: { ...bearer, origin: 'https://evil.example' } }))).toThrow(
      refused,
    );
    expect(() => guard(request({ path: ENDPOINT }))).toThrow(refused);

    turn.revoke();
    expect(() => guard(request({ path: ENDPOINT, headers: bearer }))).toThrow(refused);
    // The desktop token still opens every route, and nothing changes outside the desktop app.
    expect(() => guard(request({ path: '/api/projects', headers: { 'x-piwi-token': DESKTOP_TOKEN } }))).not.toThrow();
    vi.unstubAllEnvs();
    delete process.env.PIWI_DESKTOP_TOKEN;
    expect(() => guard(request({ path: '/api/projects' }))).not.toThrow();
  });
});

// ── The endpoint and the turn, over a database ───────────────────────────────

const member: McpContext = {
  user: { id: 2, role: InstanceRole.MEMBER, name: 'Robin', username: 'robin' } as User,
  access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.MAINTAINER }]),
  scope: new Set([1]),
};

const role: ResolvedAiRole = { provider: 'claude-cli', apiKey: '', model: '', baseUrl: null, temperature: null };

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'admin-console' },
  ]);
});
afterEach(async () => {
  await close();
});
afterAll(() => vi.unstubAllGlobals());

async function toolboxOf(ctx: McpContext) {
  const readTools = await tools.assistantReadTools(db as never, ctx, { desktop: false });
  return {
    readTools,
    toolbox: tools.createAssistantToolbox({ db: db as never, ctx, readTools, page: null, extraTools: [] }),
  };
}

/** A turn's tools as its endpoint serves them, with the events its answer emits. */
async function turnOf(ctx: McpContext, maxToolCalls = 8) {
  const { toolbox } = await toolboxOf(ctx);
  const events: AssistantEvent[] = [];
  const answer = createAssistantAnswer({ toolbox, maxToolCalls, provider: 'claude-cli', emit: (e) => events.push(e) });
  const turn: AssistantTurnTools = {
    definitions: () => toolbox.definitions(),
    async call(call) {
      const result = await answer.call(call);
      answer.afterTools();
      return result;
    },
  };
  return { turn, toolbox, answer, events };
}

type RpcResult = { id: number; result?: any; error?: { code: number; message: string } };

async function send(turn: AssistantTurnTools, body: unknown, acceptsStream = false) {
  return answerTurnMcp(turn, body, { version: '0.59.0', acceptsStream });
}

async function json(turn: AssistantTurnTools, body: unknown): Promise<RpcResult> {
  const reply = await send(turn, body);
  if (reply.kind !== 'json') throw new Error(`expected a JSON reply, got ${reply.kind}`);
  return reply.body as RpcResult;
}

const toolCall = (id: number, name: string, args: unknown = {}) => rpc(id, 'tools/call', { name, arguments: args });

describe("a turn's MCP endpoint", () => {
  test('answers initialize and ping, announces its tool list can change, and gives notifications no answer', async () => {
    const { turn } = await turnOf(member);
    const init = await json(turn, rpc(1, 'initialize', { protocolVersion: '2025-06-18' }));
    expect(init.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'piwi-assistant', version: '0.59.0' },
    });
    expect((await json(turn, rpc(2, 'ping'))).result).toEqual({});
    expect(await send(turn, rpc(null, 'notifications/initialized'))).toEqual({ kind: 'none' });
    expect((await json(turn, rpc(3, 'resources/list'))).error?.code).toBe(-32601);
  });

  test('lists the toolbox: the read tools offered, its own tools and the block tools, never a write tool', async () => {
    const { turn, toolbox } = await turnOf(member);
    const listed = (await json(turn, rpc(1, 'tools/list'))).result.tools as Array<{
      name: string;
      inputSchema: object;
    }>;
    const names = listed.map((t) => t.name);
    expect(names).toEqual(toolbox.definitions().map((d) => d.name));
    expect(names).toEqual(
      expect.arrayContaining([
        'list_projects',
        'find_tools',
        'get_instance_config',
        'find_anchors',
        'show_entity',
        'ask',
      ]),
    );
    for (const absent of [
      'set_cluster_status',
      'run_cluster_diagnosis',
      'get_coverage',
      'apply_locator_fix',
      'import_local_report',
      'read_local_source',
    ]) {
      expect(names, absent).not.toContain(absent);
    }
    expect(listed[0]!.inputSchema).toMatchObject({ type: 'object' });
  });

  test("runs a read tool with the asking user's context, and emits its tool event", async () => {
    const { turn, events } = await turnOf(member);
    const listed = await json(turn, toolCall(1, 'list_projects'));
    expect(listed.result.isError).toBe(false);
    expect(listed.result.content[0].text).toContain('shop');
    expect(listed.result.content[0].text).not.toContain('admin-console');
    expect(events).toEqual([
      {
        event: 'tool',
        data: {
          name: 'list_projects',
          summary: 'List projects',
          entities: [{ type: 'project', id: 1, label: 'shop' }],
        },
      },
    ]);

    const refused = await json(turn, toolCall(2, 'get_project', { projectId: 2 }));
    expect(refused.result).toMatchObject({ isError: true, content: [{ text: 'Error: No access to project 2' }] });
    const write = await json(turn, toolCall(3, 'set_cluster_status', { clusterId: 1, status: 'resolved' }));
    expect(write.result.content[0].text).toContain('Unknown tool: set_cluster_status');
  });

  test('a block tool sends its block; a question ends the answer and nothing is added after it', async () => {
    const { turn, answer, events } = await turnOf(member);
    await json(turn, toolCall(1, 'list_projects'));
    answer.write('Here it is.');
    const card = await json(turn, toolCall(2, 'show_entity', { id: 'shop', entity: { type: 'project', id: 1 } }));
    expect(card.result).toEqual({ content: [{ type: 'text', text: 'Shown to the user.' }], isError: false });
    expect(events.at(-1)).toEqual({
      event: 'block',
      data: { block: { kind: 'entity', id: 'shop', entity: { type: 'project', id: 1, label: 'shop' } } },
    });

    const asked = await json(
      turn,
      toolCall(3, 'ask', {
        id: 'which',
        prompt: 'Which one?',
        choices: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      }),
    );
    expect(asked.result.content[0].text).toContain('Your answer ends here');
    expect(answer.ended).toBe(true);
    const count = events.length;
    answer.write('More words.');
    const after = await json(turn, toolCall(4, 'list_projects'));
    expect(after.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('has ended') }] });
    expect(events).toHaveLength(count);
    expect(answer.blocks.map((b) => b.kind)).toEqual(['text', 'entity', 'question']);
  });

  test('find_tools announces the tools it added before its answer, to a client that takes an event stream', async () => {
    const { turn } = await turnOf(member);
    const reply = await send(turn, toolCall(5, 'find_tools', { query: 'coverage of a file' }), true);
    expect(reply.kind).toBe('stream');
    const frames = (reply as { body: string }).body
      .split('\n\n')
      .filter(Boolean)
      .map((frame) => {
        expect(frame.startsWith('event: message\ndata: ')).toBe(true);
        return JSON.parse(frame.slice('event: message\ndata: '.length));
      });
    expect(frames[0]).toEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    expect(frames[1]).toMatchObject({ id: 5, result: { isError: false } });
    const names = (await json(turn, rpc(6, 'tools/list'))).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('get_coverage');

    // A call that changes nothing answers as JSON, as does any call to a client without event streams.
    expect((await send(turn, toolCall(7, 'list_projects'), true)).kind).toBe('json');
  });

  test('refuses arguments that are not an object, and a call without a name', async () => {
    const { turn, events } = await turnOf(member);
    const bad = await json(turn, toolCall(1, 'list_projects', [1, 2]));
    expect(bad.result).toMatchObject({
      isError: true,
      content: [{ text: 'Error: The arguments were not a JSON object' }],
    });
    expect(events[0]).toMatchObject({ event: 'tool', data: { name: 'list_projects' } });
    expect((await json(turn, rpc(2, 'tools/call', {}))).error?.code).toBe(-32602);
    expect((await json(turn, { jsonrpc: '1.0', id: 3, method: 'ping' })).error?.code).toBe(-32600);
  });

  test("holds the turn's read-call limit; block tools do not count", async () => {
    const { turn } = await turnOf(member, 1);
    expect((await json(turn, toolCall(1, 'list_projects'))).result.isError).toBe(false);
    const past = await json(turn, toolCall(2, 'get_project', { projectId: 1 }));
    expect(past.result.content[0].text).toContain('Not run: This question reached the limit of 1 tool calls');
    const card = await json(turn, toolCall(3, 'show_entity', { id: 'shop', entity: { type: 'project', id: 1 } }));
    expect(card.result.isError).toBe(false);
  });
});

describe('the route', () => {
  let route: (event: H3Event) => Promise<unknown>;
  const headers = new Map<string, string>();

  beforeAll(async () => {
    vi.stubGlobal('defineRouteMeta', () => {});
    vi.stubGlobal('eventHandler', (handler: unknown) => handler);
    vi.stubGlobal('readBody', async (event: { body?: unknown }) => event.body);
    vi.stubGlobal('setResponseHeader', (_event: unknown, name: string, value: string) => headers.set(name, value));
    vi.stubGlobal(
      'getRouterParam',
      (event: { context: { params: Record<string, string> } }, name: string) => event.context.params[name],
    );
    vi.stubGlobal('apiError', (opts: { statusCode: number; message?: string }) =>
      Object.assign(new Error(opts.message), opts),
    );
    route = (await import('../../server/api/assistant/conversations/[id]/mcp.post')).default as unknown as typeof route;
  });

  test("answers only the running answer's token, for its conversation", async () => {
    const { turn: tools_ } = await turnOf(member);
    const turn = tokens.mintAssistantTurnToken({ conversationId: 7, ownerId: 2, tools: tools_ }, 60_000);
    const call = (path: string, id: string, extra: Record<string, string> = {}, body: unknown = rpc(1, 'tools/list')) =>
      route(request({ path, params: { id }, headers: { authorization: `Bearer ${turn.token}`, ...extra }, body }));

    const listed = (await call(ENDPOINT, '7')) as RpcResult;
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toContain('list_projects');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(await call(ENDPOINT, '7', {}, rpc(null, 'notifications/initialized'))).toBeNull();

    await expect(call('/api/assistant/conversations/8/mcp', '8')).rejects.toMatchObject({ statusCode: 401 });
    await expect(call(ENDPOINT, '7', { host: 'piwi.example.com' })).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      route(request({ path: ENDPOINT, params: { id: '7' }, headers: { 'x-piwi-token': DESKTOP_TOKEN } })),
    ).rejects.toMatchObject({ statusCode: 401 });
    turn.revoke();
    await expect(call(ENDPOINT, '7')).rejects.toMatchObject({ statusCode: 401 });
  });
});

// ── The CLI's arguments ──────────────────────────────────────────────────────

describe("the CLI's arguments for a turn", () => {
  const BASE_FLAGS = [
    '--print',
    '--output-format',
    '--verbose',
    '--include-partial-messages',
    '--system-prompt',
    '--model',
    '--tools',
    '--strict-mcp-config',
    '--mcp-config',
  ];
  const help = (extra: string[], text = '') => ({ flags: new Set([...BASE_FLAGS, ...extra]), text });
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  const run = { system: 'rules', tools: ['list_projects', 'ask'], maxTurns: 12 };

  test('attach only the turn server, allow only its tools, keep the built-in tools off and bound the turns', () => {
    const args = buildAgentArgs(
      help(
        ['--allowedTools', '--permission-mode', '--no-session-persistence'],
        '--permission-mode <mode>  (choices: "acceptEdits", "default", "dontAsk", "plan")',
      ),
      { ...role, model: 'sonnet' },
      run,
      '/tmp/piwi-claude-mcp-x/mcp.json',
    );
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'stream-json']);
    expect(args).toEqual(expect.arrayContaining(['--verbose', '--include-partial-messages', '--strict-mcp-config']));
    expect(after(args, '--tools')).toBe('');
    expect(args.filter((a) => a === '--mcp-config')).toHaveLength(1);
    expect(after(args, '--mcp-config')).toBe('/tmp/piwi-claude-mcp-x/mcp.json');
    expect(after(args, '--allowedTools')).toBe('mcp__piwi__list_projects,mcp__piwi__ask');
    expect(after(args, '--permission-mode')).toBe('dontAsk');
    expect(after(args, '--max-turns')).toBe('12');
    expect(after(args, '--system-prompt')).toBe('rules');
    expect(after(args, '--model')).toBe('sonnet');
    expect(args).toContain('--no-session-persistence');
  });

  test("use the CLI's spelling of the allowed tools, and only the options it has", () => {
    const args = buildAgentArgs(help(['--allowed-tools']), role, run, '/tmp/mcp.json');
    expect(after(args, '--allowed-tools')).toBe('mcp__piwi__list_projects,mcp__piwi__ask');
    for (const absent of ['--allowedTools', '--permission-mode', '--no-session-persistence', '--model']) {
      expect(args).not.toContain(absent);
    }
  });

  test('refuse a CLI that cannot attach only the turn server', () => {
    expect(() =>
      buildAgentArgs({ flags: new Set(BASE_FLAGS.filter((f) => f !== '--mcp-config')), text: '' }, role, run, 'x'),
    ).toThrow(/Update Claude Code/);
    expect(() => buildAgentArgs(help([]), role, run, 'x')).toThrow(/Update Claude Code/);
  });

  test("the MCP config names the turn's endpoint as the one server, with the turn's token", () => {
    const url = 'http://127.0.0.1:3000/api/assistant/conversations/7/mcp';
    expect(JSON.parse(agentMcpConfig({ url, token: 'pwt_abc' }))).toEqual({
      mcpServers: { piwi: { type: 'http', url, headers: { Authorization: 'Bearer pwt_abc' } } },
    });
  });

  test('the turn limit leaves a turn for each read call PIWI_AI_ASSISTANT_MAX_TOOL_CALLS allows, each block and the answer', () => {
    const turns = (value?: string) =>
      claudeCodeMaxTurns(
        resolveAssistantLimits(value === undefined ? {} : { PIWI_AI_ASSISTANT_MAX_TOOL_CALLS: value }).maxToolCalls,
      );
    const blocks = ASSISTANT_BLOCK_LIMITS.maxBlocks;
    expect(blocks).toBe(12);
    expect(turns()).toBe(8 + blocks + 2);
    expect(turns('3')).toBe(3 + blocks + 2);
    // The variable is clamped, so the turns stay finite.
    expect(turns('100000')).toBe(30 + blocks + 2);
    expect(turns('Infinity')).toBe(8 + blocks + 2);
    expect(turns('0')).toBe(1 + blocks + 2);
    // The CLI is handed that number.
    const args = buildAgentArgs(
      help(['--allowedTools']),
      role,
      { ...run, maxTurns: turns() },
      '/tmp/piwi-claude-mcp-x/mcp.json',
    );
    expect(after(args, '--max-turns')).toBe('22');
  });

  test('a proxy never carries the calls to this server, and the prompt carries the conversation first', () => {
    expect(withLoopbackNoProxy({ NO_PROXY: 'corp.example' }).NO_PROXY).toBe(
      'corp.example,127.0.0.1,localhost,::1,[::1]',
    );
    expect(withLoopbackNoProxy({}).no_proxy).toBe('127.0.0.1,localhost,::1,[::1]');
    expect(claudeCodePrompt([], 'Why?')).toBe('Why?');
    expect(
      claudeCodePrompt(
        [
          { role: 'user', text: 'Which run failed?' },
          { role: 'assistant', text: 'Run #4.' },
        ],
        'Why?',
      ),
    ).toBe(
      'The conversation so far:\n\n### User\nWhich run failed?\n\n### Assistant\nRun #4.\n\n### User (answer this)\nWhy?',
    );
  });
});

// ── The turn, with a scripted CLI ────────────────────────────────────────────

const BASE_URL = 'http://127.0.0.1:3000';

/** A CLI run that calls the turn's endpoint as Claude Code does, then reports `outcome`. */
function scriptedCli(
  script: (endpoint: (body: unknown) => Promise<unknown>, run: ClaudeCliAgentRun) => Promise<void>,
  outcome: Partial<ClaudeCliAgentResult> = {},
) {
  const runs: ClaudeCliAgentRun[] = [];
  const cli = async (_role: ResolvedAiRole, run: ClaudeCliAgentRun): Promise<ClaudeCliAgentResult> => {
    runs.push(run);
    const conversationId = Number(/conversations\/(\d+)\/mcp$/.exec(run.server.url)![1]);
    const endpoint = async (body: unknown) => {
      const turn = tokens.liveAssistantTurn(run.server.token, conversationId);
      if (!turn) throw new Error('401');
      return answerTurnMcp(turn, body, { version: '0.59.0', acceptsStream: false });
    };
    await script(endpoint, run);
    return {
      outcome: 'answered',
      error: null,
      text: '',
      model: 'claude-fake-1',
      inputTokens: 1500,
      outputTokens: 40,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 1000,
      costUsd: 0.012,
      ...outcome,
    };
  };
  return { cli, runs };
}

async function claudeCodeTurn(
  cli: ReturnType<typeof scriptedCli>['cli'],
  overrides: { allowance?: number | null; maxToolCalls?: number; baseUrl?: string } = {},
) {
  const { toolbox, readTools } = await toolboxOf(member);
  const events: AssistantEvent[] = [];
  const result = await runClaudeCodeTurn({
    role,
    system: 'rules',
    history: [],
    question: 'Which projects report here?',
    toolbox,
    limits: { maxToolCalls: overrides.maxToolCalls ?? 8, maxOutputTokens: 2048, turnTimeoutMs: 60_000 },
    allowance: { remaining: overrides.allowance ?? null, message: 'You reached your assistant allowance.' },
    emit: (e) => events.push(e),
    conversationId: 7,
    ownerId: 2,
    baseUrl: overrides.baseUrl ?? BASE_URL,
    allowedTools: tools.assistantToolNames(readTools),
    run: cli,
  });
  return { result, events, readTools };
}

describe('runClaudeCodeTurn', () => {
  test("one CLI run answers: its text streams, its calls through the endpoint emit the turn's events", async () => {
    let token = '';
    const { cli, runs } = scriptedCli(async (endpoint, run) => {
      token = run.server.token;
      run.onText('Looking at the projects.');
      await endpoint(toolCall(1, 'list_projects'));
      await endpoint(toolCall(2, 'show_entity', { id: 'shop', entity: { type: 'project', id: 1 } }));
      run.onText('**shop** reports here [list_projects].');
    });
    const { result, events, readTools } = await claudeCodeTurn(cli);

    expect(events.map((e) => e.event)).toEqual(['text', 'tool', 'block', 'text', 'done']);
    expect(events.at(-1)).toEqual({
      event: 'done',
      data: {
        messageId: null,
        provider: 'claude-cli',
        model: 'claude-fake-1',
        toolMode: 'native',
        inputTokens: 1500,
        outputTokens: 40,
        costUsd: 0.012,
      },
    });
    expect(result).toMatchObject({
      status: 'completed',
      blocks: [
        { kind: 'text', text: 'Looking at the projects.' },
        { kind: 'entity', entity: { type: 'project', id: 1, label: 'shop' } },
        { kind: 'text', text: '**shop** reports here [list_projects].' },
      ],
      toolCalls: [{ name: 'list_projects', summary: 'List projects' }],
      toolMode: 'native',
      error: null,
    });

    const [run] = runs;
    expect(run!.server.url).toBe(`${BASE_URL}/api/assistant/conversations/7/mcp`);
    expect(run!.server.token).toMatch(/^pwt_/);
    expect(run!.maxTurns).toBe(claudeCodeMaxTurns(8));
    expect(run!.maxTurns).toBe(22);
    expect(run!.tools).toEqual(tools.assistantToolNames(readTools));
    expect(run!.tools).toEqual(expect.arrayContaining(['list_projects', 'get_coverage', 'find_tools', 'ask']));
    expect(run!.tools).not.toContain('set_cluster_status');
    expect(run!.system).toContain('mcp__piwi__find_anchors');
    // The turn's token is refused once the turn is over.
    expect(tokens.liveAssistantTurn(token, 7)).toBeNull();
  });

  test('a question ends the answer: the text after it is dropped and later calls refused', async () => {
    const results: unknown[] = [];
    const { cli } = scriptedCli(async (endpoint, run) => {
      run.onText('Pick one:');
      await endpoint(
        toolCall(1, 'ask', {
          id: 'which',
          prompt: 'Which?',
          choices: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        }),
      );
      run.onText('Let me know.');
      results.push(await endpoint(toolCall(2, 'list_projects')));
    });
    const { result, events } = await claudeCodeTurn(cli);
    expect(events.map((e) => e.event)).toEqual(['text', 'block', 'done']);
    expect(result.blocks.map((b) => b.kind)).toEqual(['text', 'question']);
    expect(JSON.stringify(results[0])).toContain('has ended');
  });

  test('a run out of turns ends with the tool-call limit, keeping what it spent', async () => {
    const { cli } = scriptedCli(
      async (endpoint) => {
        await endpoint(toolCall(1, 'list_projects'));
      },
      { outcome: 'max-turns' },
    );
    const { result, events } = await claudeCodeTurn(cli, { maxToolCalls: 3 });
    expect(result).toMatchObject({
      status: 'failed',
      model: 'claude-fake-1',
      inputTokens: 1500,
      error: {
        code: 'limit',
        message: 'This question reached the limit of 3 tool calls (PIWI_AI_ASSISTANT_MAX_TOOL_CALLS).',
      },
    });
    expect(events.at(-1)).toMatchObject({ event: 'error', data: { code: 'limit' } });
  });

  test('a run past the time limit, a stopped run, a failed run and a thrown error end with their errors', async () => {
    const timedOut = await claudeCodeTurn(scriptedCli(async () => {}, { outcome: 'timeout' }).cli);
    expect(timedOut.result.error).toEqual({
      code: 'timeout',
      message: 'The answer took longer than 60 seconds (PIWI_AI_ASSISTANT_TURN_TIMEOUT_SECONDS).',
    });
    const stopped = await claudeCodeTurn(
      scriptedCli(async (_endpoint, run) => run.onText('Looking at'), { outcome: 'stopped' }).cli,
    );
    expect(stopped.result).toMatchObject({
      status: 'failed',
      text: 'Looking at',
      inputTokens: 1500,
      error: { code: 'stopped', message: 'You stopped this answer.' },
    });
    const failed = await claudeCodeTurn(
      scriptedCli(async () => {}, { outcome: 'failed', error: 'Claude Code could not reach this server.' }).cli,
    );
    expect(failed.result.error).toEqual({
      code: 'provider',
      message: '[claude-cli] Claude Code could not reach this server.',
    });
    const thrown = await claudeCodeTurn(async () => {
      throw new Error('Claude Code is not signed in.');
    });
    expect(thrown.result).toMatchObject({
      status: 'failed',
      model: null,
      error: { code: 'provider', message: '[claude-cli] Claude Code is not signed in.' },
    });
    const empty = await claudeCodeTurn(scriptedCli(async () => {}).cli);
    expect(empty.result.error).toEqual({ code: 'provider', message: 'The model returned an empty answer' });
  });

  test("the CLI calls the endpoint under the app's base path", async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ ai: {}, app: { baseURL: '/piwi/' }, public: {} }));
    try {
      const baseUrl = await tokens.assistantLoopbackBaseUrl(request({ path: '/', localPort: 8080 }));
      expect(baseUrl).toBe('http://127.0.0.1:8080/piwi');
      const { cli, runs } = scriptedCli(async (_endpoint, run) => run.onText('Done.'));
      await claudeCodeTurn(cli, { baseUrl });
      expect(runs[0]!.server.url).toBe('http://127.0.0.1:8080/piwi/api/assistant/conversations/7/mcp');
    } finally {
      vi.stubGlobal('useRuntimeConfig', RUNTIME_CONFIG);
    }
  });

  test('a daily cap reached stops the turn before the CLI runs', async () => {
    const { cli, runs } = scriptedCli(async () => {});
    const { result } = await claudeCodeTurn(cli, { allowance: 0 });
    expect(runs).toHaveLength(0);
    expect(result).toMatchObject({ status: 'failed', model: null, error: { code: 'limit' } });
  });
});
