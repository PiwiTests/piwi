import { describe, expect, test } from 'vitest';
import {
  INSPECT_ENDED_TEXT,
  MAX_HEARD_SNAPSHOTS,
  NO_INSPECT_HEARD,
  addHeardSnapshot,
  hearInspect,
  inspectCalls,
  inspectEnd,
  inspectPageUrl,
  nextInspectTest,
  shownMoment,
  type HeardSnapshot,
  type InspectHeard,
} from '~/utils/live-inspect';

/**
 * The lane panel's Inspect as a model: the snapshots heard, each moment once and a bounded list; the calls they are of,
 * in their order, with the moments heard; the moment shown, the latest call's while the view follows, else the call
 * pinned, at the moment chosen when the call has it; what the panel keeps of the test it shows and of the lane's next
 * one as the view moves on; what it says as its view ends; and the address of a page on the instance.
 */

const heard = (call: string, phase: HeardSnapshot['phase'], worker = 0, test = 'pays'): HeardSnapshot => ({
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
  test,
});
const refusal = (refused: string, test: string | null = 'pays') =>
  ({ type: 'snapshot', shard: null, worker: 0, slot: 0, refused, test }) as const;
const MASKED = 'This project masks elements: Inspect sends no page of it.';

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

  test('a test after one of the same title shows none of its calls, even as the instance tells them again', () => {
    let state: InspectHeard = NO_INSPECT_HEARD;
    state = hearInspect(state, heard('call@1', 'before'), 'shown');
    state = hearInspect(state, heard('call@2', 'before'), 'shown');
    // The lane's next test has the same title: its first image moves the view on to it.
    state = nextInspectTest(state, 'pays');
    expect(state.shown).toEqual([]);
    state = hearInspect(state, heard('call@10', 'before'), 'shown');
    // Inspect opened again: the instance tells what it keeps, the test before's calls among them.
    for (const message of [heard('call@1', 'before'), heard('call@2', 'after'), heard('call@10', 'before')]) {
      state = hearInspect(state, message, 'shown');
    }
    expect(inspectCalls(state.shown).map((c) => c.call)).toEqual(['call@10']);
    // Another worker's call of that id is another call.
    state = hearInspect(state, heard('call@1', 'before', 1), 'shown');
    expect(inspectCalls(state.shown).map((c) => [c.call, c.worker.worker])).toEqual([
      ['call@10', 0],
      ['call@1', 1],
    ]);
  });

  test('keeps what comes of the lane’s next test, its refusal too, until the view moves on to it', () => {
    let state: InspectHeard = hearInspect(NO_INSPECT_HEARD, heard('call@1', 'before'), 'shown');
    // The test shown ended: the next one's refusal comes before its first image.
    state = hearInspect(state, refusal(MASKED, 'refunds'), 'next');
    expect(state.refused).toBeNull();
    expect(inspectCalls(state.shown).map((c) => c.call)).toEqual(['call@1']);
    state = nextInspectTest(state, 'refunds');
    expect(state.shown).toEqual([]);
    expect(state.refused).toBe(MASKED);

    // A refusal and pages heard of a test the view does not go on with are let go; one of a test of the same title
    // heard after the shown one ended is the next one's.
    state = hearInspect(NO_INSPECT_HEARD, heard('call@1', 'before'), 'shown');
    state = hearInspect(state, refusal(MASKED, 'an older test'), 'next');
    state = hearInspect(state, heard('call@7', 'before', 0, 'an older test'), 'next');
    state = hearInspect(state, heard('call@20', 'before', 0, 'pays'), 'next');
    state = hearInspect(state, heard('call@1', 'after', 0, 'pays'), 'next');
    state = nextInspectTest(state, 'pays');
    expect(state.refused).toBeNull();
    expect(inspectCalls(state.shown).map((c) => c.call)).toEqual(['call@20']);
  });

  test('says the latest of a refusal and a page: a refusal shows beside the calls listed, a page heard after it ends it', () => {
    let state: InspectHeard = hearInspect(NO_INSPECT_HEARD, heard('call@1', 'before'), 'shown');
    state = hearInspect(state, refusal(MASKED), 'shown');
    expect(state.refused).toBe(MASKED);
    expect(state.shown).toHaveLength(1);
    state = hearInspect(state, heard('call@2', 'before'), 'shown');
    expect(state.refused).toBeNull();
    state = hearInspect(state, refusal(MASKED, 'refunds'), 'next');
    state = hearInspect(state, heard('call@3', 'before', 0, 'refunds'), 'next');
    expect(nextInspectTest(state, 'refunds').refused).toBeNull();
  });

  test('says why the view ended by its reason, and never offers to open a view that cannot open', () => {
    expect(inspectEnd('run-ended')).toBe('run-ended');
    expect(inspectEnd('off')).toBe('off');
    expect(inspectEnd('test-ended')).toBe('test-ended');
    for (const reason of ['worker-left', 'replaced', 'unshared', null] as const)
      expect(inspectEnd(reason)).toBe('closed');
    expect(INSPECT_ENDED_TEXT['test-ended']).toContain('next test');
    for (const end of ['run-ended', 'off'] as const) expect(INSPECT_ENDED_TEXT[end]).not.toMatch(/\bopen/i);
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
