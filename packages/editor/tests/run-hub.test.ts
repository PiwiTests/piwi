/**
 * The hub's WebSocket, as Piwi Picker reaches it: a service started in-process, the address and token it publishes
 * for its discovery file, a WebSocket client playing the extension (its `Host` and `Origin` set as a browser sets
 * them), and a fake worker on the run channel.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { parseHubMessage, type HubAnswer, type HubMessage, type HubSession } from '@piwitests/core/run-hub';
import { FakeWorker, service, waitFor, writeRunWorkspace, type Service } from './run-fixtures';

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const KEEPALIVE_MS = 150;

let dir = '';
let svc: Service;
let hub: { url: string; token: string; port: number };

beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-hub-')));
  writeRunWorkspace(dir);
  svc = await service(dir, false, { hubKeepaliveMs: KEEPALIVE_MS, hubHelloMs: 300 });
  const published = await waitFor(() => svc.published[0] ?? undefined);
  hub = { ...published.hub!, port: Number(new URL(published.hub!.url).port) };
});

afterAll(() => {
  svc?.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The extension's connection: what it heard, and how it closed. */
interface Client {
  socket: WebSocket;
  messages: HubMessage[];
  closed: Promise<{ code: number; reason: string }>;
  send(message: unknown): void;
  /** The answer to the command of `id`. */
  answer(id: number): Promise<HubAnswer>;
  /** The latest session of a ref it heard. */
  session(ref: string): HubSession | undefined;
}

/** Opens a WebSocket as a browser would, with `headers`; the handshake's refusal status, else the connection. */
function open(headers: Record<string, string | undefined> = {}): Promise<Client | number> {
  const { host, origin = ORIGIN, url = hub.url } = headers;
  const socket = new WebSocket(url, { headers: host ? { host } : {}, ...(origin ? { origin } : {}) });
  const messages: HubMessage[] = [];
  socket.on('message', (data) => {
    const message = parseHubMessage(String(data));
    if (message) messages.push(message);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.on('close', (code, reason) => resolve({ code, reason: String(reason) })),
  );
  return new Promise((resolve) => {
    socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    socket.on('error', () => {});
    socket.on('open', () =>
      resolve({
        socket,
        messages,
        closed,
        send: (message) => socket.send(typeof message === 'string' ? message : JSON.stringify(message)),
        answer: (id) => waitFor(() => messages.find((m): m is HubAnswer => m.type === 'answer' && m.id === id), 5000),
        session: (ref) =>
          messages
            .filter((m): m is Extract<HubMessage, { type: 'session' }> => m.type === 'session' && m.session.ref === ref)
            .pop()?.session,
      }),
    );
  });
}

/** A connection that said hello and heard the welcome. */
async function paired(): Promise<Client> {
  const client = (await open()) as Client;
  client.send({ type: 'hello', token: hub.token });
  await waitFor(() => client.messages.find((m) => m.type === 'welcome'));
  return client;
}

describe('the hub’s address', () => {
  test('is published for the discovery file once the service listens, with the run channel and the service', () => {
    expect(svc.published).toEqual([
      {
        pid: process.pid,
        version: '0.0.0-dev',
        client: 'Test Editor',
        startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        roots: [dir],
        hub: { url: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+\/piwi\/hub$/), token: expect.any(String) },
        runChannel: { path: expect.any(String), token: expect.any(String) },
        // Unbundled, the service has no recorder bundle beside it.
        recorderBundle: null,
      },
    ]);
    expect(hub.token).toMatch(/^[\w-]{32}$/);
    expect(svc.published[0]!.runChannel!.token).not.toBe(hub.token);
  });

  test('goes as the service stops', async () => {
    const other = await service(dir, false);
    await waitFor(() => other.published[0] ?? undefined);
    other.stop();
    expect(other.published[other.published.length - 1]).toBeNull();
  });
});

