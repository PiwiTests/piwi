import { describe, expect, test } from 'vitest';
import type { RunProgress, RunSession, RunStop, RunWorker } from '../src/protocol';
import { runLine } from '../src/run-line';

const stop = (reason: RunStop['reason'], extra: Partial<RunStop> = {}): RunStop => ({
  reason,
  title: 'Click',
  uri: 'file:///w/tests/pages/checkout.page.ts',
  line: 11,
  character: 4,
  locator: null,
  bar: false,
  since: 's1',
  ...extra,
});

const worker = (extra: Partial<RunWorker> = {}): RunWorker =>
  ({
    worker: 0,
    parallelIndex: 0,
    state: 'running',
    test: null,
    stop: null,
    takes: [],
    watchable: false,
    layers: false,
    showsWindow: false,
    pausing: false,
    waiting: null,
    ...extra,
  }) as RunWorker;

const progress = (extra: Partial<RunProgress> = {}): RunProgress => ({
  total: 9,
  done: 3,
  failed: 1,
  flaky: 0,
  skipped: 0,
  status: 'running',
  failure: null,
  ...extra,
});

const session = (extra: Partial<RunSession> = {}): RunSession =>
  ({ ref: 'ed-1', root: '/w', workers: [], ended: false, ...extra }) as RunSession;

describe('the run line both status items show', () => {
  test('is none without a stop, a Pause, a share or a count', () => {
    expect(runLine([], false)).toBeNull();
    expect(runLine([session({ workers: [worker()] })], false)).toBeNull();
  });

  test('says where a stop stands, then the run and how far it is', () => {
    const held = session({
      workers: [worker({ state: 'stopped', stop: stop('failure', { calls: true }) })],
      progress: progress(),
      page: { id: 78, url: 'http://piwi/test-runs/78' },
    });
    expect(runLine([held], false)).toEqual({
      text: 'Piwi: held at its failure · checkout.page.ts:12 · run #78 · 3 of 9 · 1 failed',
      state: 'held',
      calls: 1,
    });
    const agent = session({ workers: [worker({ state: 'stopped', stop: stop('pause', { by: 'agent' }) })] });
    expect(runLine([agent], false)).toMatchObject({
      text: 'Piwi: paused by the agent · checkout.page.ts:12',
      state: 'stopped',
      calls: 0,
    });
  });

  test('counts several stops, and a Pause on its way with the call its test waits in', () => {
    const two = session({
      workers: [
        worker({ state: 'stopped', stop: stop('breakpoint') }),
        worker({ worker: 1, parallelIndex: 1, state: 'stopped', stop: stop('failure', { since: 's2' }) }),
      ],
    });
    expect(runLine([two], false)).toMatchObject({ text: 'Piwi: 2 tests stopped', state: 'stopped' });
    const waits = session({
      workers: [
        worker({
          pausing: true,
          waiting: { title: 'waitForResponse', uri: null, line: null, since: null, endable: true },
        }),
      ],
    });
    expect(runLine([waits], false)).toMatchObject({
      text: 'Piwi: pausing… · waits in waitForResponse',
      state: 'pausing',
    });
  });

  test('names a share and its views, the window’s too, and every run’s count summed', () => {
    const shared = session({ live: { shared: true, viewers: 2 } as RunSession['live'], progress: progress() });
    const other = session({ ref: 'ed-2', progress: progress({ done: 1, total: 2, failed: 0, flaky: 1 }) });
    expect(runLine([shared, other], false)).toEqual({
      text: 'Piwi: shared live · 2 views · 4 of 11 · 1 failed · 1 flaky',
      state: 'live',
      calls: 0,
    });
    expect(runLine([], true)).toMatchObject({ text: 'Piwi: each run shared live', state: 'live' });
  });

  test('takes the glyph of how the runs went once they ended, and names who started an agent’s run', () => {
    const ended = (status: RunProgress['status'], failed = 0) =>
      runLine([session({ progress: progress({ status, done: 9, failed }) })], false)?.state;
    expect(ended('passed')).toBe('passed');
    expect(ended('failed', 1)).toBe('failed');
    expect(ended('timedout')).toBe('failed');
    expect(ended('interrupted')).toBe('interrupted');
    const agent = session({ progress: progress(), label: 'Started by Claude Code' });
    expect(runLine([agent], false)?.text).toBe('Piwi: 3 of 9 · 1 failed · Started by Claude Code');
  });
});
