/**
 * The live view of a stopped page, the input played on it and Pick on the image: the run sessions as a worker on a
 * fake socket tells them, then the hub's WebSocket as Piwi Picker reaches it, against a service started in-process,
 * and `piwi/pickAt` as the editor's client asks it.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import type * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { RUN_TAKES, type HubToRun, type RunTake, type RunToHub } from '@piwitests/core/run-channel';
import {
  parseHubMessage,
  type HubAnswer,
  type HubFrameMessage,
  type HubFrameRefusal,
  type HubMessage,
  type HubSession,
} from '@piwitests/core/run-hub';
import { MAX_VIEW_EVENT_RATE, MAX_VIEW_FRAME_BASE64 } from '@piwitests/core/run-view';
import type { PickAtResult, RunSession } from '../src/protocol';
import { RunSessions, type ViewFrame, type Viewer } from '../src/run-sessions';
import { ClientPageView } from '../src/client-page-view';
import { FakeWorker, last, service, waitFor, writeRunWorkspace, type Service } from './run-fixtures';

const ORIGIN = `chrome-extension://${'b'.repeat(32)}`;
const NEEDS_BAR =
  "Pick a locator needs the pause bar in the test's window, and this test runs headless: run it headed.";

function fakeSocket() {
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    written: [] as string[],
    write(line: string) {
      socket.written.push(line);
      return true;
    },
    destroy() {
      if (socket.destroyed) return;
      socket.destroyed = true;
      queueMicrotask(() => socket.emit('close'));
    },
  });
  return socket;
}

/** A session of `ed-1` and its worker 0 on a fake socket: what the worker heard, and how it answers. */
function harness(takes: RunTake[] = [...RUN_TAKES]) {
  const sent: RunSession[] = [];
  const sessions = new RunSessions({
    notify: (session) => void sent.push(session),
    answersStops: () => true,
    notice: () => {},
    rootOf: () => '/work/shop',
    paceMs: 5,
    burstMs: 0,
    requestMs: 2000,
  });
  const socket = fakeSocket();
  const reader = sessions.attach(socket as unknown as net.Socket, {
    type: 'run-attach',
    token: 't',
    ref: 'ed-1',
    cwd: '/work/shop',
    workerIndex: 0,
    parallelIndex: 0,
    pid: 1,
    playwright: '1.64.1',
    reporter: '0.61.0',
    takes,
  });
  const read = (message: RunToHub) => reader(JSON.stringify(message));
  const heard = (): HubToRun[] => socket.written.map((line) => JSON.parse(line) as HubToRun);
  const requests = <W extends string>(what: W) =>
    heard().filter(
      (m): m is Extract<HubToRun, { type: 'request' }> & { what: W } => m.type === 'request' && m.what === what,
    );
  const answer = (request: number, what: string, value: unknown) =>
    reader(JSON.stringify({ type: 'answer', request, what, value }));
  let lastSince = '';
  const stopAt = async (stop: number, bar = false): Promise<string> => {
    read({
      type: 'stopped',
      stop,
      reason: 'breakpoint',
      title: 'Click',
      place: { file: 'tests/a.spec.ts', line: 4 },
      locator: null,
      bar,
    });
    return waitFor(() => {
      const at = last(sent)?.workers[0]?.stop;
      return at && sent.length && at.since !== lastSince ? (lastSince = at.since) : undefined;
    });
  };
  read({
    type: 'test-begin',
    testId: 't1',
    title: ['a'],
    file: 'tests/a.spec.ts',
    line: 1,
    project: '',
    retry: 0,
    cannotPause: null,
  });
  return { sessions, read, heard, requests, answer, stopAt, socket };
}

function viewer(): Viewer & { frames: ViewFrame[] } {
  const frames: ViewFrame[] = [];
  return { frames, frame: (frame) => void frames.push(frame) };
}

const frameOf = (stop: number, data = '/9j/AA=='): RunToHub => ({ type: 'frame', stop, width: 800, height: 600, data });

