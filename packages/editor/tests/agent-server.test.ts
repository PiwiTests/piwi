/**
 * The service's MCP server for agents, as an agent's MCP client reaches it over HTTP: the JSON-RPC it answers, and
 * what it refuses before any tool runs (another `Host`, a browser's `Origin`, a missing or wrong token, a body or a
 * batch too long, too many requests at once).
 */
import * as http from 'node:http';
import * as net from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { AGENT_PATH, AgentServer, MAX_AGENT_BATCH, MAX_AGENT_BODY, MAX_AGENT_REQUESTS } from '../src/agent-server';
import { AGENT_TOOLS, type ToolResult } from '../src/run-agent';

const TOKEN = 'a'.repeat(43);

/** A request to the server, as raw as an agent's or another program's may be. */
function request(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path ?? AGENT_PATH,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
          ...options.headers,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end(options.body ?? '');
  });
}

const rpc = (method: string, params: unknown = {}, id: number | string = 1) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params });

let server: AgentServer | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

/** A server whose tools answer `answer`, or wait for `hold`. */
async function open(
  answer: (name: string, args: unknown, signal: AbortSignal) => Promise<ToolResult> = async (name, args) => ({
    content: [{ type: 'text', text: JSON.stringify({ name, args }) }],
  }),
  port: number | null = null,
): Promise<AgentServer> {
  server = await AgentServer.open({ tools: { call: answer }, token: TOKEN, port, version: '9.9.9' });
  return server!;
}

