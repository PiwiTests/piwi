/**
 * The runs the editor starts, as their workers tell them over the run channel: a service started in-process on a
 * workspace with one Playwright config and no instance, a fake worker on the socket each run names
 * (`PIWI_RUN_CHANNEL`), and the client's side of the protocol: the session it hears, the controls it sends.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import { createConnection } from 'vscode-languageserver/node';
import { lineReader, parseRecordChannel } from '@piwitests/core/ide-recorder';
import { parseHubToRun, type HubToRun, type RunToHub } from '@piwitests/core/run-channel';
import { startServer } from '../src/server';
import { RunSessions } from '../src/run-sessions';
import type {
  Notice,
  PausedPageResult,
  RecordRequested,
  RunCommand,
  RunControlResult,
  RunSession,
} from '../src/protocol';

let dir = '';
const uri = (file: string) => pathToFileURL(path.join(dir, file)).href;

function last<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

async function waitFor<T>(read: () => T | undefined, ms = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A service on the workspace, and what its client heard. */
interface Service {
  client: MessageConnection;
  stop: () => void;
  sessions: RunSession[];
  notices: Notice[];
  /** The latest session of a ref the client heard. */
  latest(ref: string): RunSession | undefined;
  /** A command that runs the spec's test, with its ref and the run channel it names. */
  command(): Promise<{ ref: string; channel: { path: string; token: string }; command: RunCommand }>;
}

