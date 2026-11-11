/**
 * How far a run is, as its own process says it on a connection of its own (`run-begin`, `run-progress`, `run-end`):
 * the run sessions as fake sockets tell them, then the record channel of a service started in-process, which hands
 * that connection to them by its first line.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RUN_TAKES, type RunMainToHub, type RunToHub } from '@piwitests/core/run-channel';
import type { RunSession } from '../src/protocol';
import { RunSessions } from '../src/run-sessions';
import { last, service, waitFor, writeRunWorkspace, type Service } from './run-fixtures';

type RunBeginLine = Extract<RunMainToHub, { type: 'run-begin' }>;

function fakeSocket() {
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    write: () => true,
    destroy() {
      if (socket.destroyed) return;
      socket.destroyed = true;
      queueMicrotask(() => socket.emit('close'));
    },
  });
  return socket;
}

const BEGIN: RunBeginLine = {
  type: 'run-begin',
  token: 't',
  ref: 'ed-1',
  cwd: '/work/shop',
  pid: 1,
  playwright: '1.64.1',
  reporter: '0.70.0',
  total: 9,
  workers: 2,
  shard: null,
};

function harness(terminal = false) {
  const sent: RunSession[] = [];
  const sessions = new RunSessions({
    notify: (session) => void sent.push(session),
    answersStops: () => true,
    notice: () => {},
    rootOf: () => '/work/shop',
    terminal: () => terminal,
    instances: () => ['https://piwi.example.com'],
    paceMs: 5,
    burstMs: 0,
    lingerMs: 50,
  });
  const main = (begin: Partial<RunBeginLine> = {}) => {
    const socket = fakeSocket();
    const reader = sessions.attachMain(socket as unknown as net.Socket, { ...BEGIN, ...begin });
    return { socket, read: (message: RunMainToHub) => reader(JSON.stringify(message)) };
  };
  const worker = (workerIndex: number) => {
    const socket = fakeSocket();
    const reader = sessions.attach(socket as unknown as net.Socket, {
      type: 'run-attach',
      token: 't',
      ref: 'ed-1',
      cwd: '/work/shop',
      workerIndex,
      parallelIndex: 0,
      pid: 2,
      playwright: '1.64.1',
      reporter: '0.70.0',
      takes: [...RUN_TAKES],
    });
    return { socket, read: (message: RunToHub) => reader(JSON.stringify(message)) };
  };
  return { sessions, sent, main, worker };
}

describe('a run’s own connection, in the run sessions', () => {
  test('says how far the run is before its first worker, as tests end, and how it ended', async () => {
    const { sent, main } = harness();
    const run = main();
    expect(await waitFor(() => last(sent))).toMatchObject({
      ref: 'ed-1',
      workers: [],
      ended: false,
      progress: { total: 9, done: 0, failed: 0, flaky: 0, skipped: 0, status: 'running', failure: null },
    });
    run.read({ type: 'run-progress', done: 3, failed: 1, flaky: 1, skipped: 0 });
    await waitFor(() => (last(sent)?.progress?.done === 3 ? true : undefined));
    const failure = { title: 'cart › adds a mug', error: 'expect(locator).toBeVisible() failed' };
    run.read({ type: 'run-end', status: 'failed', failure, done: 9, failed: 1, flaky: 1, skipped: 0 });
    expect(await waitFor(() => (last(sent)?.progress?.status === 'failed' ? last(sent) : undefined))).toMatchObject({
      ended: false,
      progress: { total: 9, done: 9, failed: 1, status: 'failed', failure },
    });
    // The run ends once its process left and no worker is there.
    run.socket.destroy();
    expect(await waitFor(() => (last(sent)?.ended ? last(sent) : undefined))).toMatchObject({
      progress: { status: 'failed' },
    });
  });

  test('names the run’s page on the instance once its process does, and keeps it to the end', async () => {
    const { sent, main } = harness();
    const run = main();
    await waitFor(() => last(sent));
    expect(last(sent)).not.toHaveProperty('page');
    // A page on an instance this host does not connect to is not linked: the test's code may name any address.
    run.read({ type: 'run-page', id: 66, url: 'https://elsewhere.example/test-runs/66' });
    run.read({ type: 'run-progress', done: 1, failed: 0, flaky: 0, skipped: 0 });
    expect(await waitFor(() => (last(sent)?.progress?.done === 1 ? last(sent) : undefined))).not.toHaveProperty('page');
    run.read({ type: 'run-page', id: 78, url: 'https://piwi.example.com/test-runs/78' });
    expect(await waitFor(() => last(sent)?.page)).toEqual({ id: 78, url: 'https://piwi.example.com/test-runs/78' });
    run.read({ type: 'run-end', status: 'passed', failure: null, done: 9, failed: 0, flaky: 0, skipped: 0 });
    run.socket.destroy();
    expect(await waitFor(() => (last(sent)?.ended ? last(sent) : undefined))).toMatchObject({
      page: { id: 78, url: 'https://piwi.example.com/test-runs/78' },
    });
  });

  test('remembers that a run’s reporter connected, for a command that ends to say so', async () => {
    const { sessions, main, worker } = harness();
    expect(sessions.heardFrom('ed-1')).toBe(false);
    // A worker alone is the capture fixtures', which run without the reporter.
    worker(0);
    expect(sessions.heardFrom('ed-1')).toBe(false);
    const run = main();
    expect(sessions.heardFrom('ed-1')).toBe(true);
    run.socket.destroy();
    expect(sessions.heardFrom('ed-1')).toBe(true);
    expect(sessions.heardFrom('ed-2')).toBe(false);
  });

  test('goes on between its workers while its process is connected', async () => {
    const { sent, main, worker } = harness();
    const run = main();
    const first = worker(0);
    await waitFor(() => (last(sent)?.workers.length === 1 ? true : undefined));
    first.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(last(sent)).toMatchObject({ ended: false, workers: [] });
    worker(1);
    await waitFor(() => (last(sent)?.workers[0]?.worker === 1 ? true : undefined));
    expect(sent.some((session) => session.ended)).toBe(false);
    run.socket.destroy();
  });

  test('takes one connection of the run’s own at a time, and none of its lines once it left', async () => {
    const { sent, main } = harness();
    const run = main();
    const second = main();
    expect(second.socket.destroyed).toBe(true);
    run.read({ type: 'run-progress', done: 2, failed: 0, flaky: 0, skipped: 0 });
    await waitFor(() => (last(sent)?.progress?.done === 2 ? true : undefined));
    second.read({ type: 'run-progress', done: 5, failed: 0, flaky: 0, skipped: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(last(sent)?.progress?.done).toBe(2);
    run.socket.destroy();
  });
});

describe('a run’s own connection, as its process leaves or the host stops', () => {
  test('ends interrupted when its process leaves without saying how it ended', async () => {
    const { sent, main } = harness();
    const run = main();
    run.read({ type: 'run-progress', done: 2, failed: 1, flaky: 0, skipped: 0 });
    run.socket.destroy();
    expect(await waitFor(() => (last(sent)?.ended ? last(sent) : undefined))).toMatchObject({
      progress: { done: 2, failed: 1, status: 'interrupted' },
    });
  });

  test('says no worker started a test yet while only the run’s process is connected', async () => {
    const { sessions, sent, main } = harness();
    const run = main();
    await waitFor(() => last(sent));
    expect(sessions.control({ ref: 'ed-1', action: 'pause' })).toMatchObject({
      ok: false,
      message: expect.stringContaining('none has started a test yet'),
    });
    run.socket.destroy();
  });

  test('names a run an editor’s test runner started, from its process alone', async () => {
    const { sent, main } = harness(true);
    const run = main({ ref: 'terminal-1', runner: true });
    expect(await waitFor(() => last(sent))).toMatchObject({ ref: 'terminal-1', terminal: true, runner: true });
    run.socket.destroy();
  });

  test('closes the run’s connection as the host stops', () => {
    const { sessions, main } = harness();
    const run = main();
    sessions.dispose();
    expect(run.socket.destroyed).toBe(true);
  });
});

describe('a run’s own connection, through the record channel', () => {
  let dir = '';
  let svc: Service;

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-progress-')));
    writeRunWorkspace(dir);
    svc = await service(dir, true);
  });

  afterAll(() => {
    svc?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('is taken with the channel’s token alone, and its progress reaches the client', async () => {
    const { ref, channel } = await svc.command();
    const connect = (token: string) => {
      const socket = net.connect(channel.path);
      socket.write(`${JSON.stringify({ ...BEGIN, ref, cwd: dir, token })}\n`);
      return socket;
    };
    const wrong = connect('not-the-token');
    await new Promise<void>((resolve) => wrong.on('close', () => resolve()));
    const run = connect(channel.token);
    try {
      const session = await waitFor(() => svc.sessions.find((s) => s.ref === ref && s.progress));
      expect(session.progress).toMatchObject({ total: 9, done: 0, status: 'running' });
      run.write(`${JSON.stringify({ type: 'run-progress', done: 4, failed: 0, flaky: 0, skipped: 1 })}\n`);
      await waitFor(() => svc.sessions.find((s) => s.ref === ref && s.progress?.done === 4));
      // Its page reaches the client too, an address that is not one left out.
      run.write(`${JSON.stringify({ type: 'run-page', id: 6, url: 'http://127.0.0.1:7494/test-runs/6' })}\n`);
      const named = await waitFor(() => svc.sessions.find((s) => s.ref === ref && s.page));
      expect(named.page).toEqual({ id: 6, url: 'http://127.0.0.1:7494/test-runs/6' });
      run.write(`${JSON.stringify({ type: 'run-page', id: 5, url: 'javascript:alert(1)' })}\n`);
      run.write(`${JSON.stringify({ type: 'run-progress', done: 5, failed: 0, flaky: 0, skipped: 1 })}\n`);
      const after = await waitFor(() => svc.sessions.find((s) => s.ref === ref && s.progress?.done === 5));
      expect(after.page).toEqual({ id: 6, url: 'http://127.0.0.1:7494/test-runs/6' });
    } finally {
      run.destroy();
    }
  });
});

describe('this window’s runs shared live, and a teammate’s ask to watch', () => {
  function writingSocket() {
    const written: string[] = [];
    const socket = Object.assign(fakeSocket(), {
      write: (line: string) => {
        written.push(line);
        return true;
      },
    });
    return { socket, written };
  }

  function window() {
    const notices: string[] = [];
    const asks: unknown[] = [];
    const windowShared: boolean[] = [];
    const sessions = new RunSessions({
      notify: () => {},
      answersStops: () => true,
      notice: (_root, _severity, message) => void notices.push(message),
      rootOf: () => '/work/shop',
      instances: () => ['https://piwi.example.com'],
      askedToWatch: (ask) => void asks.push(ask),
      shareWindowChanged: (on) => void windowShared.push(on),
      paceMs: 5,
      burstMs: 0,
      lingerMs: 50,
    });
    const main = (ref: string, run: number) => {
      const { socket, written } = writingSocket();
      const reader = sessions.attachMain(socket as unknown as net.Socket, { ...BEGIN, ref });
      reader(JSON.stringify({ type: 'run-page', id: run, url: `https://piwi.example.com/test-runs/${run}` }));
      return { socket, written, read: (message: unknown) => reader(JSON.stringify(message)) };
    };
    const worker = (ref: string) => {
      const { socket, written } = writingSocket();
      const reader = sessions.attach(socket as unknown as net.Socket, {
        type: 'run-attach',
        token: 't',
        ref,
        cwd: '/work/shop',
        workerIndex: 0,
        parallelIndex: 0,
        pid: 2,
        playwright: '1.64.1',
        reporter: '0.70.0',
        takes: [...RUN_TAKES],
      });
      const live = (on: boolean) =>
        reader(
          JSON.stringify({
            type: 'live',
            can: true,
            on,
            viewers: 0,
            page: 'https://piwi.example.com/test-runs/1',
            why: null,
          }),
        );
      return { written, live, shares: () => written.map((line) => JSON.parse(line)).filter((m) => m.type === 'share') };
    };
    return { sessions, notices, asks, windowShared, main, worker };
  }

  test('shares each run the window starts until stopped, each saying so and continuing the one before', () => {
    const { sessions, notices, windowShared, main, worker } = window();
    expect(sessions.share({ on: true, scope: 'window' })).toMatchObject({ ok: true });
    expect(windowShared).toEqual([true]);
    main('ed-1', 77);
    const first = worker('ed-1');
    expect(first.shares()).toEqual([{ type: 'share', on: true }]);
    first.live(true);
    expect(notices).toEqual([
      "Run #77 is shared live on piwi.example.com, as this window's runs are until you stop sharing them.",
    ]);
    // The next run continues the one before on the instance.
    main('ed-2', 78);
    const second = worker('ed-2');
    expect(second.shares()).toEqual([{ type: 'share', on: true, after: 77 }]);
    // Stopped, every run of the window stops sharing, and the next one is not shared.
    expect(sessions.share({ on: false, scope: 'window' })).toMatchObject({ ok: true });
    expect(windowShared).toEqual([true, false]);
    expect(second.shares()[second.shares().length - 1]).toEqual({ type: 'share', on: false });
    main('ed-3', 79);
    expect(worker('ed-3').shares()).toEqual([]);
  });

  test('asks the developer as a teammate asks to watch, and sends Not now back through the run', () => {
    const { sessions, asks, main } = window();
    const run = main('ed-1', 77);
    run.read({ type: 'run-ask', id: 'a1', by: 'Dana' });
    expect(asks).toEqual([{ ref: 'ed-1', id: 'a1', by: 'Dana', run: 77 }]);
    expect(sessions.answerAsk({ ref: 'ed-1', id: 'a1', answer: 'not-now' })).toMatchObject({ ok: true });
    expect(run.written.map((line) => JSON.parse(line))).toEqual([{ type: 'ask-answer', id: 'a1', answer: 'not-now' }]);
    expect(sessions.answerAsk({ ref: 'ed-9', id: 'a1', answer: 'not-now' })).toMatchObject({ ok: false });
  });
});
