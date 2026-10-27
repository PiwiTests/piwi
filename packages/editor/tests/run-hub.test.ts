/**
 * The hub's WebSocket, as Piwi Picker reaches it: a service started in-process, the address and token it publishes
 * for its discovery file, a WebSocket client playing the extension (its `Host` and `Origin` set as a browser sets
 * them), and a fake worker on the run channel.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import {
  MAX_HUB_COMMAND,
  MAX_HUB_ROOTS,
  parseHubMessage,
  type HubAnswer,
  type HubMessage,
  type HubSession,
} from '@piwitests/core/run-hub';
import type { RunSession } from '../src/protocol';
import { RunHub } from '../src/run-hub';
import type { RunSessions } from '../src/run-sessions';
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
        host: os.hostname(),
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

  test('cuts a connection that does not answer the close, and keeps no place for one being closed', async () => {
    // Raw handshakes that never read, so never answer the close the hub sends when no hello comes.
    const silent = Array.from({ length: 8 }, () => {
      const socket = net.connect(hub.port, '127.0.0.1');
      socket.on('error', () => {});
      socket.write(
        `GET /piwi/hub HTTP/1.1\r\nHost: 127.0.0.1:${hub.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${ORIGIN}\r\n\r\n`,
      );
      return socket;
    });
    try {
      await new Promise((r) => setTimeout(r, 100));
      // Eight connections that did not say hello hold every place for one that has not.
      expect(await open()).toBe(503);
      const started = Date.now();
      let client: Client | number = 503;
      while (typeof client === 'number' && Date.now() - started < 5000) {
        await new Promise((r) => setTimeout(r, 100));
        client = await open();
      }
      // Their hello's 300 ms, then the second they have to answer the close.
      expect(typeof client).toBe('object');
      expect(Date.now() - started).toBeLessThan(2500);
      (client as Client).send({ type: 'hello', token: hub.token });
      await waitFor(() => (client as Client).messages.find((m) => m.type === 'welcome'));
      (client as Client).socket.close();
    } finally {
      for (const socket of silent) socket.destroy();
    }
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
      client.send({ type: 'record', id: 5, ref, since: stop.since });
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
      const headless = await waitFor(() => {
        const next = client.session(ref)?.workers[0]?.stop;
        return next?.line === 30 ? next : undefined;
      });
      client.send({ type: 'runControl', id: 7, ref, action: 'step', since: stop.since });
      expect(await client.answer(7)).toMatchObject({ ok: false, message: 'The test went on.' });
      client.send({ type: 'pick', id: 8, ref, since: stop.since });
      expect(await client.answer(8)).toMatchObject({ ok: false, message: 'The test went on.' });

      // A headless stop has no window to pick or record in: refused without asking the worker.
      client.send({ type: 'pick', id: 9, ref, since: headless.since });
      expect(await client.answer(9)).toMatchObject({
        ok: false,
        message: "Pick a locator needs the pause bar in the test's window, and this test runs headless: run it headed.",
      });
      // A control or an intent that answers a stop names it; a pause needs none.
      for (const [id, command] of [
        [11, { type: 'runControl', action: 'resume' }],
        [12, { type: 'runControl', action: 'finish', since: null }],
        [13, { type: 'record' }],
      ] as const) {
        client.send({ ...command, id, ref, worker: 0 });
        expect(await client.answer(id)).toMatchObject({ ok: false, message: 'The command needs the stop it answers.' });
      }
      client.send({ type: 'runControl', id: 10, ref, action: 'resume', since: headless.since });
      expect(await client.answer(10)).toMatchObject({ ok: true, message: 'Resuming.' });
      expect(worker.heard.filter((m) => m.type === 'request')).toHaveLength(3);
      expect(worker.heard.filter((m) => m.type === 'control')).toHaveLength(3);

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
      client.send({ type: 'record', id: 2, ref, since: client.session(ref)!.workers[0]!.stop!.since });
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

/** A hub of its own, its sessions faked, with the keepalive and hello limits it ships with. */
function ownHub(
  runInfo: () => { command: string | null; label: string | null; project: string | null },
  welcome?: {
    client: string | null;
    roots: string[];
  },
): Promise<RunHub | null> {
  const session: RunSession = { ref: 'ed-1', root: '/work/shop', workers: [], ended: false };
  const sessions = { current: () => [session], intentsOf: () => [] } as unknown as RunSessions;
  return RunHub.open({
    sessions,
    runInfo,
    welcome: () => ({
      pid: process.pid,
      version: '0.60.0',
      client: welcome?.client ?? null,
      roots: welcome?.roots ?? [],
    }),
    surfacesChanged: () => {},
  });
}