describe('the handshake', () => {
  test('takes the hub’s own Host and an extension’s Origin, and says welcome after the token', async () => {
    const client = (await open({ host: `localhost:${hub.port}` })) as Client;
    client.send({ type: 'hello', token: hub.token });
    expect(await waitFor(() => client.messages[0])).toEqual({
      type: 'welcome',
      pid: process.pid,
      version: '0.0.0-dev',
      client: 'Test Editor',
      roots: [dir],
      keepaliveMs: KEEPALIVE_MS,
    });
    client.socket.close();
  });

  test('refuses another Host, a page’s origin, a null origin, none, and another path, before any WebSocket opens', async () => {
    expect(await open({ host: `evil.test:${hub.port}` })).toBe(403);
    expect(await open({ host: `127.0.0.1:${hub.port + 1}` })).toBe(403);
    expect(await open({ origin: `http://127.0.0.1:${hub.port}` })).toBe(403);
    expect(await open({ origin: 'https://piwitests.dev' })).toBe(403);
    expect(await open({ origin: 'null' })).toBe(403);
    expect(await open({ origin: 'file://' })).toBe(403);
    expect(await open({ origin: '' })).toBe(403);
    expect(await open({ url: hub.url.replace('/piwi/hub', '/other') })).toBe(404);
    const plain = await fetch(`http://127.0.0.1:${hub.port}/piwi/hub`);
    expect(plain.status).toBe(426);
  });

  test('closes a connection whose first message is not hello with the token, or that says nothing in time', async () => {
    const wrong = (await open()) as Client;
    wrong.send({ type: 'hello', token: 'x'.repeat(32) });
    expect(await wrong.closed).toMatchObject({ code: 4001 });
    const command = (await open()) as Client;
    command.send({ type: 'subscribe', id: 1 });
    expect(await command.closed).toMatchObject({ code: 4001 });
    expect(command.messages).toEqual([]);
    const silent = (await open()) as Client;
    expect(await silent.closed).toMatchObject({ code: 4002 });
  });

  test('closes a connection on a frame too long, a binary frame or a message that is no command', async () => {
    const before = (await open()) as Client;
    before.send(JSON.stringify({ type: 'hello', token: hub.token, pad: 'x'.repeat(70_000) }));
    expect(await before.closed).toMatchObject({ code: 1009 });
    const long = await paired();
    long.send({ type: 'subscribe', id: 1, pad: 'x'.repeat(70_000) });
    expect(await long.closed).toMatchObject({ code: 1009 });
    const binary = await paired();
    binary.socket.send(Buffer.from('{"type":"subscribe","id":1}'));
    expect(await binary.closed).toMatchObject({ code: 1003 });
    const malformed = await paired();
    malformed.send({ type: 'subscribe' });
    expect(await malformed.closed).toMatchObject({ code: 4003 });
  });
});

