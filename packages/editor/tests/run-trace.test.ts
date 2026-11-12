/**
 * **Open the trace so far**: a lane's running test's trace opened in Playwright's trace viewer on this machine. The run
 * sessions with a stand-in launcher and a fake worker that names its trace file, in a real folder: each check the file
 * passes and each refusal; one viewer per attempt; the hub's `openTrace` and the editor's `piwi/openTrace` answered in
 * a sentence, and the trace's path in no message a hub connection or the client hears. Then the launcher itself, with a
 * stand-in Playwright CLI: the arguments it gets, without a shell, in the run's folder, and why one that stops at once
 * did not start.
 */
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import type * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import {
  RUN_TAKES,
  type HubToRun,
  type RunFeature,
  type RunToHub,
  type TraceAnswer,
} from '@piwitests/core/run-channel';
import { parseHubMessage, type HubAnswer, type HubMessage } from '@piwitests/core/run-hub';
import type { RunControlResult, RunSession } from '../src/protocol';
import { RunHub } from '../src/run-hub';
import { RunSessions } from '../src/run-sessions';
import {
  checkTraceFile,
  hasDisplay,
  startTraceViewer,
  type TraceViewerLaunch,
  type TraceViewerLauncher,
  type TraceViewerStarted,
} from '../src/trace-viewer';
import { FakeWorker, last, service, waitFor, writeRunWorkspace } from './run-fixtures';

const ORIGIN = `chrome-extension://${'p'.repeat(32)}`;
const OPENED = "Playwright's trace viewer opened on the trace so far.";
const ALREADY =
  "Playwright's trace viewer is open on this test's trace already: close it to open the trace as it stands now.";
const TEST_ID = 'a1b2c3-d4e5f6';

let root = '';
/** The run's folder, as the file system spells it. */
let run = '';
/** The runner's trace folder of worker 0. */
let traces = '';

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-trace-')));
  run = path.join(root, 'shop');
  traces = path.join(run, 'test-results', '.playwright-artifacts-0', 'traces');
  fs.mkdirSync(traces, { recursive: true });
  fs.writeFileSync(path.join(run, 'playwright.config.ts'), 'export default {};\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Writes a file of `text` at `file` (under the run's folder unless absolute) and returns its path. */