describe('a connection the hub lets go', () => {
  test('is cut when the library closed it, a frame too long, and the other side does not answer the close', async () => {
    const own = (await ownHub(() => ({ command: null, label: null, project: null })))!;
    // A paired client that reads what the hub sends, and never closes its side nor answers a ping.
    const socket = net.connect({ port: own.port, host: '127.0.0.1', allowHalfOpen: true });
    let cut = false;
    socket.on('error', () => {
      cut = true;
    });
    socket.on('data', () => {});
    const ended = new Promise((resolve) => socket.once('end', resolve));
    try {
      socket.write(
        `GET /piwi/hub HTTP/1.1\r\nHost: 127.0.0.1:${own.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${ORIGIN}\r\n\r\n`,
      );
      await new Promise((r) => setTimeout(r, 100));
      // Its hello, a masked text frame, so the hello's time limit does not end it.
      const hello = Buffer.from(JSON.stringify({ type: 'hello', token: own.token }));
      const mask = Buffer.from([1, 2, 3, 4]);
      const masked = hello.map((byte, i) => byte ^ mask[i % 4]!);
      socket.write(
        Buffer.concat([Buffer.from([0x81, 0x80 | 126, hello.length >> 8, hello.length & 0xff]), mask, masked]),
      );
      await new Promise((r) => setTimeout(r, 200));
      // The head of a masked text frame of 70,000 bytes: over `MAX_HUB_FRAME`, refused as its length is read.
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(70_000n);
      socket.write(Buffer.concat([Buffer.from([0x81, 0xff]), length, mask]));
      await ended;
      // Past the grace, the hub no longer holds the connection: what is sent to it is refused.
      await new Promise((r) => setTimeout(r, 1500));
      for (let i = 0; i < 10 && !cut; i++) {
        socket.write('x');
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(cut).toBe(true);
    } finally {
      socket.destroy();
      own.close();
    }
  });
});

describe('what the hub sends', () => {
  test('fits what the extension reads: a command line cut, marked, and the first of many folders', async () => {
    const long = `npx playwright test ${'tests/cart.spec.ts:3 '.repeat(2000)}`;
    const roots = Array.from({ length: 100 }, (_, i) => `/work/shop-${i}`);
    const small = (await ownHub(() => ({ command: long, label: 'shop', project: 'P'.repeat(600) }), {
      client: 'C'.repeat(300),
      roots,
    }))!;
    try {
      const socket = new WebSocket(small.url, { origin: ORIGIN });
      const heard: HubMessage[] = [];
      socket.on('message', (data) => {
        const message = parseHubMessage(String(data));
        heard.push(message ?? ({ type: 'unreadable' } as unknown as HubMessage));
      });
      await new Promise((resolve) => socket.on('open', resolve));
      socket.send(JSON.stringify({ type: 'hello', token: small.token }));
      const welcome = await waitFor(() => heard.find((m) => m.type === 'welcome'));
      expect(welcome).toMatchObject({ roots: roots.slice(0, MAX_HUB_ROOTS), client: `${'C'.repeat(199)}…` });
      socket.send(JSON.stringify({ type: 'subscribe', id: 1 }));
      const sent = await waitFor(() => heard.find((m) => m.type === 'session'));
      const { command, project } = (sent as Extract<HubMessage, { type: 'session' }>).session;
      expect(command).toHaveLength(MAX_HUB_COMMAND);
      expect(command).toBe(`${long.slice(0, MAX_HUB_COMMAND - 1)}…`);
      expect(project).toBe(`${'P'.repeat(499)}…`);
      expect(heard.map((m) => m.type)).not.toContain('unreadable');
      socket.close();
    } finally {
      small.close();
    }
  });
});
