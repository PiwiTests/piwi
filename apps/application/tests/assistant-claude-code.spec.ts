/**
 * The assistant with the Claude Code CLI as its provider, end to end. The spec
 * starts a desktop-mode server of its own (port 3104, its own database and
 * storage) whose `PIWI_CLAUDE_CLI_PATH` is a fake `claude`
 * (`fixtures/fake-claude.mjs`). One CLI run answers a question: it calls the
 * answer's MCP endpoint over HTTP with the token minted for that answer (a read
 * tool, then a block), its text streams to the browser, and the answer is
 * stored with the usage the CLI reported. The desktop guard lets only that
 * endpoint through on that token, only while the answer runs, and the CLI is
 * never given the desktop token.
 */
import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROJECT } from '#shared/test-project-names';
import type { AssistantConversation, AssistantStatus } from '#shared/assistant';

const PORT = 3104;
const BASE = `http://127.0.0.1:${PORT}`;
const DESKTOP_TOKEN = 'pd_e2e_claude_code_desktop_token';
const tempDir = resolve('.test-temp', 'claude-code');
const recordPath = join(tempDir, 'fake-claude-record.json');

test.describe.configure({ mode: 'serial' });

let server: ChildProcess | null = null;

/** CI runs the production output it built; locally a dev server compiles on demand. */
function startServer(): ChildProcess {
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(join(tempDir, 'storage'), { recursive: true });
  const [command, args] = process.env.CI
    ? ['node', ['.output/server/index.mjs']]
    : ['npx', ['nuxt', 'dev', '--port', String(PORT)]];
  const child = spawn(command, args, {
    env: {
      ...process.env,
      NITRO_PORT: String(PORT),
      PORT: String(PORT),
      PIWI_DESKTOP_TOKEN: DESKTOP_TOKEN,
      PIWI_CLAUDE_CLI_PATH: resolve('tests', 'fixtures', 'fake-claude.mjs'),
      CLAUDE_FAKE_RECORD: recordPath,
      PIWI_DATABASE_PATH: join(tempDir, 'piwi.db'),
      PIWI_DATABASE_URL: '',
      PIWI_STORAGE_TYPE: 'local',
      PIWI_STORAGE_PATH: join(tempDir, 'storage'),
      PIWI_BUILD_DIR: join(tempDir, 'nuxt-build'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const log = createWriteStream(join(tempDir, 'server.log'));
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  return child;
}

async function waitForServer(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server && server.exitCode !== null) throw new Error(`The server exited; see ${join(tempDir, 'server.log')}`);
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`The server did not answer within ${timeoutMs / 1000} s; see ${join(tempDir, 'server.log')}`);
}

function stopServer() {
  if (!server?.pid || server.exitCode !== null) return;
  try {
    if (process.platform === 'win32') server.kill();
    else process.kill(-server.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

/** The events of a Server-Sent Events body, in order. */
function parseEvents(body: string): Array<{ event: string; data: any }> {
  return body
    .split('\n\n')
    .filter((frame) => frame.startsWith('event: '))
    .map((frame) => {
      const [eventLine, dataLine] = frame.split('\n');
      return { event: eventLine!.slice('event: '.length), data: JSON.parse(dataLine!.slice('data: '.length)) };
    });
}

test.describe('Assistant with the Claude Code CLI', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(6 * 60_000);
    server = startServer();
    await waitForServer(5 * 60_000);
    api = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: { 'x-piwi-token': DESKTOP_TOKEN } });
  });

  test.afterAll(async () => {
    await api?.dispose();
    stopServer();
  });

  test('one CLI run answers through the endpoint and token minted for the answer', async ({ playwright }) => {
    test.setTimeout(3 * 60_000);
    const configured = await api.put('/api/settings/ai', {
      data: { roles: { diagnosis: { provider: 'claude-cli', model: 'fake-sonnet' } }, autoDiagnose: false },
    });
    expect(configured.ok(), await configured.text()).toBeTruthy();
    const status = (await (await api.get('/api/assistant/status')).json()) as AssistantStatus;
    expect(status).toMatchObject({ available: true, provider: 'claude-cli', model: 'fake-sonnet', toolMode: 'native' });

    const submitted = await api.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.ASSISTANT_CLAUDE_CODE,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [{ title: 'opens the cart', status: 'passed', duration: 900 }],
      },
    });
    expect(submitted.ok()).toBeTruthy();

    const { id } = (await (await api.post('/api/assistant/conversations', { data: {} })).json()) as { id: number };
    const asked = await api.post(`/api/assistant/conversations/${id}/messages`, {
      data: { text: 'Which projects report here?', context: { route: '/', page: '/' } },
    });
    expect(asked.ok()).toBeTruthy();
    const events = parseEvents(await asked.text());
    expect(events.map((e) => e.event)).toEqual(['text', 'tool', 'block', 'text', 'done']);
    const answer = `The project **${PROJECT.ASSISTANT_CLAUDE_CODE}** reports here [list_projects].`;
    expect(events[0]!.data).toEqual({ text: 'Looking at the projects.' });
    expect(events[1]!.data).toMatchObject({ name: 'list_projects', summary: 'List projects' });
    expect(events[2]!.data.block).toMatchObject({
      kind: 'entity',
      id: 'project-card',
      entity: { type: 'project', label: PROJECT.ASSISTANT_CLAUDE_CODE },
    });
    expect(events[3]!.data).toEqual({ text: answer });
    expect(events[4]!.data).toMatchObject({
      provider: 'claude-cli',
      model: 'claude-fake-1',
      toolMode: 'native',
      inputTokens: 1230,
      outputTokens: 45,
      costUsd: 0.0123,
      messageId: expect.any(Number),
    });

    const conversation = (await (await api.get(`/api/assistant/conversations/${id}`)).json()) as AssistantConversation;
    expect(conversation.messages[1]).toMatchObject({
      status: 'completed',
      provider: 'claude-cli',
      model: 'claude-fake-1',
      inputTokens: 1230,
      outputTokens: 45,
      toolCalls: [{ name: 'list_projects', summary: 'List projects' }],
      blocks: [
        { kind: 'text', text: 'Looking at the projects.' },
        { kind: 'entity', id: 'project-card' },
        { kind: 'text', text: answer },
      ],
    });

    // What the CLI was given: the answer's endpoint as its one MCP server, its tools only, no built-in tool.
    expect(existsSync(recordPath)).toBe(true);
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      args: string[];
      config: { mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }> };
      tools: string[];
      probes: Record<string, number>;
      prompt: string;
    };
    const after = (flag: string) => record.args[record.args.indexOf(flag) + 1];
    expect(JSON.stringify(record)).not.toContain(DESKTOP_TOKEN);
    expect(Object.keys(record.config.mcpServers)).toEqual(['piwi']);
    const endpoint = record.config.mcpServers.piwi!;
    expect(endpoint).toMatchObject({ type: 'http', url: `${BASE}/api/assistant/conversations/${id}/mcp` });
    expect(endpoint.headers.Authorization).toMatch(/^Bearer pwt_[0-9a-f]{64}$/);
    expect(after('--tools')).toBe('');
    expect(record.args).toContain('--strict-mcp-config');
    expect(after('--max-turns')).toBe('12');
    expect(after('--permission-mode')).toBe('dontAsk');
    const allowed = after('--allowedTools')!.split(',');
    expect(allowed).toEqual(
      expect.arrayContaining(['mcp__piwi__list_projects', 'mcp__piwi__show_entity', 'mcp__piwi__read_local_source']),
    );
    expect(record.prompt).toBe('Which projects report here?');
    // The tools it was served: the toolbox, the desktop app's read_local_source with it, no tool that writes.
    expect(record.tools).toEqual(
      expect.arrayContaining(['list_projects', 'find_tools', 'find_anchors', 'read_local_source']),
    );
    for (const write of ['set_cluster_status', 'apply_locator_fix', 'import_local_report']) {
      expect(allowed).not.toContain(`mcp__piwi__${write}`);
      expect(record.tools).not.toContain(write);
    }
    // While the answer ran, its token opened no other route and no other conversation's endpoint.
    expect(record.probes).toEqual({ otherRoute: 401, mcpRoute: 401, otherConversation: 401 });

    // Once the answer is over, the token opens nothing, the desktop token alongside it included.
    const bare = await playwright.request.newContext({ baseURL: BASE });
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect((await bare.post(endpoint.url, { headers: endpoint.headers, data: list })).status()).toBe(401);
    expect((await api.post(endpoint.url, { headers: endpoint.headers, data: list })).status()).toBe(401);
    expect((await bare.get('/api/projects', { headers: endpoint.headers })).status()).toBe(401);
    await bare.dispose();

    await api.delete(`/api/assistant/conversations/${id}`);
    await api.put('/api/settings/ai', { data: { roles: null } });
  });
});
