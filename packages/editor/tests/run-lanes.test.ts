/**
 * A lane watched while its tests run: the run sessions as workers on fake sockets tell them, then the hub's WebSocket
 * as Piwi Picker reaches it, against a service started in-process.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import type * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import type { LaneLayer } from '@piwitests/core/live-layers';
import { RUN_TAKES, type HubToRun, type RunFeature, type RunToHub } from '@piwitests/core/run-channel';
import {
  parseHubMessage,
  type HubAnswer,
  type HubLaneFrameMessage,
  type HubMessage,
  type HubSession,
} from '@piwitests/core/run-hub';
import { ClientLaneView } from '../src/client-page-view';
import type { LaneFrame, RunningLine, RunSession } from '../src/protocol';
import { RunSessions, type LaneViewFrame, type LaneViewLayer, type Viewer } from '../src/run-sessions';
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
function harness(requestMs = 2000, laneTextMs = 40) {
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
    laneTextMs,
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

function viewer(): Viewer & { lanes: LaneViewFrame[]; layers: LaneViewLayer[] } {
  const lanes: LaneViewFrame[] = [];
  const layers: LaneViewLayer[] = [];
  return {
    lanes,
    layers,
    frame: () => {},
    laneFrame: (frame) => void lanes.push(frame),
    laneLayer: (layer) => void layers.push(layer),
  };
}

const AT = 1_800_000_000_000;
const pageError: RunToHub = {
  type: 'lane-layer',
  test: 't0',
  layer: 'events',
  event: { kind: 'page-error', text: 'boom' },
  at: AT,
};
const pageText: RunToHub = {
  type: 'lane-layer',
  test: 't0',
  layer: 'text',
  text: { call: null, source: 'snapshot', text: '- heading "Shop"', cut: false, at: AT },
};

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

/** A call log of the lane's test: the call `title` at line `line` of its spec, running unless said. */
const callLogOf = (title: string, line: number, status: 'running' | 'passed' | 'failed' = 'running') => ({
  id: `call@${line}`,
  call: { title, file: 'tests/a.spec.ts', line },
  status,
  lines: [],
  point: null,
  target: null,
  viewport: null,
  ms: 10,
  error: null,
});

const callLog = (test: string, title: string, line: number, status?: 'running' | 'passed' | 'failed'): RunToHub => ({
  type: 'lane-layer',
  test,
  layer: 'calls',
  log: callLogOf(title, line, status),
});

/** The worker stops at `stop`, headless, before a click of its test. */
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

