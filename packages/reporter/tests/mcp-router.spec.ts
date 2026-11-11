import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DESKTOP_CHALLENGE_HEADER, DESKTOP_PROOF_HEADER, desktopTokenProof } from '@piwitests/core/desktop-proof';
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
            inputSchema:
              name === 'run_start'
                ? { type: 'object', properties: { file: { type: 'string' }, agent: { type: 'string' } } }
                : { type: 'object' },
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
  fs.writeFileSync(path.join(folder, 'admin', 'tests', 'users.spec.ts'), '');
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
    const tools = (
      listed!.result as {
        tools: Array<{ name: string; description: string; inputSchema: { properties?: Record<string, unknown> } }>;
      }
    ).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      'run_start',
      'run_list',
      'run_follow',
      'run_control',
      'page_snapshot',
      'code_write',
    ]);
    // One definition per name: the first host's, run_list saying each run names its host.
    expect(tools[1]!.description).toBe(
      'run_list of a Through `piwi mcp`, the runs of every editor with Piwi and of the desktop app, each naming its host (`host`).',
    );
    // The router names the agent that starts a run, from its `initialize`: run_start takes no name.
    expect(Object.keys(tools[0]!.inputSchema.properties ?? {})).toEqual(['file']);
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
    // The agent's own `agent` gives way to the name its `initialize` gave.
    const { body } = await call(router, 'run_start', { file: 'admin/tests/users.spec.ts', line: 4, agent: 'x' });
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

  it('reads a relative spec against the editors’ folders when the working directory does not hold it', async () => {
    const router = new McpRouter({ hosts: async () => hosts, cwd: os.tmpdir() });
    b.calls.length = 0;
    expect((await call(router, 'run_start', { file: 'tests/users.spec.ts' })).body).toMatchObject({ ok: true });
    expect(b.calls[0]!.arguments.file).toBe(path.join(folder, 'admin', 'tests', 'users.spec.ts'));
  });

  it.skipIf(process.platform === 'win32')(
    'names a spec reached through a link under the editor’s own folder',
    async () => {
      const link = path.join(folder, 'linked-admin');
      if (!fs.existsSync(link)) fs.symlinkSync(path.join(folder, 'admin'), link);
      const router = new McpRouter({ hosts: async () => hosts });
      b.calls.length = 0;
      await call(router, 'run_start', { file: path.join(link, 'tests', 'users.spec.ts') });
      expect(b.calls[0]!.arguments.file).toBe(path.join(folder, 'admin', 'tests', 'users.spec.ts'));
    },
  );

  it('answers a message that is no JSON-RPC request, and a failure of its own, with an error', async () => {
    const router = new McpRouter({ hosts: async () => hosts });
    expect(await router.handle(null)).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await router.handle({ jsonrpc: '2.0', id: 3 })).toMatchObject({ id: 3, error: { code: -32600 } });
    const broken = new McpRouter({
      hosts: () => Promise.reject(new Error('unreadable discovery folder')),
    });
    expect(await broken.handle({ jsonrpc: '2.0', id: 4, method: 'tools/list' })).toMatchObject({
      id: 4,
      error: { code: -32603 },
    });
  });

  it('cancels a call at its host when the agent cancels it', async () => {
    let aborted = false;
    const router = new McpRouter({
      hosts: async () => hosts.slice(0, 1),
      post: (_host, body, _ms, signal) => {
        const name = (body.params as { name?: string }).name;
        if (name === 'run_list') {
          const runs = JSON.stringify({ ok: true, message: '', runs: [{ run: 'ed-a1' }] });
          return Promise.resolve({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: runs }] } });
        }
        return new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('the agent cancelled the call'));
          }),
        );
      },
    });
    const following = router.handle({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'run_follow', arguments: { run: 'ed-a1' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await router.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } })).toBe(
      null,
    );
    const answer = await following;
    expect(aborted).toBe(true);
    expect((answer!.result as { isError?: boolean }).isError).toBe(true);
  });

  it('sends the desktop app’s token only to a server that proved it holds it', async () => {
    const heard: string[] = [];
    const desktop = http.createServer((req, res) => {
      heard.push(`${req.url} ${req.headers.authorization ?? ''}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>((resolve) => desktop.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(desktop.address() as AddressInfo).port}`;
    try {
      const unproven: RouterHost = {
        key: 'desktop',
        name: 'the desktop app',
        url: `${base}/mcp`,
        headers: { authorization: `Bearer ${TOKEN_A}` },
        roots: [],
        proves: { server: base, token: TOKEN_A },
      };
      const router = new McpRouter({ hosts: async () => [unproven] });
      const { body } = await call(router, 'run_list');
      expect(body.message).toContain('the desktop app did not answer');
      expect(heard.length).toBeGreaterThan(0);
      expect(heard.every((line) => line.startsWith('/api/health') && !line.includes(TOKEN_A))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => desktop.close(() => resolve()));
    }
  });

  it('reaches a desktop app whose server proved it holds the token', async () => {
    const heard: string[] = [];
    const desktop = http.createServer(async (req, res) => {
      heard.push(req.url ?? '');
      if (req.url === '/api/health') {
        const challenge = String(req.headers[DESKTOP_CHALLENGE_HEADER]);
        const { port } = desktop.address() as AddressInfo;
        res.writeHead(200, { [DESKTOP_PROOF_HEADER]: await desktopTokenProof(TOKEN_B, port, challenge) }).end('{}');
        return;
      }
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const message = JSON.parse(body) as { id: number };
        const runs = JSON.stringify({ ok: true, message: '', runs: [{ run: 'desk-1' }] });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: runs }] } }),
        );
      });
    });
    await new Promise<void>((resolve) => desktop.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(desktop.address() as AddressInfo).port}`;
    try {
      const proven: RouterHost = {
        key: 'desktop',
        name: 'the desktop app',
        url: `${base}/mcp`,
        headers: { authorization: `Bearer ${TOKEN_B}` },
        roots: [],
        proves: { server: base, token: TOKEN_B },
      };
      const { body } = await call(new McpRouter({ hosts: async () => [proven] }), 'run_list');
      expect(body.runs).toEqual([{ host: 'the desktop app', run: 'desk-1' }]);
      expect(heard).toEqual(['/api/health', '/mcp']);
    } finally {
      await new Promise<void>((resolve) => desktop.close(() => resolve()));
    }
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

  it('tells the agent once a host that did not answer its tools answers them', async () => {
    let answers = false;
    const told: unknown[] = [];
    const router = new McpRouter({
      hosts: async () => hosts.slice(0, 1),
      notify: (message) => told.push(message),
      post: (_host, body) =>
        answers
          ? Promise.resolve({ jsonrpc: '2.0', id: body.id, result: { tools: [] } })
          : Promise.reject(new Error('starting')),
    });
    await router.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    await router.checkHosts();
    expect(told).toEqual([]);
    answers = true;
    await router.checkHosts();
    expect(told).toEqual([{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]);
    await router.checkHosts();
    expect(told.length).toBe(1);
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
    // A service whose run channel is no socket of this user's is not the one that wrote the file.
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(editors, 'not-a-socket'), '');
    fs.writeFileSync(
      path.join(editors, `${other.pid}.json`),
      formatEditorDiscovery({
        ...discovery(other.pid!, { url: b.url, token: b.token }),
        runChannel: { path: path.join(editors, 'not-a-socket'), token: 'c'.repeat(32) },
      }),
      { mode: 0o600 },
    );
    try {
      const found = await machineHosts({
        PIWI_EDITORS_DIR: editors,
        PIWI_DESKTOP_CONFIG: path.join(editors, 'none.json'),
      });
      expect(found).toEqual([
        {
          key: `editor-${process.pid}`,
          name: `Editor ${process.pid} (${path.basename(folder)})`,
          startedAt: expect.any(String),
          url: a.url,
          headers: { authorization: `Bearer ${a.token}` },
          roots: [folder],
        },
      ]);
    } finally {
      other.kill();
      fs.rmSync(editors, { recursive: true, force: true });
    }
  });

  const cli = path.join(__dirname, '..', 'dist', 'cli', 'index.js');
  it.skipIf(!fs.existsSync(cli))('serves them over stdio as `piwi mcp`', async () => {
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
    // A message that is no request, alone or in a batch, is answered with an error.
    child.stdin.write('null\n');
    child.stdin.write(`${JSON.stringify([null, { jsonrpc: '2.0', id: 3, method: 'ping' }])}\n`);
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
    const lines = out.trim().split('\n');
    expect(lines).toContain(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request: a message is a JSON-RPC object.' },
      }),
    );
    expect(lines).toContain(
      JSON.stringify([
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid Request: a message is a JSON-RPC object.' },
        },
        { jsonrpc: '2.0', id: 3, result: {} },
      ]),
    );
  });
});
