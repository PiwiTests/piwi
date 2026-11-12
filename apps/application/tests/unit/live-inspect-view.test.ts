import { describe, expect, test } from 'vitest';
import {
  MAX_HEARD_SNAPSHOTS,
  addHeardSnapshot,
  inspectCalls,
  inspectPageUrl,
  shownMoment,
  type HeardSnapshot,
} from '~/utils/live-inspect';

/**
 * The lane panel's Inspect as a model: the snapshots heard, each moment once and a bounded list; the calls they are of,
 * in their order, with the moments heard; the moment shown, the latest call's while the view follows, else the call
 * pinned, at the moment chosen when the call has it; and the address of a page on the instance.
 */

const heard = (call: string, phase: HeardSnapshot['phase'], worker = 0): HeardSnapshot => ({
  type: 'snapshot',
  shard: null,
  worker,
  slot: 0,
  call,
  title: `Click ${call}`,
  phase,
  page: 'page@1',
  frame: 'frame@1',
  main: true,
  full: false,
  index: 0,
  at: 1_800_000_000_000,
  test: 'pays',
});

function hear(...messages: HeardSnapshot[]): HeardSnapshot[] {
  return messages.reduce<HeardSnapshot[]>((list, message) => addHeardSnapshot(list, message), []);
}

describe('Inspect in the lane panel', () => {
  test('lists each call once with the moments heard, a moment heard again changing nothing', () => {
    const list = hear(
      heard('call@1', 'before'),
      heard('call@1', 'action'),
      heard('call@1', 'before'),
      heard('call@1', 'after'),
      heard('call@2', 'before'),
      heard('call@1', 'before', 1),
    );
    expect(list).toHaveLength(5);
    expect(inspectCalls(list).map((c) => [c.call, c.worker.worker, c.phases])).toEqual([
      ['call@1', 0, ['before', 'action', 'after']],
      ['call@2', 0, ['before']],
      ['call@1', 1, ['before']],
    ]);
    const many = Array.from({ length: MAX_HEARD_SNAPSHOTS + 5 }, (_, i) => heard(`call@${i}`, 'before'));
    const kept = hear(...many);
    expect(kept).toHaveLength(MAX_HEARD_SNAPSHOTS);
    expect(kept[0]!.call).toBe('call@5');
  });

  test('shows the latest call while it follows, else the call pinned, at the moment chosen when the call has it', () => {
    const calls = inspectCalls(
      hear(heard('call@1', 'before'), heard('call@1', 'action'), heard('call@1', 'after'), heard('call@2', 'before')),
    );
    expect(shownMoment([], null, null)).toBeNull();
    expect(shownMoment(calls, null, null)).toMatchObject({ call: 'call@2', phase: 'before' });
    expect(shownMoment(calls, null, 'after')).toMatchObject({ call: 'call@2', phase: 'before' });
    expect(shownMoment(calls, calls[0]!.key, null)).toMatchObject({ call: 'call@1', phase: 'after' });
    expect(shownMoment(calls, calls[0]!.key, 'action')).toMatchObject({ call: 'call@1', phase: 'action' });
    // A call the list no longer holds shows nothing.
    expect(shownMoment(calls, 'gone', null)).toBeNull();
  });

  test('names a page by the watch, the worker, the call and the moment, under the app’s base', () => {
    const moment = { worker: { shard: 2, worker: 3 }, call: 'call@4', title: 'Click', phase: 'action' as const };
    expect(inspectPageUrl('/demo/', 7, 'abc_DEF-123', moment, 'readonly')).toBe(
      '/demo/api/test-runs/7/live-view/watch/abc_DEF-123/snapshot?worker=3&shard=2&call=call%404&phase=action&mode=readonly',
    );
    expect(inspectPageUrl('/', 7, 'w', { ...moment, worker: { shard: null, worker: 0 } }, 'json')).toBe(
      '/api/test-runs/7/live-view/watch/w/snapshot?worker=0&call=call%404&phase=action&format=json',
    );
    expect(inspectPageUrl('', 7, 'w', moment, 'picker')).toBe(
      '/api/test-runs/7/live-view/watch/w/snapshot?worker=3&shard=2&call=call%404&phase=action',
    );
  });
});
