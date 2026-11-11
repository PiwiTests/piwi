import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatEditorDiscovery, type EditorDiscovery } from '@piwitests/core/editor-discovery';
import { McpRouter, machineHosts, type RouterHost } from '../src/cli/mcp.js';

/**
 * `piwi mcp`, the agents' router: one set of run tools for every host of the machine, each call routed to the host of
 * its run, run_start to the editor whose workspace holds the spec. Two fake hosts stand in for two editors: each
 * answers MCP over HTTP as an editor's agents' server does, with its runs and the calls it heard.
 */

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

interface FakeHost {
  url: string;
  token: string;
  /** The tool calls it heard, by name, with their arguments. */
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** An editor's agents' server: its tools, its runs, and run_start naming a new run. */
async function fakeHost(token: string, runs: string[], starts: boolean): Promise<FakeHost> {
  const calls: FakeHost['calls'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end();
        return;
      }
      const message = JSON.parse(body) as { id: number; method: string; params: Record<string, unknown> };
      const answer = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      };
      if (message.method === 'tools/list') {
        const tools = ['run_list', 'run_follow', 'run_control', 'page_snapshot', 'code_write', 'get_flaky_tests'];
        return answer({
          tools: [...(starts ? ['run_start'] : []), ...tools].map((name) => ({
            name,
            description: `${name} of ${token.slice(0, 1)}`,
            inputSchema: { type: 'object' },
          })),
        });
      }
      const call = message.params as { name: string; arguments: Record<string, unknown> };
      calls.push(call);
      const text = (value: unknown) => answer({ content: [{ type: 'text', text: JSON.stringify(value) }] });
      if (call.name === 'run_list') {
        return answer({
          content: [
            { type: 'text', text: JSON.stringify({ ok: true, message: '', runs: runs.map((run) => ({ run })) }) },
            { type: 'text', text: `page content of ${token.slice(0, 1)}` },
          ],
        });
      }
      if (call.name === 'run_start')
        return text({ ok: true, message: 'Started.', run: `started-${token.slice(0, 1)}` });
      return text({ ok: true, message: `${call.name} on ${token.slice(0, 1)}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let folder: string;
let a: FakeHost;
let b: FakeHost;
let hosts: RouterHost[];

beforeAll(async () => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-mcp-router-'));
  fs.mkdirSync(path.join(folder, 'shop', 'tests'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'admin', 'tests'), { recursive: true });
  a = await fakeHost(TOKEN_A, ['ed-a1'], true);
  b = await fakeHost(TOKEN_B, ['ed-b1', 'terminal-1-2'], true);
  hosts = [
    {
      key: 'a',
      name: 'Editor A',
      url: a.url,
      headers: { authorization: `Bearer ${a.token}` },
      roots: [path.join(folder, 'shop')],
    },
    {
      key: 'b',
      name: 'Editor B',
      url: b.url,
      headers: { authorization: `Bearer ${b.token}` },
      roots: [path.join(folder, 'admin')],
    },
  ];
});

afterAll(async () => {
  await a.close();
  await b.close();
  fs.rmSync(folder, { recursive: true, force: true });
});

async function call(router: McpRouter, name: string, args: Record<string, unknown> = {}) {
  const answer = await router.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const result = answer!.result as { content: Array<{ text: string }>; isError?: boolean };
  return { result, body: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
}

describe('the agents’ router', () => {
  it('forwards one set of the hosts’ run tools, run_start first, and no other tool they serve', async () => {
    const router = new McpRouter({ hosts: async () => hosts });
    const listed = await router.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const tools = (listed!.result as { tools: Array<{ name: string; description: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      'run_start',
      'run_list',
      'run_follow',
      'run_control',
      'page_snapshot',
      'code_write',
    ]);
    // One definition per name: the first host's.
    expect(tools[1]!.description).toBe('run_list of a');
  });

  it('lists every host’s runs, each named with its host, and routes a call to the host of its run', async () => {
    const router = new McpRouter({ hosts: async () => hosts });
    const { result, body } = await call(router, 'run_list');
    expect(body.runs).toEqual([
      { host: 'Editor A', run: 'ed-a1' },
      { host: 'Editor B', run: 'ed-b1' },
      { host: 'Editor B', run: 'terminal-1-2' },
    ]);
    // What came from each host's pages follows, as it came.
    expect(result.content.slice(1).map((item) => item.text)).toEqual(['page content of a', 'page content of b']);
    b.calls.length = 0;
    expect((await call(router, 'run_control', { run: 'terminal-1-2', action: 'pause' })).body).toMatchObject({
      message: 'run_control on b',
    });
    expect(b.calls).toEqual([{ name: 'run_control', arguments: { run: 'terminal-1-2', action: 'pause' } }]);
    // A run nobody lists is refused, after the hosts are asked again.
    expect((await call(router, 'run_follow', { run: 'gone' })).result.isError).toBe(true);
  });

  it('finds the host of a run it has not listed yet by asking the hosts first', async () => {
    const router = new McpRouter({ hosts: async () => hosts });
    a.calls.length = 0;
    expect((await call(router, 'page_snapshot', { run: 'ed-a1' })).body).toMatchObject({
      message: 'page_snapshot on a',
    });
    expect(a.calls.map((one) => one.name)).toEqual(['run_list', 'page_snapshot']);
  });

  it('starts a run on the editor whose workspace holds the spec, named after the agent, and follows it there', async () => {
    const router = new McpRouter({ hosts: async () => hosts, cwd: folder });
    await router.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientInfo: { name: 'Claude Code' } },
    });
    b.calls.length = 0;
    const { body } = await call(router, 'run_start', { file: 'admin/tests/users.spec.ts', line: 4 });
    expect(body).toMatchObject({ ok: true, run: 'started-b' });
    expect(b.calls).toEqual([
      {
        name: 'run_start',
        arguments: { agent: 'Claude Code', file: path.join(folder, 'admin', 'tests', 'users.spec.ts'), line: 4 },
      },
    ]);
    b.calls.length = 0;
    await call(router, 'run_follow', { run: 'started-b' });
    expect(b.calls.map((one) => one.name)).toEqual(['run_follow']);
    // A spec no editor's workspace holds starts nothing.
    const elsewhere = await call(router, 'run_start', { file: path.join(os.tmpdir(), 'x.spec.ts') });
    expect(elsewhere.result.isError).toBe(true);
  });

  it('says a host that does not answer, and refuses a tool that is no run tool', async () => {
    const gone: RouterHost = { key: 'c', name: 'Editor C', url: 'http://127.0.0.1:9/mcp', headers: {}, roots: [] };
    const router = new McpRouter({ hosts: async () => [...hosts, gone] });
    const { body } = await call(router, 'run_list');
    expect(body.message).toContain('Editor C did not answer.');
    expect((body.runs as unknown[]).length).toBe(3);
    expect((await call(router, 'get_flaky_tests')).result.isError).toBe(true);
  });

  it('tells the agent its tools changed once the hosts did', async () => {
    let now = hosts;
    const told: unknown[] = [];
    const router = new McpRouter({ hosts: async () => now, notify: (message) => told.push(message) });
    await router.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    await router.checkHosts();
    expect(told).toEqual([]);
    now = hosts.slice(0, 1);
    await router.checkHosts();
    expect(told).toEqual([{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]);
  });
});

describe('the hosts of this machine', () => {
  it('are the editors whose discovery files name their agents’ server, and no desktop app that is not running', async () => {
    const editors = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-mcp-editors-'));
    fs.chmodSync(editors, 0o700);
    const discovery = (pid: number, agents: EditorDiscovery['agents']): EditorDiscovery => ({
      pid,
      host: os.hostname(),
      version: '0.69.0',
      client: `Editor ${pid}`,
      startedAt: new Date().toISOString(),
      roots: [folder],
      hub: null,
      runChannel: null,
      recorderBundle: null,
      ...(agents ? { agents } : {}),
    });
    fs.writeFileSync(
      path.join(editors, `${process.pid}.json`),
      formatEditorDiscovery(discovery(process.pid, { url: a.url, token: a.token })),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(editors, `${process.ppid}.json`),
      formatEditorDiscovery(discovery(process.ppid, undefined)),
      {
        mode: 0o600,
      },
    );
    try {
      const found = await machineHosts({
        PIWI_EDITORS_DIR: editors,
        PIWI_DESKTOP_CONFIG: path.join(editors, 'none.json'),
      });
      expect(found).toEqual([
        {
          key: `editor-${process.pid}`,
          name: `Editor ${process.pid}`,
          url: a.url,
          headers: { authorization: `Bearer ${a.token}` },
          roots: [folder],
        },
      ]);
    } finally {
      fs.rmSync(editors, { recursive: true, force: true });
    }
  });

  it('serves them over stdio as `piwi mcp`', async () => {
    const cli = path.join(__dirname, '..', 'dist', 'cli', 'index.js');
    if (!fs.existsSync(cli)) return;
    const child = spawn(process.execPath, [cli, 'mcp'], {
      env: {
        ...process.env,
        PIWI_EDITORS_DIR: path.join(folder, 'no-editors'),
        PIWI_DESKTOP_CONFIG: path.join(folder, 'none.json'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_list', arguments: {} } })}\n`,
    );
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(0);
    const answers = out
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> });
    expect(answers.find((answer) => answer.id === 1)!.result).toMatchObject({ serverInfo: { name: 'piwi-runs' } });
    const listed = answers.find((answer) => answer.id === 2)!.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(listed.isError).toBe(true);
    expect(listed.content[0]!.text).toContain('No editor with Piwi nor the desktop app serves runs');
  });
});