function file(name: string, text = '{"type":"context-options"}\n'): string {
  const full = path.isAbsolute(name) ? name : path.join(run, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
}

function fakeSocket() {
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    written: [] as string[],
    onWrite: (_line: string) => {},
    write(line: string) {
      socket.written.push(line);
      socket.onWrite(line);
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

/** A launcher that records what it was asked to open, and starts as `next` says. */
function standIn() {
  const launches: TraceViewerLaunch[] = [];
  const closers: Array<() => void> = [];
  const launcher: TraceViewerLauncher & { next: (launch: TraceViewerLaunch) => TraceViewerStarted | null } =
    Object.assign(
      async (launch: TraceViewerLaunch): Promise<TraceViewerStarted> => {
        launches.push(launch);
        const planned = launcher.next(launch);
        if (planned) return planned;
        return { ok: true, closed: new Promise<void>((resolve) => closers.push(resolve)) };
      },
      { next: (_launch: TraceViewerLaunch): TraceViewerStarted | null => null },
    );
  return { launcher, launches, closeAll: () => closers.splice(0).forEach((close) => close()) };
}

/**
 * The run `ed-1` in its own sessions, its folder `root` (`run` unless named), its lane 0's worker running the test
 * `TEST_ID` in `cwd` (the run's folder unless named), and answering each `trace` it is asked with `answer`'s value then
 * (none, for a worker that does not answer).
 */
function harness(
  options: {
    features?: RunFeature[];
    launcher?: TraceViewerLauncher | null;
    /** Whether the machine shows the viewer's window: it does unless false. */
    display?: boolean;
    root?: string | null;
    cwd?: string;
    retry?: number;
  } = {},
) {
  const root = options.root === undefined ? run : options.root;
  const sent: RunSession[] = [];
  const notices: string[] = [];
  const own = standIn();
  const sessions = new RunSessions({
    notify: (session) => void sent.push(session),
    answersStops: () => true,
    notice: (_root, _severity, message) => void notices.push(message),
    rootOf: () => root,
    paceMs: 5,
    burstMs: 0,
    requestMs: 300,
    lingerMs: 60_000,
    ...(options.launcher === null ? {} : { traceViewer: options.launcher ?? own.launcher }),
    traceDisplay: () => options.display !== false,
  });
  const socket = fakeSocket();
  const reader = sessions.attach(socket as unknown as net.Socket, {
    type: 'run-attach',
    token: 't',
    ref: 'ed-1',
    cwd: options.cwd ?? root ?? run,
    workerIndex: 0,
    parallelIndex: 0,
    pid: 1,
    playwright: '1.64.1',
    reporter: '0.80.0',
    takes: [...RUN_TAKES],
    features: options.features ?? ['view-lane', 'layers', 'trace'],
  });
  const read = (message: RunToHub) => reader(JSON.stringify(message));
  const answer: { value: TraceAnswer | null } = { value: null };
  const asked: number[] = [];
  socket.onWrite = (line) => {
    const message = JSON.parse(line) as HubToRun;
    if (message.type !== 'request' || message.what !== 'trace') return;
    asked.push(message.request);
    const value = answer.value;
    if (value) queueMicrotask(() => read({ type: 'answer', request: message.request, what: 'trace', value }));
  };
  const begin = (retry = options.retry ?? 0, testId = TEST_ID) =>
    read({
      type: 'test-begin',
      testId,
      title: ['cart', 'adds a mug'],
      file: 'tests/cart.spec.ts',
      line: 3,
      project: 'chromium',
      retry,
      cannotPause: null,
    });
  return { sessions, sent, notices, socket, read, answer, asked, begin, ...own };
}

/** A worker's answer naming `file`. */
const named = (file: string): TraceAnswer => ({ ok: true, message: "The attempt's trace grows there.", file });

/** A hub on `sessions`, its client forwarding it the ports `forwarded` names. */
async function hubOf(sessions: RunSessions, forwarded: () => readonly number[] = () => []): Promise<RunHub> {
  return (await RunHub.open({
    sessions,
    actions: {
      action: async () => ({ ok: false, message: 'No action here.' }),
      requests: async () => ({ ok: false, message: 'No request here.', requests: [] }),
    },
    runInfo: () => ({ command: null, label: 'shop', project: null }),
    welcome: () => ({ pid: process.pid, version: '0.0.0', client: 'Test Editor', roots: [run] }),
    surfacesChanged: () => {},
    forwarded,
  }))!;
}

/** A connection to `hub` as Piwi Picker opens one (its `Host` `host` when named), paired: what it heard, as sent. */
async function pairedTo(hub: RunHub, host?: string) {
  const socket = new WebSocket(hub.url, { headers: host ? { host } : {}, origin: ORIGIN });
  const raw: string[] = [];
  socket.on('message', (data) => void raw.push(String(data)));
  const messages = () => raw.map((text) => parseHubMessage(text)).filter((m): m is HubMessage => !!m);
  await new Promise((resolve) => socket.on('open', resolve));
  socket.send(JSON.stringify({ type: 'hello', token: hub.token }));
  const welcome = await waitFor(() => messages().find((m) => m.type === 'welcome'));
  return {
    socket,
    raw,
    messages,
    welcome,
    send: (message: unknown) => socket.send(JSON.stringify(message)),
    answer: (id: number) => waitFor(() => messages().find((m): m is HubAnswer => m.type === 'answer' && m.id === id)),
  };
}

describe('opening a lane’s running test’s trace', () => {
  test('starts the viewer from the run’s folder on the attempt’s live trace, and says so in a sentence', async () => {
    const own = harness();
    own.begin();
    const trace = file(`test-results/.playwright-artifacts-0/traces/${TEST_ID}.trace`);
    own.answer.value = named(trace);
    expect(await own.sessions.openTrace({ ref: 'ed-1', lane: 0 })).toEqual({ ok: true, message: OPENED });
    expect(own.launches).toEqual([{ folder: run, trace: path.join(traces, `${TEST_ID}.json`) }]);
    own.closeAll();
  });

  test('opens every file of the attempt, a later context’s file or a retry’s, as one live trace', async () => {
    const later = harness();
    later.begin();
    later.answer.value = named(file(`test-results/.playwright-artifacts-0/traces/${TEST_ID}-recording3.trace`));
    expect(await later.sessions.openTrace({ ref: 'ed-1', lane: 0 })).toEqual({ ok: true, message: OPENED });
    expect(later.launches[0]!.trace).toBe(path.join(traces, `${TEST_ID}.json`));
    later.closeAll();
    const retry = harness({ retry: 2 });
    retry.begin();
    retry.answer.value = named(file(`test-results/.playwright-artifacts-0/traces/${TEST_ID}-retry2.trace`));
    expect(await retry.sessions.openTrace({ ref: 'ed-1', lane: 0 })).toEqual({ ok: true, message: OPENED });
    expect(retry.launches[0]!.trace).toBe(path.join(traces, `${TEST_ID}-retry2.json`));
    retry.closeAll();
  });

  test('keeps one viewer for each attempt: a second ask while it is open says so, and one after it closed opens', async () => {
    const own = harness();
    own.begin();
    own.answer.value = named(file(`test-results/.playwright-artifacts-0/traces/${TEST_ID}.trace`));
    expect(await own.sessions.openTrace({ ref: 'ed-1', lane: 0 })).toMatchObject({ ok: true });
    expect(await own.sessions.openTrace({ ref: 'ed-1', lane: 0 })).toEqual({ ok: false, message: ALREADY });
    expect(own.launches).toHaveLength(1);
    own.closeAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await own.sessions.openTrace({ ref: 'ed-1', lane: 0 })).toEqual({ ok: true, message: OPENED });
    expect(own.launches).toHaveLength(2);
    own.closeAll();
  });

  test('starts the viewer from the run’s folder the host knows, whatever folder its worker names', async () => {
    const own = harness({ cwd: path.join(root, 'elsewhere') });
    own.begin();
    own.answer.value = named(file(`test-results/.playwright-artifacts-0/traces/${TEST_ID}.trace`));
    expect(await own.sessions.openTrace({ ref: 'ed-1', lane: 0 })).toEqual({ ok: true, message: OPENED });
    expect(own.launches).toEqual([{ folder: run, trace: path.join(traces, `${TEST_ID}.json`) }]);
    own.closeAll();
    // The trace of the folder the worker names is not the run's.
    const elsewhere = harness({ cwd: path.join(root, 'elsewhere') });
    elsewhere.begin();
    elsewhere.answer.value = named(
      file(path.join(root, 'elsewhere', '.playwright-artifacts-0', 'traces', `${TEST_ID}.trace`)),
    );
    expect(await elsewhere.sessions.openTrace({ ref: 'ed-1', lane: 0 })).toEqual({
      ok: false,
      message: 'The worker named a trace outside the folder the run runs in.',
    });
    expect(elsewhere.launches).toEqual([]);
  });

  test('opens no trace of a run whose folder the host does not know, nor offers it', async () => {
    const own = harness({ root: null, cwd: run });
    own.begin();
    own.answer.value = named(file(`test-results/.playwright-artifacts-0/traces/${TEST_ID}.trace`));
    expect(await own.sessions.openTrace({ ref: 'ed-1', lane: 0 })).toEqual({
      ok: false,
      message: "This run's folder is not known here: open its trace from the editor or the app that started it.",
    });
    expect(own.asked).toEqual([]);
    expect(own.launches).toEqual([]);
    await waitFor(() => last(own.sent)?.workers[0]?.test ?? undefined);
    expect(last(own.sent)!.workers[0]).not.toHaveProperty('traces');
  });

  test('refuses a worker whose reporter does not say where its trace grows, and one between two tests', async () => {
    const older = harness({ features: ['view-lane', 'layers'] });
    older.begin();
    expect(await older.sessions.openTrace({ ref: 'ed-1', lane: 0 })).toEqual({
      ok: false,
      message: "This worker's reporter cannot open its trace: update @piwitests/reporter.",
    });
    const between = harness();
    expect(await between.sessions.openTrace({ ref: 'ed-1', lane: 0 })).toEqual({
      ok: false,
      message: 'No test runs on this worker now.',
    });
    // Neither asks the worker.
    expect([...older.asked, ...between.asked]).toEqual([]);
    expect(await between.sessions.openTrace({ ref: 'ed-1', lane: 3 })).toEqual({
      ok: false,
      message: 'This run has no worker 4 now.',
    });
    expect(await between.sessions.openTrace({ ref: 'ed-9', lane: 0 })).toMatchObject({ ok: false });
    expect(await between.sessions.openTrace({ ref: 'ed-1', lane: -1 })).toMatchObject({ ok: false });
  });

  test('says the worker’s own sentence for an attempt it does not trace, and why when it does not answer', async () => {
    const own = harness();
    own.begin();
    const untraced = "This test's attempt is not traced: its project's `trace` option records none of it.";
    own.answer.value = { ok: false, message: untraced };
    expect(await own.sessions.openTrace({ ref: 'ed-1', lane: 0 })).toEqual({ ok: false, message: untraced });
    own.answer.value = null;
    expect(await own.sessions.openTrace({ ref: 'ed-1', lane: 0 })).toEqual({
      ok: false,
      message: 'The test did not answer.',
    });
    expect(own.launches).toEqual([]);
  });

  test('opens nothing a host cannot, saying so', async () => {
    const own = harness({ launcher: null });
    own.begin();
    expect(await own.sessions.openTrace({ ref: 'ed-1', lane: 0 })).toEqual({
      ok: false,
      message: 'The editor cannot open a trace.',
    });
    expect(own.sessions.opensTraces).toBe(false);
    // Its sessions say no worker opens its trace there.
    await waitFor(() => last(own.sent)?.workers[0]?.test ?? undefined);
    expect(last(own.sent)!.workers[0]).not.toHaveProperty('traces');
  });

  test('opens nothing, nor offers it, on a machine without a display, nor asks the worker', async () => {
    const noDisplay = "This machine has no display for Playwright's trace viewer.";
    const own = harness({ display: false });
    own.begin();
    own.answer.value = named(file(`test-results/.playwright-artifacts-0/traces/${TEST_ID}.trace`));
    expect(await own.sessions.openTrace({ ref: 'ed-1', lane: 0 })).toEqual({ ok: false, message: noDisplay });
    expect(own.sessions.opensTraces).toBe(false);
    expect(own.asked).toEqual([]);
    expect(own.launches).toEqual([]);
    await waitFor(() => last(own.sent)?.workers[0]?.test ?? undefined);
    expect(last(own.sent)!.workers[0]).not.toHaveProperty('traces');
    // The hub leaves `trace` out of its features, and answers its `openTrace` so.
    const hub = await hubOf(own.sessions);
    try {
      const picker = await pairedTo(hub);
      expect(picker.welcome).toMatchObject({ features: expect.not.arrayContaining(['trace']) });
      picker.send({ type: 'openTrace', id: 1, ref: 'ed-1', lane: 0 });
      expect(await picker.answer(1)).toEqual({ type: 'answer', id: 1, ok: false, message: noDisplay });
      expect(own.asked).toEqual([]);
    } finally {
      hub.close();
    }
  });

  test('takes a display on Linux and the BSDs from DISPLAY or WAYLAND_DISPLAY, and always on macOS and Windows', () => {
    expect(hasDisplay('linux', {})).toBe(false);
    expect(hasDisplay('linux', { DISPLAY: '' })).toBe(false);
    expect(hasDisplay('linux', { DISPLAY: ':0' })).toBe(true);
    expect(hasDisplay('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(true);
    expect(hasDisplay('freebsd', {})).toBe(false);
    expect(hasDisplay('openbsd', { DISPLAY: ':1' })).toBe(true);
    expect(hasDisplay('darwin', {})).toBe(true);
    expect(hasDisplay('win32', {})).toBe(true);
  });

  test('says a worker opens its trace where its reporter answers it and the host starts the viewer', async () => {
    const own = harness();
    own.begin();
    await waitFor(() => last(own.sent)?.workers[0]?.test ?? undefined);
    expect(last(own.sent)!.workers[0]).toMatchObject({ traces: true });
    const older = harness({ features: ['view-lane'] });
    older.begin();
    await waitFor(() => last(older.sent)?.workers[0]?.test ?? undefined);
    expect(last(older.sent)!.workers[0]).not.toHaveProperty('traces');
  });
});

describe('the trace file a worker names', () => {
  /** What the run sessions answer when the worker names `named` while `TEST_ID` runs, and what they launched. */
  async function refusal(name: string, options: Parameters<typeof harness>[0] = {}): Promise<RunControlResult> {
    const own = harness(options);
    own.begin();
    own.answer.value = named(name);
    const answer = await own.sessions.openTrace({ ref: 'ed-1', lane: 0 });
    expect(own.launches, name).toEqual([]);
    return answer;
  }

  test('is an absolute path to a .trace file of the attempt that runs', async () => {
    expect(await refusal(`test-results/.playwright-artifacts-0/traces/${TEST_ID}.trace`)).toEqual({
      ok: false,
      message: "The worker named no absolute path for its test's trace.",
    });
    expect(await refusal(file(`test-results/.playwright-artifacts-0/traces/${TEST_ID}.zip`))).toEqual({
      ok: false,
      message: 'The worker named a file that is no Playwright trace.',
    });
    expect(await refusal(file('test-results/.playwright-artifacts-0/traces/other-test.trace'))).toEqual({
      ok: false,
      message: 'The worker named the trace of another test.',
    });
    // A retry's trace while the first attempt runs, and the first attempt's while a retry runs.
    expect(await refusal(file(`test-results/.playwright-artifacts-0/traces/${TEST_ID}-retry1.trace`))).toMatchObject({
      message: 'The worker named the trace of another test.',
    });
    expect(
      await refusal(file(`test-results/.playwright-artifacts-0/traces/${TEST_ID}.trace`), { retry: 1 }),
    ).toMatchObject({ message: 'The worker named the trace of another test.' });
  });

  test('is a regular file there now, not a link nor a folder', async () => {
    expect(await refusal(path.join(traces, `${TEST_ID}-recording9.trace`))).toEqual({
      ok: false,
      message: "This test's trace is no longer there: its attempt ended.",
    });
    const secret = file(path.join(root, 'secret.txt'), 'not a trace');
    const link = path.join(traces, `${TEST_ID}-recording7.trace`);
    fs.symlinkSync(secret, link);
    expect(await refusal(link)).toEqual({
      ok: false,
      message: "The worker named a link or a folder, not its test's trace file.",
    });
    const folder = path.join(traces, `${TEST_ID}-recording8.trace`);
    fs.mkdirSync(folder, { recursive: true });
    expect(await refusal(folder)).toMatchObject({ ok: false });
    fs.rmSync(link);
    fs.rmSync(folder, { recursive: true });
  });

  test('is opened only while nothing the viewer reads of its folder is a link, or other than a file', async () => {
    const trace = file(`test-results/.playwright-artifacts-0/traces/${TEST_ID}.trace`);
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    const secret = file(path.join(root, 'secret.txt'), 'not a trace');
    /** What the run sessions answer while `made` is in the runner's trace folder; it is removed after. */
    const whileThere = async (made: string, make: () => void) => {
      make();
      try {
        return await refusal(trace);
      } finally {
        fs.rmSync(made, { recursive: true, force: true });
      }
    };
    // Another file of the attempt, which the viewer lists with it: a link, a folder.
    const fileLink = "A file of this test's trace is a link or a folder: Piwi opens no trace that reads one.";
    const recording = path.join(traces, `${TEST_ID}-recording2.trace`);
    expect(await whileThere(recording, () => fs.symlinkSync(secret, recording))).toEqual({
      ok: false,
      message: fileLink,
    });
    const network = path.join(traces, `${TEST_ID}.network`);
    expect(await whileThere(network, () => fs.mkdirSync(network))).toEqual({ ok: false, message: fileLink });
    // A folder of the trace folder, whose files the viewer lists: a link.
    const resources = path.join(traces, 'resources');
    expect(await whileThere(resources, () => fs.symlinkSync(elsewhere, resources, 'dir'))).toEqual({
      ok: false,
      message: "A folder in the runner's trace folder is a link: Piwi opens no trace that reads one.",
    });
    // The live trace's listing already there, which the viewer would read in place of the folder's.
    const listing = path.join(traces, `${TEST_ID}.json`);
    expect(await whileThere(listing, () => fs.writeFileSync(listing, '{"entries":[]}'))).toEqual({
      ok: false,
      message:
        "The runner's trace folder already holds a file named as this test's live trace: Piwi opens no trace that reads it.",
    });
    // Another test's link, a file, is not read.
    const other = path.join(traces, 'another-test.network');
    fs.symlinkSync(secret, other);
    const own = harness();
    own.begin();
    own.answer.value = named(trace);
    expect(await own.sessions.openTrace({ ref: 'ed-1', lane: 0 })).toEqual({ ok: true, message: OPENED });
    own.closeAll();
    fs.rmSync(other);
  });

  test('is in a trace folder, and a folder above it, that are no links', async () => {
    const folderLink = "The runner's trace folder, or the folder above it, is a link: Piwi opens no trace there.";
    // The real trace folder of the run, and two names for it through a link.
    const real = path.join(run, 'real', '.playwright-artifacts-0', 'traces');
    file(path.join(real, `${TEST_ID}.trace`));
    const linkedTraces = path.join(run, 'linked-traces', '.playwright-artifacts-0');
    fs.mkdirSync(linkedTraces, { recursive: true });
    fs.symlinkSync(real, path.join(linkedTraces, 'traces'), 'dir');
    expect(await refusal(path.join(linkedTraces, 'traces', `${TEST_ID}.trace`))).toEqual({
      ok: false,
      message: folderLink,
    });
    const linkedArtifacts = path.join(run, 'linked-artifacts');
    fs.mkdirSync(linkedArtifacts, { recursive: true });
    fs.symlinkSync(path.dirname(real), path.join(linkedArtifacts, '.playwright-artifacts-0'), 'dir');
    expect(await refusal(path.join(linkedArtifacts, '.playwright-artifacts-0', 'traces', `${TEST_ID}.trace`))).toEqual({
      ok: false,
      message: folderLink,
    });
  });

  test('is in the runner’s trace folder of that worker', async () => {
    const outside = "The worker named a file outside the runner's trace folder.";
    expect(await refusal(file(`test-results/${TEST_ID}.trace`))).toEqual({ ok: false, message: outside });
    expect(await refusal(file(`test-results/.playwright-artifacts-0/other/${TEST_ID}.trace`))).toEqual({
      ok: false,
      message: outside,
    });
    expect(await refusal(file(`test-results/artifacts-0/traces/${TEST_ID}.trace`))).toEqual({
      ok: false,
      message: outside,
    });
    // Another worker's.
    expect(await refusal(file(`test-results/.playwright-artifacts-1/traces/${TEST_ID}.trace`))).toEqual({
      ok: false,
      message: outside,
    });
  });

  test('is inside the folder the run runs in, as the file system spells it', async () => {
    const inside = 'The worker named a trace outside the folder the run runs in.';
    const elsewhere = path.join(root, 'elsewhere', '.playwright-artifacts-0', 'traces');
    expect(await refusal(file(path.join(elsewhere, `${TEST_ID}.trace`)))).toEqual({ ok: false, message: inside });
    // A folder of the run that is a link to one outside it.
    fs.mkdirSync(path.join(run, 'linked'), { recursive: true });
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(run, 'linked', 'out'));
    expect(
      await refusal(path.join(run, 'linked', 'out', '.playwright-artifacts-0', 'traces', `${TEST_ID}.trace`)),
    ).toEqual({
      ok: false,
      message: inside,
    });
    // A run whose folder is another one.
    expect(
      checkTraceFile(path.join(traces, `${TEST_ID}.trace`), {
        folder: path.join(root, 'elsewhere'),
        worker: 0,
        testId: TEST_ID,
        retry: 0,
      }),
    ).toEqual({ ok: false, message: inside });
  });

  test('is checked as it stands when the worker answers: a test that ended since is not opened', async () => {
    const own = harness();
    own.begin();
    const trace = file(`test-results/.playwright-artifacts-0/traces/${TEST_ID}.trace`);
    own.socket.onWrite = (line) => {
      const message = JSON.parse(line) as HubToRun;
      if (message.type !== 'request' || message.what !== 'trace') return;
      queueMicrotask(() => {
        own.begin(0, 'next-test');
        own.read({ type: 'answer', request: message.request, what: 'trace', value: named(trace) });
      });
    };
    expect(await own.sessions.openTrace({ ref: 'ed-1', lane: 0 })).toEqual({
      ok: false,
      message: 'The test ended: open the trace of the one that runs now.',
    });
    expect(own.launches).toEqual([]);
  });
});

describe('the trace’s path', () => {
  test('goes into no answer, even where the viewer’s reason names it', async () => {
    const own = harness();
    own.begin();
    const trace = file(`test-results/.playwright-artifacts-0/traces/${TEST_ID}.trace`);
    own.answer.value = named(trace);
    own.launcher.next = (launch) => ({ ok: false, reason: `Trace file ${launch.trace} does not exist! (${trace})` });
    const answer = await own.sessions.openTrace({ ref: 'ed-1', lane: 0 });
    expect(answer).toEqual({
      ok: false,
      message:
        "Playwright's trace viewer could not start: Trace file the test's trace/a1b2c3-d4e5f6.json does not exist! (the test's trace).",
    });
    // A viewer that did not start leaves no viewer open.
    own.launcher.next = () => ({ ok: false, reason: 'browserType.launch: Executable doesn’t exist.' });
    expect(await own.sessions.openTrace({ ref: 'ed-1', lane: 0 })).toEqual({
      ok: false,
      message: "Playwright's trace viewer could not start: browserType.launch: Executable doesn’t exist.",
    });
    for (const said of [JSON.stringify(own.sent), JSON.stringify(own.notices)]) {
      expect(said).not.toContain(traces);
      expect(said).not.toContain('.playwright-artifacts');
    }
  });

  test('goes to no hub connection: it hears the worker opens its trace, and the answer, alone', async () => {
    const own = harness();
    const hub = await hubOf(own.sessions);
    try {
      const picker = await pairedTo(hub);
      expect(picker.welcome).toMatchObject({ features: expect.arrayContaining(['trace']) });
      own.begin();
      await waitFor(() => last(own.sent)?.workers[0]?.test ?? undefined);
      picker.send({ type: 'subscribe', id: 1 });
      const traced = await waitFor(() =>
        picker
          .messages()
          .find((m) => m.type === 'session' && m.session.workers[0]?.test && m.session.workers[0].traces),
      );
      expect(traced).toBeDefined();
      own.answer.value = named(file(`test-results/.playwright-artifacts-0/traces/${TEST_ID}.trace`));
      // A path the connection names is never read: the worker names the file.
      picker.send({ type: 'openTrace', id: 2, ref: 'ed-1', lane: 0, file: '/etc/passwd' });
      expect(await picker.answer(2)).toEqual({ type: 'answer', id: 2, ok: true, message: OPENED });
      expect(own.launches).toEqual([{ folder: run, trace: path.join(traces, `${TEST_ID}.json`) }]);
      picker.send({ type: 'openTrace', id: 3, ref: 'ed-1', lane: 0 });
      expect(await picker.answer(3)).toEqual({ type: 'answer', id: 3, ok: false, message: ALREADY });
      for (const text of picker.raw) {
        expect(text).not.toContain(traces);
        expect(text).not.toContain('.playwright-artifacts');
        expect(text).not.toContain(`${TEST_ID}.trace`);
      }
    } finally {
      own.closeAll();
      hub.close();
    }
  });

  test('opens none for a connection that came through a port the client forwards: it is on another machine', async () => {
    const own = harness();
    own.begin();
    own.answer.value = named(file(`test-results/.playwright-artifacts-0/traces/${TEST_ID}.trace`));
    const ports = { forwarded: [] as number[] };
    const hub = await hubOf(own.sessions, () => ports.forwarded);
    const port = Number(new URL(hub.url).port);
    ports.forwarded = [port === 65_535 ? port - 1 : port + 1];
    try {
      // The browser's machine, through the port the client forwards.
      const remote = await pairedTo(hub, `127.0.0.1:${ports.forwarded[0]}`);
      expect(remote.welcome).toMatchObject({ features: expect.not.arrayContaining(['trace']) });
      expect(remote.welcome).toMatchObject({ features: expect.arrayContaining(['lanes']) });
      remote.send({ type: 'openTrace', id: 1, ref: 'ed-1', lane: 0 });
      expect(await remote.answer(1)).toEqual({
        type: 'answer',
        id: 1,
        ok: false,
        message: "Playwright's trace viewer would open on the machine the run runs on, not this one.",
      });
      expect(own.asked).toEqual([]);
      expect(own.launches).toEqual([]);
      // This machine, at the hub's own port.
      const local = await pairedTo(hub);
      expect(local.welcome).toMatchObject({ features: expect.arrayContaining(['trace']) });
      local.send({ type: 'openTrace', id: 2, ref: 'ed-1', lane: 0 });
      expect(await local.answer(2)).toEqual({ type: 'answer', id: 2, ok: true, message: OPENED });
    } finally {
      own.closeAll();
      hub.close();
    }
  });

  test('goes to no editor client: piwi/openTrace answers in a sentence, from the run’s folder', async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-trace-lsp-')));
    writeRunWorkspace(dir);
    const own = standIn();
    const svc = await service(dir, true, { traceViewer: own.launcher });
    const heard: string[] = [];
    svc.client.onNotification(
      (method: string, params: unknown) => void heard.push(`${method} ${JSON.stringify(params)}`),
    );
    try {
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
        reporter: '0.80.0',
        takes: ['pick', 'record'],
        holds: ['failure'],
        features: ['view-lane', 'trace'],
      });
      worker.begin('adds a mug');
      await waitFor(() => (svc.latest(ref)?.workers[0]?.traces ? true : undefined));
      const dirTraces = path.join(dir, 'test-results', '.playwright-artifacts-0', 'traces');
      fs.mkdirSync(dirTraces, { recursive: true });
      const trace = path.join(dirTraces, 'id-adds a mug.trace');
      fs.writeFileSync(trace, '{}\n');
      const asked = svc.client.sendRequest('piwi/openTrace', { ref, lane: 0 }) as Promise<RunControlResult>;
      const request = await worker.next('request');
      expect(request).toEqual({ type: 'request', request: expect.any(Number), what: 'trace' });
      worker.send({ type: 'answer', request: request.request, what: 'trace', value: named(trace) });
      expect(await asked).toEqual({ ok: true, message: OPENED });
      expect(own.launches).toEqual([{ folder: dir, trace: path.join(dirTraces, 'id-adds a mug.json') }]);
      const all = [...heard, JSON.stringify(svc.sessions), JSON.stringify(svc.notices), JSON.stringify(await asked)];
      for (const said of all) {
        expect(said).not.toContain(dirTraces);
        expect(said).not.toContain('.playwright-artifacts');
      }
      worker.socket.destroy();
    } finally {
      own.closeAll();
      svc.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('is never asked by piwi/openTrace on a machine without a display', async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-trace-lsp-')));
    writeRunWorkspace(dir);
    const own = standIn();
    const svc = await service(dir, true, { traceViewer: own.launcher, traceDisplay: () => false });
    try {
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
        reporter: '0.80.0',
        takes: ['pick', 'record'],
        holds: ['failure'],
        features: ['view-lane', 'trace'],
      });
      worker.begin('adds a mug');
      await waitFor(() => svc.latest(ref)?.workers[0]?.test ?? undefined);
      expect(svc.latest(ref)!.workers[0]).not.toHaveProperty('traces');
      expect(await svc.client.sendRequest('piwi/openTrace', { ref, lane: 0 })).toEqual({
        ok: false,
        message: "This machine has no display for Playwright's trace viewer.",
      });
      expect(worker.heard.filter((m) => m.type === 'request')).toEqual([]);
      expect(own.launches).toEqual([]);
      worker.socket.destroy();
    } finally {
      svc.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the launcher', () => {
  let project = '';
  /** The temporary folder the launcher keeps each viewer's error output in. */
  let temp = '';

  /**
   * A project with a stand-in `@playwright/test` whose CLI writes its arguments, folder and environment beside itself,
   * then stays up a moment as a viewer does, writing on its error output as it starts and before it stops; or, for a
   * trace whose name holds `fail` or `long-reason`, says why on its error output (the latter naming the trace past its
   * 250th character) and stops. For one whose name holds `orphan`, it writes on its error output once more after its
   * parent is gone, then says it still runs (`alive`).
   */
  beforeAll(() => {
    project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-trace-project-')));
    temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-trace-temp-')));
    const pkg = path.join(project, 'node_modules', '@playwright', 'test');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@playwright/test', version: '1.64.1' }));
    fs.writeFileSync(
      path.join(pkg, 'cli.js'),
      `const fs = require('node:fs');
const path = require('node:path');
const trace = process.argv[3] || '';
if (trace.includes('fail')) {
  process.stderr.write("Error: browserType.launch: Executable doesn't exist at /x/chrome\\n");
  process.exit(1);
}
if (trace.includes('long-reason')) {
  process.stderr.write('Error: ' + 'x'.repeat(250) + ' ' + trace + '\\n');
  process.exit(1);
}
fs.writeFileSync(
  path.join(__dirname, 'heard.json'),
  JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env }),
);
process.stderr.write('Listening\\n');
if (trace.includes('orphan')) {
  setTimeout(() => {
    process.stderr.write('Still here\\n');
    setTimeout(() => fs.writeFileSync(path.join(__dirname, 'alive'), 'yes'), 200);
  }, 1500);
} else {
  setTimeout(() => process.stderr.write('Closing\\n'), 1000);
  setTimeout(() => {}, 1500);
}
`,
    );
  });

  afterAll(() => {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  });

  test('runs show-trace of the project’s own Playwright on the trace, in the run’s folder, without a shell', async () => {
    const trace = path.join(project, 'test-results', '$(touch pwned) "a b"', 'x.json');
    const started = await startTraceViewer({ folder: project, trace }, { startMs: 300, tempDir: temp });
    expect(started.ok).toBe(true);
    const heard = JSON.parse(
      fs.readFileSync(path.join(project, 'node_modules', '@playwright', 'test', 'heard.json'), 'utf8'),
    );
    expect(heard).toMatchObject({ args: ['show-trace', trace], cwd: project });
    expect(fs.existsSync(path.join(project, 'pwned'))).toBe(false);
    // It settles once the viewer stops.
    if (started.ok) await started.closed;
  });

  test('gives the viewer what a window and Playwright need, and none of the host’s own settings', async () => {
    const host: Record<string, string> = {
      // The desktop app's server's and the service's own: never the viewer's.
      PIWI_SECRET_KEY: 'secret-key',
      PIWI_DESKTOP_TOKEN: `pd_${'ab'.repeat(32)}`,
      PIWI_API_KEY: 'api-key',
      DATABASE_URL: 'postgres://piwi:password@db/piwi',
      NODE_OPTIONS: '--no-warnings',
      NODE_COMPILE_CACHE: path.join(root, 'cache'),
      NODE_ENV: 'production',
      // A window's and Playwright's, in either case.
      DISPLAY: ':7',
      WAYLAND_DISPLAY: 'wayland-1',
      XAUTHORITY: '/home/me/.Xauthority',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      LC_ALL: 'C.UTF-8',
      TZ: 'Europe/Paris',
      PLAYWRIGHT_BROWSERS_PATH: '/opt/browsers',
      http_proxy: 'http://proxy.test:3128',
      HTTPS_PROXY: 'http://proxy.test:3129',
      no_proxy: 'localhost',
      SystemRoot: 'C:\\Windows',
      FORCE_COLOR: '3',
    };
    const before = { ...process.env };
    Object.assign(process.env, host);
    let started: TraceViewerStarted;
    try {
      started = await startTraceViewer(
        { folder: project, trace: path.join(project, 'env.json') },
        { startMs: 300, tempDir: temp },
      );
    } finally {
      for (const name of Object.keys(host)) {
        if (before[name] === undefined) delete process.env[name];
        else process.env[name] = before[name];
      }
    }
    expect(started.ok).toBe(true);
    const { env } = JSON.parse(
      fs.readFileSync(path.join(project, 'node_modules', '@playwright', 'test', 'heard.json'), 'utf8'),
    ) as { env: Record<string, string> };
    expect(env).toMatchObject({
      PATH: process.env.PATH,
      DISPLAY: ':7',
      WAYLAND_DISPLAY: 'wayland-1',
      XAUTHORITY: '/home/me/.Xauthority',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      LC_ALL: 'C.UTF-8',
      TZ: 'Europe/Paris',
      PLAYWRIGHT_BROWSERS_PATH: '/opt/browsers',
      http_proxy: 'http://proxy.test:3128',
      HTTPS_PROXY: 'http://proxy.test:3129',
      no_proxy: 'localhost',
      SystemRoot: 'C:\\Windows',
      FORCE_COLOR: '0',
    });
    if (process.env.HOME) expect(env.HOME).toBe(process.env.HOME);
    for (const name of ['PIWI_SECRET_KEY', 'PIWI_DESKTOP_TOKEN', 'PIWI_API_KEY', 'DATABASE_URL']) {
      expect(env, name).not.toHaveProperty(name);
    }
    // Nothing of the host's Node, its package manager or its test runner either.
    expect(Object.keys(env).filter((name) => /^(PIWI_|NODE_|npm_|VITEST)/i.test(name))).toEqual([]);
    if (started.ok) await started.closed;
  });

  test('says why a viewer that stops at once did not start, and that Playwright is missing', async () => {
    expect(
      await startTraceViewer(
        { folder: project, trace: path.join(project, 'fail.json') },
        { startMs: 3000, tempDir: temp },
      ),
    ).toEqual({
      ok: false,
      reason: "browserType.launch: Executable doesn't exist at /x/chrome",
    });
    // Its error output is gone with it.
    expect(fs.readdirSync(temp)).toEqual([]);
    expect(
      await startTraceViewer({ folder: root, trace: path.join(root, 'x.json') }, { startMs: 300, tempDir: temp }),
    ).toEqual({
      ok: false,
      reason: 'Playwright is not installed in the folder the run runs in',
    });
  });

  test('says why it did not start with the trace’s path left out, then cut, a path across the cut included', async () => {
    const own = harness({
      root: project,
      launcher: (launch) => startTraceViewer(launch, { startMs: 3000, tempDir: temp }),
    });
    // The stand-in says why with 250 characters, then the path of what it opens, which runs past 300.
    own.begin(0, 'long-reason');
    own.answer.value = named(file(path.join(project, 'test-results/.playwright-artifacts-0/traces/long-reason.trace')));
    const answer = await own.sessions.openTrace({ ref: 'ed-1', lane: 0 });
    expect(answer).toEqual({
      ok: false,
      message: `Playwright's trace viewer could not start: ${'x'.repeat(250)} the test's trace/long-reason.json.`,
    });
    expect(answer.message).not.toContain(project.slice(0, 8));
  });

  test('keeps a running viewer’s error output in a file of a folder of its own, gone once the viewer stops', async () => {
    const started = await startTraceViewer(
      { folder: project, trace: path.join(project, 'kept.json') },
      { startMs: 300, tempDir: temp },
    );
    expect(started.ok).toBe(true);
    const [folder, ...others] = fs.readdirSync(temp);
    expect(others).toEqual([]);
    const kept = path.join(temp, folder!);
    if (process.platform !== 'win32') expect(fs.statSync(kept).mode & 0o077).toBe(0);
    const [log] = fs.readdirSync(kept);
    expect(
      await waitFor(() => (fs.readFileSync(path.join(kept, log!), 'utf8') === 'Listening\n' ? true : undefined), 2000),
    ).toBe(true);
    if (started.ok) await started.closed;
    expect(fs.readdirSync(temp)).toEqual([]);
  });

  test(
    'lets a viewer that writes on its error output outlive the host that started it',
    { timeout: 15_000 },
    async () => {
      // A host of its own, which starts the viewer and ends once it started.
      const host = path.join(project, 'host.cjs');
      await build({
        stdin: {
          contents: `import { startTraceViewer } from './trace-viewer';
const [folder, trace, tempDir] = process.argv.slice(2);
void startTraceViewer({ folder, trace }, { startMs: 200, tempDir }).then((started) => {
  process.stdout.write(JSON.stringify({ ok: started.ok }));
});
`,
          resolveDir: path.join(__dirname, '..', 'src'),
          sourcefile: 'host.ts',
          loader: 'ts',
        },
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'cjs',
        outfile: host,
        logLevel: 'silent',
      });
      const logs = fs.realpathSync.native(fs.mkdtempSync(path.join(project, 'logs-')));
      const alive = path.join(project, 'node_modules', '@playwright', 'test', 'alive');
      const ran = spawnSync(process.execPath, [host, project, path.join(project, 'orphan.json'), logs], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect({ status: ran.status, stdout: ran.stdout }).toEqual({ status: 0, stdout: '{"ok":true}' });
      // The host is gone: the viewer writes on its error output, and still runs after.
      expect(await waitFor(() => (fs.existsSync(alive) ? true : undefined), 5000)).toBe(true);
      // What it wrote is in the file the host left behind.
      const [folder] = fs.readdirSync(logs);
      const [log] = fs.readdirSync(path.join(logs, folder!));
      expect(fs.readFileSync(path.join(logs, folder!, log!), 'utf8')).toBe('Listening\nStill here\n');
    },
  );
});
