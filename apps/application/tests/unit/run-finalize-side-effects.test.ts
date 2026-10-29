import { describe, test, expect, vi, beforeEach } from 'vitest';

// The finalize side effects are mocked so the helper's routing can be asserted
// without a database or the real background work. Every ingest path (finish,
// upload, submit) shares this helper, so a probe run staying silent here means
// it stays silent on all three.
const computeRegressionSignals = vi.fn(() => Promise.resolve());
const syncAutoMarkersForRun = vi.fn(() => Promise.resolve());
const autoDiagnoseRun = vi.fn(() => Promise.resolve());
const emitRunNotifications = vi.fn(() => Promise.resolve());
const emitIncidentNotification = vi.fn(() => Promise.resolve());
const recordRunHealth = vi.fn(
  (_db: unknown, _id: number): Promise<{ metadata: unknown; incident: unknown; flagged: boolean } | null> =>
    Promise.resolve(null),
);
/** What the run's analysis answers: its fixed clusters and its change coverage, both settled. */
const analysis = { fixed: Promise.resolve([]), coverage: Promise.resolve(null) };
const analyzeFinishedRunInBackground = vi.fn((_db: unknown, _id: number) => analysis);
const postRunPrFeedbackInBackground = vi.fn((_db: unknown, _id: number, _analysis: unknown) => Promise.resolve());
const maybeEnqueueHealActionInBackground = vi.fn();
const inferRunOutcomes = vi.fn((_db: unknown, _id: number) => Promise.resolve());
const classifyRunFlakyTests = vi.fn((_db: unknown, _projectId: number, _runId: number) => Promise.resolve());

vi.mock('../../server/utils/compute-regression-signals', () => ({ computeRegressionSignals }));
vi.mock('../../server/utils/ai-diagnosis', () => ({ autoDiagnoseRun }));
vi.mock('../../server/utils/notifications/run-notifications', () => ({
  emitRunNotifications,
  emitIncidentNotification,
}));
vi.mock('#shared/handlers/run-health', () => ({ recordRunHealth }));
vi.mock('../../server/utils/scm/pr-feedback', () => ({
  analyzeFinishedRunInBackground,
  postRunPrFeedbackInBackground,
}));
vi.mock('../../server/utils/heal/policy', () => ({ maybeEnqueueHealActionInBackground }));
vi.mock('../../server/utils/outcome-inference', () => ({ inferRunOutcomes }));
vi.mock('#shared/handlers/markers', () => ({ syncAutoMarkersForRun }));
vi.mock('#shared/handlers/flaky-classify', () => ({ classifyRunFlakyTests }));
const matchCiRerunRun = vi.fn(() => Promise.resolve(null));
vi.mock('../../server/utils/ci-rerun', () => ({ matchCiRerunRun }));
const upsertDailyRollup = vi.fn((_db: unknown, _id: number) => Promise.resolve());
vi.mock('#shared/handlers/analytics/rollups', () => ({ upsertDailyRollup }));
const runTrackerAutomation = vi.fn((_db: unknown, _id: number) => Promise.resolve(0));
vi.mock('../../server/utils/integrations/automation', () => ({ runTrackerAutomation }));

const { runFinalizeSideEffects } = await import('../../server/utils/run-finalize-side-effects');
const { runEventBus } = await import('../../server/utils/run-events');

const db = {} as never;

const allEffects = [
  computeRegressionSignals,
  syncAutoMarkersForRun,
  classifyRunFlakyTests,
  analyzeFinishedRunInBackground,
  inferRunOutcomes,
  autoDiagnoseRun,
  emitRunNotifications,
  postRunPrFeedbackInBackground,
  maybeEnqueueHealActionInBackground,
];

/** Every finalize side effect ran once; the notifications come last, after the rules' filing. */
const everyEffectOnce = () =>
  vi.waitFor(() => {
    for (const fn of allEffects) expect(fn).toHaveBeenCalledTimes(1);
  });

/** What a run sends out once finished, beside the analysis every run gets. */
const outbound = [
  autoDiagnoseRun,
  emitRunNotifications,
  postRunPrFeedbackInBackground,
  maybeEnqueueHealActionInBackground,
];

