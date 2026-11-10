/**
 * Show the browser: at a stop its pause bar shows, the test's window comes to the front, in the run sessions as a worker
 * on a fake socket tells them.
 */
import { EventEmitter } from 'node:events';
import type * as net from 'node:net';
import { describe, expect, test } from 'vitest';
import { RUN_TAKES, type HubToRun, type RunFeature, type RunToHub } from '@piwitests/core/run-channel';
import { parseHubCommand } from '@piwitests/core/run-hub';
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

/** The run `ed-1` with one worker of `features`, running a test, and how it stops. */
function harness(features: RunFeature[] = ['view-lane', 'give-up', 'front']) {
  const sent: RunSession[] = [];
  const sessions = new RunSessions({
    notify: (session) => void sent.push(session),
    answersStops: () => true,
    notice: () => {},
    rootOf: () => '/work/shop',
    paceMs: 5,
    burstMs: 0,
    requestMs: 2000,
  });
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
    reporter: '0.71.0',
    takes: [...RUN_TAKES],
    features,
  });
  const read = (message: RunToHub) => reader(JSON.stringify(message));
  const fronts = () =>
    socket.written
      .map((line) => JSON.parse(line) as HubToRun)
      .filter((m): m is Extract<HubToRun, { type: 'request' }> => m.type === 'request' && m.what === 'front');
  const answer = (request: number, value: unknown) =>
    reader(JSON.stringify({ type: 'answer', request, what: 'front', value }));
  let lastSince = '';
  const stopAt = async (stop: number, bar: boolean): Promise<string> => {
    read({
      type: 'stopped',
      stop,
      reason: 'breakpoint',
      title: 'Click',
      place: { file: 'tests/a.spec.ts', line: 4 },
      locator: null,
      bar,
    });
    return waitFor(() => {
      const at = last(sent)?.workers[0]?.stop;
      return at && at.since !== lastSince ? (lastSince = at.since) : undefined;
    });
  };
  read({
    type: 'test-begin',
    testId: 't1',
    title: ['a'],
    file: 'tests/a.spec.ts',
    line: 1,
    project: '',
    retry: 0,
    cannotPause: null,
  });
  return { sessions, fronts, answer, stopAt, read };
}

describe('Show the browser', () => {
  test('brings the test’s window to the front at a stop its pause bar shows', async () => {
    const { sessions, fronts, answer, stopAt } = harness();
    const since = await stopAt(1, true);
    expect(sessions.stopIntentsOf('ed-1', 0, null)).toContain('front');
    const shown = sessions.front({ ref: 'ed-1', since });
    expect(fronts()).toEqual([{ type: 'request', request: fronts()[0]!.request, what: 'front', stop: 1 }]);
    answer(fronts()[0]!.request, { ok: true, message: "The test's window is in front." });
    expect(await shown).toEqual({ ok: true, message: "The test's window is in front." });
    sessions.dispose();
  });

  test('is not offered, and refused, at a headless stop: its browser has no window', async () => {
    const { sessions, fronts, stopAt } = harness();
    const since = await stopAt(1, false);
    expect(sessions.intentsOf('ed-1', 0)).toContain('front');
    expect(sessions.stopIntentsOf('ed-1', 0, null)).not.toContain('front');
    expect(await sessions.front({ ref: 'ed-1', since })).toEqual({
      ok: false,
      message: 'The test runs headless: its browser has no window to show. Run it headed.',
    });
    expect(fronts()).toEqual([]);
    sessions.dispose();
  });

  test('is refused for a reporter that does not take it, and past the stop', async () => {
    const older = harness(['view-lane', 'give-up']);
    const since = await older.stopAt(1, true);
    expect(older.sessions.stopIntentsOf('ed-1', 0, null)).not.toContain('front');
    expect(await older.sessions.front({ ref: 'ed-1', since })).toEqual({
      ok: false,
      message: "@piwitests/reporter 0.71.0 cannot bring the test's window forward: update it.",
    });
    expect(older.fronts()).toEqual([]);
    older.read({ type: 'running', stop: 1 });
    await waitFor(() => (older.sessions.current()[0]?.workers[0]?.stop ? undefined : true));
    expect(await older.sessions.front({ ref: 'ed-1', since })).toMatchObject({ ok: false });
    older.sessions.dispose();
  });

  test('is a hub command naming its stop', () => {
    expect(parseHubCommand(JSON.stringify({ type: 'front', id: 3, ref: 'ed-1', worker: 0, since: 's1' }))).toEqual({
      type: 'front',
      id: 3,
      ref: 'ed-1',
      worker: 0,
      since: 's1',
    });
    expect(parseHubCommand(JSON.stringify({ type: 'front', id: 4, ref: 'ed-1', worker: 0 }))).toMatchObject({
      type: 'invalid',
    });
  });
});
