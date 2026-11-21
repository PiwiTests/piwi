import { describe, expect, it } from 'vitest';
import {
  CI_READ_ONLY,
  MAX_CI_RUNS_LISTED,
  ciRunName,
  ciRunWhere,
  ciRunsListed,
  LetGoAsks,
  ciHoldKey,
  ciHoldOf,
  ciHoldWords,
  ciTally,
  heldForWords,
  isCiMetadata,
  isCiOrigin,
  offersLetGo,
  readCiHold,
  CI_CONTROL_WORDS,
  ciControlsOffered,
  ciPauseAskWords,
  readCiPauseAsk,
  ciPauseWords,
  pausedByWords,
  readCiPause,
  type CiRun,
} from '../src/ci';
import { englishRunSpeaker as en } from '../src/words';

const run = (id: number, over: Partial<CiRun> = {}): CiRun => ({
  id,
  projectId: 7,
  project: 'Shop',
  branch: 'feature/pay',
  status: 'running',
  startTime: `2026-11-12T10:${String(id % 60).padStart(2, '0')}:00.000Z`,
  total: 40,
  done: 12,
  failed: 1,
  flaky: 0,
  url: `https://piwi.example/test-runs/${id}`,
  ...over,
});

describe('the CI runs of a project in progress', () => {
  it('counts a run’s tally from the instance’s counts, never past the tests it holds', () => {
    expect(
      ciTally({ totalTests: 40, passedTests: 9, failedTests: 1, skippedTests: 1, didNotRunTests: 1, flakyTests: 2 }),
    ).toEqual({ total: 40, done: 12, failed: 1, flaky: 2 });
    // Retries counted again by the instance, and counts it does not send.
    expect(ciTally({ totalTests: 3, passedTests: 3, failedTests: 2 })).toEqual({
      total: 5,
      done: 5,
      failed: 2,
      flaky: 0,
    });
    expect(ciTally({ totalTests: 'x', passedTests: -1 })).toEqual({ total: 0, done: 0, failed: 0, flaky: 0 });
  });

  it('tells a CI run by its origin, else by the CI it names', () => {
    expect(isCiMetadata({ piwiOrigin: { kind: 'ci' } })).toBe(true);
    expect(isCiMetadata({ piwiOrigin: { kind: 'ci-rerun' }, ci: null })).toBe(true);
    expect(isCiMetadata({ piwiOrigin: { kind: 'editor', ref: 'ed-1' }, ci: { provider: 'github' } })).toBe(false);
    expect(isCiMetadata({ ci: { provider: 'github' } })).toBe(true);
    expect(isCiMetadata({ piwiOrigin: { kind: 'nonsense' } })).toBe(false);
    expect(isCiMetadata(null)).toBe(false);
    // The origin the instance lists a run with.
    expect(['ci', 'ci-rerun', 'local', 'editor', 'request', ''].map(isCiOrigin)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it('lists those still in progress, the newest first, a few at most', () => {
    const listed = ciRunsListed([
      run(1),
      run(3, { status: 'passed' }),
      run(2, { status: 'finalizing' }),
      ...Array.from({ length: 8 }, (_, i) => run(10 + i)),
    ]);
    expect(listed).toHaveLength(MAX_CI_RUNS_LISTED);
    expect(listed.map((r) => r.id)).toEqual([17, 16, 15, 14, 13]);
    expect(ciRunsListed([run(1), run(2, { status: 'finalizing' })]).map((r) => r.id)).toEqual([2, 1]);
  });

  it('names a run by its number, and says where it runs', () => {
    expect(ciRunName(run(78), en)).toBe('CI run #78');
    const where = (r: CiRun, several: boolean) => {
      const message = ciRunWhere(r, several);
      return message ? en.say(message.key, message.args) : null;
    };
    expect(where(run(78), false)).toBe('on feature/pay');
    expect(where(run(78), true)).toBe('Shop, on feature/pay');
    expect(where(run(78, { branch: null }), true)).toBe('Shop');
    expect(where(run(78, { branch: null }), false)).toBeNull();
    expect(en.say(CI_READ_ONLY.key)).toContain('nothing here steers them, except Let it go on a failure held for you');
  });
});

describe('a CI test held at its failure for its controllers', () => {
  const event = (over: Record<string, unknown> = {}) => ({
    shard: null,
    worker: 3,
    slot: 1,
    connected: true,
    holds: true,
    heldFor: ['Ana', 'Bo'],
    paused: {
      reason: 'held',
      call: { title: 'Expected "Paid", received "Pending"', file: 'tests/pay.spec.ts', line: 12 },
      test: 'pays',
      until: 1_763_727_900_000,
    },
    ...over,
  });

  it('reads the held stop of a worker that can hold from the run’s live-worker event', () => {
    expect(readCiHold(event())).toEqual({
      worker: { shard: null, worker: 3, slot: 1 },
      call: { title: 'Expected "Paid", received "Pending"', file: 'tests/pay.spec.ts', line: 12 },
      until: 1_763_727_900_000,
      heldFor: ['Ana', 'Bo'],
    });
    // A hold that names no end, and names the instance does not know.
    const bare = event({ heldFor: undefined, paused: { ...event().paused, until: 'soon' } });
    expect(readCiHold(bare)).toMatchObject({ until: null, heldFor: [] });
  });

  it('reads no hold of a worker that left, cannot hold, stands at no stop or at another', () => {
    expect(readCiHold(event({ connected: false }))).toBeNull();
    expect(readCiHold(event({ holds: undefined }))).toBeNull();
    expect(readCiHold(event({ paused: null }))).toBeNull();
    expect(readCiHold(event({ paused: { ...event().paused, reason: 'pause' } }))).toBeNull();
    expect(readCiHold(event({ worker: -1 }))).toBeNull();
    expect(readCiHold('held')).toBeNull();
  });

  it('finds a lane’s hold by its lane, else, from an older reporter, by its worker', () => {
    const hold = readCiHold(event())!;
    const older = readCiHold(event({ slot: undefined, worker: 5 }))!;
    expect(ciHoldOf([hold, older], { shard: null, slot: 1 }, 3)).toBe(hold);
    expect(ciHoldOf([hold, older], { shard: null, slot: 4 }, 5)).toBe(older);
    expect(ciHoldOf([hold, older], { shard: 2, slot: 1 }, 3)).toBeNull();
    expect(ciHoldOf([hold], { shard: null, slot: 0 }, 3)).toBeNull();
    // A hold of a worker that left the lane is not the hold of the next worker's test there.
    expect(ciHoldOf([hold], { shard: null, slot: 1 }, 5)).toBeNull();
    expect(ciHoldOf([hold], { shard: null, slot: 1 }, null)).toBe(hold);
  });

  it('says where it stands, for whom and until when, its place, and that the CI job’s timeout still runs', () => {
    const clock = (time: number) => (time === 1_763_727_900_000 ? '12:05' : '?');
    expect(ciHoldWords(readCiHold(event())!, en, clock)).toEqual({
      state: 'Failed, held at its line',
      heldFor: 'Held for Ana and Bo · until 12:05',
      place: 'tests/pay.spec.ts:12',
      note: 'The CI job’s own timeout still runs.',
    });
    const nobody = readCiHold(event({ heldFor: [], paused: { ...event().paused, call: { title: 'Timed out' } } }))!;
    expect(ciHoldWords(nobody, en, clock)).toMatchObject({ heldFor: 'Held · until 12:05', place: null });
    expect(heldForWords(undefined, ['Ana'], en, clock)).toBeNull();
    expect(heldForWords(1_763_727_900_000, ['Ana'], en, clock)).toBe('Held for Ana · until 12:05');
  });

  it('offers Let it go only on a held lane the surface’s own watch shows, as a controller’s', () => {
    const hold = readCiHold(event());
    expect(offersLetGo(hold, { shows: true, controller: true })).toBe(true);
    expect(offersLetGo(hold, { shows: true, controller: false })).toBe(false);
    expect(offersLetGo(hold, { shows: false, controller: true })).toBe(false);
    expect(offersLetGo(null, { shows: true, controller: true })).toBe(false);
  });
});

describe('a CI test paused for its controllers', () => {
  const event = (over: Record<string, unknown> = {}) => ({
    shard: null,
    worker: 3,
    slot: 1,
    connected: true,
    holds: true,
    heldFor: [],
    pauses: true,
    pausedBy: 'Ana',
    paused: {
      reason: 'pause',
      call: { title: "Click getByRole('button', { name: 'Pay' })", file: 'tests/pay.spec.ts', line: 12 },
      test: 'pays',
      until: 1_763_727_900_000,
    },
    ...over,
  });
  const running = (over: Record<string, unknown> = {}) => event({ paused: null, pausedBy: undefined, ...over });
  const CONTROLLER = { shows: true, controller: true };

  it('reads the paused stop of a worker that can pause, and who paused it', () => {
    expect(readCiPause(event())).toEqual({
      worker: { shard: null, worker: 3, slot: 1 },
      call: { title: "Click getByRole('button', { name: 'Pay' })", file: 'tests/pay.spec.ts', line: 12 },
      until: 1_763_727_900_000,
      pausedBy: 'Ana',
    });
    expect(readCiPause(event({ pausedBy: undefined }))).toMatchObject({ pausedBy: null });
    expect(readCiPause(event({ pausedBy: 'x'.repeat(300) }))!.pausedBy).toHaveLength(100);
  });

  it('reads no pause of a worker that left, cannot pause, stands at no stop or at a hold', () => {
    expect(readCiPause(event({ connected: false }))).toBeNull();
    expect(readCiPause(event({ pauses: undefined }))).toBeNull();
    expect(readCiPause(running())).toBeNull();
    expect(readCiPause(event({ paused: { ...event().paused, reason: 'held' } }))).toBeNull();
    // A local run's pause, shared live, names no end: it is no controller's.
    expect(readCiPause(event({ paused: { ...event().paused, until: undefined } }))).toBeNull();
  });

  it('says it is paused, by whom and until when, its place, and that the CI job’s timeout still runs', () => {
    const clock = (time: number) => (time === 1_763_727_900_000 ? '12:05' : '?');
    expect(ciPauseWords(readCiPause(event())!, en, clock)).toEqual({
      state: 'Paused',
      pausedBy: 'Paused by Ana · until 12:05',
      place: 'tests/pay.spec.ts:12',
      note: 'The CI job’s own timeout still runs.',
    });
    expect(pausedByWords(1_763_727_900_000, null, en, clock)).toBe('Paused · until 12:05');
    expect(pausedByWords(null, 'Ana', en, clock)).toBeNull();
  });

  it('offers a controller’s own watch Pause while the test runs, Resume and End the test while it is paused', () => {
    expect(ciControlsOffered(running(), CONTROLLER, true)).toEqual(['pause']);
    expect(ciControlsOffered(event(), CONTROLLER, true)).toEqual(['resume', 'end']);
    // No test runs, a test held at its failure, a worker that cannot pause, a watch of another lane or a Viewer's.
    expect(ciControlsOffered(running(), CONTROLLER, false)).toEqual([]);
    expect(ciControlsOffered(event({ paused: { ...event().paused, reason: 'held' } }), CONTROLLER, true)).toEqual([]);
    expect(ciControlsOffered(running({ pauses: undefined }), CONTROLLER, true)).toEqual([]);
    expect(ciControlsOffered(running(), { shows: false, controller: true }, true)).toEqual([]);
    expect(ciControlsOffered(running(), { shows: true, controller: false }, true)).toEqual([]);
    expect(ciControlsOffered(null, CONTROLLER, true)).toEqual([]);
  });

  it('reads a Pause the worker has not stopped for yet, and why it dropped the last one', () => {
    expect(readCiPauseAsk(running({ pauseAsked: { by: 'Ana' } }))).toEqual({ asked: { by: 'Ana' }, dropped: null });
    expect(readCiPauseAsk(running({ pauseAsked: {} }))).toEqual({ asked: { by: null }, dropped: null });
    expect(readCiPauseAsk(running({ pauseDropped: 'No test runs on this worker now.' }))).toEqual({
      asked: null,
      dropped: 'No test runs on this worker now.',
    });
    expect(readCiPauseAsk(running({ pauses: undefined, pauseAsked: { by: 'Ana' } }))).toEqual({
      asked: null,
      dropped: null,
    });
    expect(ciPauseAskWords({ asked: { by: 'Ana' }, dropped: null }, en)).toBe('Pause asked by Ana');
    expect(ciPauseAskWords({ asked: { by: null }, dropped: null }, en)).toBe('Pause asked');
    expect(ciPauseAskWords({ asked: null, dropped: 'Resume came before the test paused.' }, en)).toBe(
      'The Pause was dropped: Resume came before the test paused.',
    );
    expect(ciPauseAskWords({ asked: null, dropped: null }, en)).toBeNull();
  });

  it('offers Resume alone while a Pause waits for the test’s next call, which takes it back', () => {
    expect(ciControlsOffered(running({ pauseAsked: { by: 'Ana' } }), CONTROLLER, true)).toEqual(['resume']);
  });

  it('words each control as a local run’s', () => {
    expect(en.say(CI_CONTROL_WORDS.pause.label.key)).toBe('Pause');
    expect(en.say(CI_CONTROL_WORDS.resume.label.key)).toBe('Resume');
    expect(en.say(CI_CONTROL_WORDS.end.label.key)).toBe('End the test');
    expect(en.say(CI_CONTROL_WORDS.resume.title.key)).toBe('Let the test go on from where it is paused');
  });
});

describe('Let it go asked of a CI hold', () => {
  const hold = (worker: number, until: number | null = 1_763_727_900_000) => ({
    worker: { shard: null, worker, slot: 1 },
    call: { title: 'boom', file: null, line: null },
    until,
    heldFor: [],
  });

  it('names each hold of each worker apart', () => {
    expect(ciHoldKey(hold(4))).toBe(':4:1763727900000');
    expect(ciHoldKey(hold(4, null))).toBe(':4:');
    expect(ciHoldKey({ ...hold(4), worker: { shard: 2, worker: 4, slot: 1 } })).toBe('2:4:1763727900000');
  });

  it('is asked once per hold of each lane, again only after a refusal or for the lane’s next hold', () => {
    const asks = new LetGoAsks();
    expect(asks.ask('lane-2', 'a')).toBe(true);
    expect(asks.asked('lane-2', 'a')).toBe(true);
    // Asked again, the same hold waits or went through: no second ask.
    expect(asks.ask('lane-2', 'a')).toBe(false);
    // Another lane's ask is its own.
    expect(asks.asked('lane-3', 'b')).toBe(false);
    expect(asks.ask('lane-3', 'b')).toBe(true);
    asks.refused('lane-3', 'b');
    expect(asks.asked('lane-3', 'b')).toBe(false);
    expect(asks.asked('lane-2', 'a')).toBe(true);
    // The lane's next hold is asked anew.
    expect(asks.asked('lane-2', 'c')).toBe(false);
    expect(asks.ask('lane-2', 'c')).toBe(true);
    // A refusal of a hold no longer asked changes nothing.
    asks.refused('lane-2', 'a');
    expect(asks.asked('lane-2', 'c')).toBe(true);
  });
});
