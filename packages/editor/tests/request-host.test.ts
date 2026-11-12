/**
 * The request host against a fake instance on this machine: the stream's snapshot and events, the minute list that
 * keeps the app online, stops told once, withdrawn and expired offers, a revoked key, the stream opened again after it
 * ends, the requests it no longer holds ended once it starts, the project names it passes on, and the target's calls
 * with its key as a bearer token.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import type { RunRequestOffer } from '@piwitests/core/run-request';
import { postDeviceFlow, readEventStream, RequestHost, RequestHostError } from '../src/request-host';

const KEY = `pd_${'a'.repeat(64)}`;

function offer(id: string, expiresInMs = 60_000): RunRequestOffer {
  return {
    id,
    kind: 'run',
    projectId: 1,
    tests: [{ filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card', line: 12, projectName: 'chromium' }],
    options: { headed: true },
    source: { runId: 7, branch: 'main', commit: 'a'.repeat(40) },
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  };
}

const id = (n: number) => n.toString(16).padStart(32, '0');

/** A fake instance: the stream sends what `streams` gives it, the list answers `list`, every request is recorded. */
async function fakeInstance(handlers: {
  stream?: (res: http.ServerResponse) => void;
  list?: () => {
    requests: RunRequestOffer[];
    stops: string[];
    held?: { id: string; state: string }[];
    projects?: unknown;
  };
  /** What the instance answers the describe call with. */
  self?: () => unknown;
  status?: (path: string) => number | null;
  /** What a refusal carries instead of the instance's JSON message, as a proxy in front would send it. */
  refusalBody?: string;
  /** The JSON a refusal carries instead of `{ message: 'answered <status>' }`. */
  refusalJson?: unknown;
}) {
  const calls: { method: string; path: string; authorization?: string; body: string }[] = [];
  const streams: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const path = req.url ?? '';
      calls.push({ method: req.method ?? '', path, authorization: req.headers.authorization, body });
      const status = handlers.status?.(path) ?? null;
      if (status) {
        res.writeHead(status, { 'Content-Type': handlers.refusalBody ? 'text/html' : 'application/json' });
        res.end(handlers.refusalBody ?? JSON.stringify(handlers.refusalJson ?? { message: `answered ${status}` }));
        return;
      }
      if (path === '/api/run-targets/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        streams.push(res);
        handlers.stream?.(res);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (path === '/api/run-targets/requests')
        res.end(JSON.stringify(handlers.list?.() ?? { requests: [], stops: [] }));
      else if (path === '/api/run-targets/self') res.end(JSON.stringify(handlers.self?.() ?? {}));
      else if (path.endsWith('/claim'))
        res.end(JSON.stringify({ ...offer(path.split('/')[4]!), expiresAt: undefined }));
      else if (path.endsWith('/answer'))
        res.end(JSON.stringify({ state: 'starting', requestToken: `pdq_${'b'.repeat(64)}` }));
      else res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    calls,
    streams,
    send: (res: http.ServerResponse, event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`),
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of streams) res.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const until = async (check: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function host(instance: string, overrides: Partial<ConstructorParameters<typeof RequestHost>[0]> = {}) {
  const heard: string[] = [];
  const statuses: string[] = [];
  const keyGone: string[] = [];
  const made = new RequestHost({
    instance,
    key: KEY,
    describe: () => ({ platform: 'macOS', version: '0.68.0', projectIds: [1, 2] }),
    onOffer: (o) => heard.push(`offer ${o.id}`),
    onWithdrawn: (i) => heard.push(`withdrawn ${i}`),
    onStop: (i) => heard.push(`stop ${i}`),
    onStatus: (s) => statuses.push(s),
    onKeyRevoked: () => keyGone.push('key revoked'),
    timing: { retryFirstMs: 20, retryLastMs: 40, pollOpenMs: 50, pollClosedMs: 30, idleMs: 2_000 },
    ...overrides,
  });
  cleanups.push(() => made.close());
  return { made, heard, statuses, keyGone };
}

describe('postDeviceFlow', () => {
  test('posts JSON with no key to the device flow path, and reads a non-JSON answer as empty', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const answers = [
      new Response(JSON.stringify({ deviceCode: 'd', userCode: 'u' }), { status: 200 }),
      new Response('<html>', { status: 502 }),
    ];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return answers.shift()!;
    }) as typeof fetch;
    expect(
      await postDeviceFlow('https://piwi.example.com', '/api/extension/connect', { target: 'desktop' }, fetchImpl),
    ).toEqual({ status: 200, answer: { deviceCode: 'd', userCode: 'u' } });
    expect(
      await postDeviceFlow('https://piwi.example.com', '/api/extension/connect/token', { deviceCode: 'd' }, fetchImpl),
    ).toEqual({ status: 502, answer: {} });
    expect(calls.map((c) => c.url)).toEqual([
      'https://piwi.example.com/api/extension/connect',
      'https://piwi.example.com/api/extension/connect/token',
    ]);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.init).toMatchObject({ method: 'POST', body: JSON.stringify({ target: 'desktop' }) });
    expect(headers['Content-Type']).toBe('application/json');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });
});

describe('readEventStream', () => {
  test('reads the data of each event, across chunks, and skips comments', async () => {
    const encoder = new TextEncoder();
    const chunks = [': hello\n\ndata: {"a"', ':1}\n\ndata: x\r\n', 'data: y\r\n\r\n'];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const data: string[] = [];
    let activity = 0;
    await readEventStream(
      body,
      (d) => data.push(d),
      () => activity++,
    );
    expect(data).toEqual(['{"a":1}', 'x\ny']);
    expect(activity).toBe(3);
  });
});

describe('the request host', () => {
  test('takes the snapshot, then each request, stop and withdrawal, each once', async () => {
    const instance = await fakeInstance({
      stream: (res) => {
        instance.send(res, { type: 'snapshot', requests: [offer(id(1))], stops: [id(9)] });
        instance.send(res, { type: 'request', request: offer(id(1)) });
        instance.send(res, { type: 'request', request: offer(id(2)) });
        instance.send(res, { type: 'withdrawn', id: id(2) });
        instance.send(res, { type: 'stop', id: id(9) });
      },
      list: () => ({ requests: [offer(id(1))], stops: [id(9)] }),
    });
    cleanups.push(instance.close);
    const { made, heard, statuses } = host(instance.url);
    made.start();
    await until(() => heard.length >= 4);
    expect(heard).toEqual([`offer ${id(1)}`, `stop ${id(9)}`, `offer ${id(2)}`, `withdrawn ${id(2)}`]);
    expect(statuses).toEqual(['connecting', 'online']);
    // The minute list, here a few times over, tells nothing again.
    await until(() => instance.calls.filter((c) => c.path === '/api/run-targets/requests').length >= 3);
    expect(heard).toHaveLength(4);
    const describeCall = instance.calls.find((c) => c.path === '/api/run-targets/self')!;
    expect(describeCall.method).toBe('PUT');
    expect(JSON.parse(describeCall.body)).toEqual({ platform: 'macOS', version: '0.68.0', projectIds: [1, 2] });
    expect(instance.calls.every((c) => c.authorization === `Bearer ${KEY}`)).toBe(true);
  });

  test('ends once, on its first list, the requests counted as its own that it no longer holds', async () => {
    const held = [
      { id: id(4), state: 'claimed' },
      { id: id(5), state: 'running' },
      { id: id(6), state: 'running' },
      { id: id(7), state: 'stopping' },
    ];
    const instance = await fakeInstance({
      stream: (res) => instance.send(res, { type: 'snapshot', requests: [], stops: [], held }),
      list: () => ({ requests: [], stops: [], held }),
    });
    cleanups.push(instance.close);
    const { made } = host(instance.url, { holds: (i) => i === id(6) });
    made.start();
    const ends = () => instance.calls.filter((c) => c.path.endsWith('/answer') || c.path.endsWith('/state'));
    await until(() => ends().length >= 3);
    await until(() => instance.calls.filter((c) => c.path === '/api/run-targets/requests').length >= 3);
    const detail = 'The app started again and no longer holds this request';
    expect(ends().map((c) => [c.path.split('/').slice(4).join('/'), JSON.parse(c.body)])).toEqual([
      [`${id(4)}/answer`, { decision: 'refused', detail }],
      [`${id(5)}/state`, { state: 'ended', outcome: 'error', detail }],
      [`${id(7)}/state`, { state: 'ended', outcome: 'stopped', detail }],
    ]);
  });

  test('ends nothing when the instance names no held requests, or the app says what it holds by no check', async () => {
    const held = [{ id: id(4), state: 'running' }];
    const older = await fakeInstance({
      stream: (res) => older.send(res, { type: 'snapshot', requests: [], stops: [] }),
    });
    cleanups.push(older.close);
    host(older.url, { holds: () => false }).made.start();
    const unchecked = await fakeInstance({ list: () => ({ requests: [], stops: [], held }) });
    cleanups.push(unchecked.close);
    host(unchecked.url).made.start();
    for (const instance of [older, unchecked])
      await until(() => instance.calls.filter((c) => c.path === '/api/run-targets/requests').length >= 2);
    for (const instance of [older, unchecked])
      expect(instance.calls.some((c) => c.path.endsWith('/answer') || c.path.endsWith('/state'))).toBe(false);
  });

  test('passes on the project names of the describe answer, the snapshot, each request and the list', async () => {
    const instance = await fakeInstance({
      self: () => ({ projects: [{ id: 1, name: 'Checkout' }] }),
      stream: (res) => {
        instance.send(res, { type: 'snapshot', requests: [], stops: [], projects: [{ id: 2, name: 'Billing' }] });
        instance.send(res, { type: 'request', request: offer(id(1)), projects: [{ id: 3, name: ' Search ' }] });
      },
      list: () => ({
        requests: [],
        stops: [],
        projects: [
          { id: 4, name: 'Accounts' },
          { id: 0, name: 'Not an id' },
          { id: 5, name: '' },
          { id: 6, name: 'x'.repeat(201) },
          { id: 7 },
          'Mobile',
        ],
      }),
    });
    cleanups.push(instance.close);
    const named = new Map<number, string>();
    const { made } = host(instance.url, {
      onProjectNames: (projects) => projects.forEach((p) => named.set(p.id, p.name)),
    });
    made.start();
    await until(() => named.size >= 4);
    await until(() => instance.calls.filter((c) => c.path === '/api/run-targets/requests').length >= 2);
    expect(Object.fromEntries(named)).toEqual({ 1: 'Checkout', 2: 'Billing', 3: 'Search', 4: 'Accounts' });
  });

  test('withdraws an offer the list no longer holds, and one past its time', async () => {
    let requests = [offer(id(1)), offer(id(2), 150)];
    const instance = await fakeInstance({
      stream: (res) => instance.send(res, { type: 'snapshot', requests, stops: [] }),
      list: () => ({ requests, stops: [] }),
    });
    cleanups.push(instance.close);
    const { made, heard } = host(instance.url);
    made.start();
    await until(() => heard.length >= 2);
    requests = [offer(id(2), 150)];
    await until(() => heard.includes(`withdrawn ${id(1)}`));
    await until(() => heard.includes(`withdrawn ${id(2)}`), 1_000);
  });

  test('opens the stream again after it ends, and lists the requests meanwhile', async () => {
    let opened = 0;
    const instance = await fakeInstance({
      stream: (res) => {
        opened++;
        if (opened === 1) res.end();
      },
    });
    cleanups.push(instance.close);
    const { made, statuses } = host(instance.url);
    made.start();
    // The instance counts the second stream as it opens; the host says it is online once it hears the answer.
    await until(() => opened >= 2 && statuses[statuses.length - 1] === 'online');
    expect(statuses).toContain('offline');
  });

  test('stops for good once the key is revoked, on the stream or by a refusal', async () => {
    const instance = await fakeInstance({ stream: (res) => instance.send(res, { type: 'revoked' }) });
    cleanups.push(instance.close);
    const { made, statuses } = host(instance.url);
    made.start();
    await until(() => statuses.includes('revoked'));
    expect(made.state).toBe('revoked');

    const refusing = await fakeInstance({ status: () => 403 });
    cleanups.push(refusing.close);
    const other = host(refusing.url);
    other.made.start();
    await until(() => other.statuses.includes('revoked'));
    const streamsAsked = refusing.calls.filter((c) => c.path === '/api/run-targets/stream').length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(refusing.calls.filter((c) => c.path === '/api/run-targets/stream').length).toBe(streamsAsked);
  });

  test('tells the key is gone on the stream’s revoked event and on the instance’s 401 for a key it no longer holds, once', async () => {
    const revoking = await fakeInstance({ stream: (res) => revoking.send(res, { type: 'revoked' }) });
    cleanups.push(revoking.close);
    const onEvent = host(revoking.url);
    onEvent.made.start();
    await until(() => onEvent.statuses.includes('revoked'));
    expect(onEvent.keyGone).toEqual(['key revoked']);

    for (const refusalJson of [
      { message: 'Invalid or expired API key', data: { errorCode: 'RUN_TARGET_KEY_REVOKED' } },
      { message: 'The key is gone', data: { errorCode: 'RUN_TARGET_KEY_REVOKED' } },
      // An instance that sends no code yet.
      { message: 'Invalid or expired API key' },
    ]) {
      const unauthorized = await fakeInstance({ status: () => 401, refusalJson });
      cleanups.push(unauthorized.close);
      const onRefusal = host(unauthorized.url);
      onRefusal.made.start();
      await until(() => onRefusal.statuses.includes('revoked'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(onRefusal.keyGone, JSON.stringify(refusalJson)).toEqual(['key revoked']);
    }
  });

  test('keeps the key on a 403, and on a 401 that is not the instance’s answer for a key it no longer holds', async () => {
    const forbidden = await fakeInstance({
      status: () => 403,
      refusalJson: { message: 'This app is no longer connected', data: { errorCode: 'RUN_TARGET_KEY_REVOKED' } },
    });
    cleanups.push(forbidden.close);
    const onForbidden = host(forbidden.url);
    onForbidden.made.start();
    await until(() => onForbidden.statuses.includes('revoked'));
    expect(onForbidden.keyGone).toEqual([]);

    for (const refusal of [
      { refusalBody: '<html>Sign in</html>' },
      { refusalJson: { message: 'Unauthorized' } },
      { refusalJson: { message: 'Unauthorized', data: { errorCode: 'UNAUTHORIZED' } } },
      { refusalJson: { message: 'A connected app’s key is required', data: { errorCode: 'UNAUTHORIZED' } } },
    ]) {
      const proxied = await fakeInstance({ status: () => 401, ...refusal });
      cleanups.push(proxied.close);
      const onProxy = host(proxied.url);
      onProxy.made.start();
      await until(() => onProxy.statuses.includes('revoked'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(onProxy.keyGone, JSON.stringify(refusal)).toEqual([]);
    }
  });

  test('claims, answers and reports, and says what the instance refused', async () => {
    const instance = await fakeInstance({ status: (path) => (path.endsWith(`${id(3)}/claim`) ? 409 : null) });
    cleanups.push(instance.close);
    const { made } = host(instance.url);
    expect((await made.claim(id(1))).id).toBe(id(1));
    expect(await made.answer(id(1), { decision: 'run' })).toEqual({ requestToken: `pdq_${'b'.repeat(64)}` });
    await made.report(id(1), { state: 'ended', outcome: 'passed' });
    const state = instance.calls.find((c) => c.path.endsWith('/state'))!;
    expect(JSON.parse(state.body)).toEqual({ state: 'ended', outcome: 'passed' });
    const refused = await made.claim(id(3)).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RequestHostError);
    expect(refused).toMatchObject({ status: 409, message: 'answered 409' });
    expect(made.state).not.toBe('revoked');
  });

  test('a refusal of one request leaves the key connected', async () => {
    const instance = await fakeInstance({ status: (path) => (path.includes('/requests/') ? 403 : null) });
    cleanups.push(instance.close);
    const { made } = host(instance.url);
    const refused = await made.answer(id(1), { decision: 'run' }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 403 });
    await made.claim(id(2)).catch(() => {});
    expect(made.state).not.toBe('revoked');
  });

  test('offers only what the parser reads, and refuses a claim it cannot read', async () => {
    const bad = { ...offer(id(2)), options: { headed: true, workers: 64 } };
    const instance = await fakeInstance({
      list: () => ({ requests: [offer(id(1)), bad, { id: '../x' } as never], stops: ['../../etc', id(9)] }),
      status: () => null,
    });
    cleanups.push(instance.close);
    const { made, heard } = host(instance.url);
    made.start();
    await until(() => heard.includes(`offer ${id(1)}`));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(heard.filter((h) => h.startsWith('offer'))).toEqual([`offer ${id(1)}`]);
    expect(heard).toContain(`stop ${id(9)}`);
    expect(heard.some((h) => h.includes('..'))).toBe(false);
    await expect(made.claim('../x')).rejects.toMatchObject({ status: 404 });
  });
});