describe('the commands', () => {
  test('answer one Piwi does not know, or cannot take, with why, the connection kept', async () => {
    const client = await paired();
    client.send({ type: 'evaluate', id: 1, code: 'document.cookie' });
    expect(await client.answer(1)).toEqual({
      type: 'answer',
      id: 1,
      ok: false,
      message: 'Piwi does not know the command "evaluate".',
    });
    client.send({ type: 'runControl', id: 2, ref: 'ed-1', action: 'run-to', place: { uri: 'file:///x', line: 1 } });
    expect(await client.answer(2)).toMatchObject({ ok: false, message: expect.stringMatching(/^Run to a line stays/) });
    client.send({ type: 'runControl', id: 3, ref: 'ed-00000000', action: 'pause' });
    expect(await client.answer(3)).toMatchObject({
      ok: false,
      message: 'No worker of this run is connected to the editor.',
    });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    client.socket.close();
  });

  test('push every run once subscribed, steer it, and answer each control, image and intent', async () => {
    const client = await paired();
    const { ref, channel, command } = await svc.command();
    client.send({ type: 'subscribe', id: 1 });
    expect(await client.answer(1)).toMatchObject({
      ok: true,
      message: expect.stringMatching(/^Following \d+ runs?\.$/),
    });
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0);
    try {
      expect(await waitFor(() => client.session(ref))).toEqual({
        ref,
        root: dir,
        label: path.basename(dir),
        command: command.command,
        project: null,
        workers: [
          {
            worker: 0,
            parallelIndex: 0,
            state: 'between',
            test: null,
            stop: null,
            pausing: false,
            intents: ['pick', 'record'],
          },
        ],
        ended: false,
      });
      worker.begin();
      await waitFor(() => (client.session(ref)?.workers[0]?.state === 'running' ? true : undefined));
      client.send({ type: 'runControl', id: 2, ref, action: 'pause' });
      expect(await client.answer(2)).toMatchObject({ ok: true, message: 'Pausing at the next call.' });
      expect(await worker.next('control')).toEqual({ type: 'control', action: 'pause' });

      worker.stopAt(1, 30, true);
      const stop = await waitFor(() => client.session(ref)?.workers[0]?.stop ?? undefined);
      expect(stop).toMatchObject({
        reason: 'breakpoint',
        uri: pathToFileURL(path.join(dir, 'tests/pages/cart.page.ts')).href,
        line: 29,
        bar: true,
      });

      // The image of the stopped page.
      client.send({ type: 'pausedPage', id: 3, ref, worker: 0 });
      const asked = await worker.next('request');
      expect(asked).toEqual({ type: 'request', request: expect.any(Number), what: 'image' });
      worker.send({
        type: 'answer',
        request: asked.request,
        what: 'image',
        value: { mime: 'image/jpeg', data: '/9j/4A==' },
      });
      expect(await client.answer(3)).toEqual({
        type: 'answer',
        id: 3,
        ok: true,
        message: 'The stopped page.',
        image: { mime: 'image/jpeg', data: '/9j/4A==' },
      });

      // Pick and Record start in the test's window: the worker says whether they did.
      client.send({ type: 'pick', id: 4, ref, since: stop.since });
      const pick = await worker.next('request', 1);
      expect(pick).toEqual({ type: 'request', request: expect.any(Number), what: 'pick', stop: 1 });
      worker.send({
        type: 'answer',
        request: pick.request,
        what: 'pick',
        value: { ok: true, message: "Pick an element in the test's window." },
      });
      expect(await client.answer(4)).toMatchObject({ ok: true, message: "Pick an element in the test's window." });
      client.send({ type: 'record', id: 5, ref });
      const record = await worker.next('request', 2);
      expect(record).toMatchObject({ what: 'record', stop: 1 });
      worker.send({
        type: 'answer',
        request: record.request,
        what: 'record',
        value: { ok: false, message: 'Record here waits: a pick or a recording runs in the test’s window.' },
      });
      expect(await client.answer(5)).toMatchObject({ ok: false, message: expect.stringMatching(/^Record here waits/) });

      // A control naming the stop it answers: the next stop is not skipped by a click made twice.
      client.send({ type: 'runControl', id: 6, ref, action: 'step', since: stop.since });
      expect(await client.answer(6)).toMatchObject({ ok: true, message: 'Stepping to the next call.' });
      expect(await worker.next('control', 1)).toEqual({ type: 'control', action: 'step', stop: 1 });
      worker.send({ type: 'running', stop: 1 });
      worker.stopAt(2, 31, false);
      await waitFor(() => (client.session(ref)?.workers[0]?.stop?.line === 30 ? true : undefined));
      client.send({ type: 'runControl', id: 7, ref, action: 'step', since: stop.since });
      expect(await client.answer(7)).toMatchObject({ ok: false, message: 'The test went on.' });
      client.send({ type: 'pick', id: 8, ref, since: stop.since });
      expect(await client.answer(8)).toMatchObject({ ok: false, message: 'The test went on.' });

      // A headless stop has no window to pick or record in: refused without asking the worker.
      client.send({ type: 'pick', id: 9, ref });
      expect(await client.answer(9)).toMatchObject({
        ok: false,
        message: "Pick a locator needs the pause bar in the test's window, and this test runs headless: run it headed.",
      });
      client.send({ type: 'runControl', id: 10, ref, action: 'resume' });
      expect(await client.answer(10)).toMatchObject({ ok: true, message: 'Resuming.' });
      expect(worker.heard.filter((m) => m.type === 'request')).toHaveLength(3);

      await svc.client.sendNotification('piwi/commandEnded', { ref, exitCode: 0 });
      expect(await waitFor(() => (client.session(ref)?.ended ? client.session(ref) : undefined))).toMatchObject({
        workers: [],
        ended: true,
      });
    } finally {
      worker.socket.destroy();
      client.socket.close();
    }
  });

  test('refuse Pick and Record at a stop of a reporter that predates them', async () => {
    const client = await paired();
    client.send({ type: 'subscribe', id: 1 });
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0, []);
    try {
      worker.begin();
      worker.stopAt(1, 30, true);
      await waitFor(() => client.session(ref)?.workers[0]?.stop ?? undefined);
      expect(client.session(ref)!.workers[0]!.intents).toEqual([]);
      client.send({ type: 'record', id: 2, ref });
      expect(await client.answer(2)).toMatchObject({
        ok: false,
        message: "@piwitests/reporter 0.60.0 cannot start Record here from outside the test's window: update it.",
      });
      expect(worker.heard.filter((m) => m.type === 'request')).toEqual([]);
    } finally {
      worker.socket.destroy();
      client.socket.close();
    }
  });

  test('send a keepalive within Chrome’s 30 s, to a connection that said hello', async () => {
    const client = await paired();
    await waitFor(() => (client.messages.filter((m) => m.type === 'keepalive').length >= 2 ? true : undefined));
    client.socket.close();
  });
});

describe('a stop nobody else can answer, with the editor’s client unable to', () => {
  test('waits while Piwi Picker follows the runs, and goes on once it leaves', async () => {
    const client = await paired();
    client.send({ type: 'subscribe', id: 1 });
    await client.answer(1);
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0);
    try {
      worker.begin();
      worker.stopAt(1, 30);
      await waitFor(() => client.session(ref)?.workers[0]?.stop ?? undefined);
      await new Promise((r) => setTimeout(r, 200));
      expect(worker.heard.filter((m) => m.type === 'control')).toEqual([]);
      client.socket.close();
      expect(await worker.next('control')).toEqual({ type: 'control', action: 'resume', stop: 1 });

      // With nobody following, a stop no bar shows goes on at once.
      worker.send({ type: 'running', stop: 1 });
      worker.stopAt(2, 31);
      expect(await worker.next('control', 1)).toEqual({ type: 'control', action: 'resume', stop: 2 });
    } finally {
      worker.socket.destroy();
    }
  });
});
