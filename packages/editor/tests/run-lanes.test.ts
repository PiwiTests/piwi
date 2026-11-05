/**
 * A lane watched while its tests run: the run sessions as workers on fake sockets tell them, then the hub's WebSocket
 * as Piwi Picker reaches it, against a service started in-process.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import type * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { RUN_TAKES, type HubToRun, type RunFeature, type RunToHub } from '@piwitests/core/run-channel';
import {
  parseHubMessage,
  type HubAnswer,
  type HubLaneFrameMessage,
  type HubMessage,
  type HubSession,
} from '@piwitests/core/run-hub';
import type { RunSession } from '../src/protocol';
import { RunSessions, type LaneViewFrame, type Viewer } from '../src/run-sessions';
import { FakeWorker, last, service, waitFor, writeRunWorkspace, type Service } from './run-fixtures';

const ORIGIN = `chrome-extension://${'c'.repeat(32)}`;
const UPDATE = 'Update the reporter to watch a running test: this one shows a stopped test alone.';

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

/** The run `ed-1` in sessions of its own, and how each of its workers joins, talks and hears. */
function harness(requestMs = 2000) {
  const sent: RunSession[] = [];
  const sessions = new RunSessions({
    notify: (session) => void sent.push(session),
    answersStops: () => true,
    notice: () => {},
    rootOf: () => '/work/shop',
    paceMs: 5,
    burstMs: 0,
    requestMs,
    lingerMs: 60_000,
  });
  const join = (workerIndex: number, parallelIndex: number, features: RunFeature[] = ['view-lane']) => {
    const socket = fakeSocket();
    const reader = sessions.attach(socket as unknown as net.Socket, {
      type: 'run-attach',
      token: 't',
      ref: 'ed-1',
      cwd: '/work/shop',
      workerIndex,
      parallelIndex,
      pid: 1,
      playwright: '1.64.1',
      reporter: '0.70.0',
      takes: [...RUN_TAKES],
      features,
    });
    const read = (message: RunToHub) => reader(JSON.stringify(message));
    const heard = (): HubToRun[] => socket.written.map((line) => JSON.parse(line) as HubToRun);
    const asked = (on?: boolean) =>
      heard().filter(
        (m): m is Extract<HubToRun, { what: 'view-lane' }> =>
          m.type === 'request' && m.what === 'view-lane' && (on === undefined || m.on === on),
      );
    /** The worker answers each lane view request it heard and has not answered yet. */
    let answered = 0;
    const answerAll = () => {
      for (const request of asked().slice(answered)) {
        answered++;
        read({ type: 'answer', request: request.request, what: 'view-lane', value: { ok: true, message: 'On.' } });
      }
    };
    const begin = () =>
      read({
        type: 'test-begin',
        testId: `t${workerIndex}`,
        title: ['a'],
        file: 'tests/a.spec.ts',
        line: 1,
        project: '',
        retry: 0,
        cannotPause: null,
      });
    read({
      type: 'test-begin',
      testId: `t${workerIndex}`,
      title: ['a'],
      file: 'tests/a.spec.ts',
      line: 1,
      project: '',
      retry: 0,
      cannotPause: null,
    });
    return { socket, read, heard, asked, answerAll, begin };
  };
  return { sessions, sent, join };
}

function viewer(): Viewer & { lanes: LaneViewFrame[] } {
  const lanes: LaneViewFrame[] = [];
  return { lanes, frame: () => {}, laneFrame: (frame) => void lanes.push(frame) };
}

/** What `run` answers once the worker answered the lane view requests it heard. */
async function watch<T>(worker: { asked(): unknown[]; answerAll(): void }, run: Promise<T>): Promise<T> {
  await waitFor(() => (worker.asked().length ? true : undefined));
  worker.answerAll();
  return run;
}

const laneFrame = (test: string, stop: number | null, data = '/9j/AA=='): RunToHub => ({
  type: 'lane-frame',
  test,
  stop,
  width: 800,
  height: 600,
  data,
});