async function service(runControl: boolean): Promise<Service> {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const stop = startServer(createConnection(toServer, toClient), { env: { PIWI_DESKTOP_CONFIG: '/nonexistent' } });
  const client = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
  const sessions: RunSession[] = [];
  const notices: Notice[] = [];
  client.onNotification('piwi/runSessionChanged', (session: RunSession) => void sessions.push(session));
  client.onNotification('piwi/notice', (notice: Notice) => void notices.push(notice));
  client.listen();
  await client.sendRequest('initialize', {
    processId: null,
    rootUri: null,
    capabilities: {},
    workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'shop' }],
    initializationOptions: runControl ? { runControl: true } : {},
  });
  await client.sendNotification('initialized', {});
  const command = async () => {
    // The channel opens once the service is initialized: a command built before names none.
    for (;;) {
      const run = (await client.sendRequest('piwi/runArgs', {
        uri: uri('tests/cart.spec.ts'),
        testIds: [],
        locations: ['tests/cart.spec.ts:3'],
      })) as RunCommand;
      const channel = parseRecordChannel(run.env?.PIWI_RUN_CHANNEL);
      if (channel) return { ref: run.ref!, channel, command: run };
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return {
    client,
    stop: () => {
      stop();
      client.dispose();
    },
    sessions,
    notices,
    latest: (ref) => last(sessions.filter((s) => s.ref === ref)),
    command,
  };
}

/** A worker of a run on its run connection: what it heard, and what it sends. */
class FakeWorker {
  readonly heard: HubToRun[] = [];
  readonly socket: net.Socket;
  readonly closed: Promise<void>;

  constructor(channelPath: string) {
    this.socket = net.connect(channelPath);
    this.socket.setEncoding('utf8');
    this.socket.on(
      'data',
      lineReader(
        (line) => {
          const message = parseHubToRun(line);
          if (message && message.type !== 'unknown') this.heard.push(message);
        },
        () => this.socket.destroy(),
      ),
    );
    this.closed = new Promise((resolve) => this.socket.on('close', () => resolve()));
  }

  send(message: RunToHub): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  attach(token: string, ref: string, workerIndex = 0): this {
    this.send({
      type: 'run-attach',
      token,
      ref,
      cwd: dir,
      workerIndex,
      parallelIndex: workerIndex,
      pid: process.pid,
      playwright: '1.64.1',
      reporter: '0.60.0',
    });
    return this;
  }

  begin(title = 'adds a mug', cannotPause: string | null = null): void {
    this.send({
      type: 'test-begin',
      testId: `id-${title}`,
      title: ['cart', title],
      file: 'tests/cart.spec.ts',
      line: 3,
      project: 'chromium',
      retry: 0,
      cannotPause,
    });
  }

  stopAt(stop: number, line: number, bar = false): void {
    this.send({
      type: 'stopped',
      stop,
      reason: 'breakpoint',
      title: "Click getByRole('button', { name: 'Add' })",
      place: { file: 'tests/pages/cart.page.ts', line, column: 5 },
      locator: "getByRole('button', { name: 'Add' })",
      bar,
    });
  }

  /** The next message heard of a type, after `after` of them. */
  next<T extends HubToRun['type']>(type: T, after = 0): Promise<Extract<HubToRun, { type: T }>> {
    return waitFor(() => this.heard.filter((m) => m.type === type)[after] as Extract<HubToRun, { type: T }>);
  }
}

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-sessions-')));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  write('playwright.config.ts', 'export default {};\n');
  write(
    'tests/cart.spec.ts',
    "import { test } from '@playwright/test';\n\ntest('adds a mug', async ({ page }) => {});\n",
  );
  write('tests/pages/cart.page.ts', 'export class CartPage {}\n');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a run’s session, with a client that answers stops', () => {
  let svc: Service;
  beforeAll(async () => {
    svc = await service(true);
  });
  afterAll(() => svc.stop());

  const control = (params: object) => svc.client.sendRequest('piwi/runControl', params) as Promise<RunControlResult>;

  test('names the run channel beside the record channel, the same socket', async () => {
    const { command } = await svc.command();
    expect(command.env?.PIWI_RUN_CHANNEL).toBeTruthy();
    expect(command.env?.PIWI_RUN_CHANNEL).toBe(command.env?.PIWI_RECORD_CHANNEL);
  });

  test('files a worker under its run, and tells the client as it starts a test, stops, goes on and ends it', async () => {
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path).attach(channel.token, ref, 3);
    try {
      expect(await waitFor(() => svc.latest(ref))).toEqual({
        ref,
        root: dir,
        workers: [{ worker: 3, parallelIndex: 3, state: 'between', test: null, stop: null, pausing: false }],
        ended: false,
      });
      worker.begin();
      const running = await waitFor(() => svc.latest(ref)?.workers[0]?.test ?? undefined);
      expect(running).toEqual({
        id: 'id-adds a mug',
        title: ['cart', 'adds a mug'],
        uri: uri('tests/cart.spec.ts'),
        line: 2,
        project: 'chromium',
        retry: 0,
        cannotPause: null,
      });
      expect(svc.latest(ref)!.workers[0]!.state).toBe('running');

      const heard = svc.sessions.length;
      worker.stopAt(1, 30);
      const stopped = await waitFor(() => svc.latest(ref)?.workers[0]?.stop ?? undefined);
      // A stop is said at once, not at the pace of the other changes.
      expect(svc.sessions.length).toBe(heard + 1);
      expect(stopped).toEqual({
        reason: 'breakpoint',
        title: "Click getByRole('button', { name: 'Add' })",
        uri: uri('tests/pages/cart.page.ts'),
        line: 29,
        character: 4,
        locator: "getByRole('button', { name: 'Add' })",
        bar: false,
        since: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      });
      expect(svc.latest(ref)!.workers[0]!.state).toBe('stopped');

      // The end of another stop than the one held changes nothing.
      worker.send({ type: 'running', stop: 7 });
      worker.send({ type: 'running', stop: 1 });
      await waitFor(() => (svc.latest(ref)?.workers[0]?.state === 'running' ? true : undefined));
      worker.send({ type: 'test-end', testId: 'id-adds a mug', status: 'passed', pausedMs: 1200 });
      await waitFor(() => (svc.latest(ref)?.workers[0]?.state === 'between' ? true : undefined));

      // The client says the command ended: the run ends with it, and the worker's connection closes.
      await svc.client.sendNotification('piwi/commandEnded', { ref, exitCode: 0 });
      expect(await waitFor(() => (svc.latest(ref)?.ended ? svc.latest(ref) : undefined))).toEqual({
        ref,
        root: dir,
        workers: [],
        ended: true,
      });
      await worker.closed;
    } finally {
      worker.socket.destroy();
    }
  });

  test('answers each control: a pause to the running workers, the others to the one stopped, and why not', async () => {
    const { ref, channel } = await svc.command();
    const first = new FakeWorker(channel.path).attach(channel.token, ref, 0);
    const second = new FakeWorker(channel.path).attach(channel.token, ref, 1);
    try {
      await waitFor(() => (svc.latest(ref)?.workers.length === 2 ? true : undefined));
      expect(await control({ ref: 'ed-00000000', action: 'pause' })).toEqual({
        ok: false,
        message: 'No worker of this run is connected to the editor.',
      });
      expect(await control({ ref, action: 'resume' })).toEqual({ ok: false, message: 'No test runs now.' });
      expect(await control({ ref, worker: 1, action: 'step' })).toEqual({
        ok: false,
        message: 'The worker runs no test now.',
      });
      expect(await control({ ref, worker: 9, action: 'pause' })).toEqual({
        ok: false,
        message: 'Worker 9 of this run is not connected to the editor.',
      });

      first.begin('adds a mug');
      second.begin('removes a mug', "Playwright's debugger runs the test (--debug=cli) — run without --debug");
      await waitFor(() => (svc.latest(ref)?.workers.every((w) => w.test) ? true : undefined));
      expect(await control({ ref, action: 'resume' })).toEqual({ ok: false, message: 'The test is running.' });
      expect(await control({ ref, action: 'pause' })).toEqual({ ok: true, message: 'Pausing at the next call.' });
      expect(await first.next('control')).toEqual({ type: 'control', action: 'pause' });
      expect(svc.latest(ref)!.workers.map((w) => w.pausing)).toEqual([true, false]);
      expect(await control({ ref, worker: 1, action: 'pause' })).toEqual({
        ok: false,
        message: "The test does not stop: Playwright's debugger runs the test (--debug=cli) — run without --debug.",
      });

      first.stopAt(4, 12);
      await waitFor(() => (svc.latest(ref)?.workers[0]?.state === 'stopped' ? true : undefined));
      expect(svc.latest(ref)!.workers[0]!.pausing).toBe(false);
      expect(await control({ ref, worker: 0, action: 'pause' })).toEqual({
        ok: false,
        message: 'The test is stopped already.',
      });
      expect(await control({ ref, action: 'step' })).toEqual({ ok: true, message: 'Stepping to the next call.' });
      expect(await first.next('control', 1)).toEqual({ type: 'control', action: 'step', stop: 4 });
      expect(await control({ ref, action: 'finish' })).toMatchObject({ ok: true });
      expect(await first.next('control', 2)).toEqual({ type: 'control', action: 'finish', stop: 4 });

      // Run to a line: the client's file and 0-based line, the worker's place relative to the run's folder.
      expect(
        await control({ ref, action: 'run-to', place: { uri: uri('tests/pages/cart.page.ts'), line: 40 } }),
      ).toEqual({ ok: true, message: 'Running to cart.page.ts:41.' });
      expect(await first.next('run-to')).toEqual({
        type: 'run-to',
        stop: 4,
        place: { file: 'tests/pages/cart.page.ts', line: 41 },
      });
      const outside = pathToFileURL(path.join(os.tmpdir(), 'elsewhere', 'shared.ts')).href;
      expect(await control({ ref, action: 'run-to', place: { uri: outside, line: 3 } })).toEqual({
        ok: false,
        message: 'shared.ts is outside the folder the run runs in.',
      });
      expect(await control({ ref, action: 'run-to' })).toEqual({
        ok: false,
        message: 'Run to needs a line of a file.',
      });

      // Two workers stopped: a control names the one it answers.
      second.stopAt(2, 14, true);
      await waitFor(() => (svc.latest(ref)?.workers[1]?.state === 'stopped' ? true : undefined));
      expect(await control({ ref, action: 'resume' })).toEqual({
        ok: false,
        message: '2 workers are stopped: choose one.',
      });
      expect(await control({ ref, worker: 1, action: 'resume' })).toEqual({ ok: true, message: 'Resuming.' });
      expect(await second.next('control')).toEqual({ type: 'control', action: 'resume', stop: 2 });
      expect(await control({ ref, action: 'jump' })).toEqual({
        ok: false,
        message: 'Piwi does not know the action "jump".',
      });
    } finally {
      first.socket.destroy();
      second.socket.destroy();
    }
  });

  test('sends the breakpoints the client changes to the run’s workers, and to a worker that connects later', async () => {
    const { ref, channel } = await svc.command();
    const first = new FakeWorker(channel.path).attach(channel.token, ref, 0);
    let later: FakeWorker | null = null;
    try {
      await waitFor(() => svc.latest(ref));
      const outside = pathToFileURL(path.join(os.tmpdir(), 'elsewhere', 'shared.ts')).href;
      await svc.client.sendNotification('piwi/setRunBreakpoints', {
        ref,
        places: [
          { uri: uri('tests/cart.spec.ts'), line: 2 },
          { uri: uri('tests/pages/cart.page.ts'), line: 29 },
          { uri: uri('tests/cart.spec.ts'), line: 2 },
          { uri: outside, line: 1 },
          { uri: uri('tests/cart.spec.ts'), line: -1 },
        ],
      });
      const places = [
        { file: 'tests/cart.spec.ts', line: 3 },
        { file: 'tests/pages/cart.page.ts', line: 30 },
      ];
      expect(await first.next('breakpoints')).toEqual({ type: 'breakpoints', places });
      later = new FakeWorker(channel.path).attach(channel.token, ref, 1);
      expect(await later.next('breakpoints')).toEqual({ type: 'breakpoints', places });

      await svc.client.sendNotification('piwi/setRunBreakpoints', { ref, places: [] });
      expect(await first.next('breakpoints', 1)).toEqual({ type: 'breakpoints', places: [] });
    } finally {
      first.socket.destroy();
      later?.socket.destroy();
    }
  });

  test('asks a stopped worker for an image of its page, and answers none when it is not stopped', async () => {
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path).attach(channel.token, ref, 0);
    try {
      worker.begin();
      await waitFor(() => svc.latest(ref)?.workers[0]?.test ?? undefined);
      const image = (what = 'image') =>
        svc.client.sendRequest('piwi/pausedPage', { ref, worker: 0, what }) as Promise<PausedPageResult>;
      expect(await image()).toEqual({ image: null });
      worker.stopAt(1, 30);
      await waitFor(() => (svc.latest(ref)?.workers[0]?.state === 'stopped' ? true : undefined));
      const asked = image();
      const request = await worker.next('request');
      expect(request).toEqual({ type: 'request', request: expect.any(Number), what: 'image' });
      worker.send({
        type: 'answer',
        request: request.request,
        what: 'image',
        value: { mime: 'image/jpeg', data: '/9j/4AAQ' },
      });
      expect(await asked).toEqual({ image: { mime: 'image/jpeg', data: '/9j/4AAQ' } });
      expect(await image('aria')).toEqual({ image: null });
    } finally {
      worker.socket.destroy();
    }
  });

  test('lets a worker that disconnects while stopped go, the request it did not answer answered with none', async () => {
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path).attach(channel.token, ref, 0);
    const other = new FakeWorker(channel.path).attach(channel.token, ref, 1);
    try {
      worker.begin();
      worker.stopAt(1, 30);
      await waitFor(() => (svc.latest(ref)?.workers[0]?.state === 'stopped' ? true : undefined));
      const asked = svc.client.sendRequest('piwi/pausedPage', { ref, worker: 0, what: 'image' });
      await worker.next('request');
      worker.socket.destroy();
      expect(await asked).toEqual({ image: null });
      await waitFor(() =>
        svc
          .latest(ref)
          ?.workers.map((w) => w.worker)
          .join() === '1'
          ? true
          : undefined,
      );
      expect(await control({ ref, action: 'step' })).toEqual({ ok: false, message: 'No test runs now.' });
    } finally {
      worker.socket.destroy();
      other.socket.destroy();
    }
  });

  test('takes a hand-off to the recorder beside a run connection on the same socket, and refuses a wrong token', async () => {
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path).attach(channel.token, ref, 0);
    const intruder = new FakeWorker(channel.path).attach('x'.repeat(32), ref, 5);
    const handoff = net.connect(channel.path);
    try {
      await waitFor(() => svc.latest(ref));
      await intruder.closed;
      expect(svc.latest(ref)!.workers.map((w) => w.worker)).toEqual([0]);
      const requested = new Promise<RecordRequested>((resolve) => {
        const listener = svc.client.onNotification('piwi/recordRequested', (params: RecordRequested) => {
          listener.dispose();
          resolve(params);
        });
      });
      handoff.write(
        `${JSON.stringify({
          type: 'attach',
          token: channel.token,
          file: path.join(dir, 'tests/cart.spec.ts'),
          line: 3,
          reason: 'breakpoint',
          testIdAttribute: null,
          baseURL: null,
        })}\n`,
      );
      expect(await requested).toMatchObject({ uri: uri('tests/cart.spec.ts'), line: 2, reason: 'breakpoint' });
      // The run connection is untouched.
      worker.begin();
      await waitFor(() => svc.latest(ref)?.workers[0]?.test ?? undefined);
    } finally {
      handoff.destroy();
      worker.socket.destroy();
      intruder.socket.destroy();
    }
  });
});

