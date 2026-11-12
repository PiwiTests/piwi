import { liveWorkerKey, type LiveViewEnd, type LiveViewerMessage, type LiveWorkerId } from '@piwitests/core/live-view';
import type { SnapshotPhase } from '@piwitests/core/live-inspect';
import type { DesktopInspectCalls } from '#shared/desktop-runs';

/**
 * **Inspect**, as a model `LaneInspect` renders: the snapshots of the worker's page heard of
 * (`@piwitests/core/live-inspect`), each call they are of with the moments heard (before it, at its action, after
 * it), the call and moment shown (the latest call while the view follows it, else the one the reader chose), and where
 * its pages come from and what it says (`InspectSource`). Two surfaces show it: the run page's lane panel, whose watch
 * hears each snapshot the worker sends the instance, of the test the view shows and of the lane's next one
 * (`InspectHeard`), its pages on the instance (`teamInspectSource`); and the desktop app's Local runs tray, whose
 * window hears each snapshot its server read from the test's own trace (`DesktopLaneInspect`), its pages on that server
 * (`desktopInspectSource`). Nothing here holds a page: the server renders each one.
 */

/** What a watch hears of a snapshot of its worker's page, without its JSON. */
export type HeardSnapshot = Extract<LiveViewerMessage, { type: 'snapshot'; call: string }>;
/** What a watch hears for Inspect: a snapshot of its worker's page, or why the worker sends none. */
export type InspectNotice = Extract<LiveViewerMessage, { type: 'snapshot' }>;

/** The most snapshots the panel lists: past them, the oldest go. */
export const MAX_HEARD_SNAPSHOTS = 600;

/** The moments of a call, in the order Playwright takes them, with the words the panel names each by. */
export const SNAPSHOT_PHASES: ReadonlyArray<{ key: SnapshotPhase; label: string; words: string }> = [
  { key: 'before', label: 'Before', words: 'before it' },
  { key: 'action', label: 'Action', words: 'at its action' },
  { key: 'after', label: 'After', words: 'after it' },
];

/** A call whose page was heard of: its worker, its id and title, and the moments heard, in the order they came. */
export interface InspectCall {
  key: string;
  worker: LiveWorkerId;
  call: string;
  title: string;
  phases: SnapshotPhase[];
}

/** A call's moment the panel shows. */
export interface InspectMoment {
  worker: LiveWorkerId;
  call: string;
  title: string;
  phase: SnapshotPhase;
}

/** The key of a call of a worker, which the panel picks it by. */
export function inspectCallKey(worker: LiveWorkerId, call: string): string {
  return `${liveWorkerKey(worker)}#${call}`;
}

function workerOf(message: HeardSnapshot): LiveWorkerId {
  return {
    shard: message.shard,
    worker: message.worker,
    ...(message.slot === undefined ? {} : { slot: message.slot }),
  };
}

/**
 * The snapshots heard, with `message`: one of a call's moment heard already (the instance tells a watch what it keeps
 * as Inspect opens) changes nothing; past `MAX_HEARD_SNAPSHOTS`, the oldest go.
 */
export function addHeardSnapshot(heard: readonly HeardSnapshot[], message: HeardSnapshot): HeardSnapshot[] {
  const key = inspectCallKey(workerOf(message), message.call);
  if (heard.some((s) => s.phase === message.phase && inspectCallKey(workerOf(s), s.call) === key)) {
    return heard as HeardSnapshot[];
  }
  return [...heard, message].slice(-MAX_HEARD_SNAPSHOTS);
}

/**
 * What the lane panel heard for Inspect. Of the test the view shows: its snapshots (`shown`), and why the worker sends
 * none (`refused`), the latest of the two winning. Of the lane's next test, heard after the test shown ended or naming
 * a test the view does not show: its snapshots and its refusal (`next`, `nextRefused`), which become the shown test's
 * as the view moves on to it. The calls of the tests shown before (`gone`, by key): a snapshot of one heard again, as
 * the instance tells a watch what it keeps as Inspect opens, is not shown.
 */
export interface InspectHeard {
  shown: HeardSnapshot[];
  refused: string | null;
  next: HeardSnapshot[];
  nextRefused: { test: string | null; text: string } | null;
  gone: ReadonlySet<string>;
}

/** Nothing heard: a view that opens, or shows another worker or row. */
export const NO_INSPECT_HEARD: InspectHeard = {
  shown: [],
  refused: null,
  next: [],
  nextRefused: null,
  gone: new Set(),
};

/** The most calls of the tests shown before the panel keeps apart: past them, the oldest are forgotten. */
const MAX_GONE_CALLS = 4 * MAX_HEARD_SNAPSHOTS;

