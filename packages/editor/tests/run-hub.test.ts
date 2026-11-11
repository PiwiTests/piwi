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
  MAX_HUB_MESSAGE,
  MAX_HUB_PEERS,
  MAX_HUB_ROOTS,
  MAX_HUB_WARNINGS,
  parseHubMessage,
  type HubAnswer,
  type HubMessage,
  type HubSession,
  type LiveHub,
} from '@piwitests/core/run-hub';
import { RUN_TAKES } from '@piwitests/core/run-channel';
import type { RunSession } from '../src/protocol';
import { writeDiscovery } from '../src/discovery';
import { RunHub, type RunHubOptions } from '../src/run-hub';
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
      features: ['peers', 'lanes', 'hold', 'presence', 'stop'],
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

  test('takes a loopback Host at a port the client forwards to it only once named, the origin and token still needed', async () => {
    const forwarded = hub.port === 65_535 ? hub.port - 1 : hub.port + 1;
    expect(await open({ host: `127.0.0.1:${forwarded}` })).toBe(403);
    expect(await svc.client.sendRequest('piwi/hub', { forwarded: [forwarded, 0, 70_000] })).toEqual({
      url: hub.url,
      forwarded: [forwarded],
    });
    try {
      const client = (await open({ host: `localhost:${forwarded}` })) as Client;
      client.send({ type: 'hello', token: 'x'.repeat(32) });
      expect(await client.closed).toMatchObject({ code: 4001 });
      const welcomed = (await open({ host: `127.0.0.1:${forwarded}` })) as Client;
      welcomed.send({ type: 'hello', token: hub.token });
      expect(await waitFor(() => welcomed.messages[0])).toMatchObject({ type: 'welcome' });
      welcomed.socket.close();
      expect(await open({ host: `evil.test:${forwarded}`, origin: ORIGIN })).toBe(403);
      expect(await open({ host: `127.0.0.1:${forwarded}`, origin: `http://127.0.0.1:${forwarded}` })).toBe(403);
      expect(await open({ host: `127.0.0.1:${forwarded + 1}` })).toBe(403);
      // Asking the address alone changes nothing.
      expect(await svc.client.sendRequest('piwi/hub', {})).toEqual({ url: hub.url, forwarded: [forwarded] });
    } finally {
      await svc.client.sendRequest('piwi/hub', { forwarded: [] });
    }
    // Forgotten, the port is refused again; the hub's own still opens.
    expect(await open({ host: `127.0.0.1:${forwarded}` })).toBe(403);
    const own = await open();
    expect(typeof own).toBe('object');
    (own as Client).socket.close();
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
      message:
        "No worker of this run is connected to the editor: none has started a test yet, or its tests import `test` from '@playwright/test' rather than from the file that extends Piwi's capture fixtures.",
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
        hold: { on: false, by: 'start' },
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

      // A pick that runs in the test's window there: the connection hears it on the stop, and its end.
      worker.send({ type: 'acting', stop: 1, what: 'pick' });
      expect(await waitFor(() => client.session(ref)?.workers[0]?.stop?.acting)).toBe('pick');
      worker.send({ type: 'acting', stop: 1, what: null });
      await waitFor(() => (client.session(ref)?.workers[0]?.stop?.acting === undefined ? true : undefined));

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

  test('end the test at its stop, never at a failure, and name a run started in a terminal', async () => {
    const client = await paired();
    client.send({ type: 'subscribe', id: 1 });
    await client.answer(1);
    const channel = (await waitFor(() => svc.published[0] ?? undefined)).runChannel!;
    const ref = 'terminal-4242-1730000000001';
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0, [...RUN_TAKES]);
    try {
      expect(await waitFor(() => client.session(ref))).toMatchObject({ ref, command: null, terminal: true });
      expect(client.session(ref)!.workers[0]!.intents).toContain('end');
      worker.begin();
      worker.stopAt(1, 30, true);
      const stop = await waitFor(() => client.session(ref)?.workers[0]?.stop ?? undefined);
      expect(stop.intents).toContain('end');
      client.send({ type: 'runControl', id: 2, ref, action: 'end', since: stop.since });
      expect(await client.answer(2)).toMatchObject({
        ok: true,
        message: 'Ending the test: it is reported as skipped.',
      });
      expect(await worker.next('control')).toEqual({ type: 'control', action: 'end', stop: 1 });
      worker.send({ type: 'running', stop: 1 });
      worker.send({
        type: 'stopped',
        stop: 2,
        reason: 'failure',
        title: 'Failed: Timed out',
        place: { file: 'tests/cart.spec.ts', line: 3, column: 1 },
        locator: null,
        bar: true,
      });
      const failed = await waitFor(() => {
        const next = client.session(ref)?.workers[0]?.stop;
        return next?.reason === 'failure' ? next : undefined;
      });
      expect(failed.intents).not.toContain('end');
    } finally {
      worker.socket.destroy();
      client.socket.close();
    }
  });

  test('stop a run the editor started through its client, and refuse one started in a terminal', async () => {
    const client = await paired();
    client.send({ type: 'subscribe', id: 1 });
    await client.answer(1);
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0, [...RUN_TAKES]);
    const terminalRef = 'terminal-4244-1730000000003';
    const terminal = new FakeWorker(channel.path, dir).attach(channel.token, terminalRef, 0, [...RUN_TAKES]);
    try {
      await waitFor(() => client.session(ref));
      await waitFor(() => client.session(terminalRef));
      client.send({ type: 'stop', id: 2, ref });
      expect(await client.answer(2)).toMatchObject({ ok: true, message: 'Test Editor stops the run.' });
      expect(svc.stops).toEqual([ref]);
      // The client's own refusal, and a run it did not start, which it is never asked to stop.
      svc.stopAnswer = { ok: false, message: 'The run was not started in this window: stop it in its terminal.' };
      client.send({ type: 'stop', id: 3, ref });
      expect(await client.answer(3)).toMatchObject({
        ok: false,
        message: 'The run was not started in this window: stop it in its terminal.',
      });
      client.send({ type: 'stop', id: 4, ref: terminalRef });
      expect(await client.answer(4)).toMatchObject({
        ok: false,
        message: 'The run was started in a terminal: stop it there.',
      });
      expect(svc.stops).toEqual([ref, ref]);
    } finally {
      svc.stopAnswer = { ok: true, message: 'Test Editor stops the run.' };
      worker.socket.destroy();
      terminal.socket.destroy();
      client.socket.close();
    }
  });

  test('name a run the editor’s own test runner started, as its workers say', async () => {
    const client = await paired();
    client.send({ type: 'subscribe', id: 1 });
    await client.answer(1);
    const channel = (await waitFor(() => svc.published[0] ?? undefined)).runChannel!;
    const ref = 'terminal-4243-1730000000002';
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0, [...RUN_TAKES], ['failure'], true);
    try {
      expect(await waitFor(() => client.session(ref))).toMatchObject({
        ref,
        command: null,
        terminal: true,
        runner: true,
      });
    } finally {
      worker.socket.destroy();
      client.socket.close();
    }
  });

  test('share a run live as the window asks, every connection hearing how it stands on the instance', async () => {
    const client = await paired();
    const other = await paired();
    client.send({ type: 'subscribe', id: 1 });
    other.send({ type: 'subscribe', id: 1 });
    await client.answer(1);
    await other.answer(1);
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0, [...RUN_TAKES]);
    const page = 'https://piwi.example.com/test-runs/42';
    try {
      worker.send({ type: 'live', can: true, on: false, viewers: 0, page, why: null });
      expect(await waitFor(() => other.session(ref)?.live)).toEqual({
        shared: false,
        refused: null,
        stopped: null,
        page,
        viewers: 0,
      });
      client.send({ type: 'share', id: 2, ref, on: true });
      expect(await client.answer(2)).toMatchObject({
        ok: true,
        message: expect.stringMatching(/^Sharing the run live/),
      });
      expect(await worker.next('share')).toEqual({ type: 'share', on: true });
      worker.send({ type: 'live', can: true, on: true, viewers: 1, page, why: null });
      await waitFor(() => (other.session(ref)?.live?.viewers === 1 ? true : undefined));
      expect(other.session(ref)?.live).toEqual({ shared: true, refused: null, stopped: null, page, viewers: 1 });
      client.send({ type: 'share', id: 3, ref });
      expect(await client.answer(3)).toMatchObject({ ok: false, message: expect.stringMatching(/^share needs on/) });
    } finally {
      worker.socket.destroy();
      client.socket.close();
      other.socket.close();
    }
  });

  test('end a stop the worker ended unanswered, refusing what names it, and say why a stop has no image', async () => {
    const client = await paired();
    client.send({ type: 'subscribe', id: 1 });
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0);
    try {
      worker.begin();
      worker.stopAt(1, 30, true);
      const stop = await waitFor(() => client.session(ref)?.workers[0]?.stop ?? undefined);
      // A worker that cannot tell which page a stop is of answers no image.
      client.send({ type: 'pausedPage', id: 2, ref, worker: 0 });
      const asked = await worker.next('request');
      worker.send({ type: 'answer', request: asked.request, what: 'image', value: null });
      expect(await client.answer(2)).toEqual({
        type: 'answer',
        id: 2,
        ok: false,
        message:
          'No image: the worker is not stopped, cannot tell which page it stopped in, or did not answer in time.',
        image: null,
      });
      // The test ended under the stop, or its page closed: the worker ends it with no answer.
      worker.send({ type: 'running', stop: 1 });
      await waitFor(() => (client.session(ref)?.workers[0]?.state === 'running' ? true : undefined));
      expect(client.session(ref)!.workers[0]!.stop).toBeNull();
      client.send({ type: 'pick', id: 3, ref, since: stop.since });
      expect(await client.answer(3)).toMatchObject({ ok: false, message: 'The test went on.' });
      client.send({ type: 'runControl', id: 4, ref, action: 'resume', since: stop.since });
      expect(await client.answer(4)).toMatchObject({ ok: false, message: 'The test went on.' });
      expect(worker.heard.filter((m) => m.type === 'request')).toHaveLength(1);
      expect(worker.heard.filter((m) => m.type === 'control')).toEqual([]);
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
  refusal = 'No action here.',
  extra: Partial<RunHubOptions> = {},
): Promise<RunHub | null> {
  const session: RunSession = { ref: 'ed-1', root: '/work/shop', workers: [], ended: false };
  const sessions = {
    current: () => [session],
    intentsOf: () => [],
    stopIntentsOf: () => [],
    presenceFor: () => null,
    presentOn: () => undefined,
    unwatchAll: () => {},
  } as unknown as RunSessions;
  return RunHub.open({
    sessions,
    actions: {
      action: async () => ({ ok: false, message: refusal }),
      requests: async () => ({ ok: false, message: 'No request here.', requests: [] }),
    },
    runInfo,
    welcome: () => ({
      pid: process.pid,
      version: '0.60.0',
      client: welcome?.client ?? null,
      roots: welcome?.roots ?? [],
    }),
    surfacesChanged: () => {},
    ...extra,
  });
}

describe('stopping a whole run', () => {
  /** A connection to `own` that said hello: its welcome, and the answer to a stop of `ref` sent as command `id`. */
  async function stopOn(own: RunHub, ref: string): Promise<{ welcome: HubMessage; answer: HubMessage }> {
    const socket = new WebSocket(own.url, { origin: ORIGIN });
    const heard: HubMessage[] = [];
    socket.on('message', (data) => void heard.push(readWhole(data)));
    try {
      await new Promise((resolve) => socket.on('open', resolve));
      socket.send(JSON.stringify({ type: 'hello', token: own.token }));
      const welcome = await waitFor(() => heard.find((m) => m.type === 'welcome'));
      socket.send(JSON.stringify({ type: 'stop', id: 4, ref }));
      const answer = await waitFor(() => heard.find((m) => m.type === 'answer'));
      return { welcome, answer };
    } finally {
      socket.close();
    }
  }

  test('is offered by a hub whose host stops runs, which stops the run the command names and says so', async () => {
    const stopped: string[] = [];
    const own = (await ownHub(() => ({ command: null, label: null, project: null }), undefined, undefined, {
      stopRun: async (ref) => {
        stopped.push(ref);
        return { ok: true, message: 'Test Editor stops the run.' };
      },
    }))!;
    try {
      const { welcome, answer } = await stopOn(own, 'ed-1');
      expect(welcome).toMatchObject({ features: ['peers', 'lanes', 'hold', 'presence', 'stop'] });
      expect(answer).toEqual({ type: 'answer', id: 4, ok: true, message: 'Test Editor stops the run.' });
      expect(stopped).toEqual(['ed-1']);
    } finally {
      own.close();
    }
  });

  test('is neither offered nor done by a hub whose host cannot stop a run', async () => {
    const own = (await ownHub(() => ({ command: null, label: null, project: null })))!;
    try {
      const { welcome, answer } = await stopOn(own, 'ed-1');
      expect(welcome).toMatchObject({ features: ['peers', 'lanes', 'hold', 'presence'] });
      expect(answer).toEqual({
        type: 'answer',
        id: 4,
        ok: false,
        message: 'This hub cannot stop a run: stop it where it was started.',
      });
    } finally {
      own.close();
    }
  });
});

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

describe('a failure held at its line', () => {
  test('names its error in the stop both the client and Piwi Picker hear, and a reporter before it names none', async () => {
    const client = await paired();
    client.send({ type: 'subscribe', id: 1 });
    await client.answer(1);
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0);
    const error = "expect(locator).toBeVisible() failed\nLocator: getByRole('button', { name: 'Pay' })";
    const failed = (stop: number, named: string | undefined) =>
      worker.send({
        type: 'stopped',
        stop,
        reason: 'failure',
        title: 'Failed: Error: expect(locator).toBeVisible() failed',
        place: { file: 'tests/cart.spec.ts', line: 3, column: 3 },
        locator: "getByRole('button', { name: 'Pay' })",
        bar: true,
        ...(named === undefined ? {} : { error: named }),
      });
    try {
      worker.begin();
      failed(1, error);
      const heard = await waitFor(() => client.session(ref)?.workers[0]?.stop ?? undefined);
      expect(heard).toMatchObject({ reason: 'failure', error });
      const stopOf = (since: string) => {
        const stop = svc.latest(ref)?.workers[0]?.stop;
        return stop?.since === since ? stop : undefined;
      };
      // Piwi Picker hears what the stop takes from it, the client what its worker takes.
      const { intents, ...asTheClientHears } = heard;
      expect(intents).toEqual(['pick', 'record']);
      expect(await waitFor(() => stopOf(heard.since))).toEqual(asTheClientHears);
      worker.send({ type: 'running', stop: 1 });
      await waitFor(() => (client.session(ref)?.workers[0]?.stop ? undefined : true));
      failed(2, undefined);
      const older = await waitFor(() => client.session(ref)?.workers[0]?.stop ?? undefined);
      expect(older).toMatchObject({ reason: 'failure', title: 'Failed: Error: expect(locator).toBeVisible() failed' });
      expect(older).not.toHaveProperty('error');
      expect(await waitFor(() => stopOf(older.since))).not.toHaveProperty('error');
    } finally {
      worker.socket.destroy();
      client.socket.close();
    }
  });
});

