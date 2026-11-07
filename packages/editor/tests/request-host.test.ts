/**
 * The request host against a fake instance on this machine: the stream's snapshot and events, the minute list that
 * keeps the app online, stops told once, withdrawn and expired offers, a revoked key, the stream opened again after it
 * ends, and the target's calls with its key as a bearer token.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import type { RunRequestOffer } from '@piwitests/core/run-request';
import { readEventStream, RequestHost, RequestHostError } from '../src/request-host';

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
  list?: () => { requests: RunRequestOffer[]; stops: string[] };
  status?: (path: string) => number | null;
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
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: `answered ${status}` }));
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
  const made = new RequestHost({
    instance,
    key: KEY,
    describe: () => ({ platform: 'macOS', version: '0.68.0', projectIds: [1, 2] }),
    onOffer: (o) => heard.push(`offer ${o.id}`),
    onWithdrawn: (i) => heard.push(`withdrawn ${i}`),
    onStop: (i) => heard.push(`stop ${i}`),
    onStatus: (s) => statuses.push(s),
    timing: { retryFirstMs: 20, retryLastMs: 40, pollOpenMs: 50, pollClosedMs: 30, idleMs: 2_000 },
    ...overrides,
  });
  cleanups.push(() => made.close());
  return { made, heard, statuses };
}

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
    await until(() => opened >= 2);
    expect(statuses).toContain('offline');
    expect(statuses[statuses.length - 1]).toBe('online');
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
});
