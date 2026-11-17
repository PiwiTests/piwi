import { afterEach, describe, expect, test } from 'vitest';
import type { LiveViewerMessage } from '@piwitests/core/live-view';
import type { Lane } from '#shared/live-lanes';
import { DEMO_NO_IMAGE, DEMO_NO_TEXT, demoCallLog, demoSnapshotNotice } from '../../app/demo/live-calls';
import { DemoLiveWatch, demoLaneWorkers, forgetDemoWorkers, hearDemoEvent } from '../../app/demo/live-watch';
import type { LiveWatchAsk, LiveWatchState } from '../../app/utils/live-watch';

/**
 * The demo's watch of a run: what its simulated workers said, kept as the instance keeps it for a view that opens
 * later, and told to the worker shown in full, its pages only with Inspect open; no image, no text.
 */

const RUN = 7;
const paypal = { shard: null, worker: 1, slot: 1 };
const other = { shard: null, worker: 0, slot: 0 };
const TEST = 'should complete checkout with PayPal';
const pay = {
  title: 'Click',
  subtitle: "getByRole('button', { name: 'Pay' })",
  category: 'action',
  params: { locator: "getByRole('button', { name: 'Pay' })" },
};

function callLog(id: typeof paypal, ms: number, test = TEST): LiveViewerMessage {
  const log = demoCallLog(pay, { id: 'call@12', testLocation: 'tests/a.spec.ts:1:1', status: 'running', ms });
  return { type: 'call-log', ...id, log, test };
}
function page(phase: 'before' | 'after', test = TEST): LiveViewerMessage {
  const at = { call: 'call@12:1', testLocation: 'tests/a.spec.ts:1:1', phase, index: 0, at: 1_800_000_000_000 };
  return demoSnapshotNotice(paypal, test, pay, at)!;
}
/** What a simulated worker of `runId` said, as the channel carries it. */
function say(message: LiveViewerMessage, runId = RUN): void {
  hearDemoEvent({ scope: 'live', runId, message });
}

/** A demo watch of the run, with what it told the page. */
function open() {
  const heard: LiveViewerMessage[] = [];
  const states: LiveWatchState[] = [];
  const watch = new DemoLiveWatch(RUN, {
    message: (message) => heard.push(message),
    state: (state) => states.push(state),
    focusRefused: () => {
      throw new Error('the demo never refuses a view');
    },
  });
  return { watch, heard, states };
}
const ask = (over: Partial<LiveWatchAsk> = {}): LiveWatchAsk => ({
  focus: paypal,
  tiles: false,
  size: null,
  layers: ['events'],
  inspect: false,
  ...over,
});

afterEach(() => forgetDemoWorkers());