/**
 * A hub message as Piwi Picker reads it, `unreadable` when it reads less than the hub sent: the message, or one of a
 * session's workers or its `live`, which the reader leaves out, or a worker state it reads as `other`.
 */
function readWhole(data: unknown): HubMessage {
  const unreadable = { type: 'unreadable' } as unknown as HubMessage;
  const message = parseHubMessage(String(data));
  if (message?.type === 'peers') {
    const sent = JSON.parse(String(data)) as { hubs: unknown[] };
    return message.hubs.length === sent.hubs.length ? message : unreadable;
  }
  if (message?.type !== 'session') return message ?? unreadable;
  const sent = JSON.parse(String(data)) as { session: { workers: unknown[]; live?: unknown } };
  const { workers, live } = message.session;
  if (workers.length !== sent.session.workers.length || (sent.session.live !== undefined) !== (live !== undefined)) {
    return unreadable;
  }
  if ((sent as { session: { progress?: unknown } }).session.progress !== undefined && !message.session.progress) {
    return unreadable;
  }
  return workers.some((worker) => worker.state === 'other') ? unreadable : message;
}

describe('what the hub sends', () => {
  test('sends how far a run is, which Piwi Picker reads whole', async () => {
    const progress = {
      total: 9,
      done: 4,
      failed: 1,
      flaky: 0,
      skipped: 1,
      status: 'running' as const,
      failure: { title: 'cart › pays', error: 'expect(locator).toBeVisible() failed' },
    };
    const session: RunSession = { ref: 'ed-1', root: '/work/shop', workers: [], ended: false, progress };
    const sessions = {
      current: () => [session],
      intentsOf: () => [],
      stopIntentsOf: () => [],
      presenceFor: () => null,
      presentOn: () => undefined,
      unwatchAll: () => {},
    } as unknown as RunSessions;
    const own = (await ownHub(() => ({ command: null, label: null, project: null }), undefined, undefined, {
      sessions,
    }))!;
    const socket = new WebSocket(own.url, { origin: ORIGIN });
    const heard: HubMessage[] = [];
    socket.on('message', (data) => void heard.push(readWhole(data)));
    try {
      await new Promise((resolve) => socket.on('open', resolve));
      socket.send(JSON.stringify({ type: 'hello', token: own.token }));
      await waitFor(() => heard.find((m) => m.type === 'welcome'));
      socket.send(JSON.stringify({ type: 'subscribe', id: 1 }));
      const sent = await waitFor(() => heard.find((m) => m.type === 'session' || m.type === ('unreadable' as never)));
      expect(sent).toMatchObject({ type: 'session', session: { ref: 'ed-1', progress } });
    } finally {
      socket.close();
      own.close();
    }
  });

  test('names a stop’s line where it stands now, as the editor does, and the run’s page', async () => {
    const stop = {
      reason: 'breakpoint' as const,
      title: 'Click',
      uri: 'file:///work/shop/tests/cart.spec.ts',
      line: 4,
      character: 2,
      locator: null,
      bar: true,
      since: '2026-11-10T10:00:00.000Z',
    };
    const page = { id: 78, url: 'https://piwi.example.com/test-runs/78' };
    const session = {
      ref: 'ed-1',
      root: '/work/shop',
      workers: [
        { worker: 0, parallelIndex: 0, state: 'stopped', test: null, stop, pausing: false, waiting: null, takes: [] },
      ],
      ended: false,
      page,
    } as unknown as RunSession;
    const sessions = {
      current: () => [session],
      intentsOf: () => [],
      stopIntentsOf: () => [],
      presenceFor: () => null,
      presentOn: () => undefined,
      unwatchAll: () => {},
    } as unknown as RunSessions;
    const asked: Array<[string, string, number]> = [];
    const own = (await ownHub(() => ({ command: null, label: null, project: null }), undefined, undefined, {
      sessions,
      // Two lines were added above the stop since the run started.
      lineNow: (ref, uri, line) => (asked.push([ref, uri, line]), line + 2),
    }))!;
    const socket = new WebSocket(own.url, { origin: ORIGIN });
    const heard: HubMessage[] = [];
    socket.on('message', (data) => void heard.push(readWhole(data)));
    try {
      await new Promise((resolve) => socket.on('open', resolve));
      socket.send(JSON.stringify({ type: 'hello', token: own.token }));
      await waitFor(() => heard.find((m) => m.type === 'welcome'));
      socket.send(JSON.stringify({ type: 'subscribe', id: 1 }));
      const sent = (await waitFor(() => heard.find((m) => m.type === 'session'))) as Extract<
        HubMessage,
        { type: 'session' }
      >;
      expect(sent.session.workers[0]?.stop).toMatchObject({ line: 6, uri: stop.uri });
      expect(sent.session.page).toEqual(page);
      expect(asked).toEqual([['ed-1', stop.uri, 4]]);
    } finally {
      socket.close();
      own.close();
    }
  });

  test('tells what a code came to to the connections that follow the runs alone, cut to fit what they read', async () => {
    const long = 'Piwi could not write the check: '.padEnd(MAX_HUB_MESSAGE + 200, 'x');
    const own = (await ownHub(() => ({ command: null, label: null, project: null }), undefined, long))!;
    const connect = async (subscribe: boolean) => {
      const socket = new WebSocket(own.url, { origin: ORIGIN });
      const heard: HubMessage[] = [];
      socket.on('message', (data) => {
        heard.push(readWhole(data));
      });
      await new Promise((resolve) => socket.on('open', resolve));
      socket.send(JSON.stringify({ type: 'hello', token: own.token }));
      await waitFor(() => heard.find((m) => m.type === 'welcome'));
      if (subscribe) {
        socket.send(JSON.stringify({ type: 'subscribe', id: 1 }));
        await waitFor(() => heard.find((m) => m.type === 'answer'));
      }
      return { socket, heard };
    };
    const follower = await connect(true);
    const bystander = await connect(false);
    try {
      own.code({
        ref: 'ed-1',
        worker: 0,
        since: '2026-10-27T10:00:00.000Z',
        action: 'mock',
        ok: true,
        message: long,
        warnings: Array.from({ length: 20 }, (_, i) => `Warning ${i}: `.padEnd(MAX_HUB_MESSAGE + 10, 'w')),
      });
      const code = await waitFor(() => follower.heard.find((m) => m.type === 'code'));
      expect(code).toMatchObject({ type: 'code', ref: 'ed-1', since: '2026-10-27T10:00:00.000Z', ok: true });
      const { message, warnings } = code as Extract<HubMessage, { type: 'code' }>;
      expect(message).toBe(`${long.slice(0, MAX_HUB_MESSAGE - 1)}…`);
      expect(warnings).toHaveLength(MAX_HUB_WARNINGS);
      expect(warnings!.every((w) => w.length === MAX_HUB_MESSAGE && w.endsWith('…'))).toBe(true);
      // An answer too long for the extension is cut the same way.
      follower.socket.send(JSON.stringify({ type: 'assert', id: 2, ref: 'ed-1', since: 's' }));
      const answer = await waitFor(() => follower.heard.find((m) => m.type === 'answer' && m.id === 2));
      expect(answer).toMatchObject({ ok: false, message: `${long.slice(0, MAX_HUB_MESSAGE - 1)}…` });
      expect(follower.heard.map((m) => m.type)).not.toContain('unreadable');
      await new Promise((r) => setTimeout(r, 50));
      expect(bystander.heard.map((m) => m.type)).toEqual(['welcome']);
    } finally {
      follower.socket.close();
      bystander.socket.close();
      own.close();
    }
  });

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
        heard.push(readWhole(data));
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

/** A live hub as an editor's discovery file names it. */
function liveHub(port: number, client = 'Visual Studio Code'): LiveHub {
  return {
    url: `ws://127.0.0.1:${port}/piwi/hub`,
    token: `token-of-the-hub-${port}`,
    pid: 4000 + port,
    version: '0.67.0',
    client,
    roots: [`/work/app-${port}`],
    startedAt: '2026-11-05T10:00:00.000Z',
  };
}

describe('the other live hubs', () => {
  test('are named to a subscribed connection after its runs, never with their tokens, and again only as they change', async () => {
    let live: LiveHub[] = [];
    const own = (await ownHub(() => ({ command: null, label: null, project: null }), undefined, undefined, {
      peers: () => live,
      peersMs: 40,
    }))!;
    live = [liveHub(own.port), liveHub(51_001)];
    try {
      const connect = async (subscribe: boolean) => {
        const socket = new WebSocket(own.url, { origin: ORIGIN });
        const heard: HubMessage[] = [];
        socket.on('message', (data) => {
          heard.push(readWhole(data));
          expect(String(data)).not.toContain('token-of-the-hub');
        });
        await new Promise((resolve) => socket.on('open', resolve));
        socket.send(JSON.stringify({ type: 'hello', token: own.token }));
        await waitFor(() => heard.find((m) => m.type === 'welcome'));
        if (subscribe) socket.send(JSON.stringify({ type: 'subscribe', id: 1 }));
        return { socket, heard };
      };
      const peersOf = (heard: HubMessage[]) =>
        heard.flatMap((m) => (m.type === 'peers' ? [m.hubs.map((hub) => hub.url)] : []));
      const follower = await connect(true);
      const quiet = await connect(false);
      await waitFor(() => peersOf(follower.heard)[0]);
      // The runs first, then the hubs: itself left out.
      expect(follower.heard.map((m) => m.type)).toEqual(['welcome', 'answer', 'session', 'peers']);
      const { token: _token, ...peer } = liveHub(51_001);
      expect(follower.heard[3]).toEqual({ type: 'peers', hubs: [peer] });

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(peersOf(follower.heard)).toHaveLength(1);

      live = [...live, liveHub(51_002, 'IntelliJ IDEA')];
      await waitFor(() => peersOf(follower.heard)[1]);
      expect(peersOf(follower.heard)[1]).toEqual(['ws://127.0.0.1:51001/piwi/hub', 'ws://127.0.0.1:51002/piwi/hub']);
      live = [];
      await waitFor(() => peersOf(follower.heard)[2]);
      expect(peersOf(follower.heard)[2]).toEqual([]);
      expect(peersOf(quiet.heard)).toEqual([]);
      expect(follower.heard.map((m) => m.type)).not.toContain('unreadable');
      follower.socket.close();
      quiet.socket.close();
    } finally {
      own.close();
    }
  });

  test('are named up to their limit, and a folder that cannot be read sends none and keeps the connection', async () => {
    let live: LiveHub[] = Array.from({ length: MAX_HUB_PEERS + 10 }, (_, i) => liveHub(52_000 + i));
    let fail = false;
    const own = (await ownHub(() => ({ command: null, label: null, project: null }), undefined, undefined, {
      peers: () => {
        if (fail) throw new Error('EACCES');
        return live;
      },
      peersMs: 40,
    }))!;
    try {
      const socket = new WebSocket(own.url, { origin: ORIGIN });
      const heard: HubMessage[] = [];
      socket.on('message', (data) => void heard.push(readWhole(data)));
      await new Promise((resolve) => socket.on('open', resolve));
      socket.send(JSON.stringify({ type: 'hello', token: own.token }));
      socket.send(JSON.stringify({ type: 'subscribe', id: 1 }));
      const first = await waitFor(() => heard.find((m) => m.type === 'peers'));
      expect((first as Extract<HubMessage, { type: 'peers' }>).hubs).toHaveLength(MAX_HUB_PEERS);
      fail = true;
      live = [];
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(heard.filter((m) => m.type === 'peers')).toHaveLength(1);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      socket.close();
    } finally {
      own.close();
    }
  });

  test('are read by the service from the editors’ folder it is given', async () => {
    const editors = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-editors-'));
    fs.chmodSync(editors, 0o700);
    const other = await service(dir, false, { editorsDir: editors, hubPeersMs: 40 });
    try {
      const published = await waitFor(() => other.published[0] ?? undefined);
      writeDiscovery(editors, {
        pid: process.pid,
        host: os.hostname(),
        version: '0.67.0',
        client: 'IntelliJ IDEA',
        startedAt: '2026-11-05T10:00:00.000Z',
        roots: ['/work/api'],
        hub: { url: 'ws://127.0.0.1:53001/piwi/hub', token: 'token-of-the-hub-53001' },
        runChannel: null,
        recorderBundle: null,
      });
      const socket = new WebSocket(published.hub!.url, { origin: ORIGIN });
      const heard: HubMessage[] = [];
      socket.on('message', (data) => void heard.push(readWhole(data)));
      await new Promise((resolve) => socket.on('open', resolve));
      socket.send(JSON.stringify({ type: 'hello', token: published.hub!.token }));
      socket.send(JSON.stringify({ type: 'subscribe', id: 1 }));
      const peers = await waitFor(() => heard.find((m) => m.type === 'peers'));
      expect(peers).toEqual({
        type: 'peers',
        hubs: [
          {
            url: 'ws://127.0.0.1:53001/piwi/hub',
            pid: process.pid,
            version: '0.67.0',
            client: 'IntelliJ IDEA',
            roots: ['/work/api'],
            startedAt: '2026-11-05T10:00:00.000Z',
          },
        ],
      });
      socket.close();
    } finally {
      other.stop();
      fs.rmSync(editors, { recursive: true, force: true });
    }
  });
});
