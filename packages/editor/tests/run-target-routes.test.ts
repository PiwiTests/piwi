import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RunRequestOffer } from '@piwitests/core/run-request';
import { cookiesOf, isBrowserRequest, presentsToken, TOKEN_COOKIE } from '../src/host-guard';
import type * as RunTargetStream from '../src/run-target-stream';
import { MAX_HUB_BUFFERED } from '../src/run-hub';
import { resetDesktopRunTarget } from '../src/run-target';
import { MAX_RUN_TARGET_BODY, serveRunTarget } from '../src/run-target-http';
import { matchRunTargetRoute, RUN_TARGET_BASE, RUN_TARGET_ROUTES } from '../src/run-target-routes';
import {
  answerSession,
  mintSessionCode,
  queryOf,
  SESSION_CODE_TTL_MS,
  SESSION_PATH,
  sessionCookieHeader,
  takeSessionCode,
} from '../src/run-target-session';
import {
  limitedSend,
  matchStream,
  SHELL_STREAM_PATH,
  STREAM_CUT_BYTES,
  STREAM_HOLD_BYTES,
  WINDOW_STREAM_PATH,
  type StreamSink,
} from '../src/run-target-stream';

/** How many times each stream's `stop` ran: the stop a stream returns runs once, when its reader leaves. */
const stopped = vi.hoisted(() => ({ window: 0, shell: 0, opened: 0 }));

vi.mock('../src/run-target-stream', async (importOriginal) => {
  const actual = await importOriginal<typeof RunTargetStream>();
  return {
    ...actual,
    openWindowStream: (send: Parameters<typeof actual.openWindowStream>[0]) => {
      stopped.opened++;
      const stop = actual.openWindowStream(send);
      return () => {
        stopped.window++;
        stop();
      };
    },
    openShellStream: (send: Parameters<typeof actual.openShellStream>[0]) => {
      stopped.opened++;
      const stop = actual.openShellStream(send);
      return () => {
        stopped.shell++;
        stop();
      };
    },
  };
});

