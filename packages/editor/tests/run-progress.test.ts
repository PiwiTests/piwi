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

const BEGIN = {
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
} as const;

function harness() {
  const sent: RunSession[] = [];
  const sessions = new RunSessions({
    notify: (session) => void sent.push(session),
    answersStops: () => true,
    notice: () => {},
    rootOf: () => '/work/shop',
    paceMs: 5,
    burstMs: 0,
    lingerMs: 50,
  });
  const main = () => {
    const socket = fakeSocket();
    const reader = sessions.attachMain(socket as unknown as net.Socket, BEGIN);
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
    } finally {
      run.destroy();
    }
  });
});