/** `heard` with `message`, of the test the view shows or of the lane's next one (`of`). */
export function hearInspect(heard: InspectHeard, message: InspectNotice, of: 'shown' | 'next'): InspectHeard {
  if ('refused' in message) {
    return of === 'shown'
      ? { ...heard, refused: message.refused }
      : { ...heard, nextRefused: { test: message.test, text: message.refused } };
  }
  if (heard.gone.has(inspectCallKey(workerOf(message), message.call))) return heard;
  if (of === 'shown') return { ...heard, shown: addHeardSnapshot(heard.shown, message), refused: null };
  const nextRefused = heard.nextRefused?.test === message.test ? null : heard.nextRefused;
  return { ...heard, next: addHeardSnapshot(heard.next, message), nextRefused };
}

/**
 * The view moves on to the lane's next test, `test` (another test, or the next of the same title): the calls of the
 * test it showed are gone, and what came of `test` ahead of it is shown.
 */
export function nextInspectTest(heard: InspectHeard, test: string): InspectHeard {
  const gone = new Set(heard.gone);
  for (const message of heard.shown) gone.add(inspectCallKey(workerOf(message), message.call));
  for (const key of gone) {
    if (gone.size <= MAX_GONE_CALLS) break;
    gone.delete(key);
  }
  const ofTest = (title: string | null) => title === null || title === test;
  const shown = heard.next.filter(
    (message) => ofTest(message.test) && !gone.has(inspectCallKey(workerOf(message), message.call)),
  );
  const refused = heard.nextRefused && ofTest(heard.nextRefused.test) ? heard.nextRefused.text : null;
  return { shown, refused, next: [], nextRefused: null, gone };
}

/** The calls the snapshots heard are of, in the order their first snapshot came. */
export function inspectCalls(heard: readonly HeardSnapshot[]): InspectCall[] {
  const calls = new Map<string, InspectCall>();
  for (const message of heard) {
    const worker = workerOf(message);
    const key = inspectCallKey(worker, message.call);
    const known = calls.get(key);
    if (known) known.phases.push(message.phase);
    else calls.set(key, { key, worker, call: message.call, title: message.title, phases: [message.phase] });
  }
  return [...calls.values()];
}

/**
 * The moment the panel shows: of the latest call while it follows (`pinned` null), else of the call pinned while the
 * list still holds it; at the moment chosen (`phase`) when that call has it, else at its latest heard. Null for none.
 */
export function shownMoment(
  calls: readonly InspectCall[],
  pinned: string | null,
  phase: SnapshotPhase | null,
): InspectMoment | null {
  const call = pinned === null ? calls.at(-1) : calls.find((c) => c.key === pinned);
  if (!call) return null;
  const shown = phase && call.phases.includes(phase) ? phase : call.phases.at(-1)!;
  return { worker: call.worker, call: call.call, title: call.title, phase: shown };
}

/**
 * The address of the page at a moment, as the watch `watch` of run `runId` reads it: the read-only render, the
 * picker's (`mode` left for the picker to add) or its viewport (`json`).
 */
export function inspectPageUrl(
  base: string,
  runId: number,
  watch: string,
  moment: InspectMoment,
  as: 'readonly' | 'picker' | 'json',
): string {
  const query = new URLSearchParams({ worker: String(moment.worker.worker) });
  if (moment.worker.shard !== null) query.set('shard', String(moment.worker.shard));
  query.set('call', moment.call);
  query.set('phase', moment.phase);
  if (as === 'readonly') query.set('mode', 'readonly');
  if (as === 'json') query.set('format', 'json');
  const path = `/api/test-runs/${runId}/live-view/watch/${encodeURIComponent(watch)}/snapshot`;
  return `${base.replace(/\/$/, '')}${path}?${query}`;
}

/**
 * The address of the page at a moment of a lane the desktop app's window `viewer` has Inspect open on, as its server
 * serves it: the read-only render, the picker's (`mode` left for the picker to add) or its viewport (`json`).
 */
export function desktopInspectPageUrl(
  base: string,
  viewer: string,
  at: { ref: string; lane: number },
  moment: InspectMoment,
  as: 'readonly' | 'picker' | 'json',
): string {
  const query = new URLSearchParams({ viewer, ref: at.ref, lane: String(at.lane), call: moment.call });
  query.set('phase', moment.phase);
  if (as === 'readonly') query.set('mode', 'readonly');
  if (as === 'json') query.set('format', 'json');
  return `${base.replace(/\/$/, '')}/api/desktop/runs/inspect/page?${query}`;
}

/**
 * Why the lane panel's view ended, as Inspect says it: the run ended, the live view was turned off, the test ended,
 * or the view closed.
 */
export type InspectEnd = 'run-ended' | 'off' | 'test-ended' | 'closed';