describe('runFinalizeSideEffects', () => {
  beforeEach(() => {
    for (const fn of allEffects) fn.mockClear();
    upsertDailyRollup.mockClear();
    emitIncidentNotification.mockClear();
    recordRunHealth.mockClear();
  });

  test('a run the classifier flags sends one incident event in place of the verdicts', async () => {
    const incident = { rule: 'host-unreachable', reason: '9 of 10 tests failed', host: 'staging.example.test' };
    recordRunHealth.mockResolvedValueOnce({ metadata: { incident }, incident, flagged: true });
    await runFinalizeSideEffects(db, 42, { projectId: 1, metadata: { scm: {} } });
    await vi.waitFor(() => expect(emitIncidentNotification).toHaveBeenCalledWith(db, 42));
    expect(upsertDailyRollup).toHaveBeenCalled();
    expect(syncAutoMarkersForRun).toHaveBeenCalledTimes(1);
    for (const fn of [
      computeRegressionSignals,
      classifyRunFlakyTests,
      analyzeFinishedRunInBackground,
      inferRunOutcomes,
      ...outbound,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  test('a run already flagged is finalized again without a second incident event', async () => {
    const incident = { rule: 'person', reason: 'Marked', host: null };
    recordRunHealth.mockResolvedValueOnce({ metadata: { incident }, incident, flagged: false });
    await runFinalizeSideEffects(db, 42, { projectId: 1, metadata: { incident } });
    expect(emitIncidentNotification).not.toHaveBeenCalled();
    expect(emitRunNotifications).not.toHaveBeenCalled();
  });

  test('the incident check runs before anything else, and its failure is logged', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      recordRunHealth.mockRejectedValueOnce(new Error('classifier down'));
      await runFinalizeSideEffects(db, 42, { projectId: 1 });
      expect(errors).toHaveBeenCalledWith('[run-health] recordRunHealth failed', expect.any(Error));
      await everyEffectOnce();
    } finally {
      errors.mockRestore();
    }
  });

  test('a real run fires every finalize side effect', async () => {
    runFinalizeSideEffects(db, 42, { projectId: 1, metadata: { scm: {} } });
    await everyEffectOnce();
  });

  test.each(['bisect', 'reproduce'])('a %s run classifies no flaky root cause', async (kind) => {
    await runFinalizeSideEffects(db, 42, { projectId: 1, metadata: { piwiOrigin: { kind } } });
    await vi.waitFor(() => expect(inferRunOutcomes).toHaveBeenCalledWith(db, 42));
    expect(classifyRunFlakyTests).not.toHaveBeenCalled();
  });

  test.each([
    ['a bisect step', 'bisect', 1],
    ['a reproduction', 'reproduce', 1],
    ['an editor run', 'editor', 1],
    ['a partial editor run', 'editor', 0],
    ['a partial local run', 'local', 0],
    ['a partial desktop run', 'desktop', 0],
  ])('%s gets its analysis and its outcomes, and sends nothing', async (_name, kind, isFullRun) => {
    await runFinalizeSideEffects(db, 42, {
      projectId: 1,
      metadata: { piwiOrigin: { kind } },
      isFullRun,
      status: 'failed',
    });
    // Fix verification, change coverage and the scenario gaps, each under its own use.
    expect(analyzeFinishedRunInBackground).toHaveBeenCalledWith(db, 42);
    await vi.waitFor(() => expect(inferRunOutcomes).toHaveBeenCalledWith(db, 42));
    expect(syncAutoMarkersForRun).toHaveBeenCalledTimes(1);
    for (const fn of outbound) expect(fn).not.toHaveBeenCalled();
  });

  test('an editor run the classifier flags sends no incident event', async () => {
    const incident = { rule: 'host-unreachable', reason: '1 of 1 tests failed', host: 'localhost' };
    recordRunHealth.mockResolvedValueOnce({ metadata: { incident }, incident, flagged: true });
    await runFinalizeSideEffects(db, 42, {
      projectId: 1,
      metadata: { piwiOrigin: { kind: 'editor' } },
      isFullRun: 0,
      status: 'failed',
    });
    expect(syncAutoMarkersForRun).toHaveBeenCalledTimes(1);
    expect(emitIncidentNotification).not.toHaveBeenCalled();
    expect(emitRunNotifications).not.toHaveBeenCalled();
  });

  test('an editor run flagged as an incident sends no incident event when the caller’s metadata lacks the origin', async () => {
    const incident = { rule: 'host-unreachable', reason: '1 of 1 tests failed', host: 'localhost' };
    recordRunHealth.mockResolvedValueOnce({
      metadata: { piwiOrigin: { kind: 'editor' }, incident },
      incident,
      flagged: true,
    });
    await runFinalizeSideEffects(db, 42, { projectId: 1, metadata: { scm: {} }, isFullRun: 1, status: 'failed' });
    expect(syncAutoMarkersForRun).toHaveBeenCalledTimes(1);
    expect(emitIncidentNotification).not.toHaveBeenCalled();
    expect(emitRunNotifications).not.toHaveBeenCalled();
  });

  test.each(['local', 'desktop'])('the whole suite run from %s gets everything', async (kind) => {
    runFinalizeSideEffects(db, 42, {
      projectId: 1,
      metadata: { piwiOrigin: { kind } },
      isFullRun: 1,
      status: 'failed',
    });
    await everyEffectOnce();
    // The comment is posted from the run's own analysis.
    expect(postRunPrFeedbackInBackground).toHaveBeenCalledWith(db, 42, analysis);
  });

  test('the flaky root causes of the run are classified from its id and project', async () => {
    runFinalizeSideEffects(db, 42, { projectId: 7 });
    await vi.waitFor(() => expect(classifyRunFlakyTests).toHaveBeenCalledWith(db, 7, 42));
  });

  test('a failing flaky classification is logged and leaves the other side effects running', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      classifyRunFlakyTests.mockRejectedValueOnce(new Error('classifier down'));
      await expect(runFinalizeSideEffects(db, 42, { projectId: 1 })).resolves.toBeUndefined();
      await everyEffectOnce();
      expect(errors).toHaveBeenCalledWith('[flaky-classify] classifyRunFlakyTests failed', expect.any(Error));
    } finally {
      errors.mockRestore();
    }
  });

  test('the rules file issues once fix verification is done, and the notifications follow them', async () => {
    runTrackerAutomation.mockClear();
    let verified!: (fixed: never[]) => void;
    const fixed = new Promise<never[]>((resolve) => (verified = resolve));
    analyzeFinishedRunInBackground.mockImplementationOnce(() => ({ fixed, coverage: Promise.resolve(null) }));
    runFinalizeSideEffects(db, 42, { projectId: 1 });
    await vi.waitFor(() => expect(autoDiagnoseRun).toHaveBeenCalled());
    // A regression's reopen transition is queued by fix verification, before a rule reads the cluster.
    expect(runTrackerAutomation).not.toHaveBeenCalled();
    expect(emitRunNotifications).not.toHaveBeenCalled();
    verified([]);
    await vi.waitFor(() => expect(runTrackerAutomation).toHaveBeenCalledWith(db, 42));
    await vi.waitFor(() => expect(emitRunNotifications).toHaveBeenCalledWith(db, 42));
  });

  test('auto-heal starts once change coverage stored the run’s locator breaks', async () => {
    let stored!: () => void;
    postRunPrFeedbackInBackground.mockImplementationOnce(() => new Promise<void>((resolve) => (stored = resolve)));
    runFinalizeSideEffects(db, 42, { projectId: 1 });
    await vi.waitFor(() => expect(postRunPrFeedbackInBackground).toHaveBeenCalled());
    expect(maybeEnqueueHealActionInBackground).not.toHaveBeenCalled();
    stored();
    await vi.waitFor(() => expect(maybeEnqueueHealActionInBackground).toHaveBeenCalledWith(db, 42));
  });

  test('a probe-stamped run fires none of them', async () => {
    await runFinalizeSideEffects(db, 42, { projectId: 1, metadata: { piwiProbe: true } });
    for (const fn of allEffects) expect(fn).not.toHaveBeenCalled();
    expect(recordRunHealth).not.toHaveBeenCalled();
  });

  test('a flake-lab run fires none of them: no rollup, regression signals, notifications or pull-request feedback', async () => {
    await runFinalizeSideEffects(db, 42, {
      projectId: 1,
      metadata: { piwiFlakeLab: { experimentId: 'exp-1', armId: 'control' } },
    });
    for (const fn of allEffects) expect(fn).not.toHaveBeenCalled();
  });

  test('a run with no metadata still finalizes', async () => {
    runFinalizeSideEffects(db, 42, { projectId: 1 });
    await everyEffectOnce();
  });

  test('rollup-updated follows each write of the rollup, never comes before it', async () => {
    let release!: () => void;
    upsertDailyRollup.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const events: Array<{ type: string; projectId: number }> = [];
    const unsubscribe = runEventBus.subscribeGlobal((e) => events.push({ type: e.type, projectId: e.projectId }));
    try {
      const counted = runFinalizeSideEffects(db, 42, { projectId: 7 });
      await vi.waitFor(() => expect(upsertDailyRollup).toHaveBeenCalled());
      // The widget cache would re-cache the old numbers if the event went out before the write.
      expect(events).toEqual([]);
      release();
      await counted;
      expect(events).toEqual([{ type: 'rollup-updated', projectId: 7 }]);
      // The second write, once the regression signals are in, is announced too.
      await vi.waitFor(() => expect(events).toHaveLength(2));
      expect(upsertDailyRollup).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  test('a probe-stamped run writes no rollup and announces none', async () => {
    const events: string[] = [];
    const unsubscribe = runEventBus.subscribeGlobal((e) => events.push(e.type));
    await runFinalizeSideEffects(db, 42, { projectId: 1, metadata: { piwiProbe: true } });
    unsubscribe();
    expect(upsertDailyRollup).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe('every complete-run ingest path routes finalize through the shared helper', () => {
  // Pins the deliberate unification: a batch upload (and submit, and finish) fires
  // the full probe-aware finalize set — regression signals, markers, diagnosis,
  // notifications, PR feedback and heal — not just AI diagnosis. Reverting any
  // path to call an effect directly (bypassing the helper) breaks this.
  const read = async (rel: string) => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    return readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  };
  const paths = [
    '../../server/api/test-runs/upload.post.ts',
    '../../server/api/test-runs/submit.post.ts',
    '../../server/api/test-runs/[id]/finish.post.ts',
  ];
  for (const rel of paths) {
    test(`${rel} calls runFinalizeSideEffects and no side effect directly`, async () => {
      const src = await read(rel);
      expect(src).toContain('runFinalizeSideEffects');
      // The individual effects must only reach these endpoints through the helper.
      expect(src).not.toContain('autoDiagnoseRun(');
      expect(src).not.toContain('emitRunNotifications(');
      expect(src).not.toContain('postRunPrFeedbackInBackground(');
    });
  }
});
