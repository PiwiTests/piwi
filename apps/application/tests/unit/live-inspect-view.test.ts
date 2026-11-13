import { describe, expect, test } from 'vitest';
import {
  DESKTOP_INSPECT_VIEW_WORDS,
  INSPECT_ENDED_TEXT,
  MAX_HEARD_SNAPSHOTS,
  NO_DESKTOP_INSPECT,
  NO_INSPECT_HEARD,
  TEAM_INSPECT_WORDS,
  addHeardSnapshot,
  desktopInspectPageUrl,
  desktopInspectSource,
  hearDesktopCalls,
  hearDesktopInspect,
  hearInspect,
  inspectCalls,
  inspectEnd,
  inspectPageUrl,
  nextInspectTest,
  shownMoment,
  teamInspectSource,
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

describe('Inspect’s sources', () => {
  const moment = { worker: { shard: null, worker: 5 }, call: 'call@4', title: 'Click', phase: 'after' as const };

  test('reads the run page’s pages on the instance through its watch, none while the watch is not open', () => {
    const team = teamInspectSource('/demo/', 7, 'w1');
    expect(team.words).toBe(TEAM_INSPECT_WORDS);
    expect(team.pageUrl!(moment, 'json')).toBe(inspectPageUrl('/demo/', 7, 'w1', moment, 'json'));
    expect(teamInspectSource('/', 7, null).pageUrl).toBeNull();
  });

  test('reads the tray’s pages on the desktop app’s server through the window’s stream, by run and lane', () => {
    const at = { ref: 'desktop-41', lane: 2 };
    expect(desktopInspectPageUrl('/', 'f'.repeat(32), at, moment, 'readonly')).toBe(
      `/api/desktop/runs/inspect/page?viewer=${'f'.repeat(32)}&ref=desktop-41&lane=2&call=call%404&phase=after&mode=readonly`,
    );
    expect(desktopInspectPageUrl('/', 'v', at, moment, 'picker')).toBe(
      '/api/desktop/runs/inspect/page?viewer=v&ref=desktop-41&lane=2&call=call%404&phase=after',
    );
    const desktop = desktopInspectSource('/', null, at);
    expect(desktop.pageUrl).toBeNull();
    expect(desktop.words).toBe(DESKTOP_INSPECT_VIEW_WORDS);
    // Its words say where the pages come from: never the instance, nor a worker that sends them.
    for (const text of [
      DESKTOP_INSPECT_VIEW_WORDS.note,
      DESKTOP_INSPECT_VIEW_WORDS.testEnded,
      DESKTOP_INSPECT_VIEW_WORDS.waiting,
      DESKTOP_INSPECT_VIEW_WORDS.calls,
    ]) {
      expect(text).not.toMatch(/instance|worker sen/);
    }
    expect(DESKTOP_INSPECT_VIEW_WORDS.calls).toMatch(/from the test’s trace/);
    expect(TEAM_INSPECT_WORDS.calls).toMatch(/the worker sent/);
  });

  /** A snapshot the tray heard, taken `at` milliseconds into the test. */
  const taken = (call: string, phase: HeardSnapshot['phase'], at: number): HeardSnapshot => ({
    ...heard(call, phase),
    slot: undefined,
    index: at,
    at: 1_800_000_000_000 + at,
  });
  const calls = (inspect: { heard: readonly HeardSnapshot[] }) => inspect.heard.map((h) => `${h.call} ${h.phase}`);

  test('hears the tray’s Inspect: the attempt it follows, each snapshot once, why none shows, until the next attempt', () => {
    const opened = hearDesktopInspect(NO_DESKTOP_INSPECT, { attempt: 't1#0' });
    expect(opened).toMatchObject({ attempt: 't1#0', turn: 1, heard: [], refused: null });
    const untraced = 'This test’s attempt is not traced.';
    const refused = hearDesktopInspect(opened, { attempt: 't1#0', refused: untraced });
    expect(refused.refused).toBe(untraced);
    // The same attempt said again: why none showed goes.
    expect(hearDesktopInspect(refused, { attempt: 't1#0' })).toMatchObject({ turn: 1, refused: null });
    const one = hearDesktopInspect(refused, { attempt: 't1#0', snapshot: heard('call@1', 'after') });
    expect(one).toMatchObject({ turn: 1, refused: null });
    expect(hearDesktopInspect(one, { attempt: 't1#0', snapshot: heard('call@1', 'after') }).heard).toHaveLength(1);
    // What the server listed as Inspect opened, with what was heard already, once each.
    const listed = hearDesktopCalls(
      one,
      { attempt: 't1#0', heard: [heard('call@1', 'after'), heard('call@2', 'before')], refused: null },
      one.said,
    );
    expect(listed.heard.map((h) => h.call)).toEqual(['call@1', 'call@2']);
    // Another attempt, or none: the view starts afresh.
    expect(hearDesktopInspect(listed, { attempt: null })).toMatchObject({
      attempt: null,
      turn: 2,
      heard: [],
      refused: null,
    });
    expect(hearDesktopInspect(listed, { attempt: 't2#0', snapshot: heard('call@9', 'before') })).toMatchObject({
      attempt: 't2#0',
      turn: 2,
      heard: [expect.objectContaining({ call: 'call@9' })],
    });
  });

  test('lists the tray’s snapshots in the order they were taken, whether the stream or the listing brought each first', () => {
    // The stream said the latest before the listing of what the server read came back: the latest call stays last.
    const opened = hearDesktopInspect(NO_DESKTOP_INSPECT, { attempt: 't1#0' });
    const asked = opened.said;
    const early = hearDesktopInspect(opened, { attempt: 't1#0', snapshot: taken('call@3', 'after', 30) });
    const listed = hearDesktopCalls(
      early,
      {
        attempt: 't1#0',
        heard: [taken('call@1', 'after', 10), taken('call@2', 'after', 20), taken('call@3', 'after', 30)],
        refused: null,
      },
      asked,
    );
    expect(calls(listed)).toEqual(['call@1 after', 'call@2 after', 'call@3 after']);
    expect(shownMoment(inspectCalls(listed.heard), null, null)?.call).toBe('call@3');
    expect(listed.turn).toBe(early.turn);
    // A snapshot the stream says late lands where it was taken; one taken in the same millisecond, by its index.
    const late = hearDesktopInspect(listed, { attempt: 't1#0', snapshot: taken('call@2', 'before', 15) });
    expect(calls(late)).toEqual(['call@1 after', 'call@2 before', 'call@2 after', 'call@3 after']);
    const tie = { ...taken('call@4', 'before', 30), index: 29 };
    expect(calls(hearDesktopInspect(late, { attempt: 't1#0', snapshot: tie })).slice(-2)).toEqual([
      'call@4 before',
      'call@3 after',
    ]);
    // Past the most the view lists, the earliest taken go.
    let many = opened;
    for (let at = MAX_HEARD_SNAPSHOTS + 1; at > 0; at--) {
      many = hearDesktopInspect(many, { attempt: 't1#0', snapshot: taken(`call@${at}`, 'after', at) });
    }
    expect(many.heard).toHaveLength(MAX_HEARD_SNAPSHOTS);
    expect(many.heard[0]!.call).toBe('call@2');
    expect(many.heard.at(-1)!.call).toBe(`call@${MAX_HEARD_SNAPSHOTS + 1}`);
  });

  test('keeps the tray’s view on the attempt the stream follows: a listing or an event of an older one changes nothing', () => {
    const untraced = 'This test’s attempt is not traced.';
    const first = hearDesktopInspect(hearDesktopInspect(NO_DESKTOP_INSPECT, { attempt: 't1#0' }), {
      attempt: 't1#0',
      snapshot: taken('call@1', 'after', 10),
    });
    // The lane moved on to its next attempt after the server listed the one before: the listing is too old.
    const asked = first.said;
    const moved = hearDesktopInspect(first, { attempt: 't2#0' });
    const stale = { attempt: 't1#0', heard: [taken('call@1', 'after', 10)], refused: untraced };
    expect(hearDesktopCalls(moved, stale, asked)).toBe(moved);
    // The same, the view never having followed the older one: the stream spoke since the window asked.
    const fresh = hearDesktopInspect(NO_DESKTOP_INSPECT, { attempt: 't2#0' });
    expect(hearDesktopCalls(fresh, stale, NO_DESKTOP_INSPECT.said)).toBe(fresh);
    // Nor its refusal: the stream said the attempt since, which a refusal said before it does not outlast.
    const sameAttempt = hearDesktopCalls(first, { ...stale, heard: [] }, NO_DESKTOP_INSPECT.said);
    expect(sameAttempt.refused).toBeNull();
    // Of the attempt the view follows, its snapshots join it all the same.
    const joined = hearDesktopCalls(
      moved,
      { attempt: 't2#0', heard: [taken('call@5', 'before', 50)], refused: null },
      asked,
    );
    expect(calls(joined)).toEqual(['call@5 before']);
    // Nothing said since it asked: the listing is all the server keeps, its attempt, snapshots and refusal.
    const caughtUp = hearDesktopCalls(
      first,
      { attempt: 't2#0', heard: [taken('call@5', 'before', 50)], refused: untraced },
      first.said,
    );
    expect(caughtUp).toMatchObject({ attempt: 't2#0', turn: first.turn + 1, refused: untraced });
    expect(calls(caughtUp)).toEqual(['call@5 before']);
    // An event of the attempt left, late on the stream after the listing moved the view on, changes nothing.
    expect(hearDesktopInspect(caughtUp, { attempt: 't1#0', snapshot: taken('call@2', 'after', 20) })).toBe(caughtUp);
    expect(hearDesktopInspect(caughtUp, { attempt: 't1#0', refused: untraced })).toBe(caughtUp);
    expect(hearDesktopCalls(caughtUp, stale, caughtUp.said)).toBe(caughtUp);
    // Between tests, then the next: the view follows them, and what the attempts left said still changes nothing.
    const between = hearDesktopInspect(caughtUp, { attempt: null });
    const next = hearDesktopInspect(between, { attempt: 't3#0' });
    expect(next).toMatchObject({ attempt: 't3#0', turn: caughtUp.turn + 2 });
    expect(hearDesktopInspect(next, { attempt: 't2#0', snapshot: taken('call@6', 'after', 60) })).toBe(next);
  });
});