describe('the layers of a lane watched in the run sessions', () => {
  test('go to the lane’s viewers that asked for each alone, the worker hearing what they ask together', async () => {
    const { sessions, join } = harness();
    const w = join(0, 0, ['view-lane', 'layers']);
    const [a, b, c, other] = [viewer(), viewer(), viewer(), viewer()];
    const layersHeard = () =>
      w.heard().flatMap((m) => (m.type === 'layers' ? [m.layers] : ([] as Array<readonly string[]>)));
    await watch(w, sessions.watchLane({ ref: 'ed-1', lane: 0, on: true, layers: ['events', 'calls'] }, a));
    await watch(w, sessions.watchLane({ ref: 'ed-1', lane: 0, on: true, layers: ['text'] }, b));
    await watch(w, sessions.watchLane({ ref: 'ed-1', lane: 0, on: true }, c));
    // A viewer that asks for nothing more than the others leaves the worker as it was.
    expect(layersHeard()).toEqual([
      ['calls', 'events'],
      ['calls', 'events', 'text'],
    ]);

    w.read(pageError);
    w.read(pageText);
    expect(a.layers).toEqual([
      {
        ref: 'ed-1',
        lane: 0,
        worker: 0,
        test: 't0',
        layer: 'events',
        event: { kind: 'page-error', text: 'boom' },
        at: AT,
      },
    ]);
    expect(b.layers.map((layer) => layer.layer)).toEqual(['text']);
    expect(c.layers).toEqual([]);
    expect(other.layers).toEqual([]);

    // A viewer that leaves takes its layers with it; the last one turns them off with the lane view.
    await sessions.watchLane({ ref: 'ed-1', lane: 0, on: false }, b);
    expect(last(layersHeard())).toEqual(['calls', 'events']);
    sessions.unwatchAll(a);
    sessions.unwatchAll(c);
    expect(last(layersHeard())).toEqual([]);
    expect(w.asked(false)).toHaveLength(1);
    w.read(pageError);
    expect(a.layers).toHaveLength(1);
  });

  test('never tells a worker that sends no layers about them, and forgets a lane’s layers with the run', async () => {
    const { sessions, join } = harness();
    const old = join(0, 0);
    const a = viewer();
    await watch(old, sessions.watchLane({ ref: 'ed-1', lane: 0, on: true, layers: ['events'] }, a));
    expect(old.heard().some((m) => m.type === 'layers')).toBe(false);
    // A worker Playwright starts in the lane later, which sends layers, hears what the lane's viewers ask.
    old.socket.destroy();
    const next = join(1, 0, ['view-lane', 'layers']);
    await waitFor(() => (next.heard().some((m) => m.type === 'layers') ? true : undefined));
    expect(next.heard().find((m) => m.type === 'layers')).toEqual({ type: 'layers', layers: ['events'] });

    // The run ends: the viewer watches it no more, and a rerun under its ref starts with no lane watched, no layers.
    sessions.commandEnded('ed-1');
    expect(sessions.watchesLane(a, 'ed-1', 0)).toBe(false);
    next.read(pageError);
    expect(a.layers).toEqual([]);
    const rerun = join(0, 0, ['view-lane', 'layers']);
    await new Promise((r) => setTimeout(r, 20));
    expect(rerun.heard().filter((m) => m.type === 'layers' || m.type === 'request')).toEqual([]);
    rerun.read(pageError);
    expect(a.layers).toEqual([]);
    expect(await sessions.laneText({ ref: 'ed-1', lane: 0 }, a)).toEqual({
      ok: false,
      message: 'Watch the worker first.',
    });
  });

  test('tells the worker the layers again only as they change, or as a viewer asks anew for what it sends again', async () => {
    const { sessions, join } = harness();
    const w = join(0, 0, ['view-lane', 'layers']);
    const [a, b] = [viewer(), viewer()];
    const layersHeard = () => w.heard().flatMap((m) => (m.type === 'layers' ? [m.layers] : []));
    const both: LaneLayer[] = ['calls', 'events', 'filmstrip'];
    await watch(w, sessions.watchLane({ ref: 'ed-1', lane: 0, on: true, layers: both }, a));
    // The same watch asked again changes nothing the worker hears, nor does a viewer that asks for no more than it.
    await sessions.watchLane({ ref: 'ed-1', lane: 0, on: true, layers: both }, a);
    await sessions.watchLane({ ref: 'ed-1', lane: 0, on: true, layers: ['events'] }, b);
    expect(layersHeard()).toEqual([both]);
    // A viewer asking for the filmstrip anew has the worker send again what it keeps (its lane view asked on again),
    // the layers as they were.
    const lanesAsked = () => w.heard().filter((m) => m.type === 'request' && m.what === 'view-lane' && m.on).length;
    const asked = lanesAsked();
    await sessions.watchLane({ ref: 'ed-1', lane: 0, on: true, layers: ['events', 'filmstrip'] }, b);
    expect(layersHeard()).toEqual([both]);
    expect(lanesAsked()).toBe(asked + 1);
    // Leaving it asks for nothing less: the worker hears nothing; the last viewer of it to leave turns it off.
    await sessions.watchLane({ ref: 'ed-1', lane: 0, on: true, layers: ['events'] }, b);
    expect(layersHeard()).toHaveLength(1);
    await sessions.watchLane({ ref: 'ed-1', lane: 0, on: true, layers: ['calls', 'events'] }, a);
    expect(last(layersHeard())).toEqual(['calls', 'events']);
  });

  test('asks a worker for its page’s text once for the asks that come together, and once a moment at most', async () => {
    const { sessions, join } = harness(2000, 60);
    const w = join(0, 0, ['view-lane', 'layers']);
    const [a, b] = [viewer(), viewer()];
    const texts = () => w.heard().filter((m) => m.type === 'request' && m.what === 'text');
    const moment = () => new Promise((r) => setTimeout(r, 80));
    const onItsWay = { ok: true, message: 'The page’s text is on its way.' };
    await watch(w, sessions.watchLane({ ref: 'ed-1', lane: 0, on: true, layers: ['calls', 'text'] }, a));
    await sessions.watchLane({ ref: 'ed-1', lane: 0, on: true, layers: ['text'] }, b);
    // The layers listing the text anew had the worker take it: an ask right after is that one.
    expect(await sessions.laneText({ ref: 'ed-1', lane: 0 }, b)).toEqual(onItsWay);
    expect(texts()).toHaveLength(0);

    await moment();
    // Two viewers asking together: the worker hears one request, and both get its answer.
    const first = sessions.laneText({ ref: 'ed-1', lane: 0 }, a);
    const second = sessions.laneText({ ref: 'ed-1', lane: 0 }, b);
    const request = await waitFor(() => texts()[0]);
    w.read({ type: 'answer', request: request.request, what: 'text', value: { ok: true, message: 'On its way.' } });
    expect(await first).toEqual({ ok: true, message: 'On its way.' });
    expect(await second).toEqual({ ok: true, message: 'On its way.' });
    // Within a moment of it, another ask is that one too; after it, the worker is asked again.
    expect(await sessions.laneText({ ref: 'ed-1', lane: 0 }, a)).toEqual({ ok: true, message: 'On its way.' });
    expect(texts()).toHaveLength(1);
    await moment();
    void sessions.laneText({ ref: 'ed-1', lane: 0 }, a);
    await waitFor(() => texts()[1]);
    expect(texts()).toHaveLength(2);
  });
});

