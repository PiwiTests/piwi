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
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RUN_TAKES, type RunToHub } from '@piwitests/core/run-channel';
import { RunSessions } from '../src/run-sessions';
import { parseRecordChannel } from '@piwitests/core/ide-recorder';
import type { PausedPageResult, RecordRequested, RunCommand, RunControlResult, RunSession } from '../src/protocol';
import { FakeWorker, last, service as startService, waitFor, writeRunWorkspace, type Service } from './run-fixtures';

let dir = '';
const uri = (file: string) => pathToFileURL(path.join(dir, file)).href;
const service = (runControl: boolean) => startService(dir, runControl);

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-sessions-')));
  writeRunWorkspace(dir);
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

  test('holds a headless failure in a run started with the editor’s breakpoints, and lets one of a plain run go', async () => {
    const failed = (worker: FakeWorker) =>
      worker.send({
        type: 'stopped',
        stop: 1,
        reason: 'failure',
        title: 'Failed: Timed out',
        place: { file: 'tests/cart.spec.ts', line: 3, column: 1 },
        locator: null,
        bar: false,
      });
    const plain = await svc.command();
    const quiet = new FakeWorker(plain.channel.path, dir).attach(plain.channel.token, plain.ref, 0);
    const debugged = (await svc.client.sendRequest('piwi/runArgs', {
      uri: uri('tests/cart.spec.ts'),
      testIds: [],
      locations: ['tests/cart.spec.ts:3'],
      breakpoints: [{ uri: uri('tests/cart.spec.ts'), line: 2 }],
    })) as RunCommand;
    const channel = parseRecordChannel(debugged.env?.PIWI_RUN_CHANNEL)!;
    const watched = new FakeWorker(channel.path, dir).attach(channel.token, debugged.ref!, 0);
    try {
      expect(debugged.args).toContain('--headed');
      quiet.begin();
      failed(quiet);
      expect(await quiet.next('control')).toEqual({ type: 'control', action: 'resume', stop: 1 });
      watched.begin();
      failed(watched);
      await waitFor(() => svc.latest(debugged.ref!)?.workers[0]?.stop ?? undefined);
      await new Promise((r) => setTimeout(r, 100));
      expect(watched.heard.filter((m) => m.type === 'control')).toEqual([]);
    } finally {
      quiet.socket.destroy();
      watched.socket.destroy();
    }
  });

  test('takes a run started in a terminal on the channel its discovery file names, with the editor’s breakpoints', async () => {
    const discovery = await waitFor(() => last(svc.published) ?? undefined);
    const channel = discovery.runChannel!;
    await svc.client.sendNotification('piwi/setBreakpoints', { places: [{ uri: uri('tests/cart.spec.ts'), line: 2 }] });
    // Once the service read it.
    await control({ ref: 'none', action: 'pause' });
    const ref = 'terminal-4242-1730000000000';
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0, [...RUN_TAKES]);
    try {
      expect(await worker.next('breakpoints')).toEqual({
        type: 'breakpoints',
        places: [{ file: 'tests/cart.spec.ts', line: 3 }],
      });
      // Nobody follows the runs in Piwi Picker: it holds no failure.
      expect(worker.heard[0]).toEqual({ type: 'attached', holds: [] });
      expect(await waitFor(() => svc.latest(ref))).toMatchObject({ ref, root: dir, terminal: true });
      worker.begin();
      worker.stopAt(1, 3);
      await waitFor(() => svc.latest(ref)?.workers[0]?.stop ?? undefined);
      expect(await control({ ref, action: 'end' })).toEqual({
        ok: true,
        message: 'Ending the test: it is reported as skipped.',
      });
      expect(await worker.next('control')).toEqual({ type: 'control', action: 'end', stop: 1 });
    } finally {
      worker.socket.destroy();
    }
    // A run the editor built is none, whatever its ref.
    const own = await svc.command();
    const ownWorker = new FakeWorker(own.channel.path, dir).attach(own.channel.token, own.ref, 0);
    try {
      expect((await waitFor(() => svc.latest(own.ref))).terminal).toBeUndefined();
    } finally {
      ownWorker.socket.destroy();
    }
  });

  test('stops at a statement broken over lines, by a breakpoint or Run to cursor on its first line', async () => {
    fs.writeFileSync(
      path.join(dir, 'tests/wrapped.spec.ts'),
      [
        "import { test, expect } from '@playwright/test';",
        '',
        "test('shows the cart', async ({ page }) => {",
        '  await expect(',
        "    page.getByRole('heading', { name: 'Cart' }),",
        '  ).toBeVisible();',
        '});',
        '',
      ].join('\n'),
    );
    const atFirstLine = { uri: uri('tests/wrapped.spec.ts'), line: 3 };
    const started = (await svc.client.sendRequest('piwi/runArgs', {
      uri: uri('tests/wrapped.spec.ts'),
      testIds: [],
      locations: ['tests/wrapped.spec.ts:3'],
      breakpoints: [atFirstLine],
    })) as RunCommand;
    expect(started.env?.PIWI_PAUSE_AT).toBe('tests/wrapped.spec.ts:4;tests/wrapped.spec.ts:5;tests/wrapped.spec.ts:6');
    const discovery = await waitFor(() => last(svc.published) ?? undefined);
    const channel = discovery.runChannel!;
    await svc.client.sendNotification('piwi/setBreakpoints', { places: [atFirstLine] });
    // Once the service read it.
    await control({ ref: 'none', action: 'pause' });
    const ref = 'terminal-4243-1730000000001';
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0, [...RUN_TAKES]);
    try {
      // Playwright stops at `toBeVisible`, on the statement's third line.
      expect(await worker.next('breakpoints')).toEqual({
        type: 'breakpoints',
        places: [4, 5, 6].map((line) => ({ file: 'tests/wrapped.spec.ts', line })),
      });
      worker.begin();
      worker.stopAt(1, 3);
      await waitFor(() => svc.latest(ref)?.workers[0]?.stop ?? undefined);
      expect(await control({ ref, action: 'run-to', place: atFirstLine })).toEqual({
        ok: true,
        message: 'Running to wrapped.spec.ts:4.',
      });
      expect(await worker.next('run-to')).toEqual({
        type: 'run-to',
        stop: 1,
        place: { file: 'tests/wrapped.spec.ts', line: 6 },
      });
    } finally {
      worker.socket.destroy();
      await svc.client.sendNotification('piwi/setBreakpoints', { places: [] });
    }
  });

  test('shares a run live through piwi/shareRun, the client hearing how it stands', async () => {
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0, [...RUN_TAKES]);
    const page = 'http://127.0.0.1:7494/test-runs/5';
    worker.send({ type: 'live', can: true, on: false, viewers: 0, page, why: null });
    await waitFor(() => svc.latest(ref)?.live);
    const shared = (await svc.client.sendRequest('piwi/shareRun', { ref, on: true })) as RunControlResult;
    expect(shared).toMatchObject({ ok: true, message: expect.stringContaining('127.0.0.1:7494') });
    expect(await worker.next('share')).toEqual({ type: 'share', on: true });
    worker.send({ type: 'live', can: true, on: true, viewers: 0, page, why: null });
    await waitFor(() => (svc.latest(ref)?.live?.shared ? true : undefined));
    worker.socket.destroy();
  });

  test('names the run channel beside the record channel, the same socket', async () => {
    const { command } = await svc.command();
    expect(command.env?.PIWI_RUN_CHANNEL).toBeTruthy();
    expect(command.env?.PIWI_RUN_CHANNEL).toBe(command.env?.PIWI_RECORD_CHANNEL);
  });

  test('files a worker under its run, and tells the client as it starts a test, stops, goes on and ends it', async () => {
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 3);
    try {
      expect(await waitFor(() => svc.latest(ref))).toEqual({
        ref,
        root: dir,
        workers: [
          {
            worker: 3,
            parallelIndex: 3,
            state: 'between',
            test: null,
            stop: null,
            pausing: false,
            takes: ['pick', 'record'],
          },
        ],
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
    const first = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0);
    const second = new FakeWorker(channel.path, dir).attach(channel.token, ref, 1);
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
      await waitFor(() => (svc.latest(ref)!.workers[0]!.pausing ? true : undefined));
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
      // A control naming the stop it answers picks that worker among several, and reaches none past it.
      const since = svc.latest(ref)!.workers[0]!.stop!.since;
      expect(await control({ ref, action: 'finish', since })).toEqual({
        ok: true,
        message: 'Finishing the test without stopping at a breakpoint.',
      });
      expect(await first.next('control', 3)).toEqual({ type: 'control', action: 'finish', stop: 4 });
      expect(await control({ ref, worker: 0, action: 'resume', since: '2026-01-01T00:00:00.000Z' })).toEqual({
        ok: false,
        message: 'The test went on.',
      });
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
    const first = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0);
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
      later = new FakeWorker(channel.path, dir).attach(channel.token, ref, 1);
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
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0);
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
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0);
    const other = new FakeWorker(channel.path, dir).attach(channel.token, ref, 1);
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

  test('names each stop apart, so a second Resume for a stop the worker went past reaches nothing', async () => {
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0);
    try {
      worker.begin();
      worker.stopAt(1, 30);
      const first = await waitFor(() => svc.latest(ref)?.workers[0]?.stop ?? undefined);
      expect(await control({ ref, action: 'resume', since: first.since })).toEqual({ ok: true, message: 'Resuming.' });
      // The worker goes on and stops again at once: the client still shows the first stop when its key repeats.
      worker.send({ type: 'running', stop: 1 });
      worker.stopAt(2, 31);
      const second = await waitFor(() =>
        svc.latest(ref)?.workers[0]?.stop?.line === 30 ? svc.latest(ref)!.workers[0]!.stop! : undefined,
      );
      expect(second.since > first.since).toBe(true);
      expect(await control({ ref, action: 'resume', since: first.since })).toEqual({
        ok: false,
        message: 'The test went on.',
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(worker.heard.filter((m) => m.type === 'control')).toEqual([
        { type: 'control', action: 'resume', stop: 1 },
      ]);
    } finally {
      worker.socket.destroy();
    }
  });

  test('ends a stop the worker ended unanswered, the test ending or its page closing, and refuses a control naming it', async () => {
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0);
    try {
      worker.begin();
      worker.stopAt(1, 30, true);
      const stop = await waitFor(() => svc.latest(ref)?.workers[0]?.stop ?? undefined);
      worker.send({ type: 'running', stop: 1 });
      await waitFor(() => (svc.latest(ref)?.workers[0]?.state === 'running' ? true : undefined));
      expect(svc.latest(ref)!.workers[0]!.stop).toBeNull();
      expect(await control({ ref, action: 'step', since: stop.since })).toEqual({
        ok: false,
        message: 'The test went on.',
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(worker.heard.filter((m) => m.type === 'control' || m.type === 'run-to')).toEqual([]);
    } finally {
      worker.socket.destroy();
    }
  });

  test('sends a burst of stops and goings-on as a few notifications, the last one as it stands', async () => {
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0);
    try {
      worker.begin();
      await waitFor(() => svc.latest(ref)?.workers[0]?.test ?? undefined);
      const before = svc.sessions.length;
      for (let stop = 1; stop <= 500; stop++) {
        worker.stopAt(stop, 30);
        worker.send({ type: 'running', stop });
      }
      worker.stopAt(501, 33);
      // The burst's stops at line 30 may be heard on the way: the last one, at line 33, is heard last.
      await waitFor(() => (svc.latest(ref)?.workers[0]?.stop?.line === 32 ? true : undefined));
      await new Promise((r) => setTimeout(r, 150));
      expect(svc.sessions.length - before).toBeLessThan(20);
      expect(svc.latest(ref)!.workers[0]!.state).toBe('stopped');
    } finally {
      worker.socket.destroy();
    }
  });

  test('reads nothing more of a connection it refused, the lines of the same chunk included', async () => {
    const { ref, channel } = await svc.command();
    const socket = net.connect(channel.path);
    socket.on('error', () => {});
    try {
      const attach = (token: string): RunToHub => ({
        type: 'run-attach',
        token,
        ref,
        cwd: dir,
        workerIndex: 0,
        parallelIndex: 0,
        pid: process.pid,
        playwright: '',
        reporter: '',
        takes: [],
      });
      socket.write(`${JSON.stringify(attach('x'.repeat(32)))}\n${JSON.stringify(attach(channel.token))}\n`);
      await new Promise((resolve) => socket.on('close', resolve));
      await new Promise((r) => setTimeout(r, 400));
      expect(svc.latest(ref)).toBeUndefined();
    } finally {
      socket.destroy();
    }
  });

  test('takes a hand-off to the recorder beside a run connection on the same socket, and refuses a wrong token', async () => {
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0);
    const intruder = new FakeWorker(channel.path, dir).attach('x'.repeat(32), ref, 5);
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
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0);
    try {
      worker.begin();
      worker.stopAt(1, 30);
      expect(await worker.next('control')).toEqual({ type: 'control', action: 'resume', stop: 1 });
      expect(await waitFor(() => svc.notices[0])).toEqual({
        root: dir,
        severity: 'information',
        message:
          'Piwi resumed the test stopped at cart.page.ts:30: no pause bar shows in a headless browser, and neither ' +
          'this editor nor Piwi Picker shows where a run stops. Run it headed to pause there.',
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
      lingerMs: 300,
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
        takes: [],
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

  /** The sessions with a fake socket per worker of `ed-1`, and what the client heard. */
  function harness(options: Partial<ConstructorParameters<typeof RunSessions>[0]> = {}) {
    const sent: RunSession[] = [];
    const sessions = new RunSessions({
      notify: (session) => void sent.push(session),
      answersStops: () => true,
      notice: () => {},
      rootOf: () => '/work/shop',
      paceMs: 10,
      lingerMs: 5_000,
      ...options,
    });
    const attach = (workerIndex: number, extra: Partial<Extract<RunToHub, { type: 'run-attach' }>> = {}) => {
      const socket = fakeSocket();
      const read = sessions.attach(socket as unknown as net.Socket, {
        type: 'run-attach',
        token: 't',
        ref: 'ed-1',
        cwd: '/work/shop',
        workerIndex,
        parallelIndex: workerIndex,
        pid: 1,
        playwright: '',
        reporter: '',
        takes: [],
        ...extra,
      });
      return { socket, read: (message: RunToHub) => read(JSON.stringify(message)) };
    };
    return { sent, sessions, attach };
  }

  test('gives a new follower each run as the client last heard it, so both hear the changes after it alike', async () => {
    const { sent, sessions, attach } = harness({ burstMs: 200 });
    const worker = attach(0);
    const state = (session: RunSession | undefined) => session?.workers[0]?.state;
    worker.read({
      type: 'test-begin',
      testId: 'a',
      title: ['a'],
      file: 'tests/a.spec.ts',
      line: 1,
      project: '',
      retry: 0,
      cannotPause: null,
    });
    await waitFor(() => (state(last(sent)) === 'running' ? true : undefined));
    const stopped = (stop: number) =>
      worker.read({
        type: 'stopped',
        stop,
        reason: 'breakpoint',
        title: 'Click',
        place: { file: 'tests/a.spec.ts', line: stop + 1 },
        locator: null,
        bar: true,
      });
    stopped(1);
    await waitFor(() => (state(last(sent)) === 'stopped' ? true : undefined));
    worker.read({ type: 'running', stop: 1 });
    // The client heard the test run again; the next stop waits for the next burst.
    await waitFor(() => (state(last(sent)) === 'running' ? true : undefined));
    const heard = sent.length;
    stopped(2);
    // Piwi Picker subscribes now: it is given the run as the client heard it, not the stop on its way.
    const followed = sessions.current();
    expect(followed).toEqual([last(sent)]);
    worker.read({ type: 'running', stop: 2 });
    await new Promise((r) => setTimeout(r, 300));
    // The stop and its end came within one burst: neither the client nor the follower hears either.
    expect(sent).toHaveLength(heard);
    expect(sessions.current()).toEqual(followed);
    expect(state(followed[0])).toBe('running');
    sessions.dispose();
  });

  test('gives no follower a run the client has not heard of yet', () => {
    const { sessions, attach } = harness({ paceMs: 1000 });
    attach(0);
    expect(sessions.current()).toEqual([]);
    sessions.dispose();
  });

  test('refuses a second process naming a worker connected now, and lets a rerun’s worker start a session', async () => {
    const { sent, sessions, attach } = harness();
    const live = attach(0).socket;
    await waitFor(() => sent[0]);
    // A test running Playwright itself, in the run's environment.
    const nested = attach(0).socket;
    await new Promise((r) => setTimeout(r, 20));
    expect(nested.destroyed).toBe(true);
    expect(live.destroyed).toBe(false);
    expect(last(sent)?.workers.map((w) => w.worker)).toEqual([0]);
    // The command ended: its worker's connection closes with the run, and a rerun's worker of that index is taken.
    sessions.commandEnded('ed-1');
    expect(live.destroyed).toBe(true);
    expect(last(sent)?.ended).toBe(true);
    const rerun = attach(0).socket;
    await waitFor(() => (last(sent)?.ended === false ? true : undefined));
    expect(rerun.destroyed).toBe(false);
    sessions.dispose();
  });

  test('tells a worker that holds a failure only for a service that shows it that this one does, and an older one nothing', async () => {
    const { sessions, attach } = harness();
    const heard = (socket: ReturnType<typeof fakeSocket>) => socket.written.map((line) => JSON.parse(line));
    expect(heard(attach(0, { holds: ['failure'] }).socket)).toEqual([{ type: 'attached', holds: ['failure'] }]);
    expect(heard(attach(1, { holds: [] }).socket)).toEqual([{ type: 'attached', holds: [] }]);
    // A reporter that predates the capability lists none, and hears no message it would not know.
    expect(heard(attach(2).socket)).toEqual([]);
    sessions.dispose();
  });

  test('starts a rerun’s code from the files as they stand: a session of a ref whose command ended before', async () => {
    const started: Array<{ ref: string; again: boolean }> = [];
    const { sent, sessions, attach } = harness({ sessionStarted: (ref, again) => void started.push({ ref, again }) });
    const first = attach(0).socket;
    await waitFor(() => sent[0]);
    expect(started).toEqual([{ ref: 'ed-1', again: false }]);
    // A worker leaving and another joining within the run is the same session.
    first.destroy();
    attach(1);
    expect(started).toHaveLength(1);
    // The command ended; its rerun, under the same ref, starts a session of its own.
    sessions.commandEnded('ed-1');
    attach(0);
    expect(started).toEqual([
      { ref: 'ed-1', again: false },
      { ref: 'ed-1', again: true },
    ]);
    sessions.dispose();
  });

  /** A worker of `ed-1` that takes every action, and the controls it was sent. */
  function takingWorker(sessions: RunSessions) {
    const socket = fakeSocket();
    const read = sessions.attach(socket as unknown as net.Socket, {
      type: 'run-attach',
      token: 't',
      ref: 'ed-1',
      cwd: '/work/shop',
      workerIndex: 0,
      parallelIndex: 0,
      pid: 1,
      playwright: '',
      reporter: '',
      takes: [...RUN_TAKES],
    });
    const controls = () => socket.written.map((line) => JSON.parse(line)).filter((m) => m.type === 'control');
    const fail = (stop: number, bar = false) =>
      read(
        JSON.stringify({
          type: 'stopped',
          stop,
          reason: 'failure',
          title: 'Failed: Timed out',
          place: { file: 'tests/a.spec.ts', line: 4, column: 5 },
          locator: null,
          bar,
        } satisfies RunToHub),
      );
    return { controls, fail };
  }

  test('holds a failure no bar shows only in a run started to be watched, or while a Runs window follows the runs', async () => {
    let watched = false;
    let followed = false;
    const notices: string[] = [];
    const { sessions, sent } = harness({
      watched: () => watched,
      followed: () => followed,
      notice: (_root, _severity, message) => void notices.push(message),
    });
    const worker = takingWorker(sessions);
    // A plain run of a client that answers stops: the failure goes on at once, shown and said to nobody.
    worker.fail(1);
    expect(worker.controls()).toEqual([{ type: 'control', action: 'resume', stop: 1 }]);
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.some((s) => s.workers.some((w) => w.stop))).toBe(false);
    // One the bar shows waits for its answer there.
    worker.fail(2, true);
    expect(worker.controls()).toHaveLength(1);
    // A run started with breakpoints, or followed in a Runs window, holds it.
    watched = true;
    worker.fail(3);
    watched = false;
    followed = true;
    worker.fail(4);
    expect(worker.controls()).toHaveLength(1);
    // The last Runs window closes: the failure it held goes on.
    followed = false;
    sessions.surfacesChanged();
    expect(worker.controls()).toEqual([
      { type: 'control', action: 'resume', stop: 1 },
      { type: 'control', action: 'resume', stop: 4 },
    ]);
    expect(notices).toEqual([]);
    sessions.dispose();
  });

  test('holds no failure in a run its host says holds none, whoever watches it, and tells its workers so', () => {
    const { sessions, attach } = harness({
      watched: () => true,
      followed: () => true,
      holdsFailures: (ref) => ref !== 'lab-1',
      host: 'the desktop app',
    });
    const lines = (socket: ReturnType<typeof fakeSocket>) => socket.written.map((line) => JSON.parse(line));
    const controls = (socket: ReturnType<typeof fakeSocket>) => lines(socket).filter((m) => m.type === 'control');
    const lab = attach(0, { ref: 'lab-1', holds: ['failure'] });
    const plain = attach(0, { ref: 'ed-1', holds: ['failure'] });
    // Each worker hears what it holds, and what the host is called.
    expect(lines(lab.socket)).toEqual([{ type: 'attached', holds: [], host: 'the desktop app' }]);
    expect(lines(plain.socket)).toEqual([{ type: 'attached', holds: ['failure'], host: 'the desktop app' }]);
    const failure: RunToHub = {
      type: 'stopped',
      stop: 1,
      reason: 'failure',
      title: 'Failed: Timed out',
      place: { file: 'tests/a.spec.ts', line: 4, column: 5 },
      locator: null,
      bar: false,
    };
    // A failure that stops the lab's worker anyway goes on at once; the watched run's waits, and keeps waiting.
    lab.read(failure);
    plain.read(failure);
    expect(controls(lab.socket)).toEqual([{ type: 'control', action: 'resume', stop: 1 }]);
    sessions.surfacesChanged();
    expect(controls(plain.socket)).toEqual([]);
    sessions.dispose();
  });

  test('offers Piwi Picker the actions that write code only while the client writes it', () => {
    let writes = false;
    const { sessions } = harness({ writesCode: () => writes });
    takingWorker(sessions);
    expect(sessions.intentsOf('ed-1', 0)).toEqual([
      'pick',
      'record',
      'view',
      'input',
      'input-clicks',
      'pick-at',
      'end',
    ]);
    writes = true;
    expect(sessions.intentsOf('ed-1', 0)).toEqual([
      'pick',
      'record',
      'assert',
      'assert-region',
      'mock',
      'view',
      'input',
      'input-clicks',
      'pick-at',
      'end',
    ]);
    sessions.dispose();
  });

  test('ends the test at a stop for a worker that takes it, saying what comes of a failure, and offers it so', () => {
    const { sessions, attach } = harness();
    const controls = (socket: ReturnType<typeof fakeSocket>) =>
      socket.written.map((line) => JSON.parse(line)).filter((m) => m.type === 'control');
    const stopped = (reason: 'breakpoint' | 'failure', stop: number): RunToHub => ({
      type: 'stopped',
      stop,
      reason,
      title: reason === 'failure' ? 'Failed: Timed out' : "Click getByText('Add')",
      place: { file: 'tests/a.spec.ts', line: 4, column: 5 },
      locator: null,
      bar: true,
    });
    const worker = attach(0, { takes: [...RUN_TAKES] });
    worker.read(stopped('breakpoint', 1));
    expect(sessions.stopIntentsOf('ed-1', 0, null)).toContain('end');
    expect(sessions.control({ ref: 'ed-1', action: 'end' })).toEqual({
      ok: true,
      message: 'Ending the test: it is reported as skipped.',
    });
    worker.read({ type: 'running', stop: 1 });
    worker.read(stopped('failure', 2));
    // At a failure, Resume ends it as it failed: no End is offered, and one sent ends it so.
    expect(sessions.stopIntentsOf('ed-1', 0, null)).not.toContain('end');
    expect(sessions.control({ ref: 'ed-1', action: 'end' })).toEqual({
      ok: true,
      message: 'The test failed already: it ends as it failed.',
    });
    expect(controls(worker.socket)).toEqual([
      { type: 'control', action: 'end', stop: 1 },
      { type: 'control', action: 'end', stop: 2 },
    ]);
    // A reporter that predates it is asked nothing.
    const older = attach(1, { ref: 'ed-2', takes: RUN_TAKES.filter((take) => take !== 'end') });
    older.read(stopped('breakpoint', 1));
    expect(sessions.intentsOf('ed-2', 1)).not.toContain('end');
    expect(sessions.control({ ref: 'ed-2', action: 'end' })).toEqual({
      ok: false,
      message: '@piwitests/reporter cannot end a test: update it.',
    });
    expect(controls(older.socket)).toEqual([]);
    sessions.dispose();
  });

  test('shares a run live as a person asks, a worker that connects later following, and says why one cannot be', async () => {
    const notices: string[] = [];
    const { sessions, attach } = harness({ notice: (_root, _severity, message) => void notices.push(message) });
    const shares = (socket: ReturnType<typeof fakeSocket>) =>
      socket.written.map((line) => JSON.parse(line)).filter((m) => m.type === 'share');
    const page = 'https://piwi.example.com/test-runs/42';
    const ready = { type: 'live', can: true, on: false, viewers: 0, page, why: null } as const;
    const first = attach(0, { takes: [...RUN_TAKES] });
    expect(sessions.share({ ref: 'ed-1', on: true })).toEqual({
      ok: false,
      message: "The run's workers have not said yet whether it can be shared live: try again in a moment.",
    });
    first.read(ready);
    const live = () => sessions.current().find((s) => s.ref === 'ed-1')?.live;
    await waitFor(() => (live() ? true : undefined));
    expect(live()).toEqual({ shared: false, refused: null, stopped: null, page, viewers: 0 });

    expect(sessions.share({ ref: 'ed-1', on: true })).toEqual({
      ok: true,
      message:
        "Sharing the run live on piwi.example.com: whoever may open it there can watch its tests' pages while someone does.",
    });
    expect(shares(first.socket)).toEqual([{ type: 'share', on: true }]);
    first.read({ ...ready, on: true, viewers: 2 });
    // A worker Playwright starts later shares too, and the viewers of both are counted.
    const second = attach(1, { takes: [...RUN_TAKES] });
    expect(shares(second.socket)).toEqual([{ type: 'share', on: true }]);
    second.read({ ...ready, on: true, viewers: 1 });
    await waitFor(() => (live()?.viewers === 3 ? true : undefined));
    expect(live()).toEqual({ shared: true, refused: null, stopped: null, page, viewers: 3 });

    // A stream the instance stopped answering stops that worker's sharing: the run stays shared while another streams,
    // and stops with the last, said once, Share live offered again.
    const lost = 'Sharing stopped: the instance did not answer.';
    second.read({ ...ready, why: lost });
    await waitFor(() => (live()?.viewers === 2 ? true : undefined));
    expect(live()).toMatchObject({ shared: true, stopped: null });
    first.read({ ...ready, why: lost });
    second.read({ ...ready, why: lost });
    await waitFor(() => (live()?.shared === false ? true : undefined));
    expect(live()).toEqual({ shared: false, refused: null, stopped: lost, page, viewers: 0 });
    expect(notices).toEqual([lost]);
    expect(sessions.share({ ref: 'ed-1', on: true })).toMatchObject({ ok: true });
    first.read({ ...ready, on: true });
    await waitFor(() => (live()?.shared ? true : undefined));
    expect(live()).toMatchObject({ shared: true, stopped: null });

    expect(sessions.share({ ref: 'ed-1', on: false })).toEqual({
      ok: true,
      message: 'Stopped sharing the run: nothing more goes to piwi.example.com.',
    });
    first.read(ready);
    await waitFor(() => (live()?.shared === false ? true : undefined));
    expect(shares(first.socket)).toEqual([
      { type: 'share', on: true },
      { type: 'share', on: true },
      { type: 'share', on: false },
    ]);
    const third = attach(2, { takes: [...RUN_TAKES] });
    expect(shares(third.socket)).toEqual([{ type: 'share', on: false }]);

    // A run whose workers hold no key says why, and is not shared.
    const unshareable = attach(0, { ref: 'ed-2', takes: [...RUN_TAKES] });
    const why = "This run cannot be shared live: its project's live view is off on the instance.";
    unshareable.read({ type: 'live', can: false, on: false, viewers: 0, page: null, why });
    expect(sessions.share({ ref: 'ed-2', on: true })).toEqual({ ok: false, message: why });
    expect(shares(unshareable.socket)).toEqual([]);
    await waitFor(() => (sessions.current().find((s) => s.ref === 'ed-2')?.live ? true : undefined));
    expect(sessions.current().find((s) => s.ref === 'ed-2')?.live).toEqual({
      shared: false,
      refused: why,
      stopped: null,
      page: null,
      viewers: 0,
    });

    // A reporter that predates it says nothing of it, and is asked nothing.
    const older = attach(0, { ref: 'ed-3', takes: RUN_TAKES.filter((take) => take !== 'share') });
    expect(sessions.share({ ref: 'ed-3', on: true })).toEqual({
      ok: false,
      message: '@piwitests/reporter cannot share a run live: update it.',
    });
    expect(shares(older.socket)).toEqual([]);
    expect(sessions.share({ ref: 'ed-9', on: true })).toMatchObject({ ok: false });
    sessions.dispose();
  });

  test('stops sharing a run while no worker of it is connected, and the next worker hears it', async () => {
    const { sessions, attach } = harness();
    const shares = (socket: ReturnType<typeof fakeSocket>) =>
      socket.written.map((line) => JSON.parse(line)).filter((m) => m.type === 'share');
    const page = 'https://piwi.example.com/test-runs/7';
    const ready = { type: 'live', can: true, on: false, viewers: 0, page, why: null } as const;
    const live = () => sessions.current().find((s) => s.ref === 'ed-1')?.live;
    const first = attach(0, { takes: [...RUN_TAKES] });
    first.read(ready);
    expect(sessions.share({ ref: 'ed-1', on: true })).toMatchObject({ ok: true });
    first.read({ ...ready, on: true });
    await waitFor(() => (live()?.shared ? true : undefined));
    // Its test failed: Playwright ends the worker and starts another, which has not connected yet.
    first.socket.destroy();
    await waitFor(() => (sessions.current().find((s) => s.ref === 'ed-1')?.workers.length === 0 ? true : undefined));
    expect(sessions.share({ ref: 'ed-1', on: false })).toEqual({
      ok: true,
      message: 'Stopped sharing the run: nothing more goes to piwi.example.com.',
    });
    await waitFor(() => (live()?.shared === false ? true : undefined));
    // Sharing again waits for a worker; the one that connects next does not share.
    expect(sessions.share({ ref: 'ed-1', on: true })).toMatchObject({ ok: false });
    const second = attach(1, { takes: [...RUN_TAKES] });
    expect(shares(second.socket)).toEqual([{ type: 'share', on: false }]);
    sessions.dispose();
  });

  test('says once a run, not once a worker, that its sharing stopped though nobody asked', async () => {
    const notices: string[] = [];
    const { sessions, attach } = harness({ notice: (_root, _severity, message) => void notices.push(message) });
    const page = 'https://piwi.example.com/test-runs/7';
    const ready = { type: 'live', can: true, on: false, viewers: 0, page, why: null } as const;
    const workers = [0, 1, 2].map((index) => attach(index, { takes: [...RUN_TAKES] }));
    for (const worker of workers) worker.read(ready);
    expect(sessions.share({ ref: 'ed-1', on: true })).toMatchObject({ ok: true });
    for (const worker of workers) worker.read({ ...ready, on: true });
    // The instance started again: none of the workers' streams is taken any more.
    const why = "Sharing stopped: the instance no longer takes this run's live view key.";
    for (const worker of workers) worker.read({ type: 'live', can: false, on: false, viewers: 0, page, why });
    expect(notices).toEqual([why]);
    const live = () => sessions.current().find((s) => s.ref === 'ed-1')?.live;
    await waitFor(() => (live()?.stopped ? true : undefined));
    expect(live()).toEqual({ shared: false, refused: why, stopped: why, page, viewers: 0 });
    sessions.dispose();
  });

  test('takes a run started in a terminal, with the editor’s breakpoints as it starts and no failure held unfollowed', async () => {
    let followed = false;
    const { sessions, sent, attach } = harness({
      terminal: (ref) => ref.startsWith('terminal-'),
      followed: () => followed,
      lingerMs: 20,
    });
    const lines = (socket: ReturnType<typeof fakeSocket>) => socket.written.map((line) => JSON.parse(line));
    sessions.setEditorBreakpoints({
      places: [
        { uri: pathToFileURL('/work/shop/tests/a.spec.ts').href, line: 3 },
        { uri: pathToFileURL('/elsewhere/b.spec.ts').href, line: 1 },
      ],
    });
    const first = attach(0, { ref: 'terminal-41-1', holds: ['failure'] });
    expect(lines(first.socket)).toEqual([
      { type: 'attached', holds: [] },
      { type: 'breakpoints', places: [{ file: 'tests/a.spec.ts', line: 4 }] },
    ]);
    const shown = await waitFor(() => sent.find((s) => s.ref === 'terminal-41-1'));
    expect(shown).toMatchObject({ ref: 'terminal-41-1', terminal: true });
    // The run's lines are the files as it started: later breakpoints of the editor reach the runs that start later.
    sessions.setEditorBreakpoints({ places: [{ uri: pathToFileURL('/work/shop/tests/a.spec.ts').href, line: 9 }] });
    followed = true;
    const second = attach(1, { ref: 'terminal-41-1', holds: ['failure'] });
    expect(lines(second.socket)).toEqual([
      { type: 'attached', holds: ['failure'] },
      { type: 'breakpoints', places: [{ file: 'tests/a.spec.ts', line: 4 }] },
    ]);
    // A terminal's run is no test runner's.
    expect(shown).not.toHaveProperty('runner');
    // A run the editor's own test runner started is one too, which its workers say.
    attach(0, { ref: 'terminal-42-1', runner: true });
    expect(await waitFor(() => sent.find((s) => s.ref === 'terminal-42-1'))).toMatchObject({
      terminal: true,
      runner: true,
    });
    // A run the editor started is none, whatever its workers say of a test runner.
    attach(0, { ref: 'ed-1', runner: true });
    const own = await waitFor(() => sent.find((s) => s.ref === 'ed-1'));
    expect(own.terminal).toBeUndefined();
    expect(own).not.toHaveProperty('runner');
    // It ends a while after its last worker left: no command of the editor's ends it.
    first.socket.destroy();
    second.socket.destroy();
    expect(await waitFor(() => sent.find((s) => s.ref === 'terminal-41-1' && s.ended))).toMatchObject({
      terminal: true,
      ended: true,
    });
    sessions.dispose();
  });
});