describe('the demo’s watch of a run', () => {
  test('opens at once on the worker it shows: no image, its latest call log, then each message of that worker', () => {
    say(callLog(paypal, 1000));
    say(callLog(paypal, 2000));
    const { watch, heard, states } = open();
    expect(watch.id).toBeNull();

    watch.want(ask());
    expect(states).toEqual([{ kind: 'open' }]);
    expect(watch.id).toMatch(/^demo-watch-/);
    expect(heard.map((m) => m.type)).toEqual(['refused', 'call-log']);
    expect(heard[0]).toEqual({ type: 'refused', ...paypal, message: DEMO_NO_IMAGE });
    expect(heard[1]).toMatchObject({ log: { ms: 2000 } });

    // The same view asked again hears nothing again; another worker's messages go elsewhere.
    watch.want(ask({ size: { width: 640, height: 400 } }));
    say(callLog(other, 500, 'another test'));
    say(callLog(paypal, 3000));
    expect(heard.map((m) => m.type)).toEqual(['refused', 'call-log', 'call-log']);
    expect(heard[2]).toMatchObject({ ...paypal, log: { ms: 3000 } });
    // Of another run, nothing.
    say(callLog(paypal, 4000), RUN + 1);
    expect(heard).toHaveLength(3);
  });

  test('tells a view that attaches again to the same worker what it kept, as the page starts that view afresh', () => {
    say(callLog(paypal, 1000));
    say(page('before'));
    const { watch, heard } = open();
    watch.want(ask({ inspect: true }));
    expect(heard.map((m) => m.type)).toEqual(['refused', 'call-log', 'snapshot']);

    // The lane panel connects again on the same worker (another row's Watch): `show` resumes the watch.
    watch.want(ask({ inspect: true }));
    watch.resume();
    expect(heard.map((m) => m.type)).toEqual(['refused', 'call-log', 'snapshot', 'refused', 'call-log', 'snapshot']);
  });

  test('tells the pages of the worker’s test with Inspect open alone, those kept as Inspect opens', () => {
    say(page('before'));
    const { watch, heard } = open();
    watch.want(ask());
    say(page('after'));
    expect(heard.filter((m) => m.type === 'snapshot')).toEqual([]);

    watch.want(ask({ inspect: true }));
    expect(heard.flatMap((m) => (m.type === 'snapshot' && 'phase' in m ? [m.phase] : []))).toEqual(['before', 'after']);
    say({ type: 'snapshot', ...paypal, refused: 'no page', test: TEST });
    expect(heard.at(-1)).toMatchObject({ type: 'snapshot', refused: 'no page' });
  });

  test('lets a test’s call log and pages go as it ends, and a message of the next test starts its record afresh', () => {
    say(callLog(paypal, 1000));
    say(page('before'));
    say({ type: 'test-ended', ...paypal, outcome: { test: TEST, status: 'failed', ms: 30_000 } });
    const late = open();
    late.watch.want(ask({ inspect: true }));
    expect(late.heard.map((m) => m.type)).toEqual(['refused']);

    say(callLog(paypal, 10, 'the next test'));
    say(page('before', 'the next test'));
    const next = open();
    next.watch.want(ask({ inspect: true }));
    expect(next.heard.map((m) => m.type)).toEqual(['refused', 'call-log', 'snapshot']);
    expect(next.heard.slice(1).every((m) => 'test' in m && m.test === 'the next test')).toBe(true);
  });

  test('refuses the page’s text, ends with the run, and hears nothing once closed', () => {
    const { watch, heard, states } = open();
    watch.want(ask({ layers: ['text'] }));
    watch.askText();
    expect(heard.at(-1)).toEqual({ type: 'text', ...paypal, refused: DEMO_NO_TEXT, test: null });

    hearDemoEvent({ scope: 'run', runId: RUN, event: { type: 'run-finished', data: {} } });
    expect(heard.at(-1)).toEqual({ type: 'end', reason: 'run-ended' });
    expect(states.at(-1)).toEqual({ kind: 'closed', status: null, reason: 'run-ended' });
    expect(watch.id).toBeNull();
    say(callLog(paypal, 1000));
    watch.want(ask());
    expect(heard.at(-1)).toEqual({ type: 'end', reason: 'run-ended' });
    // A run that ended takes no watch.
    const late = open();
    late.watch.want(ask());
    expect(late.states).toEqual([{ kind: 'closed', status: null, reason: 'run-ended' }]);
    expect(late.heard).toEqual([]);
  });

  test('ends as the instance ends a run’s live view: cancelled, submitted whole or finalizing', () => {
    for (const type of ['run-cancelled', 'run-submitted', 'run-finalizing'] as const) {
      forgetDemoWorkers();
      const { watch, heard, states } = open();
      watch.want(ask());
      hearDemoEvent({ scope: 'global', event: { type, runId: RUN, projectId: 1 } });
      expect(heard.at(-1), type).toEqual({ type: 'end', reason: 'run-ended' });
      expect(states.at(-1), type).toEqual({ kind: 'closed', status: null, reason: 'run-ended' });
    }
    forgetDemoWorkers();
    const { watch, heard } = open();
    watch.want(ask());
    hearDemoEvent({ scope: 'run', runId: RUN, event: { type: 'run-finalizing', data: {} } });
    expect(heard.at(-1)).toEqual({ type: 'end', reason: 'run-ended' });
  });

  test('closes once nothing is wanted, and hears nothing more', () => {
    const { watch, heard, states } = open();
    watch.want(ask());
    watch.want(ask({ focus: null }));
    expect(states).toEqual([{ kind: 'open' }, { kind: 'idle' }]);
    say(callLog(paypal, 2000));
    expect(heard.map((m) => m.type)).toEqual(['refused']);
  });
});

describe('demoLaneWorkers', () => {
  const lane = (slot: number, over: Partial<Lane> = {}): Lane => ({
    id: { run: RUN, shard: null, lane: slot },
    state: 'running',
    worker: slot + 4,
    test: { id: `t${slot}`, retry: 0, title: `test ${slot}` } as Lane['test'],
    stop: null,
    waiting: null,
    done: 0,
    failed: 0,
    ...over,
  });

  test('stands a worker in the run’s live view for each lane that runs a test, keyed as the run page keys them', () => {
    expect(demoLaneWorkers([lane(0), lane(1, { test: null, state: 'between' }), lane(2, { state: 'done' })])).toEqual({
      ':4': { shard: null, worker: 4, slot: 0, connected: true, paused: null },
    });
  });
});