describe('a run’s session, with a client that does not answer stops', () => {
  let svc: Service;
  beforeAll(async () => {
    svc = await service(false);
  });
  afterAll(() => svc.stop());

  test('resumes a stop no pause bar shows at once, and says so once a run', async () => {
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path).attach(channel.token, ref, 0);
    try {
      worker.begin();
      worker.stopAt(1, 30);
      expect(await worker.next('control')).toEqual({ type: 'control', action: 'resume', stop: 1 });
      expect(await waitFor(() => svc.notices[0])).toEqual({
        root: dir,
        severity: 'information',
        message:
          'Piwi resumed the test stopped at cart.page.ts:30: no pause bar shows in a headless browser, and this ' +
          'editor does not show where a run stops. Run it headed to pause there.',
      });
      worker.send({ type: 'running', stop: 1 });
      worker.stopAt(2, 31);
      expect(await worker.next('control', 1)).toEqual({ type: 'control', action: 'resume', stop: 2 });
      // A stop the bar shows is the page's to answer.
      worker.send({ type: 'running', stop: 2 });
      worker.stopAt(3, 32, true);
      await waitFor(() => (svc.latest(ref)?.workers[0]?.stop?.line === 31 ? true : undefined));
      await new Promise((r) => setTimeout(r, 100));
      expect(worker.heard.filter((m) => m.type === 'control')).toHaveLength(2);
      expect(svc.notices).toHaveLength(1);
    } finally {
      worker.socket.destroy();
    }
  });
});

