/**
 * A Pause that waits for the call a test runs: the call the worker says it waits in (`waiting`), kept while it pauses
 * and gone as the test moves on, and End the test there (`give-up`), in the run sessions as workers on fake sockets
 * tell them.
 */
import { EventEmitter } from 'node:events';
import type * as net from 'node:net';
import { describe, expect, test } from 'vitest';
import { RUN_TAKES, type HubToRun, type RunFeature, type RunToHub } from '@piwitests/core/run-channel';
import type { RunSession } from '../src/protocol';
import { RunSessions } from '../src/run-sessions';
import { last, waitFor } from './run-fixtures';

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

/** The run `ed-1`, and how its worker joins, running a test, and what it heard. */
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
  const join = (features: RunFeature[] = ['view-lane', 'give-up']) => {
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
      reporter: '0.70.0',
      takes: [...RUN_TAKES],
      features,
    });
    const read = (message: RunToHub) => reader(JSON.stringify(message));
    const heard = (): HubToRun[] => socket.written.map((line) => JSON.parse(line) as HubToRun);
    read({
      type: 'test-begin',
      testId: 't0',
      title: ['checkout', 'pays'],
      file: 'tests/a.spec.ts',
      line: 1,
      project: '',
      retry: 0,
      cannotPause: null,
    });
    return { read, heard };
  };
  return { sessions, sent, join };
}

const WAITING = {
  type: 'waiting',
  title: "Click getByRole('button', { name: 'Pay' })",
  place: { file: 'tests/a.spec.ts', line: 4, column: 3 },
  ms: 1500,
  endable: true,
} satisfies RunToHub;

describe('a Pause that waits for the call a test runs', () => {
  test('says the call it waits in, and ends the test there as asked, the Pause dropped', async () => {
    const { sessions, sent, join } = harness();
    const w = join();
    expect(sessions.control({ ref: 'ed-1', action: 'pause' })).toMatchObject({ ok: true });
    const before = Date.now();
    w.read(WAITING);
    const waiting = await waitFor(() => last(sent)?.workers[0]?.waiting ?? undefined);
    expect(waiting).toMatchObject({
      title: WAITING.title,
      uri: 'file:///work/shop/tests/a.spec.ts',
      line: 3,
      endable: true,
    });
    const began = Date.parse(waiting.since!);
    expect(began).toBeGreaterThanOrEqual(before - 1500 - 50);
    expect(began).toBeLessThanOrEqual(Date.now() - 1500 + 50);
    expect(sessions.intentsOf('ed-1', 0)).toContain('give-up');
    expect(sessions.control({ ref: 'ed-1', action: 'give-up' })).toEqual({
      ok: true,
      message: "Ending the test: Click getByRole('button', { name: 'Pay' }) is given up.",
    });
    expect(w.heard()).toContainEqual({ type: 'control', action: 'give-up' });
    expect(await waitFor(() => (last(sent)?.workers[0]?.pausing === false ? last(sent) : undefined))).toMatchObject({
      workers: [{ pausing: false, waiting: null }],
    });
    expect(sessions.intentsOf('ed-1', 0)).not.toContain('give-up');
    expect(sessions.control({ ref: 'ed-1', action: 'give-up' })).toEqual({
      ok: false,
      message: 'No test waits for a Pause.',
    });
  });

  test('forgets the call as the test stops, goes on or ends, and hears none while no Pause waits', async () => {
    const { sessions, sent, join } = harness();
    const w = join();
    w.read(WAITING);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(last(sent)?.workers[0]?.waiting ?? null).toBeNull();
    sessions.control({ ref: 'ed-1', action: 'pause' });
    w.read({ ...WAITING, ms: null, endable: false });
    expect(await waitFor(() => last(sent)?.workers[0]?.waiting ?? undefined)).toMatchObject({
      since: null,
      endable: false,
    });
    expect(sessions.control({ ref: 'ed-1', action: 'give-up' })).toMatchObject({
      ok: true,
      message: "Ending the test as Click getByRole('button', { name: 'Pay' }) returns.",
    });
    sessions.control({ ref: 'ed-1', action: 'pause' });
    w.read(WAITING);
    await waitFor(() => last(sent)?.workers[0]?.waiting ?? undefined);
    w.read({
      type: 'stopped',
      stop: 1,
      reason: 'pause',
      title: 'Click',
      place: { file: 'tests/a.spec.ts', line: 5 },
      locator: null,
      bar: true,
    });
    expect(await waitFor(() => (last(sent)?.workers[0]?.stop ? last(sent) : undefined))).toMatchObject({
      workers: [{ waiting: null }],
    });
    expect(sessions.control({ ref: 'ed-1', action: 'give-up' })).toEqual({
      ok: false,
      message: 'The test is stopped: End the test answers its stop.',
    });
  });

  test('ends no test of a reporter that does not end one there, which says no call it waits in', async () => {
    const { sessions, sent, join } = harness();
    const w = join(['view-lane']);
    sessions.control({ ref: 'ed-1', action: 'pause' });
    w.read(WAITING);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(last(sent)?.workers[0]?.waiting ?? null).toBeNull();
    expect(sessions.intentsOf('ed-1', 0)).not.toContain('give-up');
    expect(sessions.control({ ref: 'ed-1', action: 'give-up' })).toEqual({
      ok: false,
      message:
        '@piwitests/reporter 0.70.0 cannot end a test while it waits for a Pause: update it, or let the call finish.',
    });
    expect(w.heard()).not.toContainEqual({ type: 'control', action: 'give-up' });
  });
});