describe('a lane view the worker answers late, or never', () => {
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

describe('a lane the editor client watches', () => {
  const inputs = (w: { heard(): HubToRun[] }) =>
    w.heard().filter((m): m is Extract<HubToRun, { what: 'input' }> => m.type === 'request' && m.what === 'input');

  test('sends its frames with their test and stop, and takes its input at a stop of the lane alone', async () => {
    const { sessions, sent, join } = harness();
    const w = join(0, 0);
    const frames: LaneFrame[] = [];
    const client = new ClientLaneView(sessions, async (frame) => void frames.push(frame));
    expect(await watch(w, client.watch({ ref: 'ed-1', lane: 0, on: true }))).toMatchObject({ ok: true });
    w.read(laneFrame('t0', null));
    expect(await waitFor(() => last(frames))).toEqual({
      ref: 'ed-1',
      lane: 0,
      worker: 0,
      test: 't0',
      since: null,
      data: '/9j/AA==',
      width: 800,
      height: 600,
    });
    // While the test runs, no stop takes its input.
    expect(client.takes({ ref: 'ed-1', worker: 0, since: 'x', events: [] })).toBe(false);
    stopAt(w, 1);
    const since = await waitFor(() => last(sent)?.workers[0]?.stop?.since);
    w.read(laneFrame('t0', 1, '/9j/BB=='));
    await waitFor(() => (last(frames)?.since === since ? true : undefined));
    expect(client.takes({ ref: 'ed-1', worker: 0, since, events: [] })).toBe(true);
    expect(client.takes({ ref: 'ed-1', worker: 1, since, events: [] })).toBe(false);
    const played = client.input({
      ref: 'ed-1',
      worker: 0,
      since,
      events: [{ type: 'mouse', action: 'down', x: 3, y: 4, button: 'left' }],
    });
    const asked = await waitFor(() => inputs(w)[0]);
    w.read({ type: 'answer', request: asked.request, what: 'input', value: { ok: true, message: 'Played.' } });
    expect(await played).toMatchObject({ ok: true });
    // Leaving lets go of the button held down there, and stops the lane view.
    client.dispose();
    expect(inputs(w)[1]).toMatchObject({ events: [{ type: 'mouse', action: 'up', x: 3, y: 4, button: 'left' }] });
    expect(w.asked(false)).toHaveLength(1);
    expect(await client.input({ ref: 'ed-1', worker: 0, since, events: [] })).toMatchObject({ ok: false });
  });

  test('sends the layers it asked for alone, asks for the page’s text as asked, and none once it stops', async () => {
    const { sessions, join } = harness();
    const w = join(0, 0, ['view-lane', 'layers']);
    const told: LaneViewLayer[] = [];
    const elsewhere: LaneViewLayer[] = [];
    const client = new ClientLaneView(
      sessions,
      async () => {},
      undefined,
      async (layer) => void told.push(layer),
    );
    const other = new ClientLaneView(
      sessions,
      async () => {},
      undefined,
      async (layer) => void elsewhere.push(layer),
    );
    const layersHeard = () => w.heard().flatMap((m) => (m.type === 'layers' ? [m.layers] : []));
    const texts = () => w.heard().filter((m) => m.type === 'request' && m.what === 'text');
    await watch(w, client.watch({ ref: 'ed-1', lane: 0, on: true, layers: ['events', 'calls'] }));
    await watch(w, other.watch({ ref: 'ed-1', lane: 0, on: true }));
    expect(last(layersHeard())).toEqual(['calls', 'events']);
    w.read(pageError);
    w.read(pageText);
    expect(told).toEqual([
      {
        ref: 'ed-1',
        lane: 0,
        worker: 0,
        test: 't0',
        layer: 'events',
        event: { kind: 'page-error', text: 'boom' },
        at: AT,
      },
    ]);
    expect(elsewhere).toEqual([]);

    // The text before the client shows it is refused; its layers then change in place, the lane view kept on.
    expect(await client.watch({ ref: 'ed-1', lane: 0, on: true, layers: ['calls', 'events'], text: true })).toEqual({
      ok: false,
      message: 'Show the page’s text first.',
    });
    expect(await client.watch({ ref: 'ed-1', lane: 0, on: true, layers: ['calls', 'events', 'text'] })).toMatchObject({
      ok: true,
    });
    expect(last(layersHeard())).toEqual(['calls', 'events', 'text']);
    expect(w.asked(false)).toHaveLength(0);
    expect(texts()).toHaveLength(0);
    // Asked again once the text the layers took is a moment old, the text alone is taken: the worker hears no layers,
    // so sends no call log nor filmstrip again.
    await new Promise((r) => setTimeout(r, 50));
    const before = layersHeard().length;
    const asked = client.watch({ ref: 'ed-1', lane: 0, on: true, layers: ['calls', 'events', 'text'], text: true });
    const request = await waitFor(() => texts()[0]);
    expect(layersHeard()).toHaveLength(before);
    w.read({ type: 'answer', request: request.request, what: 'text', value: { ok: true, message: 'On its way.' } });
    expect(await asked).toEqual({ ok: true, message: 'On its way.' });
    w.read(pageText);
    expect(told.map((layer) => layer.layer)).toEqual(['events', 'text']);
    expect(elsewhere).toEqual([]);

    // Nothing reaches a client that stopped watching, though the lane's other viewer keeps it on.
    client.dispose();
    w.read(pageError);
    w.read(pageText);
    expect(told).toHaveLength(2);
    expect(last(layersHeard())).toEqual([]);
    expect(await client.watch({ ref: 'ed-1', lane: 0, on: true, layers: ['text'], text: true })).toMatchObject({
      ok: true,
    });
    expect(texts()).toHaveLength(1);
  });

  test('tells the running call’s line to a client that marks it, and that it goes at a stop, the test’s end and the run’s', async () => {
    const { sessions, join } = harness();
    const w = join(0, 0, ['view-lane', 'layers']);
    const lines: RunningLine[] = [];
    const told: LaneViewLayer[] = [];
    const client = new ClientLaneView(
      sessions,
      async () => {},
      undefined,
      async (layer) => void told.push(layer),
      async (line) => void lines.push(line),
      () => true,
    );
    const layersHeard = () => w.heard().flatMap((m) => (m.type === 'layers' ? [m.layers] : []));
    await watch(w, client.watch({ ref: 'ed-1', lane: 0, on: true, layers: ['events'] }));
    // The call log is asked for the line, though the client shows no call log.
    expect(last(layersHeard())).toEqual(['calls', 'events']);
    w.read(callLog('t0', "Click getByRole('button')", 7));
    w.read(callLog('t0', "Click getByRole('button')", 7, 'passed'));
    const at = { ref: 'ed-1', lane: 0, worker: 0 };
    const uri = 'file:///work/shop/tests/a.spec.ts';
    expect(lines).toEqual([{ ...at, call: { test: 't0', title: "Click getByRole('button')", uri, line: 6 } }]);
    expect(told).toEqual([]);
    w.read(callLog('t0', "Fill getByLabel('Name')", 9));
    expect(last(lines)).toEqual({ ...at, call: { test: 't0', title: "Fill getByLabel('Name')", uri, line: 8 } });
    // A stop has a mark of its own: the line goes, and a call log heard at the stop brings none back.
    stopAt(w, 1);
    client.changed();
    expect(last(lines)).toEqual({ ...at, call: null });
    w.read(callLog('t0', 'Click', 4));
    expect(last(lines)).toEqual({ ...at, call: null });
    w.read({ type: 'running', stop: 1 });
    w.read(callLog('t0', 'Click', 5));
    expect(last(lines)).toMatchObject({ call: { line: 4 } });
    // A call with no place in the user's code names no line.
    w.read({
      type: 'lane-layer',
      test: 't0',
      layer: 'calls',
      log: { ...callLogOf('Expect', 5), call: { title: 'Expect', file: null, line: null } },
    });
    expect(last(lines)).toEqual({ ...at, call: null });
    w.read(callLog('t0', 'Click', 6));
    // The test's end takes it, and a late call log of that test brings none back.
    w.read({ type: 'test-end', testId: 't0', status: 'passed', pausedMs: 0 });
    client.changed();
    expect(last(lines)).toEqual({ ...at, call: null });
    const count = lines.length;
    w.read(callLog('t0', 'Click', 6));
    expect(lines).toHaveLength(count);
    // The next test's call, then the run's end.
    w.begin();
    w.read(callLog('t0', 'Goto', 2));
    expect(last(lines)).toMatchObject({ call: { line: 1 } });
    sessions.commandEnded('ed-1');
    client.changed();
    expect(last(lines)).toEqual({ ...at, call: null });
  });

  test('tells no running line to a client that does not mark it, and none once it stops watching', async () => {
    const { sessions, join } = harness();
    const w = join(0, 0, ['view-lane', 'layers']);
    const lines: RunningLine[] = [];
    const plain = new ClientLaneView(
      sessions,
      async () => {},
      undefined,
      async () => {},
      async (line) => void lines.push(line),
    );
    const layersHeard = () => w.heard().flatMap((m) => (m.type === 'layers' ? [m.layers] : []));
    await watch(w, plain.watch({ ref: 'ed-1', lane: 0, on: true, layers: ['events'] }));
    expect(last(layersHeard())).toEqual(['events']);
    w.read(callLog('t0', 'Click', 7));
    expect(lines).toEqual([]);
    plain.dispose();

    const marks = new ClientLaneView(
      sessions,
      async () => {},
      undefined,
      async () => {},
      async (line) => void lines.push(line),
      () => true,
    );
    await watch(w, marks.watch({ ref: 'ed-1', lane: 0, on: true }));
    w.read(callLog('t0', 'Click', 7));
    expect(lines).toHaveLength(1);
    marks.dispose();
    expect(last(lines)).toEqual({ ref: 'ed-1', lane: 0, worker: 0, call: null });
    w.read(callLog('t0', 'Click', 8));
    expect(lines).toHaveLength(2);
  });

  test('watches one lane at a time, and ends with the run', async () => {
    const { sessions, join } = harness();
    const first = join(0, 0);
    const second = join(1, 1);
    const client = new ClientLaneView(sessions, async () => {});
    await watch(first, client.watch({ ref: 'ed-1', lane: 0, on: true }));
    await watch(second, client.watch({ ref: 'ed-1', lane: 1, on: true }));
    expect(first.asked(false)).toHaveLength(1);
    expect(sessions.watchesLane(client.viewer, 'ed-1', 1)).toBe(true);
    sessions.commandEnded('ed-1');
    client.changed();
    expect(sessions.watchesLane(client.viewer, 'ed-1', 1)).toBe(false);
    expect(await client.watch({ ref: 'ed-1', lane: -1, on: true })).toMatchObject({ ok: false });
  });
});

describe('a lane the editor client watches, through the language server', () => {
  let dir = '';
  let svc: Service;
  let without: Service;

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-lane-lsp-')));
    writeRunWorkspace(dir);
    svc = await service(dir, true);
    without = await service(dir, false);
  });

  afterAll(() => {
    svc?.stop();
    without?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('sends a watched lane’s frames, and takes its input at a stop; a client that shows no stop watches none', async () => {
    const frames: LaneFrame[] = [];
    svc.client.onNotification('piwi/laneFrame', (frame: LaneFrame) => void frames.push(frame));
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir);
    worker.send({
      type: 'run-attach',
      token: channel.token,
      ref,
      cwd: dir,
      workerIndex: 0,
      parallelIndex: 0,
      pid: process.pid,
      playwright: '1.64.1',
      reporter: '0.70.0',
      takes: [...RUN_TAKES],
      features: ['view-lane'],
    });
    try {
      worker.begin();
      expect(await waitFor(() => svc.latest(ref)?.workers[0])).toMatchObject({ watchable: true });
      const watching = svc.client.sendRequest('piwi/laneView', { ref, lane: 0, on: true });
      const asked = await worker.next('request');
      expect(asked).toMatchObject({ what: 'view-lane', on: true });
      worker.send({ type: 'answer', request: asked.request, what: 'view-lane', value: { ok: true, message: 'On.' } });
      expect(await watching).toMatchObject({ ok: true });
      worker.send({ type: 'lane-frame', test: 'id-adds a mug', stop: null, width: 800, height: 600, data: '/9j/AA==' });
      expect(await waitFor(() => last(frames))).toMatchObject({
        ref,
        lane: 0,
        worker: 0,
        test: 'id-adds a mug',
        since: null,
      });
      worker.stopAt(1, 4);
      const since = await waitFor(() => svc.latest(ref)?.workers[0]?.stop?.since);
      const input = svc.client.sendRequest('piwi/pageInput', {
        ref,
        worker: 0,
        since,
        events: [{ type: 'mouse', action: 'move', x: 1, y: 1 }],
      });
      const played = await worker.next('request', 1);
      expect(played).toMatchObject({ what: 'input', stop: 1 });
      worker.send({ type: 'answer', request: played.request, what: 'input', value: { ok: true, message: 'Played.' } });
      expect(await input).toMatchObject({ ok: true });
      expect(await without.client.sendRequest('piwi/laneView', { ref, lane: 0, on: true })).toEqual({
        ok: false,
        message: 'This client does not show running tests.',
      });
    } finally {
      worker.socket.destroy();
    }
  });
});

describe('a lane’s layers the editor client asks for, through the language server', () => {
  let dir = '';
  let svc: Service;

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-lane-layers-lsp-')));
    writeRunWorkspace(dir);
    svc = await service(dir, true);
  });

  afterAll(() => {
    svc?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('tells the client each layer it asked for as `piwi/laneLayer`, and none it did not', async () => {
    const layers: LaneViewLayer[] = [];
    svc.client.onNotification('piwi/laneLayer', (layer: LaneViewLayer) => void layers.push(layer));
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir);
    worker.send({
      type: 'run-attach',
      token: channel.token,
      ref,
      cwd: dir,
      workerIndex: 0,
      parallelIndex: 0,
      pid: process.pid,
      playwright: '1.64.1',
      reporter: '0.70.0',
      takes: [...RUN_TAKES],
      features: ['view-lane', 'layers'],
    });
    try {
      worker.begin();
      expect(await waitFor(() => svc.latest(ref)?.workers[0])).toMatchObject({ watchable: true, layers: true });
      const watching = svc.client.sendRequest('piwi/laneView', { ref, lane: 0, on: true, layers: ['events'] });
      const asked = await worker.next('request');
      worker.send({ type: 'answer', request: asked.request, what: 'view-lane', value: { ok: true, message: 'On.' } });
      expect(await watching).toMatchObject({ ok: true });
      expect(await worker.next('layers')).toEqual({ type: 'layers', layers: ['events'] });
      worker.send({ ...pageText, test: 'id-adds a mug' });
      worker.send({ ...pageError, test: 'id-adds a mug' });
      expect(await waitFor(() => last(layers))).toEqual({
        ref,
        lane: 0,
        worker: 0,
        test: 'id-adds a mug',
        layer: 'events',
        event: { kind: 'page-error', text: 'boom' },
        at: AT,
      });
      expect(layers).toHaveLength(1);
    } finally {
      worker.socket.destroy();
    }
  });
});