describe('a lane watched in the run sessions', () => {
  test('starts with its first viewer and stops with its last, its frames to its viewers alone', async () => {
    const { sessions, join } = harness();
    const w = join(0, 0);
    const [a, b, other] = [viewer(), viewer(), viewer()];
    expect(await watch(w, sessions.watchLane({ ref: 'ed-1', lane: 0, on: true }, a))).toEqual({
      ok: true,
      message: 'On.',
    });
    expect(w.asked(true)).toHaveLength(1);
    // A second viewer has the worker send its latest frame again.
    expect(await watch(w, sessions.watchLane({ ref: 'ed-1', lane: 0, on: true }, b))).toMatchObject({ ok: true });
    expect(w.asked(true)).toHaveLength(2);

    w.read(laneFrame('t0', null));
    expect(a.lanes).toEqual([
      { ref: 'ed-1', lane: 0, worker: 0, since: null, test: 't0', width: 800, height: 600, data: '/9j/AA==' },
    ]);
    expect(b.lanes).toHaveLength(1);
    expect(other.lanes).toEqual([]);
    const running = { ref: 'ed-1', lane: 0, worker: 0, since: null };
    expect(sessions.laneFrameGoes(a, running)).toBe(true);
    expect(sessions.laneFrameGoes(other, running)).toBe(false);

    expect(await sessions.watchLane({ ref: 'ed-1', lane: 0, on: false }, b)).toMatchObject({ ok: true });
    expect(w.asked(false)).toHaveLength(0);
    sessions.unwatchAll(a);
    expect(w.asked(false)).toHaveLength(1);
    w.read(laneFrame('t0', null, '/9j/BB=='));
    expect(a.lanes).toHaveLength(1);
  });

  test('names the stop a frame shows, and takes a lane viewer’s input at that stop', async () => {
    const { sessions, sent, join } = harness();
    const w = join(0, 0);
    const a = viewer();
    await watch(w, sessions.watchLane({ ref: 'ed-1', lane: 0, on: true }, a));
    w.read({
      type: 'stopped',
      stop: 1,
      reason: 'pause',
      title: 'Click',
      place: { file: 'tests/a.spec.ts', line: 4 },
      locator: null,
      bar: false,
    });
    const since = await waitFor(() => last(sent)?.workers[0]?.stop?.since);
    w.read(laneFrame('t0', 1));
    expect(a.lanes[a.lanes.length - 1]).toMatchObject({ since, test: 't0' });
    expect(sessions.stopIntentsOf('ed-1', 0, a)).toContain('input');
    expect(sessions.stopIntentsOf('ed-1', 0, viewer())).not.toContain('input');
    const played = sessions.input({ ref: 'ed-1', worker: 0, since }, a, [
      { type: 'mouse', action: 'move', x: 1, y: 1 },
    ]);
    const asked = await waitFor(() =>
      w.heard().find((m): m is Extract<HubToRun, { what: 'input' }> => m.type === 'request' && m.what === 'input'),
    );
    w.read({ type: 'answer', request: asked.request, what: 'input', value: { ok: true, message: 'Played.' } });
    expect(await played).toMatchObject({ ok: true });
    // A frame of a stop the hub no longer stands at names none.
    w.read({ type: 'running', stop: 1 });
    w.read(laneFrame('t0', 1, '/9j/CC=='));
    expect(a.lanes[a.lanes.length - 1]).toMatchObject({ since: null, data: '/9j/CC==' });
  });

  test('follows its lane into the worker Playwright starts in its place, and waits for one that is not there', async () => {
    const { sessions, join } = harness();
    const first = join(0, 1);
    const a = viewer();
    await watch(first, sessions.watchLane({ ref: 'ed-1', lane: 1, on: true }, a));
    first.socket.destroy();
    const next = join(3, 1);
    await waitFor(() => (next.asked(true).length ? true : undefined));
    next.answerAll();
    next.read(laneFrame('t3', null));
    expect(a.lanes[a.lanes.length - 1]).toMatchObject({ lane: 1, worker: 3, test: 't3' });
    // A lane no worker stands in now is watched from the next one.
    const b = viewer();
    expect(await sessions.watchLane({ ref: 'ed-1', lane: 2, on: true }, b)).toEqual({
      ok: true,
      message: 'You watch worker 3 from its next test.',
    });
    const later = join(4, 2);
    await waitFor(() => (later.asked(true).length ? true : undefined));
  });

  test('refuses the lane of a reporter that shows a stopped test alone, and offers watch only where it can', async () => {
    const { sessions, join } = harness();
    const old = join(0, 0, []);
    join(1, 1);
    expect(await sessions.watchLane({ ref: 'ed-1', lane: 0, on: true }, viewer())).toEqual({
      ok: false,
      message: UPDATE,
    });
    expect(old.asked()).toEqual([]);
    expect(sessions.intentsOf('ed-1', 0)).not.toContain('watch');
    expect(sessions.intentsOf('ed-1', 1)).toContain('watch');
    expect(await sessions.watchLane({ ref: 'ed-9', lane: 0, on: true }, viewer())).toMatchObject({ ok: false });
  });
});