/** Why the view ended, from the end the instance said, null when it said none. */
export function inspectEnd(reason: LiveViewEnd | null): InspectEnd {
  return reason === 'run-ended' || reason === 'off' || reason === 'test-ended' ? reason : 'closed';
}

/** What Inspect says once the test it shows ended, while the view waits for the lane's next. */
export const INSPECT_TEST_ENDED = 'The test ended: the instance let its pages go. The next test’s come as it runs.';

/** What Inspect says once its view ended, by why. */
export const INSPECT_ENDED_TEXT: Record<InspectEnd, string> = {
  'run-ended': 'The run ended: the instance let its pages go.',
  off: 'The project’s live view was turned off: the instance let this run’s pages go.',
  'test-ended': 'The test ended: the next test’s pages come as it runs, in the worker’s view of it.',
  closed: 'The view closed: Inspect shows a test’s pages while the worker’s view of it is open.',
};

/** What Inspect says, by where its pages come from. */
export interface InspectWords {
  /** While the connection its pages are read through is not open. */
  connecting: string;
  /** Why **Pick a locator** is off meanwhile. */
  pickConnecting: string;
  /** While no page of the test came yet. */
  waiting: string;
  /** Once the test ended, while the view waits for the lane's next. */
  testEnded: string;
  /** Once the view ended, by why. */
  ended: Record<InspectEnd, string>;
  /** Under the view: where its pages come from, and what is kept of them. */
  note: string;
  /** The name of the list of calls, which says where their pages come from. */
  calls: string;
  /** Where the picker says the page came from: `Rendered from the page <from> at <call>`. */
  from: string;
}

/**
 * Where **Inspect** reads its pages, and what it says: the address of the page at a moment (`pageUrl`: the read-only
 * render, the picker's, or its viewport as JSON), null while the connection it reads them through is not open.
 */
export interface InspectSource {
  pageUrl: ((moment: InspectMoment, as: 'readonly' | 'picker' | 'json') => string) | null;
  words: InspectWords;
}

/** What the run page's Inspect says: the worker sends the pages, and the instance keeps them. */
export const TEAM_INSPECT_WORDS: InspectWords = {
  connecting: 'Waiting for the view’s connection…',
  pickConnecting: 'The view’s connection is opening again: pick a locator once it is open.',
  waiting:
    'Waiting for the page at the test’s next call. The worker sends one before each call, at its action and after it.',
  testEnded: INSPECT_TEST_ENDED,
  ended: INSPECT_ENDED_TEXT,
  note: 'The worker sends these pages only while Inspect is open, without their scripts and with the values of their secret fields removed. The instance keeps them in memory until the run ends.',
  calls: 'The calls whose page the worker sent, the latest last',
  from: 'the worker sent',
};

/** The run page's Inspect, through the watch `watchId` of run `runId` (null while it is not open). */
export function teamInspectSource(base: string, runId: number, watchId: string | null): InspectSource {
  return {
    pageUrl: watchId === null ? null : (moment, as) => inspectPageUrl(base, runId, watchId, moment, as),
    words: TEAM_INSPECT_WORDS,
  };
}

/** What the tray's Inspect says: the desktop app reads the pages from the test's own trace, on this machine. */
export const DESKTOP_INSPECT_VIEW_WORDS: InspectWords = {
  connecting: 'Waiting for the window’s connection to the runs…',
  pickConnecting: 'The window’s connection to the runs is opening again: pick a locator once it is open.',
  waiting:
    'Waiting for the page at the test’s next call. Its trace takes one before each call, at its action and after it.',
  testEnded: 'The test ended: the desktop app let its pages go. The next test’s come as it runs.',
  ended: {
    'run-ended': 'The run ended: the desktop app let its pages go.',
    off: 'Inspect closed: the desktop app let this test’s pages go.',
    'test-ended': 'The test ended: the next test’s pages come as it runs.',
    closed: 'Inspect closed: the desktop app let this test’s pages go.',
  },
  note: 'The desktop app reads these pages from the test’s own trace on this machine while Inspect is open, without their scripts and with the values of their secret fields removed, and keeps them in memory until the test ends.',
  calls: 'The calls whose page the desktop app read from the test’s trace, the latest last',
  from: 'its trace took',
};

/** The tray's Inspect of the lane `at`, through the window's stream `viewer` (null while it is not open). */
export function desktopInspectSource(
  base: string,
  viewer: string | null,
  at: { ref: string; lane: number },
): InspectSource {
  return {
    pageUrl: viewer === null ? null : (moment, as) => desktopInspectPageUrl(base, viewer, at, moment, as),
    words: DESKTOP_INSPECT_VIEW_WORDS,
  };
}