describe('the running line, through the language server', () => {
  let dir = '';
  let marks: Service;
  let plain: Service;

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-running-line-lsp-')));
    writeRunWorkspace(dir);
    marks = await service(dir, true, {}, { runningLine: true });
    plain = await service(dir, true);
  });

  afterAll(() => {
    marks?.stop();
    plain?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function watched(svc: Service, lines: RunningLine[]) {
    svc.client.onNotification('piwi/runningLine', (line: RunningLine) => void lines.push(line));
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir);
    worker.send({
      type: 'run-attach',
      token: channel.token,
      ref,
      cwd: dir,
      workerIndex: 0,
      parallelIndex: 0,
      pid: process.pid,
      playwright: '1.64.1',
      reporter: '0.70.0',
      takes: [...RUN_TAKES],
      features: ['view-lane', 'layers'],
    });
    worker.begin();
    await waitFor(() => svc.latest(ref)?.workers[0]?.test ?? undefined);
    const watching = svc.client.sendRequest('piwi/laneView', { ref, lane: 0, on: true, layers: ['events'] });
    const asked = await worker.next('request');
    worker.send({ type: 'answer', request: asked.request, what: 'view-lane', value: { ok: true, message: 'On.' } });
    await watching;
    const layers = await worker.next('layers');
    return { ref, worker, layers };
  }

  test('goes to a client that marks it, as `piwi/runningLine`, and to no other', async () => {
    const lines: RunningLine[] = [];
    const { ref, worker, layers } = await watched(marks, lines);
    try {
      expect(layers).toEqual({ type: 'layers', layers: ['calls', 'events'] });
      const test = marks.latest(ref)!.workers[0]!.test!.id;
      worker.send(callLog(test, 'Click', 4));
      expect(await waitFor(() => last(lines))).toEqual({
        ref,
        lane: 0,
        worker: 0,
        call: { test, title: 'Click', uri: pathToFileURL(path.join(dir, 'tests/a.spec.ts')).href, line: 3 },
      });
      await marks.client.sendRequest('piwi/laneView', { ref, lane: 0, on: false });
      expect(await waitFor(() => (last(lines)?.call === null ? last(lines) : undefined))).toMatchObject({ ref });
    } finally {
      worker.socket.destroy();
    }

    const none: RunningLine[] = [];
    const other = await watched(plain, none);
    try {
      expect(other.layers).toEqual({ type: 'layers', layers: ['events'] });
      other.worker.send(callLog(plain.latest(other.ref)!.workers[0]!.test!.id, 'Click', 4));
      await new Promise((r) => setTimeout(r, 100));
      expect(none).toEqual([]);
    } finally {
      other.worker.socket.destroy();
    }
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
      layers: () => messages.filter((m) => m.type === 'lane-layer'),
    };
  }

  test('sends a lane’s layers to the connections that asked for them alone', async () => {
    const [a, b] = [await paired(), await paired()];
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir);
    worker.send({
      type: 'run-attach',
      token: channel.token,
      ref,
      cwd: dir,
      workerIndex: 1,
      parallelIndex: 0,
      pid: process.pid,
      playwright: '1.64.1',
      reporter: '0.70.0',
      takes: [...RUN_TAKES],
      features: ['view-lane', 'layers'],
    });
    worker.begin();
    try {
      expect(a.welcome).toMatchObject({ features: expect.arrayContaining(['layers']) });
      await waitFor(() => a.session(ref)?.workers[0]?.intents);
      a.send({ type: 'watch', id: 2, ref, lane: 0, on: true, layers: ['events'] });
      const asked = await worker.next('request');
      worker.send({
        type: 'answer',
        request: (asked as { request: number }).request,
        what: 'view-lane',
        value: { ok: true, message: 'The live view is on.' },
      });
      expect(await a.answer(2)).toMatchObject({ ok: true });
      b.send({ type: 'watch', id: 3, ref, lane: 0, on: true });
      await b.answer(3);
      expect(await worker.next('layers')).toEqual({ type: 'layers', layers: ['events'] });
      worker.send({ ...pageError, test: 'id-adds a mug' });
      const [layer] = await waitFor(() => (a.layers().length ? a.layers() : undefined));
      expect(layer).toEqual({
        type: 'lane-layer',
        ref,
        lane: 0,
        worker: 1,
        test: 'id-adds a mug',
        layer: 'events',
        event: { kind: 'page-error', text: 'boom' },
        at: AT,
      });
      await new Promise((r) => setTimeout(r, 150));
      expect(b.layers()).toEqual([]);

      // A watch that lists the page's text asks for it now: the layers listing it anew take it, and the worker hears
      // no request of it for the watches that come within a moment, then one.
      const texts = () => worker.heard.filter((m) => m.type === 'request' && m.what === 'text');
      a.send({ type: 'watch', id: 4, ref, lane: 0, on: true, layers: ['events', 'text'] });
      expect(await a.answer(4)).toMatchObject({ ok: true });
      expect(await worker.next('layers', 1)).toEqual({ type: 'layers', layers: ['events', 'text'] });
      a.send({ type: 'watch', id: 5, ref, lane: 0, on: true, layers: ['events', 'text'] });
      await a.answer(5);
      await new Promise((r) => setTimeout(r, 1100));
      expect(texts()).toEqual([]);
      a.send({ type: 'watch', id: 6, ref, lane: 0, on: true, layers: ['events', 'text'] });
      await a.answer(6);
      await waitFor(() => texts()[0]);
      expect(worker.heard.filter((m) => m.type === 'layers')).toHaveLength(2);
    } finally {
      worker.socket.destroy();
      a.socket.close();
      b.socket.close();
    }
  });

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