describe('a lane view the worker answers late, or never', () => {
  const stopAt = (w: { read(message: RunToHub): void }, stop: number) =>
    w.read({
      type: 'stopped',
      stop,
      reason: 'pause',
      title: 'Click',
      place: { file: 'tests/a.spec.ts', line: 4 },
      locator: null,
      bar: false,
    });

  test('is turned off again once its start was given up, and an answer that comes too late starts nothing', async () => {
    const { sessions, join } = harness(80);
    const w = join(0, 0);
    const a = viewer();
    expect(await sessions.watchLane({ ref: 'ed-1', lane: 0, on: true }, a)).toEqual({
      ok: false,
      message: 'The test did not answer.',
    });
    expect(w.asked(false)).toHaveLength(1);
    // The late answer, and a frame after it, reach nobody.
    w.answerAll();
    w.read(laneFrame('t0', null));
    expect(a.lanes).toEqual([]);
  });

  test('keeps a lane on for its viewers when a later viewer’s resend goes unanswered', async () => {
    const { sessions, join } = harness(80);
    const w = join(0, 0);
    const [a, b] = [viewer(), viewer()];
    await watch(w, sessions.watchLane({ ref: 'ed-1', lane: 0, on: true }, a));
    expect(await sessions.watchLane({ ref: 'ed-1', lane: 0, on: true }, b)).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    w.read(laneFrame('t0', null));
    expect(a.lanes).toHaveLength(1);
    expect(b.lanes).toHaveLength(1);
    expect(w.asked(false)).toEqual([]);
  });

  test('answers a viewer that asks twice once the worker answered, and the start is asked once', async () => {
    const { sessions, join } = harness();
    const w = join(0, 0);
    const a = viewer();
    const first = sessions.watchLane({ ref: 'ed-1', lane: 0, on: true }, a);
    const second = sessions.watchLane({ ref: 'ed-1', lane: 0, on: true }, a);
    w.answerAll();
    expect(await Promise.all([first, second])).toEqual([
      { ok: true, message: 'On.' },
      { ok: true, message: 'On.' },
    ]);
    expect(w.asked(true)).toHaveLength(1);
  });

  test('watches the next worker of the lane when its worker left before it answered', async () => {
    const { sessions, join } = harness();
    const first = join(0, 0);
    const a = viewer();
    const asked = sessions.watchLane({ ref: 'ed-1', lane: 0, on: true }, a);
    first.socket.destroy();
    expect(await asked).toEqual({ ok: true, message: 'You watch worker 1 from its next test.' });
    const next = join(1, 0);
    await waitFor(() => (next.asked(true).length ? true : undefined));
  });

  test('asks no worker that does not show its lane, though its lane is watched', async () => {
    const { sessions, join } = harness();
    const a = viewer();
    await sessions.watchLane({ ref: 'ed-1', lane: 0, on: true }, a);
    const old = join(0, 0, []);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(old.asked()).toEqual([]);
  });

  test('grants a lane viewer no input at a stop outside a test, which the lane does not show', async () => {
    const { sessions, sent, join } = harness();
    const w = join(0, 0);
    const a = viewer();
    await watch(w, sessions.watchLane({ ref: 'ed-1', lane: 0, on: true }, a));
    w.read({ type: 'test-end', testId: 't0', status: 'failed', pausedMs: 0 });
    stopAt(w, 1);
    await waitFor(() => last(sent)?.workers[0]?.stop ?? undefined);
    expect(sessions.stopIntentsOf('ed-1', 0, a)).not.toContain('input');
    expect(sessions.stopIntentsOf('ed-1', 0, a)).not.toContain('watch');
  });

  test('lets no paced frame of a stop that ended, or of a worker that left, go', async () => {
    const { sessions, sent, join } = harness();
    const w = join(0, 0);
    const a = viewer();
    await watch(w, sessions.watchLane({ ref: 'ed-1', lane: 0, on: true }, a));
    stopAt(w, 1);
    const since = await waitFor(() => last(sent)?.workers[0]?.stop?.since);
    const atStop = { ref: 'ed-1', lane: 0, worker: 0, since };
    expect(sessions.laneFrameGoes(a, atStop)).toBe(true);
    w.read({ type: 'running', stop: 1 });
    expect(sessions.laneFrameGoes(a, atStop)).toBe(false);
    expect(sessions.laneFrameGoes(a, { ...atStop, since: null })).toBe(true);
    w.socket.destroy();
    await waitFor(() => (sessions.laneFrameGoes(a, { ...atStop, since: null }) ? undefined : true));
  });
});

