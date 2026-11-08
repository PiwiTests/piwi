import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type { H3Event } from 'h3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RunRequestOffer } from '@piwitests/core/run-request';
import type { RunTargetMessage } from '@piwitests/editor/run-target-view';
import { apiError } from '../../server/utils/api-error';
import {
  answerRunRequest,
  connectRunTarget,
  instanceUrlOf,
  keyToKeep,
  launchOf,
  linksOf,
  outcomeOf,
  planAgain,
  requestedRunEnded,
  requestedRunStarted,
  resetDesktopRunTarget,
  setRunTargetKind,
  setRunTargetVersion,
  shutdownRunTarget,
  runTargetConnection,
  subscribeRunTargetShell,
  subscribeRunTargetWindow,
  useKeptKey,
  useLinks,
  type ShellRunTargetCommand,
} from '@piwitests/editor/run-target';

/**
 * The desktop app as a run target: the bundled server claims what a team instance offers, checks it against the
 * linked folder, asks in the window, hands the shell the request token once after **Run**, reports the run, and tells
 * the shell a stop. The device flow keeps its key for the shell; the shell-only routes refuse a browser.
 */

vi.mock('../../server/utils/auth', () => ({ requireAuth: async () => ({ id: 1 }) }));
vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('setResponseHeader', () => {});
vi.stubGlobal('getRouterParam', (event: { params?: Record<string, string> }, name: string) => event.params?.[name]);
vi.stubGlobal(
  'getRequestHeader',
  (event: { node: { req: { headers: Record<string, string> } } }, name: string) => event.node.req.headers[name],
);

const KEY = `pd_${'a'.repeat(64)}`;
const TOKEN = `pdq_${'b'.repeat(64)}`;
const REQUEST_ID = 'c'.repeat(32);

let folder: string;
let instance: Awaited<ReturnType<typeof fakeInstance>>;
/** The sign-in page the fake instance names, else its own `/connect`. */
let verifyAt: string | null = null;

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

