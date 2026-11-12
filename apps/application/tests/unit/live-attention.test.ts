import { describe, expect, test } from 'vitest';
import type { LiveWorkerState } from '#shared/live-view';
import type { TestCaseResult } from '../../types/api';
import {
  AttentionFollower,
  DWELL_MS,
  FRESH_MS,
  HOLD_MS,
  attentionSignals,
  attentionWords,
  type AttentionSignal,
} from '../../app/utils/live-attention';

/**
 * Follow what needs attention: each lane's failures, Stuck? marks and stops are read from the run page's rows and its
 * live workers; the view moves to the newest of them in another lane of the live view, no sooner than a few seconds
 * after it last moved or the person chose a lane, never away from a lane that needs attention itself, never to a
 * failure older than the mode or stale, and says why it moved.
 */

const row = (over: Partial<TestCaseResult>): TestCaseResult =>
  ({
    executionId: -1,
    testCaseId: 0,
    title: 'pays',
    location: 'tests/a.spec.ts:4:3',
    status: 'running',
    parallelIndex: 0,
    shardIndex: null,
    retries: 0,
    ...over,
  }) as TestCaseResult;

const worker = (slot: number, over: Partial<LiveWorkerState> = {}): LiveWorkerState => ({
  shard: null,
  worker: slot,
  slot,
  connected: true,
  paused: null,
  ...over,
});

const lane = (slot: number) => ({ shard: null, slot });
const LANES = [lane(0), lane(1), lane(2)];
const signal = (slot: number, reason: AttentionSignal['reason'], key = `${reason}:${slot}`): AttentionSignal => ({
  key,
  lane: lane(slot),
  reason,
  test: `test ${slot}`,
});

describe('what needs attention', () => {
  test('is read from the rows and the workers: failures, Stuck? marks and stops, each in its lane', () => {
    const stop = {
      reason: 'breakpoint' as const,
      title: 'Click',
      file: null,
      line: null,
      bar: true,
      since: 5,
      pausedMs: 0,
    };
    const signals = attentionSignals(
      [
        row({ title: 'fails', status: 'failed', parallelIndex: 1 }),
        row({ title: 'times out', status: 'timedout', parallelIndex: 2, shardIndex: 3 }),
        row({ title: 'hangs', stuck: { elapsedMs: 400_000, usualMs: 6_000 } }),
        row({ title: 'waits', parallelIndex: 4, liveStop: stop }),
        row({ title: 'passes', status: 'passed', parallelIndex: 5 }),
        row({ title: 'old reporter', status: 'failed', parallelIndex: null }),
      ],
      [
        worker(6, {
          paused: { reason: 'page-pause', call: { title: 'Pause', file: null, line: null }, test: 'pauses' },
        }),
        worker(7),
      ],
    );
    expect(signals.map((s) => [s.reason, s.lane, s.test, s.stop])).toEqual([
      ['failed', lane(1), 'fails', undefined],
      ['failed', { shard: 3, slot: 2 }, 'times out', undefined],
      ['stuck', lane(0), 'hangs', undefined],
      ['stopped', lane(4), 'waits', 'Stopped at a breakpoint'],
      ['stopped', lane(6), 'pauses', 'Stopped at page.pause()'],
    ]);
    // A retry's failure is another occurrence than its first attempt's.
    const [first] = attentionSignals([row({ status: 'failed' })], []);
    const [retry] = attentionSignals([row({ status: 'failed', retries: 1 })], []);
    expect(first!.key).not.toBe(retry!.key);
    // So is the same test's failure in another browser project of the lane.
    const browser = (projectName: string) => ({ browserName: 'chromium', projectName }) as TestCaseResult['browser'];
    const [chromium] = attentionSignals([row({ status: 'failed', browser: browser('chromium') })], []);
    const [mobile] = attentionSignals([row({ status: 'failed', browser: browser('mobile') })], []);
    expect(chromium!.key).not.toBe(mobile!.key);
  });

  test('says why the view moved, by the worker’s number and what its test did', () => {
    expect(attentionWords(signal(2, 'failed'))).toBe('Moved to worker 3: “test 2” failed.');
    expect(attentionWords({ ...signal(0, 'stuck'), lane: { shard: 2, slot: 0 } })).toBe(
      'Moved to worker 1 of shard 2: “test 0” has run far longer than it usually does (Stuck?).',
    );
    expect(attentionWords({ ...signal(1, 'stopped'), stop: 'Stopped at a breakpoint' })).toBe(
      'Moved to worker 2: “test 1”: stopped at a breakpoint.',
    );
  });
});