describe('a lane watched on the hub', () => {
  let dir = '';
  let svc: Service;
  let hub: { url: string; token: string };

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-lanes-')));
    writeRunWorkspace(dir);
    svc = await service(dir, true);
    hub = (await waitFor(() => svc.published[0] ?? undefined)).hub!;
  });

  afterAll(() => {
    svc?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function paired() {
    const socket = new WebSocket(hub.url, { origin: ORIGIN });
    const messages: HubMessage[] = [];
    socket.on('message', (data) => {
      const message = parseHubMessage(String(data));
      if (message) messages.push(message);
    });
    await new Promise((resolve) => socket.on('open', resolve));
    const send = (message: object) => socket.send(JSON.stringify(message));
    const answer = (id: number) =>
      waitFor(() => messages.find((m): m is HubAnswer => m.type === 'answer' && m.id === id));
    send({ type: 'hello', token: hub.token });
    const welcome = await waitFor(() => messages.find((m) => m.type === 'welcome'));
    send({ type: 'subscribe', id: 1 });
    await answer(1);
    return {
      socket,
      welcome,
      send,
      answer,
      session: (ref: string) =>
        messages
          .filter((m): m is Extract<HubMessage, { type: 'session' }> => m.type === 'session' && m.session.ref === ref)
          .pop()?.session as HubSession | undefined,
      lanes: () => messages.filter((m): m is HubLaneFrameMessage => m.type === 'lane-frame' && 'data' in m),
    };
  }

  test('says it shows lanes, offers watch for a worker that can, and sends its frames to its watchers alone', async () => {
    const [a, b] = [await paired(), await paired()];
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir);
    worker.send({
      type: 'run-attach',
      token: channel.token,
      ref,
      cwd: dir,
      workerIndex: 2,
      parallelIndex: 0,
      pid: process.pid,
      playwright: '1.64.1',
      reporter: '0.70.0',
      takes: [...RUN_TAKES],
      features: ['view-lane'],
    });
    worker.begin();
    try {
      expect(a.welcome).toMatchObject({ features: expect.arrayContaining(['lanes']) });
      expect(await waitFor(() => a.session(ref)?.workers[0]?.intents)).toContain('watch');
      a.send({ type: 'watch', id: 2, ref, lane: 0, on: true });
      const asked = await worker.next('request');
      expect(asked).toMatchObject({ what: 'view-lane', on: true });
      worker.send({
        type: 'answer',
        request: (asked as { request: number }).request,
        what: 'view-lane',
        value: { ok: true, message: 'The live view is on.' },
      });
      expect(await a.answer(2)).toMatchObject({ ok: true });
      worker.send({
        type: 'lane-frame',
        test: 'id-adds a mug',
        stop: null,
        width: 1280,
        height: 720,
        data: '/9j/4A==',
      });
      const [frame] = await waitFor(() => (a.lanes().length ? a.lanes() : undefined));
      expect(frame).toEqual({
        type: 'lane-frame',
        ref,
        lane: 0,
        worker: 2,
        test: 'id-adds a mug',
        since: null,
        width: 1280,
        height: 720,
        data: '/9j/4A==',
      });
      await new Promise((r) => setTimeout(r, 150));
      expect(b.lanes()).toEqual([]);
      // The last viewer's connection closes: the worker turns its lane view off.
      a.socket.close();
      await waitFor(() =>
        worker.heard.some((m) => m.type === 'request' && m.what === 'view-lane' && !m.on) ? true : undefined,
      );
    } finally {
      worker.socket.destroy();
      a.socket.close();
      b.socket.close();
    }
  });
});