async function fakeInstance() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const streams: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      calls.push({ method: req.method ?? '', path: url, body: raw ? JSON.parse(raw) : null });
      if (url === '/api/run-targets/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'snapshot', requests: [offer()], stops: [] })}\n\n`);
        streams.push(res);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (url === '/api/extension/connect') {
        res.end(
          JSON.stringify({
            deviceCode: 'dev',
            userCode: 'ABCD-EFGH',
            verificationUrl: verifyAt ?? `http://${req.headers.host}/connect`,
            interval: 1,
            expiresIn: 600,
          }),
        );
      } else if (url === '/api/extension/connect/token') {
        res.end(JSON.stringify({ status: 'approved', apiKey: KEY }));
      } else if (url === '/api/run-targets/requests') {
        res.end(JSON.stringify({ requests: [], stops: [] }));
      } else if (url.endsWith('/claim')) {
        const { expiresAt: _expiresAt, ...request } = offer();
        res.end(JSON.stringify(request));
      } else if (url.endsWith('/answer')) {
        res.end(JSON.stringify({ state: 'starting', requestToken: TOKEN }));
      } else res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    stop: (id: string) => {
      for (const res of streams) res.write(`data: ${JSON.stringify({ type: 'stop', id })}\n\n`);
    },
    revoke: () => {
      for (const res of streams) res.write(`data: ${JSON.stringify({ type: 'revoked' })}\n\n`);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of streams) res.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

beforeEach(async () => {
  process.env.PIWI_DESKTOP_TOKEN = 'desktop-token';
  folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-target-')));
  fs.mkdirSync(path.join(folder, 'tests'));
  fs.writeFileSync(path.join(folder, 'tests', 'checkout.spec.ts'), '');
  fs.writeFileSync(path.join(folder, 'playwright.config.ts'), 'export default {};\n');
  fs.mkdirSync(path.join(folder, 'node_modules', '@playwright', 'test'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'node_modules', '@playwright', 'test', 'package.json'), '{}');
  instance = await fakeInstance();
});

afterEach(async () => {
  verifyAt = null;
  resetDesktopRunTarget();
  await instance.close();
  fs.rmSync(folder, { recursive: true, force: true });
  delete process.env.PIWI_DESKTOP_TOKEN;
});

describe('the values the routes take', () => {
  test('an instance URL is http(s), without credentials or a trailing slash', () => {
    expect(instanceUrlOf('https://piwi.example.com/')).toBe('https://piwi.example.com');
    expect(instanceUrlOf('https://piwi.example.com/team/')).toBe('https://piwi.example.com/team');
    expect(instanceUrlOf('https://robin:secret@piwi.example.com')).toBe(null);
    expect(instanceUrlOf('file:///etc/passwd')).toBe(null);
    expect(instanceUrlOf(42)).toBe(null);
  });

  test('links map project ids to folders', () => {
    expect(linksOf({ '3': '/work/shop' })).toEqual(new Map([[3, '/work/shop']]));
    expect(linksOf({ x: '/work' })).toBe(null);
    expect(linksOf({ '3': 5 })).toBe(null);
    expect(linksOf([])).toBe(null);
  });

  test('an outcome from how Playwright exited', () => {
    expect(outcomeOf(0, false)).toBe('passed');
    expect(outcomeOf(1, false)).toBe('failed');
    expect(outcomeOf(130, false)).toBe('stopped');
    expect(outcomeOf(2, false)).toBe('error');
    expect(outcomeOf(null, false)).toBe('error');
    expect(outcomeOf(0, true)).toBe('stopped');
    expect(outcomeOf(null, true)).toBe('stopped');
  });
});

describe('a request from the team instance', () => {
  test('is claimed, checked and asked about, then run once with its token, reported, and stopped', async () => {
    const heard: RunTargetMessage[] = [];
    const shell: ShellRunTargetCommand[] = [];
    subscribeRunTargetWindow((message) => heard.push(message));
    subscribeRunTargetShell((command) => shell.push(command));
    setRunTargetVersion('0.68.0');
    useKeptKey(instance.url, KEY, new Map([[3, folder]]));

    await until(() => heard.some((m) => m.type === 'run-request'));
    const asked = heard.find((m) => m.type === 'run-request')!;
    expect(asked.type === 'run-request' && asked.request).toMatchObject({
      id: REQUEST_ID,
      runnable: true,
      hasFolder: true,
      instance: instance.url,
    });
    expect(JSON.stringify(heard)).not.toContain(KEY);
    const self = instance.calls.find((c) => c.path === '/api/run-targets/self')!;
    expect(self.body).toMatchObject({ version: '0.68.0', projectIds: [3] });

    // Run with a command the window did not show is asked about again.
    expect(await answerRunRequest(REQUEST_ID, 'run', 'npx playwright test')).toMatchObject({
      ok: false,
      statusCode: 409,
    });
    const shown = asked.type === 'run-request' ? asked.request.command : null;
    // A plan under way when **Run** comes never shows the request again.
    const replanning = planAgain(REQUEST_ID);
    const answering = answerRunRequest(REQUEST_ID, 'run', shown);
    expect(await replanning).toBe(null);
    // Nothing plans the request again while **Run** is being answered.
    expect(await planAgain(REQUEST_ID)).toBe(null);
    expect(await answering).toEqual({ ok: true, launch: true });
    expect(JSON.stringify(heard)).not.toContain(TOKEN);
    // A folder linked after **Run** changes nothing it approved: the shell refuses a folder other than this one.
    useLinks(new Map([[3, path.join(folder, 'elsewhere')]]));
    expect(await planAgain(REQUEST_ID)).toBe(null);
    const launch = launchOf(REQUEST_ID)!;
    expect(launch).toMatchObject({ instance: instance.url, token: TOKEN, projectId: 3, folder });
    expect(launch.args).toContain('--headed');
    expect(launchOf(REQUEST_ID)).toBe(null);

    await requestedRunStarted(REQUEST_ID);
    instance.stop(REQUEST_ID);
    await until(() => shell.length > 0);
    expect(shell).toEqual([{ type: 'requested-run-stop', requestId: REQUEST_ID }]);
    await requestedRunEnded(REQUEST_ID, null, true);
    const states = instance.calls.filter((c) => c.path.endsWith('/state')).map((c) => c.body);
    expect(states).toEqual([
      { state: 'running' },
      { state: 'stopping', detail: 'Stopped from the dashboard' },
      { state: 'ended', outcome: 'stopped' },
    ]);
  });

  test('a folder without its specs is never launched, as it would run every test', async () => {
    const heard: RunTargetMessage[] = [];
    subscribeRunTargetWindow((message) => heard.push(message));
    fs.rmSync(path.join(folder, 'tests', 'checkout.spec.ts'));
    useKeptKey(instance.url, KEY, new Map([[3, folder]]));
    await until(() => heard.some((m) => m.type === 'run-request'));
    const asked = heard.find((m) => m.type === 'run-request')!;
    expect(asked.type === 'run-request' && asked.request.runnable).toBe(false);
    const shown = asked.type === 'run-request' ? asked.request.command : null;
    expect(await answerRunRequest(REQUEST_ID, 'run', shown)).toMatchObject({ ok: false, statusCode: 409 });
    expect(launchOf(REQUEST_ID)).toBe(null);
    expect(instance.calls.some((c) => c.path.endsWith('/answer'))).toBe(false);
  });

  test('without a linked folder, Not now refuses it with the failed check', async () => {
    const heard: RunTargetMessage[] = [];
    subscribeRunTargetWindow((message) => heard.push(message));
    useKeptKey(instance.url, KEY, new Map());
    await until(() => heard.some((m) => m.type === 'run-request'));
    expect(await answerRunRequest(REQUEST_ID, 'run')).toMatchObject({ ok: false, statusCode: 409 });
    expect(await answerRunRequest(REQUEST_ID, 'not-now')).toEqual({ ok: true, launch: false });
    const answer = instance.calls.find((c) => c.path.endsWith('/answer'))!;
    expect(answer.body).toEqual({
      decision: 'refused',
      detail: 'No folder is linked to this project on this machine.',
    });
    expect(launchOf(REQUEST_ID)).toBe(null);
  });
});

describe('a key the instance revoked', () => {
  test('tells the shell to forget it, once, and the window that the app is disconnected', async () => {
    const heard: RunTargetMessage[] = [];
    const shell: ShellRunTargetCommand[] = [];
    subscribeRunTargetWindow((message) => heard.push(message));
    subscribeRunTargetShell((command) => shell.push(command));
    useKeptKey(instance.url, KEY, new Map([[3, folder]]));
    await until(() => heard.some((m) => m.type === 'run-request'));

    instance.revoke();
    await until(() => shell.length > 0);
    expect(shell).toEqual([{ type: 'key-revoked', instance: instance.url }]);
    expect(runTargetConnection()).toMatchObject({ state: 'revoked', keyToKeep: false });
    expect(keyToKeep()).toBe(null);
    expect(JSON.stringify(shell)).not.toContain(KEY);
  });
});

describe('connecting', () => {
  test('the device flow gives a key for the shell to keep, once', async () => {
    const connection = await connectRunTarget(instance.url);
    expect(connection).toMatchObject({ state: 'signing-in', userCode: 'ABCD-EFGH' });
    expect(instance.calls[0]).toMatchObject({ path: '/api/extension/connect', body: { target: 'desktop' } });
    await until(() => keyToKeep() !== null);
    expect(keyToKeep()).toEqual({ instance: instance.url, key: KEY });
    expect(runTargetConnection().keyToKeep).toBe(true);
    useKeptKey(instance.url, KEY, new Map());
    expect(keyToKeep()).toBe(null);
  });

  test('names the app that serves the target: the desktop app unless Piwi Runner sets it', async () => {
    await connectRunTarget(instance.url);
    expect(instance.calls[0]).toMatchObject({ path: '/api/extension/connect', body: { target: 'desktop' } });

    setRunTargetKind('runner');
    await connectRunTarget(instance.url);
    expect(instance.calls.filter((c) => c.path === '/api/extension/connect').pop()).toMatchObject({
      body: { target: 'runner' },
    });

    resetDesktopRunTarget();
    await connectRunTarget(instance.url);
    expect(instance.calls.filter((c) => c.path === '/api/extension/connect').pop()).toMatchObject({
      body: { target: 'desktop' },
    });
  });

  test('opens the sign-in page of the address connected to, whatever page the answer names', async () => {
    verifyAt = 'https://elsewhere.example.com/connect';
    const connection = await connectRunTarget(instance.url);
    expect(connection).toMatchObject({
      state: 'signing-in',
      verificationUrl: `${instance.url}/extension/connect?code=ABCD-EFGH`,
    });
  });
});

describe('the host stopping', () => {
  test('closes the connection to the instance, tells the window its requests are gone, and drops the listeners', async () => {
    const heard: RunTargetMessage[] = [];
    subscribeRunTargetWindow((message) => heard.push(message));
    useKeptKey(instance.url, KEY, new Map([[3, folder]]));
    await until(() => heard.some((m) => m.type === 'run-request'));

    shutdownRunTarget();
    expect(runTargetConnection().state).toBe('none');
    expect(heard.some((m) => m.type === 'run-request-gone' && m.id === REQUEST_ID)).toBe(true);

    const count = heard.length;
    const calls = instance.calls.length;
    useLinks(new Map([[3, folder]]));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(heard).toHaveLength(count);
    expect(instance.calls).toHaveLength(calls);
  });
});

describe('the shell’s routes', () => {
  type Route = (event: H3Event) => Promise<unknown>;
  const asked = (headers: Record<string, string>, params: Record<string, string> = {}, body?: string) =>
    ({
      context: {},
      params,
      node: { req: Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), { headers }), res: {} },
    }) as unknown as H3Event;

  test('refuse a request a browser sends, and answer the shell', async () => {
    const getKey = (await import('../../server/api/desktop/run-target/key.post')).default as Route;
    const launch = (await import('../../server/api/desktop/run-target/requests/[id]/launch.post')).default as Route;
    const browser = { origin: 'http://127.0.0.1:3000' };
    await expect(getKey(asked(browser))).rejects.toMatchObject({ statusCode: 403 });
    await expect(launch(asked(browser, { id: REQUEST_ID }))).rejects.toMatchObject({ statusCode: 403 });
    const json = { 'content-type': 'application/json' };
    await expect(getKey(asked(json))).rejects.toMatchObject({ statusCode: 404 });
    await expect(launch(asked(json, { id: 'x' }))).rejects.toMatchObject({ statusCode: 400 });
  });

  test('refuse a body that is not application/json, as the node host does', async () => {
    const connect = (await import('../../server/api/desktop/run-target/connect.post')).default as Route;
    const answer = (await import('../../server/api/desktop/run-target/requests/[id]/answer.post')).default as Route;
    const decision = '{"decision":"run"}';
    for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
      await expect(answer(asked({ 'content-type': type }, { id: REQUEST_ID }, decision))).rejects.toMatchObject({
        statusCode: 415,
      });
    }
    await expect(
      answer(asked({ 'content-type': 'text/plain' }, { id: REQUEST_ID }, 'decision=run')),
    ).rejects.toMatchObject({ statusCode: 415 });
    await expect(connect(asked({}, {}, '{"instance":"ftp://piwi.example.com"}'))).rejects.toMatchObject({
      statusCode: 415,
    });
    for (const type of ['application/json', 'Application/JSON; charset=utf-8']) {
      await expect(
        connect(asked({ 'content-type': type }, {}, '{"instance":"ftp://piwi.example.com"}')),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  test('refuse a POST that is not application/json before reading its body, bodiless ones included', async () => {
    const plan = (await import('../../server/api/desktop/run-target/requests/[id]/plan.post')).default as Route;
    const launch = (await import('../../server/api/desktop/run-target/requests/[id]/launch.post')).default as Route;
    const params = { id: REQUEST_ID };
    for (const route of [plan, launch]) {
      await expect(route(asked({}, params))).rejects.toMatchObject({ statusCode: 415 });
      await expect(route(asked({ 'content-type': 'text/plain' }, params, '{}'))).rejects.toMatchObject({
        statusCode: 415,
      });
    }
    await expect(launch(asked({ 'content-type': 'application/json' }, params))).rejects.toMatchObject({
      statusCode: 404,
    });
    const body = asked({ 'content-type': 'text/plain' }, params, '{}');
    await expect(plan(body)).rejects.toMatchObject({ statusCode: 415 });
    expect(body.node.req.readableDidRead).toBe(false);
  });

  test('give a session code to the shell only, and answer 404 on the server build', async () => {
    const mint = (await import('../../server/api/desktop/run-target/session-code.post')).default as Route;
    const json = { 'content-type': 'application/json' };
    await expect(mint(asked({ ...json, origin: 'http://127.0.0.1:3000' }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(mint(asked({}))).rejects.toMatchObject({ statusCode: 415 });
    expect(await mint(asked(json, {}, '{}'))).toEqual({ code: expect.stringMatching(/^pds_[0-9a-f]{64}$/) });
    delete process.env.PIWI_DESKTOP_TOKEN;
    await expect(mint(asked(json, {}, '{}'))).rejects.toMatchObject({ statusCode: 404 });
  });

  test('answer 404 on the server build', async () => {
    delete process.env.PIWI_DESKTOP_TOKEN;
    const status = (await import('../../server/api/desktop/run-target/index.get')).default as Route;
    await expect(status(asked({}))).rejects.toMatchObject({ statusCode: 404 });
  });
});