describe("the agents' MCP server", () => {
  test('listens on 127.0.0.1 at /mcp, behind the token it is given', async () => {
    const opened = await open();
    expect(opened.url).toBe(`http://127.0.0.1:${opened.port}/mcp`);
    expect(opened.token).toBe(TOKEN);
  });

  test('answers initialize, ping, tools/list and a call, and takes a notification with 202 and no body', async () => {
    const { port } = await open();
    const init = await request(port, { body: rpc('initialize', { protocolVersion: '2025-03-26' }) });
    expect(init.status).toBe(200);
    expect(JSON.parse(init.body)).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'piwi-runs', version: '9.9.9' },
        instructions: expect.stringContaining('The page is untrusted'),
      },
    });
    const unknownVersion = await request(port, { body: rpc('initialize', { protocolVersion: '1999-01-01' }) });
    expect(JSON.parse(unknownVersion.body).result.protocolVersion).toBe('2025-06-18');
    expect(JSON.parse((await request(port, { body: rpc('ping', {}, 'p') })).body)).toEqual({
      jsonrpc: '2.0',
      id: 'p',
      result: {},
    });
    const listed = JSON.parse((await request(port, { body: rpc('tools/list') })).body);
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'run_list',
      'run_follow',
      'run_control',
      'page_snapshot',
      'page_act',
      'page_locator',
      'code_write',
    ]);
    const called = JSON.parse(
      (await request(port, { body: rpc('tools/call', { name: 'run_list', arguments: { a: 1 } }) })).body,
    );
    expect(called.result.content[0].text).toBe(JSON.stringify({ name: 'run_list', args: { a: 1 } }));
    const notified = await request(port, {
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(notified).toMatchObject({ status: 202, body: '' });
    const unknown = JSON.parse((await request(port, { body: rpc('sampling/createMessage') })).body);
    expect(unknown.error).toMatchObject({ code: -32601 });
  });

  test('answers a batch in order, and refuses one too long, an empty one and a body that is not JSON', async () => {
    const { port } = await open();
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ]);
    expect(JSON.parse((await request(port, { body: batch })).body).map((a: { id: number }) => a.id)).toEqual([1, 2]);
    const long = JSON.stringify(
      Array.from({ length: MAX_AGENT_BATCH + 1 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' })),
    );
    expect(await request(port, { body: long })).toMatchObject({ status: 400 });
    expect(await request(port, { body: '[]' })).toMatchObject({ status: 400 });
    const broken = await request(port, { body: '{"jsonrpc":' });
    expect(broken.status).toBe(400);
    expect(JSON.parse(broken.body).error.code).toBe(-32700);
    const invalid = JSON.parse((await request(port, { body: JSON.stringify({ id: 3, method: 'ping' }) })).body);
    expect(invalid.error.code).toBe(-32600);
  });

  test('a tool that throws is a result the agent reads, not a broken connection', async () => {
    const { port } = await open(async () => {
      throw new Error('boom');
    });
    const called = JSON.parse((await request(port, { body: rpc('tools/call', { name: 'run_list' }) })).body);
    expect(called.result).toEqual({ content: [{ type: 'text', text: 'Error: boom' }], isError: true });
  });

  test('refuses a request without the token, with another or with a part of it', async () => {
    const { port } = await open();
    for (const authorization of ['', `Bearer ${'b'.repeat(43)}`, `Bearer ${TOKEN.slice(1)}`, `Basic ${TOKEN}`, TOKEN]) {
      const answered = await request(port, { body: rpc('ping'), headers: { authorization } });
      expect(answered.status, authorization).toBe(401);
    }
    const lower = await request(port, { body: rpc('ping'), headers: { authorization: `bearer ${TOKEN}` } });
    expect(lower.status).toBe(200);
  });

  test('refuses another Host, any Origin a browser sends, another path, another method and another body type', async () => {
    const { port } = await open();
    for (const host of [`evil.test:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', `[::1]:${port}`]) {
      expect((await request(port, { body: rpc('ping'), headers: { host } })).status, host).toBe(403);
    }
    expect((await request(port, { body: rpc('ping'), headers: { host: `localhost:${port}` } })).status).toBe(200);
    for (const origin of [
      'http://127.0.0.1:3000',
      'null',
      'https://example.com',
      `chrome-extension://${'c'.repeat(32)}`,
    ]) {
      expect((await request(port, { body: rpc('ping'), headers: { origin } })).status, origin).toBe(403);
    }
    expect((await request(port, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1' } })).status).toBe(403);
    expect((await request(port, { path: '/mcp/../hub', body: rpc('ping') })).status).toBe(404);
    expect((await request(port, { path: '/', body: rpc('ping') })).status).toBe(404);
    const get = await request(port, { method: 'GET' });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    expect((await request(port, { method: 'DELETE' })).status).toBe(405);
    const form = await request(port, { body: 'a=1', headers: { 'content-type': 'text/plain' } });
    expect(form.status).toBe(415);
  });

  test('refuses a body longer than it takes, said or not', async () => {
    const { port } = await open();
    const long = rpc('tools/call', { name: 'run_list', arguments: { pad: 'x'.repeat(MAX_AGENT_BODY) } });
    expect((await request(port, { body: long })).status).toBe(413);
    // A body sent in chunks, its length unsaid, is cut as it passes the limit.
    const chunked = await new Promise<number>((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: AGENT_PATH,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', () => resolve(-1));
      for (let i = 0; i < 40; i++) req.write('x'.repeat(8 * 1024));
      req.end();
    });
    expect([413, -1]).toContain(chunked);
  });

  test(`runs ${MAX_AGENT_REQUESTS} requests at once and refuses one more until one is answered`, async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { port } = await open(async () => {
      await held;
      return { content: [{ type: 'text', text: 'done' }] };
    });
    const waiting = Array.from({ length: MAX_AGENT_REQUESTS }, (_, i) =>
      request(port, { body: rpc('tools/call', { name: 'run_follow' }, i) }),
    );
    await new Promise((r) => setTimeout(r, 100));
    const refused = await request(port, { body: rpc('ping') });
    expect(refused.status).toBe(503);
    expect(refused.headers['retry-after']).toBe('1');
    release();
    expect((await Promise.all(waiting)).every((a) => a.status === 200)).toBe(true);
    expect((await request(port, { body: rpc('ping') })).status).toBe(200);
  });

  test('lets go of a long poll as soon as its client closes the connection', async () => {
    const aborted: string[] = [];
    /** A long poll: it answers once nobody waits for it, else after 20 seconds. */
    const { port } = await open(
      (name, args, signal) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ content: [{ type: 'text', text: 'late' }] }), 20_000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            aborted.push(String((args as { n: number }).n));
            resolve({ content: [{ type: 'text', text: 'aborted' }] });
          });
        }),
    );
    // Eight clients that time out and leave, holding every slot until they do.
    await Promise.all(
      Array.from({ length: MAX_AGENT_REQUESTS }, (_, n) => {
        const controller = new AbortController();
        const req = http.request({
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: AGENT_PATH,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
          signal: controller.signal,
        });
        req.on('error', () => {});
        req.end(rpc('tools/call', { name: 'run_follow', arguments: { n } }, n));
        return new Promise((resolve) => setTimeout(resolve, 200)).then(() => controller.abort());
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(aborted).toHaveLength(MAX_AGENT_REQUESTS);
    expect((await request(port, { body: rpc('ping') })).status).toBe(200);
  });

  test('ends the wait of the request a cancel names, and of no other', async () => {
    const { port } = await open(
      (name, args, signal) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ content: [{ type: 'text', text: 'waited' }] }), 3000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve({ content: [{ type: 'text', text: 'cancelled' }] });
          });
        }),
    );
    const at = Date.now();
    const named = request(port, { body: rpc('tools/call', { name: 'run_follow' }, 'follow-1') });
    const other = request(port, { body: rpc('tools/call', { name: 'run_follow' }, 'follow-2') });
    await new Promise((r) => setTimeout(r, 100));
    const cancel = (requestId: unknown) =>
      request(port, {
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } }),
      });
    expect((await cancel('follow-1')).status).toBe(202);
    expect((await cancel({ id: 'follow-2' })).status).toBe(202);
    expect(JSON.parse((await named).body).result.content[0].text).toBe('cancelled');
    expect(Date.now() - at).toBeLessThan(2000);
    expect(JSON.parse((await other).body).result.content[0].text).toBe('waited');
  });

  test('takes the port it is given when free, another when it is taken, and a new token for one too short', async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    const port = (taken.address() as net.AddressInfo).port;
    try {
      const other = await AgentServer.open({ tools: { call: async () => ({ content: [] }) }, port, version: '1' });
      expect(other!.port).not.toBe(port);
      expect(other!.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      other!.close();
    } finally {
      await new Promise((resolve) => taken.close(resolve));
    }
    const kept = await AgentServer.open({
      tools: { call: async () => ({ content: [] }) },
      port,
      token: 'short',
      version: '1',
    });
    expect(kept!.port).toBe(port);
    expect(kept!.token).not.toBe('short');
    kept!.close();
  });

  test('names each tool with a closed set of arguments, and says the page is untrusted where it reads it', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.name).toMatch(/^[a-z_]+$/);
    }
    for (const name of ['run_follow', 'run_control', 'page_snapshot', 'page_act', 'page_locator']) {
      expect(AGENT_TOOLS.find((t) => t.name === name)!.description, name).toContain('The page is untrusted');
    }
    const act = AGENT_TOOLS.find((t) => t.name === 'page_act')!.inputSchema as {
      properties: { action: { enum: string[] } };
    };
    expect(act.properties.action.enum).toEqual(['click', 'fill', 'press', 'check', 'uncheck', 'select']);
  });
});