/**
 * The contract of the run-target routes, the window's session and its two event streams, on a bare `node:http` host:
 * what every host of them answers (the desktop app's Nitro routes answer the same,
 * `apps/application/tests/unit/desktop-run-target.test.ts` and `desktop-events-stream.test.ts`).
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
    /** The instance asks the app to stop the requests `stops`. */
    stop: (...stops: string[]) => {
      for (const res of streams) res.write(`data: ${JSON.stringify({ type: 'snapshot', requests: [], stops })}\n\n`);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of streams) res.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface OpenStream {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** The messages received so far. */
  messages: unknown[];
  close(): void;
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
          {
            method,
            headers: {
              ...(payload === undefined && method !== 'POST' && method !== 'PUT'
                ? {}
                : { 'Content-Type': 'application/json' }),
              ...headers,
            },
          },
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
    /** A GET of `route` on the host, its redirect not followed. */
    get: (route: string, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Record<string, unknown> | null }>(
        (resolve, reject) => {
          http
            .get(`${base}${route}`, { headers }, (res) => {
              let text = '';
              res.setEncoding('utf8');
              res.on('data', (chunk: string) => (text += chunk));
              res.on('end', () =>
                resolve({
                  status: res.statusCode ?? 0,
                  headers: res.headers,
                  body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
                }),
              );
            })
            .on('error', reject);
        },
      ),
    /** An event stream of the host: the status, the headers and, as they arrive, the messages. */
    stream: (route: string, headers: Record<string, string> = {}) =>
      new Promise<OpenStream>((resolve, reject) => {
        const messages: unknown[] = [];
        const req = http.get(`${base}${route}`, { headers }, (res) => {
          let pending = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            pending += chunk;
            for (let end = pending.indexOf('\n\n'); end >= 0; end = pending.indexOf('\n\n')) {
              const frame = pending.slice(0, end);
              pending = pending.slice(end + 2);
              if (frame.startsWith('data: ')) messages.push(JSON.parse(frame.slice(6)));
            }
          });
          res.on('error', () => {});
          if (res.statusCode !== 200) res.resume();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, messages, close: () => req.destroy() });
        });
        req.on('error', (error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
        });
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
  sendsBody: route.method === 'POST' || route.method === 'PUT',
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

  test('answers 415 to a POST or PUT that is not application/json, with a body or without', async () => {
    const decision = '{"decision":"run"}';
    for (const call of ROUTE_CALLS.filter((c) => c.sendsBody)) {
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'text/plain;application/json']) {
        const answer = await host.call(call.method, call.route, { ...SHELL, 'Content-Type': type }, decision);
        expect(answer.status, `${call.name} ${type}`).toBe(415);
        expect(answer.body).toEqual({ message: 'The body is application/json' });
      }
      const sent = await host.call(call.method, call.route, { ...SHELL, 'Content-Type': '' }, decision);
      expect(sent.status, call.name).toBe(415);
      const bodiless = await host.call(call.method, call.route, { ...SHELL, 'Content-Type': 'text/plain' });
      expect(bodiless.status, `${call.name} without a body`).toBe(415);
    }
  });

  test('refuses a request by its headers before reading its body', async () => {
    const large = JSON.stringify({ instance: 'x'.repeat(MAX_RUN_TARGET_BODY) });
    expect((await host.call('POST', '/connect', { ...SHELL, 'Content-Type': 'text/plain' }, large)).status).toBe(415);
    expect((await host.call('PUT', '/links', BROWSER, large)).status).toBe(403);
    expect((await host.call('POST', '/requests/x/answer', SHELL, large)).status).toBe(400);
    expect((await host.call('GET', '', SHELL)).status).toBe(200);
  });

  test('reads a JSON body whatever the case or parameters of its type', async () => {
    for (const type of ['application/json', 'Application/JSON', 'application/json; charset=utf-8']) {
      const answer = await host.call(
        'POST',
        `/requests/${REQUEST_ID}/answer`,
        { ...SHELL, 'Content-Type': type },
        { decision: 'yes' },
      );
      expect(answer.status, type).toBe(400);
    }
  });

  test('answers 413 to a body past 64 KB, and keeps answering', async () => {
    const large = JSON.stringify({ instance: 'x'.repeat(MAX_RUN_TARGET_BODY) });
    expect((await host.call('POST', '/connect', SHELL, large)).status).toBe(413);
    expect((await host.call('POST', '/connect', SHELL, { instance: 'x'.repeat(1000) })).status).toBe(400);
    expect((await host.call('GET', '', SHELL)).status).toBe(200);
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

describe('every host of the window session', () => {
  const session = (query: string) => `${SESSION_PATH}${query}`;
  /** A session code as the shell gets one, over the shell-only route. */
  const mint = async (): Promise<string> => {
    const answer = await host.call('POST', '/session-code', SHELL, {});
    expect(answer.status).toBe(200);
    return (answer.body as { code: string }).code;
  };

  test('gives a session code to the shell only, and never stores it', async () => {
    const answer = await host.call('POST', '/session-code', SHELL, {});
    expect(answer).toMatchObject({ status: 200, noStore: true });
    expect((answer.body as { code: string }).code).toMatch(/^pds_[0-9a-f]{64}$/);
    expect((await host.call('POST', '/session-code', BROWSER, {})).status).toBe(403);
    expect((await host.call('POST', '/session-code', { 'x-piwi-token': 'pd_wrong' }, {})).status).toBe(401);
    expect((await host.call('POST', '/session-code', {}, {})).status).toBe(401);
    expect(await mint()).not.toBe(await mint());
  });

  test('answers 403 to a code that is missing, unknown or sent twice', async () => {
    const code = await mint();
    for (const query of ['', '?code=', `?code=${code}0`, `?code=${code}&code=${code}`, `?code[]=${code}`]) {
      const answer = await host.get(session(query));
      expect(answer.status, query).toBe(403);
      expect(answer.body, query).toEqual({ message: 'Invalid session code' });
      expect(answer.headers['set-cookie'], query).toBeUndefined();
    }
  });

  test('opens nothing for the access token on the URL, as `token` or as `code`', async () => {
    for (const query of [`?token=${TOKEN}`, `?code=${TOKEN}`, `?token=${TOKEN}&code=${TOKEN}`]) {
      const answer = await host.get(session(query));
      expect(answer.status, query).toBe(403);
      expect(answer.headers['set-cookie'], query).toBeUndefined();
    }
  });

  test('exchanges the code for the cookie and redirects to the home page', async () => {
    const answer = await host.get(session(`?code=${await mint()}`));
    expect(answer.status).toBe(302);
    expect(answer.headers.location).toBe('/');
    expect(answer.headers['set-cookie']).toEqual([
      `${TOKEN_COOKIE}=${TOKEN}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`,
    ]);
  });

  test('takes a code once: the second use is refused and sets no cookie', async () => {
    const code = await mint();
    expect((await host.get(session(`?code=${code}`))).status).toBe(302);
    const again = await host.get(session(`?code=${code}`));
    expect(again.status).toBe(403);
    expect(again.headers['set-cookie']).toBeUndefined();
  });

  test('uses up a code that fails, so a refused page does not leave it to try again', async () => {
    const code = await mint();
    expect((await host.get(session(`?code=${code}&to=${encodeURIComponent('/日本')}`))).status).toBe(400);
    expect((await host.get(session(`?code=${code}`))).status).toBe(403);
  });

  test('refuses a code after its lifetime, and a code before it has run out is still good', () => {
    const at = 1_000_000;
    const late = mintSessionCode(at);
    expect(answerSession({ code: late }, TOKEN, at + SESSION_CODE_TTL_MS)).toEqual({
      status: 403,
      message: 'Invalid session code',
    });
    expect(answerSession({ code: late }, TOKEN, at)).toEqual({ status: 403, message: 'Invalid session code' });
    const timely = mintSessionCode(at);
    expect(answerSession({ code: timely }, TOKEN, at + SESSION_CODE_TTL_MS - 1)).toMatchObject({ status: 302 });
  });

  test('keeps at most a few codes: a new one past the cap drops the oldest', () => {
    const codes = Array.from({ length: 9 }, () => mintSessionCode());
    expect(takeSessionCode(codes[0])).toBe(false);
    expect(takeSessionCode(codes[8])).toBe(true);
    expect(takeSessionCode(codes[1])).toBe(true);
    expect(takeSessionCode(undefined)).toBe(false);
    expect(takeSessionCode(['x'])).toBe(false);
  });

  test('redirects to the dashboard page `to` names, and to the home page for anything else', async () => {
    const to = async (page: string) =>
      (await host.get(session(`?code=${await mint()}&to=${encodeURIComponent(page)}`))).headers.location;
    expect(await to('/projects/3/runs?tab=failed#top')).toBe('/projects/3/runs?tab=failed');
    for (const refused of [
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '/api/projects',
      '/_nuxt/a',
      '/logo.svg',
      'https://evil.example',
    ]) {
      expect(await to(refused), refused).toBe('/');
    }
  });

  test('answers 400 to a page a Location header cannot hold, and sets no cookie', async () => {
    for (const page of ['/日本', '/café', '/a b']) {
      const answer = await host.get(session(`?code=${await mint()}&to=${encodeURIComponent(page)}`));
      expect(answer.status, page).toBe(400);
      expect(answer.body, page).toEqual({ message: 'Invalid page' });
      expect(answer.headers['set-cookie'], page).toBeUndefined();
    }
    expect(answerSession({ code: mintSessionCode(), to: '/日本' }, TOKEN)).toEqual({
      status: 400,
      message: 'Invalid page',
    });
  });

  test('answers without the guard, and the cookie it sets passes the guard of the streams', async () => {
    expect((await host.get(WINDOW_STREAM_PATH)).status).toBe(401);
    const set = (await host.get(session(`?code=${await mint()}`))).headers['set-cookie']![0]!;
    const stream = await host.stream(WINDOW_STREAM_PATH, { cookie: set.split(';')[0]! });
    expect(stream.status).toBe(200);
    stream.close();
  });

  test('answers 404 on a host without a token, and builds the cookie header as the hosts send it', () => {
    expect(answerSession({ code: mintSessionCode() }, undefined)).toEqual({ status: 404, message: 'Not found' });
    expect(answerSession({ code: mintSessionCode() }, '')).toEqual({ status: 404, message: 'Not found' });
    const answer = answerSession({ code: mintSessionCode(), to: '/runs' }, TOKEN);
    expect(answer).toMatchObject({ status: 302, location: '/runs' });
    if (answer.status !== 302) throw new Error('not signed in');
    expect(sessionCookieHeader({ ...answer.cookie, value: 'a b;c' })).toBe(
      `${TOKEN_COOKIE}=a%20b%3Bc; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`,
    );
    expect(queryOf('/x?a=1&b=2&a=3&c=%20')).toEqual({ a: ['1', '3'], b: '2', c: ' ' });
  });
});

describe('every host of the run target streams', () => {
  test('matches the streams by method and path, and nothing else', () => {
    expect(matchStream('GET', `${WINDOW_STREAM_PATH}?x=1`)).toBe('window');
    expect(matchStream('get', `${SHELL_STREAM_PATH}/`)).toBe('shell');
    expect(matchStream('POST', WINDOW_STREAM_PATH)).toBeNull();
    expect(matchStream('GET', `${WINDOW_STREAM_PATH}-other`)).toBeNull();
    expect(matchStream('GET', '/api/desktop/runs/events')).toBeNull();
  });

  test('answers 401 to a request without the token, and serves the stream with it', async () => {
    for (const route of [WINDOW_STREAM_PATH, SHELL_STREAM_PATH]) {
      expect(await host.get(route), route).toMatchObject({
        status: 401,
        body: { message: 'Desktop access token required' },
      });
      expect((await host.get(route, { 'x-piwi-token': 'pd_wrong' })).status, route).toBe(401);
      const stream = await host.stream(route, SHELL);
      expect(stream.status, route).toBe(200);
      expect(stream.headers['content-type'], route).toBe('text/event-stream');
      expect(stream.headers['cache-control'], route).toBe('no-cache, no-transform');
      expect(stream.headers['x-accel-buffering'], route).toBe('no');
      stream.close();
    }
  });

  test('tells the window the connection first, then each request it is asked about', async () => {
    const first = await host.stream(WINDOW_STREAM_PATH, SHELL);
    await until(() => first.messages.length === 1);
    expect(first.messages[0]).toMatchObject({ type: 'run-target', connection: { state: 'none' } });

    await host.call('PUT', '/key', SHELL, { instance: instance.url, key: KEY, links: { 3: folder } });
    await until(() => first.messages.some((m) => (m as { type: string }).type === 'run-request'));
    expect(first.messages.map((m) => (m as { type: string }).type)[0]).toBe('run-target');
    first.close();

    // A window that opens later hears the connection, then the request again.
    const later = await host.stream(WINDOW_STREAM_PATH, SHELL);
    await until(() => later.messages.length >= 2);
    expect(later.messages.map((m) => (m as { type: string }).type).slice(0, 2)).toEqual(['run-target', 'run-request']);
    expect(later.messages[1]).toMatchObject({ request: { id: REQUEST_ID } });
    later.close();
  });

  test('tells the shell the stop of a run it started, and nothing before', async () => {
    const shell = await host.stream(SHELL_STREAM_PATH, SHELL);
    await host.call('PUT', '/key', SHELL, { instance: instance.url, key: KEY, links: { 3: folder } });
    await until(async () => (((await host.call('GET', '', SHELL)).body?.requests ?? []) as unknown[]).length === 1);
    const asked = ((await host.call('GET', '', SHELL)).body!.requests as { command: string }[])[0]!;
    await host.call('POST', `/requests/${REQUEST_ID}/answer`, SHELL, { decision: 'run', command: asked.command });
    await host.call('POST', `/requests/${REQUEST_ID}/launch`, SHELL);
    expect(shell.messages).toEqual([]);

    instance.stop(REQUEST_ID);
    await until(() => shell.messages.length === 1);
    expect(shell.messages).toEqual([{ type: 'requested-run-stop', requestId: REQUEST_ID }]);
    shell.close();
  });

  test('ends the stream of a reader that leaves, once, and keeps answering', async () => {
    // The streams of the tests before have left.
    await until(() => stopped.window + stopped.shell === stopped.opened);
    const before = { ...stopped };
    const window = await host.stream(WINDOW_STREAM_PATH, SHELL);
    const shell = await host.stream(SHELL_STREAM_PATH, SHELL);
    await until(() => window.messages.length === 1);
    expect(stopped.window + stopped.shell).toBe(before.window + before.shell);

    window.close();
    await until(() => stopped.window === before.window + 1);
    expect(stopped.shell).toBe(before.shell);

    shell.close();
    await until(() => stopped.shell === before.shell + 1);
    await host.call('PUT', '/key', SHELL, { instance: instance.url, key: KEY, links: { 3: folder } });
    expect((await host.call('GET', '', SHELL)).status).toBe(200);
    expect(stopped).toMatchObject({ window: before.window + 1, shell: before.shell + 1 });
  });
});

/** A sink with a reader that has read `unread` bytes less than was written. */
function fakeSink(counts = true) {
  const sent: unknown[] = [];
  const drains: (() => void)[] = [];
  const state = { unread: 0, closed: 0 };
  const base = { send: (message: unknown) => void sent.push(message), close: () => void state.closed++ };
  const sink: StreamSink = counts
    ? { ...base, buffered: () => state.unread, onDrain: (listener) => void drains.push(listener) }
    : base;
  return {
    sink,
    sent,
    state,
    /** The reader reads everything but `left` bytes. */
    read: (left: number) => {
      state.unread = left;
      for (const listener of drains) listener();
    },
  };
}

describe('the unread data of a stream', () => {
  test('requires a sink that counts to say when its reader reads', () => {
    // @ts-expect-error `buffered` without `onDrain`
    const half: StreamSink = { send: () => undefined, close: () => undefined, buffered: () => 0 };
    expect(half.onDrain).toBeUndefined();
  });

  test('keeps the cut where the run hub puts it', () => {
    expect(STREAM_CUT_BYTES).toBe(MAX_HUB_BUFFERED);
    expect(STREAM_HOLD_BYTES).toBe(1024 * 1024);
  });

  test('sends straight out when the sink cannot count', () => {
    const { sink, sent, state } = fakeSink(false);
    const send = limitedSend(sink);
    for (let i = 0; i < 3; i++) send({ i });
    expect(sent).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
    expect(state.closed).toBe(0);
  });

  test('holds a message past 1 MB and sends the held ones in order once the reader catches up', () => {
    const { sink, sent, state, read } = fakeSink();
    const send = limitedSend(sink);
    send({ i: 0 });
    state.unread = STREAM_HOLD_BYTES + 1;
    send({ i: 1 });
    send({ i: 2 });
    expect(sent).toEqual([{ i: 0 }]);

    // Still behind: nothing goes out.
    read(STREAM_HOLD_BYTES + 1);
    expect(sent).toEqual([{ i: 0 }]);

    read(0);
    expect(sent).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
    // A message after the flush does not overtake, and does not wait.
    send({ i: 3 });
    expect(sent[sent.length - 1]).toEqual({ i: 3 });
    expect(state.closed).toBe(0);
  });

  test('keeps a message behind the ones that wait, though the reader is caught up', () => {
    const { sink, sent, state } = fakeSink();
    const send = limitedSend(sink);
    state.unread = STREAM_HOLD_BYTES + 1;
    send({ i: 1 });
    state.unread = 0;
    send({ i: 2 });
    expect(sent).toEqual([]);
  });

  test('cuts the stream once, counting what waits, past 32 MB', () => {
    const { sink, sent, state, read } = fakeSink();
    const send = limitedSend(sink);
    state.unread = STREAM_CUT_BYTES - 100;
    send({ i: 1 });
    expect(state.closed).toBe(0);

    state.unread = STREAM_CUT_BYTES;
    send({ i: 2 });
    expect(state.closed).toBe(1);
    send({ i: 3 });
    read(0);
    expect(state.closed).toBe(1);
    expect(sent).toEqual([]);
  });

  test('counts the bytes a message is written as, framing included', () => {
    const { sink, sent, state } = fakeSink();
    const send = limitedSend(sink);
    // Fewer characters than the cut, more bytes: each euro sign is one character and three bytes.
    const text = '€'.repeat(12 * 1024 * 1024);
    expect(JSON.stringify({ text }).length).toBeLessThan(STREAM_CUT_BYTES);
    send({ text });
    expect(state.closed).toBe(1);
    expect(sent).toEqual([]);

    const edge = fakeSink();
    const sendEdge = limitedSend(edge.sink);
    const framed = (message: unknown) => Buffer.byteLength(`data: ${JSON.stringify(message)}\n\n`);
    edge.state.unread = STREAM_CUT_BYTES - framed({ i: 1 });
    sendEdge({ i: 1 });
    expect(edge.state.closed).toBe(0);
    edge.state.unread += 1;
    sendEdge({ i: 2 });
    expect(edge.state.closed).toBe(1);
  });

  test('counts what waits toward the cut', () => {
    const { sink, state } = fakeSink();
    const send = limitedSend(sink);
    state.unread = STREAM_HOLD_BYTES + 1;
    const big = { text: 'x'.repeat(STREAM_CUT_BYTES / 2) };
    send(big);
    expect(state.closed).toBe(0);
    send(big);
    send(big);
    expect(state.closed).toBe(1);
  });
});
