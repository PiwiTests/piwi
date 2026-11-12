/**
 * The state each worker of a session says, as the run sessions reduce it per lane (`@piwitests/core/live-lane`): the
 * worker Playwright starts again in a lane takes it between tests, a Pause between two tests waits for the next one,
 * and the run's end leaves no test running; workers on fake sockets tell them.
 */
import { EventEmitter } from 'node:events';
import type * as net from 'node:net';
import { describe, expect, test } from 'vitest';
import { RUN_TAKES, type RunToHub } from '@piwitests/core/run-channel';
import type { RunSession } from '../src/protocol';
import { RunSessions } from '../src/run-sessions';
import { last, waitFor } from './run-fixtures';

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

function harness() {
  const sent: RunSession[] = [];
  const sessions = new RunSessions({
    notify: (session) => void sent.push(session),
    answersStops: () => true,
    notice: () => {},
    rootOf: () => '/work/shop',
    paceMs: 5,
    burstMs: 0,
    lingerMs: 60_000,
  });
  /** A worker `index` joins the lane `parallelIndex` of the run `ed-1`. */
  const join = (index: number, parallelIndex: number) => {
    const socket = fakeSocket();
    const reader = sessions.attach(socket as unknown as net.Socket, {
      type: 'run-attach',
      token: 't',
      ref: 'ed-1',
      cwd: '/work/shop',
      workerIndex: index,
      parallelIndex,
      pid: 1,
      playwright: '1.64.1',
      reporter: '0.70.0',
      takes: [...RUN_TAKES],
      features: ['view-lane', 'give-up'],
    });
    const read = (message: RunToHub) => reader(JSON.stringify(message));
    const begin = (testId: string, retry = 0) =>
      read({
        type: 'test-begin',
        testId,
        title: ['checkout', testId],
        file: 'tests/a.spec.ts',
        line: 1,
        project: '',
        retry,
        cannotPause: null,
      });
    return { socket, read, begin };
  };
  /** The workers of the session as the client heard them last. */
  const workers = () => last(sent)?.workers ?? [];
  return { sessions, sent, join, workers };
}

describe('the lane state a session says', () => {
  test('the worker Playwright starts again in a lane takes it between tests, then runs its next test', async () => {
    const { join, workers } = harness();
    const first = join(0, 0);
    first.begin('t0');
    await waitFor(() => (workers()[0]?.state === 'running' ? true : undefined));
    first.read({ type: 'test-end', testId: 't0', status: 'failed', pausedMs: 0 });
    first.socket.destroy();
    const second = join(1, 0);
    await waitFor(() => (workers().length === 1 && workers()[0]!.worker === 1 ? true : undefined));
    expect(workers()[0]).toMatchObject({ worker: 1, parallelIndex: 0, state: 'between', test: null, stop: null });
    second.begin('t0', 1);
    await waitFor(() => (workers()[0]?.state === 'running' ? true : undefined));
    expect(workers()[0]?.test).toMatchObject({ id: 't0', retry: 1 });
  });

  test('a Pause between two tests says pausing, between, until the next test runs pausing', async () => {
    const { sessions, join, workers } = harness();
    join(0, 0);
    await waitFor(() => (workers()[0]?.state === 'between' ? true : undefined));
    expect(sessions.control({ ref: 'ed-1', action: 'pause' })).toMatchObject({ ok: true });
    await waitFor(() => (workers()[0]?.pausing ? true : undefined));
    expect(workers()[0]).toMatchObject({ state: 'between', pausing: true, test: null });
  });

  test('a test that cannot stop ends the Pause waiting for it', async () => {
    const { sessions, join, workers } = harness();
    const worker = join(0, 0);
    await waitFor(() => (workers()[0] ? true : undefined));
    sessions.control({ ref: 'ed-1', action: 'pause' });
    await waitFor(() => (workers()[0]?.pausing ? true : undefined));
    worker.read({
      type: 'test-begin',
      testId: 't1',
      title: ['checkout', 't1'],
      file: 'tests/a.spec.ts',
      line: 1,
      project: '',
      retry: 0,
      cannotPause: 'running under CI',
    });
    await waitFor(() => (workers()[0]?.state === 'running' ? true : undefined));
    expect(workers()[0]?.pausing).toBe(false);
  });
});
