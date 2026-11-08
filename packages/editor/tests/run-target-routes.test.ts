import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { RunRequestOffer } from '@piwitests/core/run-request';
import { cookiesOf, isBrowserRequest, presentsToken, TOKEN_COOKIE } from '../src/host-guard';
import { resetDesktopRunTarget } from '../src/run-target';
import { serveRunTarget } from '../src/run-target-http';
import { matchRunTargetRoute, RUN_TARGET_BASE, RUN_TARGET_ROUTES } from '../src/run-target-routes';

/**
 * The contract of the run-target routes, on a bare `node:http` host: what every host of them answers (the desktop
 * app's Nitro routes answer the same, `apps/application/tests/unit/desktop-run-target.test.ts`).
 */

const TOKEN = `pd_${'d'.repeat(64)}`;
const KEY = `pd_${'a'.repeat(64)}`;
const REQUEST_TOKEN = `pdq_${'b'.repeat(64)}`;
const REQUEST_ID = 'c'.repeat(32);
const SHELL = { 'x-piwi-token': TOKEN };
const BROWSER = { ...SHELL, origin: 'http://127.0.0.1:3000' };

function offer(): RunRequestOffer {
  return {
    id: REQUEST_ID,
    kind: 'run',
    projectId: 3,
    tests: [{ filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card', line: 12, projectName: 'chromium' }],
    options: { headed: true },
    source: { runId: 7 },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

/** A team instance that offers one request, gives its key and its request token. */
async function fakeInstance() {
  const streams: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = req.url ?? '';
      if (url === '/api/run-targets/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'snapshot', requests: [offer()], stops: [] })}\n\n`);
        streams.push(res);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (url === '/api/run-targets/requests') res.end(JSON.stringify({ requests: [], stops: [] }));
      else if (url.endsWith('/claim')) {
        const { expiresAt: _expiresAt, ...request } = offer();
        res.end(JSON.stringify(request));
      } else if (url.endsWith('/answer')) res.end(JSON.stringify({ state: 'starting', requestToken: REQUEST_TOKEN }));
      else res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of streams) res.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The bare host: the run-target routes, and 404 for anything else. */
async function bareHost() {
  const served: Promise<boolean>[] = [];
  const server = http.createServer((req, res) => {
    const serving = serveRunTarget(req, res, TOKEN);
    served.push(serving);
    void serving.then((served) => {
      if (!served) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    /** A request as the shell sends one: `node:http`, which adds no `Sec-Fetch-*` header, unlike `fetch`. */
    call: (method: string, route: string, headers: Record<string, string> = {}, body?: unknown) =>
      new Promise<{ status: number; noStore: boolean; body: Record<string, unknown> | null }>((resolve, reject) => {
        const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
        const req = http.request(
          `${base}${RUN_TARGET_BASE}${route}`,
          { method, headers: { ...headers, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) } },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (text += chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                noStore: res.headers['cache-control'] === 'no-store',
                body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(payload);
      }),
    served,
    port: (server.address() as AddressInfo).port,
    other: () => fetch(`${base}/api/health`).then((r) => r.status),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const until = async (check: () => boolean | Promise<boolean>, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

let host: Awaited<ReturnType<typeof bareHost>>;
let instance: Awaited<ReturnType<typeof fakeInstance>>;
let folder: string;

beforeEach(async () => {
  folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-target-routes-')));
  fs.mkdirSync(path.join(folder, 'tests'));
  fs.writeFileSync(path.join(folder, 'tests', 'checkout.spec.ts'), '');
  fs.writeFileSync(path.join(folder, 'playwright.config.ts'), 'export default {};\n');
  fs.mkdirSync(path.join(folder, 'node_modules', '@playwright', 'test'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'node_modules', '@playwright', 'test', 'package.json'), '{}');
  host = await bareHost();
  instance = await fakeInstance();
});

afterEach(async () => {
  resetDesktopRunTarget();
  await host.close();
  await instance.close();
  fs.rmSync(folder, { recursive: true, force: true });
});

const ROUTE_CALLS = Object.entries(RUN_TARGET_ROUTES).map(([name, route]) => ({
  name,
  method: route.method,
  route: route.path.replace(':id', REQUEST_ID),
  shellOnly: route.shellOnly,
}));

describe('the guard', () => {
  test('takes the token from the cookie, the x-piwi-token header, a bearer or X-API-Key, in constant time', () => {
    const asked = (headers: Record<string, string>) => ({ headers, cookies: cookiesOf(headers.cookie) });
    expect(presentsToken(asked({ cookie: `other=1; ${TOKEN_COOKIE}=${TOKEN}` }), TOKEN)).toBe(true);
    expect(presentsToken(asked({ 'x-piwi-token': TOKEN }), TOKEN)).toBe(true);
    expect(presentsToken(asked({ authorization: `bearer ${TOKEN}` }), TOKEN)).toBe(true);
    expect(presentsToken(asked({ 'x-api-key': TOKEN }), TOKEN)).toBe(true);
    expect(presentsToken(asked({}), TOKEN)).toBe(false);
    expect(presentsToken(asked({ 'x-piwi-token': `${TOKEN}0` }), TOKEN)).toBe(false);
    expect(isBrowserRequest({ headers: { 'sec-fetch-mode': 'cors' } })).toBe(true);
    expect(isBrowserRequest({ headers: { 'x-piwi-token': TOKEN } })).toBe(false);
  });

  test('matches the routes by method and path, and nothing else', () => {
    expect(matchRunTargetRoute('GET', `${RUN_TARGET_BASE}?x=1`)).toEqual({ name: 'status' });
    expect(matchRunTargetRoute('POST', `${RUN_TARGET_BASE}/requests/${REQUEST_ID}/launch`)).toEqual({
      name: 'launch',
      id: REQUEST_ID,
    });
    expect(matchRunTargetRoute('POST', `${RUN_TARGET_BASE}/connect/`)).toEqual({ name: 'connect' });
    expect(matchRunTargetRoute('GET', `${RUN_TARGET_BASE}/key`)).toBeNull();
    expect(matchRunTargetRoute('GET', `${RUN_TARGET_BASE}-other`)).toBeNull();
    expect(matchRunTargetRoute('POST', '/api/desktop/runs/picks')).toBeNull();
  });
});

describe('every host of the run-target routes', () => {
  test('answers 401 to a request without the token, on every route', async () => {
    for (const call of ROUTE_CALLS) {
      expect((await host.call(call.method, call.route)).status, call.name).toBe(401);
      expect((await host.call(call.method, call.route, { 'x-piwi-token': 'pd_wrong' })).status, call.name).toBe(401);
    }
    expect(await host.other()).toBe(404);
  });

  test('refuses a browser on the shell-only routes, and only there', async () => {
    for (const call of ROUTE_CALLS.filter((c) => c.shellOnly)) {
      const answer = await host.call(call.method, call.route, BROWSER, call.method === 'DELETE' ? undefined : {});
      expect(answer.status, call.name).toBe(403);
      expect(answer.body).toEqual({ message: 'The desktop shell alone calls this route' });
    }
    expect((await host.call('GET', '', BROWSER)).status).toBe(200);
    expect(
      (await host.call('GET', '', { cookie: `${TOKEN_COOKIE}=${TOKEN}`, origin: 'http://127.0.0.1:3000' })).status,
    ).toBe(200);
  });

  test('answers 400 to a bad body or request id', async () => {
    expect((await host.call('POST', '/connect', SHELL, { instance: 'ftp://piwi.example.com' })).status).toBe(400);
    expect((await host.call('POST', '/connect', SHELL, 'not json')).status).toBe(400);
    expect((await host.call('PUT', '/key', SHELL, { instance: instance.url, key: 'secret', links: {} })).status).toBe(
      400,
    );
    expect((await host.call('PUT', '/links', SHELL, { links: { x: folder } })).status).toBe(400);
    expect((await host.call('POST', `/requests/${REQUEST_ID}/answer`, SHELL, { decision: 'yes' })).status).toBe(400);
    for (const call of ROUTE_CALLS.filter((c) => c.route.includes(REQUEST_ID))) {
      expect((await host.call(call.method, call.route.replace(REQUEST_ID, 'x'), SHELL, {})).status, call.name).toBe(
        400,
      );
    }
  });

  test('settles a request whose client leaves mid-body, and answers the next one', async () => {
    await new Promise<void>((resolve) => {
      const socket = net.connect(host.port, '127.0.0.1', () => {
        socket.write(
          `POST ${RUN_TARGET_BASE}/connect HTTP/1.1\r\nHost: 127.0.0.1\r\nx-piwi-token: ${TOKEN}\r\n` +
            'Content-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"ins',
          () => setTimeout(() => (socket.destroy(), resolve()), 50),
        );
      });
    });
    await until(() => host.served.length > 0);
    await expect(Promise.all(host.served)).resolves.toEqual([true]);
    expect((await host.call('GET', '', SHELL)).status).toBe(200);
  });

  test('answers launch once, after Run, and keeps the shell’s answers out of caches', async () => {
    const used = await host.call('PUT', '/key', SHELL, { instance: instance.url, key: KEY, links: { 3: folder } });
    expect(used).toEqual({ status: 200, noStore: true, body: { ok: true } });
    await until(async () => {
      const status = await host.call('GET', '', SHELL);
      return ((status.body?.requests ?? []) as unknown[]).length === 1;
    });
    const status = await host.call('GET', '', SHELL);
    expect(status.noStore).toBe(true);
    const [asked] = status.body!.requests as { command: string; runnable: boolean }[];
    expect(asked!.runnable).toBe(true);

    expect((await host.call('POST', `/requests/${REQUEST_ID}/launch`, SHELL)).status).toBe(404);
    const answered = await host.call('POST', `/requests/${REQUEST_ID}/answer`, SHELL, {
      decision: 'run',
      command: asked!.command,
    });
    expect(answered).toMatchObject({ status: 200, body: { launch: true } });

    const launch = await host.call('POST', `/requests/${REQUEST_ID}/launch`, SHELL);
    expect(launch).toMatchObject({
      status: 200,
      noStore: true,
      body: { instance: instance.url, token: REQUEST_TOKEN, projectId: 3, folder },
    });
    expect((await host.call('POST', `/requests/${REQUEST_ID}/launch`, SHELL)).status).toBe(404);
  });
});