/**
 * What the tray heard for Inspect of a lane: the attempt its server follows (`attempt`, the lane's running test and
 * its retry, null between tests), counted as it changes (`turn`, which starts the view afresh), the snapshots read of
 * it in the order they were taken, and why no page of it shows, the latest of the two winning. The attempts it
 * followed, the latest last (`followed`): what is said of one before the latest is late, and changes nothing. How many
 * times the stream said something of the lane (`said`): a listing asked before the latest may be older than it.
 */
export interface DesktopLaneInspect {
  attempt: string | null;
  turn: number;
  heard: HeardSnapshot[];
  refused: string | null;
  followed: string[];
  said: number;
}

/** Nothing heard yet: Inspect just opened on the lane. */
export const NO_DESKTOP_INSPECT: DesktopLaneInspect = {
  attempt: null,
  turn: 0,
  heard: [],
  refused: null,
  followed: [],
  said: 0,
};

/** The most attempts the tray remembers it followed: past them, the oldest are forgotten. */
const MAX_FOLLOWED_ATTEMPTS = 64;

/** Whether `attempt` is one the view followed before the latest it followed: what is said of it is late. */
function attemptLeft(inspect: DesktopLaneInspect, attempt: string | null): boolean {
  return attempt !== null && attempt !== inspect.followed.at(-1) && inspect.followed.includes(attempt);
}

/** The view on `attempt`: another one starts it afresh. */
function followAttempt(inspect: DesktopLaneInspect, attempt: string | null): DesktopLaneInspect {
  if (attempt === inspect.attempt) return inspect;
  const followed =
    attempt === null || attempt === inspect.followed.at(-1)
      ? inspect.followed
      : [...inspect.followed, attempt].slice(-MAX_FOLLOWED_ATTEMPTS);
  return { ...inspect, attempt, turn: inspect.turn + 1, heard: [], refused: null, followed };
}

/** The order snapshots were taken in: by when, and in one frame by their place in its chain. */
function takenBefore(a: HeardSnapshot, b: HeardSnapshot): number {
  return a.at - b.at || (a.frame === b.frame ? a.index - b.index : 0);
}

/**
 * `heard` with `more`, each moment of a call once, in the order they were taken, whichever came first; past
 * `MAX_HEARD_SNAPSHOTS`, the earliest taken go.
 */
function addDesktopSnapshots(heard: readonly HeardSnapshot[], more: readonly HeardSnapshot[]): HeardSnapshot[] {
  const momentKey = (message: HeardSnapshot) => `${inspectCallKey(workerOf(message), message.call)}\n${message.phase}`;
  const keys = new Set(heard.map(momentKey));
  const all = [...heard];
  for (const message of more) {
    const key = momentKey(message);
    if (keys.has(key)) continue;
    keys.add(key);
    all.push(message);
  }
  return all.length === heard.length ? (heard as HeardSnapshot[]) : all.sort(takenBefore).slice(-MAX_HEARD_SNAPSHOTS);
}

/**
 * `inspect` with what the stream said of the lane (`event`): of another attempt, the view starts afresh, but of one it
 * followed before the latest, nothing changes; a snapshot of it is heard once, where it was taken; why none shows
 * replaces what showed, until a snapshot comes; the attempt alone, said again, clears why none showed.
 */
export function hearDesktopInspect(
  inspect: DesktopLaneInspect,
  event: { attempt: string | null; snapshot?: HeardSnapshot; refused?: string },
): DesktopLaneInspect {
  if (attemptLeft(inspect, event.attempt)) return inspect;
  const next = followAttempt({ ...inspect, said: inspect.said + 1 }, event.attempt);
  if (event.snapshot) return { ...next, heard: addDesktopSnapshots(next.heard, [event.snapshot]), refused: null };
  if (event.refused) return { ...next, refused: event.refused };
  return next.turn === inspect.turn ? { ...next, refused: null } : next;
}

/**
 * `inspect` with what the server listed as the window opened Inspect (`calls`), asked when the stream had said `asked`
 * things of the lane. Of an attempt the view followed before the latest, nothing changes. When the stream said nothing
 * since, the listing is all the server keeps of the lane: its attempt (another one starting the view afresh), its
 * snapshots and why none shows replace what the view held. Otherwise the stream may have said more since: the
 * listing's snapshots of the attempt the view follows join those it holds, and the rest of it is older than the stream.
 */
export function hearDesktopCalls(
  inspect: DesktopLaneInspect,
  calls: DesktopInspectCalls,
  asked: number,
): DesktopLaneInspect {
  if (attemptLeft(inspect, calls.attempt)) return inspect;
  if (inspect.said === asked) {
    const next = followAttempt(inspect, calls.attempt);
    return { ...next, heard: addDesktopSnapshots([], calls.heard), refused: calls.refused };
  }
  if (calls.attempt !== inspect.attempt) return inspect;
  return { ...inspect, heard: addDesktopSnapshots(inspect.heard, calls.heard) };
}
