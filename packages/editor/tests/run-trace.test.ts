/**
 * **Open the trace so far**: a lane's running test's trace opened in Playwright's trace viewer on this machine. The run
 * sessions with a stand-in launcher and a fake worker that names its trace file, in a real folder: each check the file
 * passes and each refusal; one viewer per attempt; the hub's `openTrace` and the editor's `piwi/openTrace` answered in
 * a sentence, and the trace's path in no message a hub connection or the client hears. Then the launcher itself, with a
 * stand-in Playwright CLI: the arguments it gets, without a shell, in the run's folder, and why one that stops at once
 * did not start.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import type * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
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
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-trace-')));
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
 * The run `ed-1` in its own sessions, its lane 0's worker running the test `TEST_ID` in `run`, and answering each
 * `trace` it is asked with `answer`'s value then (none, for a worker that does not answer).
 */
function harness(
  options: { features?: RunFeature[]; launcher?: TraceViewerLauncher | null; cwd?: string; retry?: number } = {},
) {
  const sent: RunSession[] = [];
  const notices: string[] = [];
  const own = standIn();
  const sessions = new RunSessions({
    notify: (session) => void sent.push(session),
    answersStops: () => true,
    notice: (_root, _severity, message) => void notices.push(message),
    rootOf: () => run,
    paceMs: 5,
    burstMs: 0,
    requestMs: 300,
    lingerMs: 60_000,
    ...(options.launcher === null ? {} : { traceViewer: options.launcher ?? own.launcher }),
  });
  const socket = fakeSocket();
  const reader = sessions.attach(socket as unknown as net.Socket, {
    type: 'run-attach',
    token: 't',
    ref: 'ed-1',
    cwd: options.cwd ?? run,
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
    // A run whose working directory is another folder.
    expect(
      checkTraceFile(path.join(traces, `${TEST_ID}.trace`), {
        folders: [path.join(root, 'elsewhere')],
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
    const hub = (await RunHub.open({
      sessions: own.sessions,
      actions: {
        action: async () => ({ ok: false, message: 'No action here.' }),
        requests: async () => ({ ok: false, message: 'No request here.', requests: [] }),
      },
      runInfo: () => ({ command: null, label: 'shop', project: null }),
      welcome: () => ({ pid: process.pid, version: '0.0.0', client: 'Test Editor', roots: [run] }),
      surfacesChanged: () => {},
    }))!;
    const socket = new WebSocket(hub.url, { origin: ORIGIN });
    const raw: string[] = [];
    socket.on('message', (data) => void raw.push(String(data)));
    const messages = () => raw.map((text) => parseHubMessage(text)).filter((m): m is HubMessage => !!m);
    try {
      await new Promise((resolve) => socket.on('open', resolve));
      socket.send(JSON.stringify({ type: 'hello', token: hub.token }));
      expect(await waitFor(() => messages().find((m) => m.type === 'welcome'))).toMatchObject({
        features: expect.arrayContaining(['trace']),
      });
      own.begin();
      await waitFor(() => last(own.sent)?.workers[0]?.test ?? undefined);
      socket.send(JSON.stringify({ type: 'subscribe', id: 1 }));
      const traced = await waitFor(() =>
        messages().find((m) => m.type === 'session' && m.session.workers[0]?.test && m.session.workers[0].traces),
      );
      expect(traced).toBeDefined();
      own.answer.value = named(file(`test-results/.playwright-artifacts-0/traces/${TEST_ID}.trace`));
      // A path the connection names is never read: the worker names the file.
      socket.send(JSON.stringify({ type: 'openTrace', id: 2, ref: 'ed-1', lane: 0, file: '/etc/passwd' }));
      expect(await waitFor(() => messages().find((m): m is HubAnswer => m.type === 'answer' && m.id === 2))).toEqual({
        type: 'answer',
        id: 2,
        ok: true,
        message: OPENED,
      });
      expect(own.launches).toEqual([{ folder: run, trace: path.join(traces, `${TEST_ID}.json`) }]);
      socket.send(JSON.stringify({ type: 'openTrace', id: 3, ref: 'ed-1', lane: 0 }));
      expect(await waitFor(() => messages().find((m): m is HubAnswer => m.type === 'answer' && m.id === 3))).toEqual({
        type: 'answer',
        id: 3,
        ok: false,
        message: ALREADY,
      });
      for (const text of raw) {
        expect(text).not.toContain(traces);
        expect(text).not.toContain('.playwright-artifacts');
        expect(text).not.toContain(`${TEST_ID}.trace`);
      }
    } finally {
      own.closeAll();
      socket.close();
      hub.close();
    }
  });

  test('goes to no editor client: piwi/openTrace answers in a sentence, from the run’s folder', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-trace-lsp-')));
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
});

describe('the launcher', () => {
  let project = '';

  /**
   * A project with a stand-in `@playwright/test` whose CLI writes its arguments and folder beside itself, then stays
   * up a moment as a viewer does; or, for a trace whose name holds `fail`, says why on its error output and stops.
   */
  beforeAll(() => {
    project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-trace-viewer-')));
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
fs.writeFileSync(path.join(__dirname, 'heard.json'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
setTimeout(() => {}, 1500);
`,
    );
  });

  afterAll(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  test('runs show-trace of the project’s own Playwright on the trace, in the run’s folder, without a shell', async () => {
    const trace = path.join(project, 'test-results', '$(touch pwned) "a b"', 'x.json');
    const started = await startTraceViewer({ folder: project, trace }, 300);
    expect(started.ok).toBe(true);
    const heard = JSON.parse(
      fs.readFileSync(path.join(project, 'node_modules', '@playwright', 'test', 'heard.json'), 'utf8'),
    );
    expect(heard).toEqual({ args: ['show-trace', trace], cwd: project });
    expect(fs.existsSync(path.join(project, 'pwned'))).toBe(false);
    // It settles once the viewer stops.
    if (started.ok) await started.closed;
  });

  test('says why a viewer that stops at once did not start, and that Playwright is missing', async () => {
    expect(await startTraceViewer({ folder: project, trace: path.join(project, 'fail.json') }, 3000)).toEqual({
      ok: false,
      reason: "browserType.launch: Executable doesn't exist at /x/chrome",
    });
    expect(await startTraceViewer({ folder: root, trace: path.join(root, 'x.json') }, 300)).toEqual({
      ok: false,
      reason: 'Playwright is not installed in the folder the run runs in',
    });
  });
});