describe('the editor panel’s live viewer', () => {
  test('keeps only the latest waiting frame and drops it when the panel leaves', async () => {
    const h = harness();
    const since = await h.stopAt(1);
    const frames: ViewFrame[] = [];
    let finish!: () => void;
    const client = new ClientPageView(h.sessions, async (frame) => {
      frames.push(frame);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const at = { ref: 'ed-1', worker: 0, since, on: true };
    const watching = client.watch(at);
    h.answer(h.requests('view')[0]!.request, 'view', { ok: true, message: 'Watching.' });
    expect((await watching).ok).toBe(true);
    h.read(frameOf(1, '/9j/AA=='));
    h.read(frameOf(1, '/9j/BB=='));
    h.read(frameOf(1, '/9j/CC=='));
    expect(frames).toHaveLength(1);
    finish();
    await waitFor(() => (frames.length === 2 ? true : undefined));
    expect(frames[1]).toMatchObject({ data: '/9j/CC==' });
    h.read(frameOf(1, '/9j/DD=='));
    await client.watch({ ...at, on: false });
    finish();
    await Promise.resolve();
    expect(frames).toHaveLength(2);
    expect(last(h.requests('view'))).toMatchObject({ on: false });
    h.sessions.dispose();
  });

  test('binds input and release to the watched stop and releases held keys on close', async () => {
    const h = harness();
    const since = await h.stopAt(1);
    const client = new ClientPageView(h.sessions, async () => {});
    const at = { ref: 'ed-1', worker: 0, since, on: true };
    const events = [
      { type: 'key', action: 'down', key: 'Control' },
      { type: 'mouse', action: 'down', x: 3, y: 4, button: 'left' },
    ] as const;
    expect((await client.input({ ...at, events: [...events] })).ok).toBe(false);
    const watching = client.watch(at);
    h.answer(h.requests('view')[0]!.request, 'view', { ok: true, message: 'Watching.' });
    await watching;
    const playing = client.input({ ...at, events: [...events] });
    h.answer(h.requests('input')[0]!.request, 'input', { ok: true, message: 'Played.' });
    expect((await playing).ok).toBe(true);
    expect((await client.input({ ...at, since: 'old', events: [], release: true })).ok).toBe(false);
    expect((await client.input({ ...at, events: [{ type: 'key', action: 'press', key: 'unrecognized' }] })).ok).toBe(
      false,
    );
    await client.watch({ ...at, since: 'old', on: false });
    expect(h.sessions.viewing(client.viewer, at.ref, at.worker, since)).toBe(true);
    client.dispose();
    expect(h.requests('input')[1]).toMatchObject({
      events: [
        { type: 'mouse', action: 'up', x: 3, y: 4, button: 'left' },
        { type: 'key', action: 'up', key: 'Control' },
      ],
    });
    h.answer(h.requests('input')[1]!.request, 'input', { ok: true, message: 'Released.' });
    expect((await client.input({ ...at, events: [...events] })).ok).toBe(false);
    h.sessions.dispose();
  });

  test('refuses an older reporter', async () => {
    const h = harness([]);
    const since = await h.stopAt(1);
    const client = new ClientPageView(h.sessions, async () => {});
    expect((await client.watch({ ref: 'ed-1', worker: 0, since, on: true })).ok).toBe(false);
    expect(h.requests('view')).toHaveLength(0);
    client.changed();
    client.dispose();
    h.sessions.dispose();
  });

  test('drops a pending frame when its stop resumes and requires the new stop to be watched', async () => {
    const h = harness();
    const since = await h.stopAt(1);
    const frames: ViewFrame[] = [];
    let finish!: () => void;
    const client = new ClientPageView(h.sessions, async (frame) => {
      frames.push(frame);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const at = { ref: 'ed-1', worker: 0, since, on: true };
    const watching = client.watch(at);
    h.answer(h.requests('view')[0]!.request, 'view', { ok: true, message: 'Watching.' });
    await watching;
    h.read(frameOf(1));
    h.read(frameOf(1, '/9j/BB=='));
    h.read({ type: 'running', stop: 1 });
    client.changed();
    finish();
    await Promise.resolve();
    const next = await h.stopAt(2);
    h.read(frameOf(2));
    expect(frames).toHaveLength(1);
    expect((await client.input({ ...at, since: next, events: [{ type: 'text', text: 'no' }] })).ok).toBe(false);
    client.dispose();
    h.sessions.dispose();
  });
});

describe('a stopped page’s live view, in the run sessions', () => {
  test('starts with the stop’s first viewer and stops with its last, its frames to its viewers alone', async () => {
    const { sessions, read, requests, answer, stopAt } = harness();
    const since = await stopAt(1);
    const [a, b, c] = [viewer(), viewer(), viewer()];
    const watchedA = sessions.watch({ ref: 'ed-1', since, on: true }, a);
    const watchedB = sessions.watch({ ref: 'ed-1', since, on: true }, b);
    // One worker, one view: the second viewer joins the first.
    expect(requests('view')).toEqual([
      { type: 'request', request: expect.any(Number), what: 'view', stop: 1, on: true },
    ]);
    answer(requests('view')[0]!.request, 'view', { ok: true, message: 'The live view is on.' });
    expect(await watchedA).toEqual({ ok: true, message: 'The live view is on.' });
    expect(await watchedB).toEqual({ ok: true, message: 'The live view is on.' });

    read(frameOf(1));
    // A frame of another stop than the one the worker stands at goes nowhere.
    read(frameOf(7, '/9j/BB=='));
    const frame = { ref: 'ed-1', worker: 0, since, width: 800, height: 600, data: '/9j/AA==' };
    expect(a.frames).toEqual([frame]);
    expect(b.frames).toEqual([frame]);
    expect(c.frames).toEqual([]);
    expect(sessions.viewing(a, 'ed-1', 0, since)).toBe(true);
    expect(sessions.viewing(c, 'ed-1', 0, since)).toBe(false);

    expect(await sessions.watch({ ref: 'ed-1', since, on: false }, a)).toEqual({
      ok: true,
      message: 'You no longer watch the page.',
    });
    expect(requests('view')).toHaveLength(1);
    read(frameOf(1, '/9j/CC=='));
    expect(a.frames).toHaveLength(1);
    expect(b.frames).toHaveLength(2);
    // The last viewer leaves: the worker stops the view.
    sessions.unwatchAll(b);
    expect(requests('view')).toHaveLength(2);
    expect(requests('view')[1]).toMatchObject({ what: 'view', stop: 1, on: false });
    read(frameOf(1, '/9j/DD=='));
    expect(b.frames).toHaveLength(2);
    sessions.dispose();
  });

  test('has the worker send its latest frame again for a viewer that comes to a view on', async () => {
    const { sessions, read, requests, answer, stopAt } = harness();
    const since = await stopAt(1);
    const [a, b] = [viewer(), viewer()];
    const watchedA = sessions.watch({ ref: 'ed-1', since, on: true }, a);
    answer(requests('view')[0]!.request, 'view', { ok: true, message: 'The live view is on.' });
    await watchedA;
    read(frameOf(1));
    // A still page paints no other frame: the second viewer has the worker send the one it sent last again.
    const watchedB = sessions.watch({ ref: 'ed-1', since, on: true }, b);
    expect(requests('view')).toHaveLength(2);
    expect(requests('view')[1]).toMatchObject({ what: 'view', stop: 1, on: true });
    answer(requests('view')[1]!.request, 'view', { ok: true, message: 'The live view is on.' });
    read(frameOf(1));
    expect(await watchedB).toEqual({ ok: true, message: 'The live view is on.' });
    expect(b.frames.map((f) => 'data' in f && f.data)).toEqual(['/9j/AA==']);
    // A viewer that watches already asks nothing more.
    await sessions.watch({ ref: 'ed-1', since, on: true }, b);
    expect(requests('view')).toHaveLength(2);
    sessions.dispose();
  });

  test('ends with its stop: no frame of the stop before, and the next stop needs its own view', async () => {
    const { sessions, read, requests, answer, stopAt } = harness();
    const first = await stopAt(1);
    const a = viewer();
    const watched = sessions.watch({ ref: 'ed-1', since: first, on: true }, a);
    answer(requests('view')[0]!.request, 'view', { ok: true, message: 'The live view is on.' });
    await watched;
    read({ type: 'running', stop: 1 });
    read(frameOf(1));
    expect(a.frames).toEqual([]);
    const second = await stopAt(2);
    read(frameOf(2));
    expect(a.frames).toEqual([]);
    expect(await sessions.watch({ ref: 'ed-1', since: first, on: true }, a)).toEqual({
      ok: false,
      message: 'The test went on.',
    });
    const again = sessions.watch({ ref: 'ed-1', since: second, on: true }, a);
    expect(requests('view')).toHaveLength(2);
    expect(requests('view')[1]).toMatchObject({ stop: 2, on: true });
    answer(requests('view')[1]!.request, 'view', { ok: true, message: 'The live view is on.' });
    expect(await again).toMatchObject({ ok: true });
    read(frameOf(2));
    expect(a.frames.map((f) => f.since)).toEqual([second]);
    // The test ends under the stop: its view goes with it.
    read({ type: 'test-end', testId: 't1', status: 'passed', pausedMs: 10 });
    read(frameOf(2));
    expect(a.frames).toHaveLength(1);
    sessions.dispose();
  });

  test('refuses a view the worker cannot show, and one of a reporter that does not take it', async () => {
    const { sessions, read, requests, answer, stopAt } = harness();
    const since = await stopAt(1);
    const a = viewer();
    const refused = sessions.watch({ ref: 'ed-1', since, on: true }, a);
    const why = "This stop has no page to show: its call does not name one among its context's pages.";
    answer(requests('view')[0]!.request, 'view', { ok: false, message: why });
    expect(await refused).toEqual({ ok: false, message: why });
    read(frameOf(1));
    expect(a.frames).toEqual([]);
    expect(sessions.viewing(a, 'ed-1', 0, since)).toBe(false);
    // Asked again, the worker is asked again.
    void sessions.watch({ ref: 'ed-1', since, on: true }, a);
    expect(requests('view')).toHaveLength(2);
    sessions.dispose();

    const older = harness(['pick', 'record']);
    const at = await older.stopAt(1);
    expect(await older.sessions.watch({ ref: 'ed-1', since: at, on: true }, a)).toEqual({
      ok: false,
      message: "@piwitests/reporter 0.61.0 cannot show the stopped page's live view: update it.",
    });
    expect(await older.sessions.input({ ref: 'ed-1', since: at }, a, [{ type: 'text', text: 'a' }])).toMatchObject({
      ok: false,
      message: '@piwitests/reporter 0.61.0 cannot play input on the stopped page: update it.',
    });
    expect(older.requests('view')).toEqual([]);
    older.sessions.dispose();
  });

  test('takes Pick and Record at a stop no pause bar shows from a viewer of its view alone, and offers them so', async () => {
    const { sessions, requests, answer, stopAt } = harness();
    const since = await stopAt(1);
    const a = viewer();
    const b = viewer();
    expect(await sessions.intent({ ref: 'ed-1', since, what: 'pick', viewer: a })).toEqual({
      ok: false,
      message: NEEDS_BAR,
    });
    expect(sessions.stopIntentsOf('ed-1', 0, a)).toEqual(['view', 'pick-at', 'end']);
    const watched = sessions.watch({ ref: 'ed-1', since, on: true }, a);
    answer(requests('view')[0]!.request, 'view', { ok: true, message: 'The live view is on.' });
    await watched;
    expect(sessions.stopIntentsOf('ed-1', 0, a)).toEqual([
      'pick',
      'record',
      'view',
      'input',
      'input-clicks',
      'pick-at',
      'end',
    ]);
    expect(sessions.stopIntentsOf('ed-1', 0, b)).toEqual(['view', 'pick-at', 'end']);
    expect(sessions.stopIntentsOf('ed-1', 0, null)).toEqual(['view', 'pick-at', 'end']);
    // Someone who does not watch is refused, as without a view.
    expect(await sessions.intent({ ref: 'ed-1', since, what: 'pick', viewer: b })).toEqual({
      ok: false,
      message: NEEDS_BAR,
    });
    expect(requests('pick')).toEqual([]);
    const started = sessions.intent({ ref: 'ed-1', since, what: 'pick', viewer: a });
    expect(requests('pick')).toEqual([{ type: 'request', request: expect.any(Number), what: 'pick', stop: 1 }]);
    answer(requests('pick')[0]!.request, 'pick', { ok: true, message: 'Pick an element in the view.' });
    expect(await started).toEqual({ ok: true, message: 'Pick an element in the view.' });
    sessions.dispose();
  });

  test('offers the actions in the window at a stop the pause bar shows, and the input to its viewers alone', async () => {
    const { sessions, stopAt } = harness();
    await stopAt(1, true);
    expect(sessions.stopIntentsOf('ed-1', 0, viewer())).toEqual(['pick', 'record', 'view', 'pick-at', 'end']);
    expect(sessions.stopIntentsOf('ed-9', 0, null)).toEqual([]);
    sessions.dispose();
  });

  test('plays a viewer’s input on the page it watches, and refuses anyone else’s', async () => {
    const { sessions, requests, answer, stopAt } = harness();
    const since = await stopAt(1);
    const a = viewer();
    const events = [{ type: 'mouse', action: 'click', x: 20, y: 90, button: 'left', clickCount: 1 } as const];
    expect(await sessions.input({ ref: 'ed-1', since }, a, [...events])).toEqual({
      ok: false,
      message: 'The input needs the live view of this stop: watch it first.',
    });
    const watched = sessions.watch({ ref: 'ed-1', since, on: true }, a);
    answer(requests('view')[0]!.request, 'view', { ok: true, message: 'The live view is on.' });
    await watched;
    const played = sessions.input({ ref: 'ed-1', since }, a, [...events]);
    expect(requests('input')).toEqual([
      { type: 'request', request: expect.any(Number), what: 'input', stop: 1, events },
    ]);
    answer(requests('input')[0]!.request, 'input', { ok: true, message: 'Played 1 event.' });
    expect(await played).toEqual({ ok: true, message: 'Played 1 event.' });
    expect(await sessions.input({ ref: 'ed-1', since: 'gone' }, a, [...events])).toEqual({
      ok: false,
      message: 'The test went on.',
    });
    sessions.dispose();
  });

  test('picks at a point of a stopped page for anyone who names the stop, and says why it cannot', async () => {
    const { sessions, requests, answer, stopAt } = harness();
    const since = await stopAt(1);
    expect(await sessions.pickAt({ ref: 'ed-1', since: '', x: 1, y: 1 })).toEqual({
      ok: false,
      message: 'The command needs the stop it answers.',
      locator: null,
    });
    for (const [x, y] of [
      [-1, 1],
      [1, 10_001],
      [Number.NaN, 1],
    ] as const) {
      expect(await sessions.pickAt({ ref: 'ed-1', since, x, y })).toMatchObject({ ok: false, locator: null });
    }
    expect(requests('pick-at')).toEqual([]);
    const picked = sessions.pickAt({ ref: 'ed-1', since, x: 20, y: 90.5 });
    expect(requests('pick-at')).toEqual([
      { type: 'request', request: expect.any(Number), what: 'pick-at', stop: 1, x: 20, y: 90.5 },
    ]);
    const locator = "getByRole('button', { name: 'Go' })";
    answer(requests('pick-at')[0]!.request, 'pick-at', { ok: true, message: 'Sent.', locator });
    expect(await picked).toEqual({ ok: true, message: 'Sent.', locator });
    sessions.dispose();

    const older = harness(['pick']);
    const at = await older.stopAt(1);
    expect(await older.sessions.pickAt({ ref: 'ed-1', since: at, x: 1, y: 1 })).toEqual({
      ok: false,
      message:
        '@piwitests/reporter 0.61.0 cannot pick the element under a point of an image of the stopped page: update it.',
      locator: null,
    });
    older.sessions.dispose();
  });

  test('forgets the views of a worker whose connection closed', async () => {
    const { sessions, read, requests, answer, stopAt, socket } = harness();
    const since = await stopAt(1);
    const a = viewer();
    const watched = sessions.watch({ ref: 'ed-1', since, on: true }, a);
    answer(requests('view')[0]!.request, 'view', { ok: true, message: 'The live view is on.' });
    await watched;
    socket.destroy();
    await new Promise((r) => setTimeout(r, 10));
    read(frameOf(1));
    expect(a.frames).toEqual([]);
    expect(sessions.viewing(a, 'ed-1', 0, since)).toBe(false);
    sessions.dispose();
  });
});

describe('the live view on the hub', () => {
  let dir = '';
  let svc: Service;
  let hub: { url: string; token: string };

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-view-')));
    writeRunWorkspace(dir);
    svc = await service(dir, true);
    hub = (await waitFor(() => svc.published[0] ?? undefined)).hub!;
  });

  afterAll(() => {
    svc?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  interface Client {
    socket: WebSocket;
    messages: HubMessage[];
    send(message: object): void;
    answer(id: number): Promise<HubAnswer>;
    session(ref: string): HubSession | undefined;
    frames(): HubFrameMessage[];
    refusals(): HubFrameRefusal[];
  }

  async function paired(): Promise<Client> {
    const socket = new WebSocket(hub.url, { origin: ORIGIN });
    const messages: HubMessage[] = [];
    socket.on('message', (data) => {
      const message = parseHubMessage(String(data));
      if (message) messages.push(message);
    });
    await new Promise((resolve) => socket.on('open', resolve));
    const client: Client = {
      socket,
      messages,
      send: (message) => socket.send(JSON.stringify(message)),
      answer: (id) => waitFor(() => messages.find((m): m is HubAnswer => m.type === 'answer' && m.id === id)),
      session: (ref) =>
        messages
          .filter((m): m is Extract<HubMessage, { type: 'session' }> => m.type === 'session' && m.session.ref === ref)
          .pop()?.session,
      frames: () => messages.filter((m): m is HubFrameMessage => m.type === 'frame' && 'data' in m),
      refusals: () => messages.filter((m): m is HubFrameRefusal => m.type === 'frame' && 'refused' in m),
    };
    client.send({ type: 'hello', token: hub.token });
    await waitFor(() => messages.find((m) => m.type === 'welcome'));
    client.send({ type: 'subscribe', id: 1 });
    await client.answer(1);
    return client;
  }

  /** A worker of a new run, stopped headless at its first stop, which `client` heard. */
  async function stopped(client: Client): Promise<{ ref: string; worker: FakeWorker; since: string }> {
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0, [...RUN_TAKES]);
    worker.begin();
    worker.stopAt(1, 30, false);
    const stop = await waitFor(() => client.session(ref)?.workers[0]?.stop ?? undefined);
    return { ref, worker, since: stop.since };
  }

  /** The worker answers the latest request of `what` it heard. */
  async function answerLatest(worker: FakeWorker, what: string, value: unknown, after = 0): Promise<HubToRun> {
    const asked = await waitFor(
      () => worker.heard.filter((m) => m.type === 'request' && m.what === what)[after] as HubToRun | undefined,
    );
    worker.send({ type: 'answer', request: (asked as { request: number }).request, what, value } as RunToHub);
    return asked;
  }

  test('sends a stop’s frames to the connections that watch it alone, the latest one at the view’s pace', async () => {
    const [a, b] = [await paired(), await paired()];
    const { ref, worker, since } = await stopped(a);
    try {
      a.send({ type: 'view', id: 2, ref, since, on: true });
      expect(await answerLatest(worker, 'view', { ok: true, message: 'The live view is on.' })).toMatchObject({
        stop: 1,
        on: true,
      });
      expect(await a.answer(2)).toMatchObject({ ok: true, message: 'The live view is on.' });
      // What the stop takes from each: the connection that watches drives the page through its view.
      const intentsOf = (client: Client) =>
        waitFor(() => {
          const stop = client.session(ref)?.workers[0]?.stop;
          return stop?.intents?.includes('input') || client === b ? stop?.intents : undefined;
        });
      expect(await intentsOf(a)).toEqual(['pick', 'record', 'view', 'input', 'input-clicks', 'pick-at', 'end']);
      expect(await intentsOf(b)).toEqual(['view', 'pick-at', 'end']);

      const started = Date.now();
      for (let i = 0; i < 30; i++)
        worker.send({ type: 'frame', stop: 1, width: 1280, height: 720, data: `/9j/${i}A==` });
      await waitFor(() => (a.frames().some((f) => f.data === '/9j/29A==') ? true : undefined));
      const took = Date.now() - started;
      // The first goes at once, the latest once the pace allows; the 28 between are dropped.
      expect(a.frames().map((f) => f.data)).toEqual(['/9j/0A==', '/9j/29A==']);
      expect(took).toBeGreaterThanOrEqual(80);
      expect(a.frames()[0]).toEqual({
        type: 'frame',
        ref,
        worker: 0,
        since,
        width: 1280,
        height: 720,
        data: '/9j/0A==',
      });
      expect(b.frames()).toEqual([]);

      // The stop ends: no frame of it is sent after, and the view needs asking again at the next.
      worker.send({ type: 'frame', stop: 1, width: 1280, height: 720, data: '/9j/30A==' });
      worker.send({ type: 'running', stop: 1 });
      worker.send({ type: 'frame', stop: 1, width: 1280, height: 720, data: '/9j/31A==' });
      await new Promise((r) => setTimeout(r, 250));
      expect(a.frames().map((f) => f.data)).not.toContain('/9j/31A==');
      expect(a.frames().map((f) => f.data)).not.toContain('/9j/30A==');
    } finally {
      worker.socket.destroy();
      a.socket.close();
      b.socket.close();
    }
  });

  test('tells the connections that watch a stop why its view sends no frame, as a frame goes', async () => {
    const [a, b] = [await paired(), await paired()];
    const { ref, worker, since } = await stopped(a);
    try {
      a.send({ type: 'view', id: 2, ref, since, on: true });
      await answerLatest(worker, 'view', { ok: true, message: 'The live view is on.' });
      await a.answer(2);
      const refused = 'This page is too heavy for the live view.';
      worker.send({ type: 'frame', stop: 1, refused });
      expect(await waitFor(() => a.refusals()[0])).toEqual({ type: 'frame', ref, worker: 0, since, refused });
      // Then a frame takes its place.
      worker.send({ type: 'frame', stop: 1, width: 1280, height: 720, data: '/9j/AA==' });
      await waitFor(() => a.frames()[0]);
      await new Promise((r) => setTimeout(r, 150));
      expect(b.refusals()).toEqual([]);
      expect(b.frames()).toEqual([]);
    } finally {
      worker.socket.destroy();
      a.socket.close();
      b.socket.close();
    }
  });

  test('keeps the latest frame alone for a connection whose socket is backed up', async () => {
    const a = await paired();
    const { ref, worker, since } = await stopped(a);
    try {
      a.send({ type: 'view', id: 2, ref, since, on: true });
      await answerLatest(worker, 'view', { ok: true, message: 'The live view is on.' });
      await a.answer(2);
      // It reads nothing for a while: what the hub sends piles up in its socket, then in the hub.
      a.socket.pause();
      const big = 'A'.repeat(MAX_VIEW_FRAME_BASE64 - 8);
      const sent = 30;
      for (let i = 0; i < sent; i++) {
        worker.send({
          type: 'frame',
          stop: 1,
          width: 1280,
          height: 720,
          data: `${big}${String(i).padStart(4, '0')}AAAA`,
        });
        await new Promise((r) => setTimeout(r, 110));
      }
      a.socket.resume();
      const latest = `${big}${String(sent - 1).padStart(4, '0')}AAAA`;
      await waitFor(() => (a.frames().some((f) => f.data === latest) ? true : undefined), 10_000);
      const got = a.frames().length;
      expect(got).toBeLessThan(sent);
      expect(last(a.frames())!.data).toBe(latest);
    } finally {
      worker.socket.destroy();
      a.socket.close();
    }
  }, 20_000);

  test('plays the input of the connection that watches, within its pace, and picks at a point for anyone', async () => {
    const [a, b] = [await paired(), await paired()];
    const { ref, worker, since } = await stopped(a);
    try {
      const click = { type: 'mouse', action: 'click', x: 20, y: 90, button: 'left', clickCount: 1 };
      b.send({ type: 'input', id: 2, ref, since, events: [click] });
      expect(await b.answer(2)).toMatchObject({
        ok: false,
        message: 'The input needs the live view of this stop: watch it first.',
      });
      a.send({ type: 'view', id: 3, ref, since, on: true });
      await answerLatest(worker, 'view', { ok: true, message: 'The live view is on.' });
      await a.answer(3);
      const moves = Array.from({ length: 50 }, (_, i) => ({ type: 'mouse', action: 'move', x: i, y: i }));
      const batches = MAX_VIEW_EVENT_RATE / moves.length;
      for (let id = 10; id < 10 + batches + 1; id++) a.send({ type: 'input', id, ref, since, events: moves });
      expect(await a.answer(10 + batches)).toEqual({
        type: 'answer',
        id: 10 + batches,
        ok: false,
        message: `Too much input: ${MAX_VIEW_EVENT_RATE} events a second at most.`,
      });
      for (let i = 0; i < batches; i++)
        await answerLatest(worker, 'input', { ok: true, message: 'Played 50 events.' }, i);
      expect(await a.answer(10)).toMatchObject({ ok: true, message: 'Played 50 events.' });
      expect(worker.heard.filter((m) => m.type === 'request' && m.what === 'input')).toHaveLength(batches);

      // Pick on the image needs no view: any image of the page will do.
      b.send({ type: 'pick-at', id: 4, ref, since, x: 20, y: 90 });
      const locator = "getByRole('button', { name: 'Go' })";
      expect(await answerLatest(worker, 'pick-at', { ok: true, message: 'Sent.', locator })).toMatchObject({
        x: 20,
        y: 90,
        stop: 1,
      });
      expect(await b.answer(4)).toEqual({ type: 'answer', id: 4, ok: true, message: 'Sent.', locator });

      // The connection that watched leaves: the worker stops the view.
      a.socket.close();
      expect(
        await waitFor(() => worker.heard.filter((m) => m.type === 'request' && m.what === 'view')[1]),
      ).toMatchObject({ on: false, stop: 1 });
    } finally {
      worker.socket.destroy();
      a.socket.close();
      b.socket.close();
    }
  });

  test('answers piwi/pickAt for the editor’s client, the locator sent where a pick goes', async () => {
    const a = await paired();
    const { ref, worker, since } = await stopped(a);
    try {
      const asked = svc.client.sendRequest('piwi/pickAt', { ref, since, x: 12.5, y: 40 }) as Promise<PickAtResult>;
      await answerLatest(worker, 'pick-at', { ok: false, message: 'No element there.', locator: null });
      expect(await asked).toEqual({ ok: false, message: 'No element there.', locator: null });
      expect(worker.heard.find((m) => m.type === 'request' && m.what === 'pick-at')).toMatchObject({ x: 12.5, y: 40 });
      expect(await svc.client.sendRequest('piwi/pickAt', { ref, since: 'gone', x: 1, y: 1 })).toEqual({
        ok: false,
        message: 'The test went on.',
        locator: null,
      });
    } finally {
      worker.socket.destroy();
      a.socket.close();
    }
  });

  test('streams to the editor client only after watching, and binds input to that stop', async () => {
    const a = await paired();
    const { ref, worker, since } = await stopped(a);
    const frames: ViewFrame[] = [];
    const listener = svc.client.onNotification('piwi/pageFrame', (frame: ViewFrame) => void frames.push(frame));
    const at = { ref, worker: 0, since };
    try {
      const watch = svc.client.sendRequest('piwi/pageView', { ...at, on: true });
      await answerLatest(worker, 'view', { ok: true, message: 'Watching.' });
      expect(await watch).toMatchObject({ ok: true });
      worker.send(frameOf(1));
      await waitFor(() => (frames.length === 1 ? true : undefined));
      expect(frames[0]).toMatchObject({ ...at, data: '/9j/AA==' });
      const input = svc.client.sendRequest('piwi/pageInput', { ...at, events: [{ type: 'text', text: 'hello' }] });
      await answerLatest(worker, 'input', { ok: true, message: 'Played.' });
      expect(await input).toMatchObject({ ok: true });
      expect(
        await svc.client.sendRequest('piwi/pageInput', {
          ...at,
          since: 'stale',
          events: [{ type: 'text', text: 'no' }],
        }),
      ).toMatchObject({ ok: false });
      expect(await svc.client.sendRequest('piwi/pageView', { ...at, on: false })).toMatchObject({ ok: true });
      expect(
        await svc.client.sendRequest('piwi/pageInput', { ...at, events: [{ type: 'text', text: 'no' }] }),
      ).toMatchObject({ ok: false });
      worker.send(frameOf(1, '/9j/BB=='));
      // A round trip also lets any preceding notification reach the client.
      await svc.client.sendRequest('piwi/pageView', { ...at, on: false });
      expect(frames).toHaveLength(1);
    } finally {
      listener.dispose();
      worker.socket.destroy();
      a.socket.close();
    }
  });
});