describe('RunSessions', () => {
  /** A worker's socket, as the session uses it. */
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

  test('ends a run a while after its last worker left, unless another connects, and paces the other changes', async () => {
    const sent: RunSession[] = [];
    const sessions = new RunSessions({
      notify: (session) => void sent.push(session),
      answersStops: () => true,
      notice: () => {},
      rootOf: () => '/work/shop',
      paceMs: 50,
      lingerMs: 100,
    });
    const attach = (workerIndex: number) => {
      const socket = fakeSocket();
      const read = sessions.attach(socket as unknown as net.Socket, {
        type: 'run-attach',
        token: 't',
        ref: 'ed-1',
        cwd: '/work/shop',
        workerIndex,
        parallelIndex: 0,
        pid: 1,
        playwright: '',
        reporter: '',
      });
      return { socket, read };
    };
    const first = attach(0);
    const line = (message: RunToHub) => JSON.stringify(message);
    first.read(
      line({
        type: 'test-begin',
        testId: 'a',
        title: ['a'],
        file: 'tests/a.spec.ts',
        line: 1,
        project: '',
        retry: 0,
        cannotPause: null,
      }),
    );
    first.read(line({ type: 'test-end', testId: 'a', status: 'passed', pausedMs: 0 }));
    // The attach, the test and its end come together, at the pace.
    expect(sent).toEqual([]);
    await waitFor(() => sent[0]);
    expect(sent.map((s) => s.workers.map((w) => w.state))).toEqual([['between']]);

    first.socket.destroy();
    await waitFor(() => (last(sent)?.workers.length === 0 ? true : undefined));
    // Playwright starts a new worker after a failure: the run goes on.
    await new Promise((r) => setTimeout(r, 50));
    const second = attach(1);
    second.socket.destroy();
    await waitFor(() => (last(sent)?.ended ? true : undefined), 2000);
    expect(last(sent)).toEqual({ ref: 'ed-1', root: '/work/shop', workers: [], ended: true });
    expect(sent.filter((s) => s.ended)).toHaveLength(1);

    // A later worker of the same ref, a rerun of the command, starts a new session.
    const rerun = attach(0);
    await waitFor(() => (last(sent)?.ended === false ? true : undefined));
    sessions.dispose();
    expect(rerun.socket.destroyed).toBe(true);
  });
});