describe('the view that follows what needs attention', () => {
  test('moves to the newest news of another lane in the live view, and says what it moved for', () => {
    const follower = new AttentionFollower();
    let now = 100_000;
    expect(follower.update([], lane(0), LANES, now)).toBeNull();
    now += 1000;
    expect(follower.update([signal(1, 'failed')], lane(0), LANES, now)).toMatchObject({
      lane: lane(1),
      reason: 'failed',
    });
    // Its news is acted on: nothing more moves it, past the wait too.
    now += DWELL_MS + HOLD_MS;
    expect(follower.update([signal(1, 'failed')], lane(1), LANES, now)).toBeNull();
    // A lane not in the live view is no place to go.
    expect(follower.update([signal(1, 'failed'), signal(9, 'stuck')], lane(1), LANES, now)).toBeNull();
    // Two at once: the newest.
    now += 1000;
    const signals = [signal(1, 'failed'), signal(9, 'stuck'), signal(0, 'stuck')];
    expect(follower.update(signals, lane(1), LANES, now)).toMatchObject({ lane: lane(0), reason: 'stuck' });
  });

  test('takes no failure from before the mode as news, but a stop or a mark that lasts', () => {
    const follower = new AttentionFollower();
    expect(follower.update([signal(1, 'failed'), signal(2, 'stopped')], lane(0), LANES, 100_000)).toMatchObject({
      lane: lane(2),
      reason: 'stopped',
    });
    expect(new AttentionFollower().update([signal(1, 'failed')], lane(0), LANES, 100_000)).toBeNull();
  });

  test('stays a while after it moved or the person chose a lane, then moves', () => {
    const follower = new AttentionFollower();
    let now = 100_000;
    follower.update([], lane(0), LANES, now);
    follower.chose([], now);
    now += 1000;
    expect(follower.update([signal(1, 'stuck')], lane(0), LANES, now)).toBeNull();
    now += DWELL_MS;
    expect(follower.update([signal(1, 'stuck')], lane(0), LANES, now)).toMatchObject({ lane: lane(1) });
    now += 1000;
    expect(follower.update([signal(1, 'stuck'), signal(2, 'failed')], lane(1), LANES, now)).toBeNull();
  });

  test('takes nothing from before the person chose a lane as news', () => {
    const follower = new AttentionFollower();
    let now = 100_000;
    follower.update([], lane(0), LANES, now);
    now += 1000;
    // A failure and a stop, then the person chooses a lane: neither moves the view once the wait is over.
    const before = [signal(1, 'failed'), signal(2, 'stopped')];
    follower.chose(before, now);
    now += DWELL_MS;
    expect(follower.update(before, lane(0), LANES, now)).toBeNull();
    // What comes after the choice does.
    expect(follower.update([...before, signal(1, 'stuck')], lane(0), LANES, now)).toMatchObject({
      lane: lane(1),
      reason: 'stuck',
    });
  });

  test('times a failure from when it was noted, the view moving or not', () => {
    const follower = new AttentionFollower();
    let now = 100_000;
    follower.update([], lane(0), LANES, now);
    // Noted while the view is closed: a failure stays news for its while, from then.
    now += 1000;
    follower.note([signal(1, 'failed')], now);
    now += FRESH_MS;
    expect(follower.update([signal(1, 'failed')], lane(0), LANES, now)).toBeNull();
    now += 1000;
    follower.note([signal(1, 'failed'), signal(2, 'failed')], now);
    now += 1000;
    expect(follower.update([signal(1, 'failed'), signal(2, 'failed')], lane(0), LANES, now)).toMatchObject({
      lane: lane(2),
    });
  });

  test('stays on a lane that needs attention itself: a stop or a mark while it lasts, a failure a while', () => {
    const follower = new AttentionFollower();
    let now = 100_000;
    follower.update([], lane(0), LANES, now);
    now += DWELL_MS;
    // The lane shown stands stopped: the view stays, whatever else comes.
    expect(follower.update([signal(0, 'stopped'), signal(1, 'failed')], lane(0), LANES, now)).toBeNull();
    // It goes on: the view moves to the failure, still news.
    now += 1000;
    expect(follower.update([signal(1, 'failed')], lane(0), LANES, now)).toMatchObject({ lane: lane(1) });
    // A failure holds the lane moved to for a while, past the wait.
    now += DWELL_MS;
    expect(follower.update([signal(1, 'failed'), signal(2, 'stuck')], lane(1), LANES, now)).toBeNull();
    now += HOLD_MS;
    expect(follower.update([signal(1, 'failed'), signal(2, 'stuck')], lane(1), LANES, now)).toMatchObject({
      lane: lane(2),
    });
  });

  test('forgets a failure once stale, and a stop or a mark once it ended', () => {
    const follower = new AttentionFollower();
    let now = 100_000;
    follower.update([], lane(0), LANES, now);
    follower.chose([], now);
    expect(follower.update([signal(1, 'failed'), signal(2, 'stopped')], lane(0), LANES, now)).toBeNull();
    now += FRESH_MS;
    // The failure went stale while the view waited; the stop ended.
    expect(follower.update([signal(1, 'failed')], lane(0), LANES, now)).toBeNull();
  });
});
