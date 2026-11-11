import { getDatabase } from '../../../database';
import { testRuns } from '../../../database/schema';
import { eq, sql } from 'drizzle-orm';
import { runEventBus } from '../../../utils/run-events';
import { liveAsks } from '../../../utils/live-asks';
import { persistRunCases, type RunCaseInput } from '../../../utils/persist-run-cases';
import { mapWireCaseToRunCase } from '../../../utils/map-wire-case';
import { runningCaseKey } from '../../../utils/inserted-run-cases';
import { mapStepEventsToRunEvents } from '../../../utils/map-step-events';
import { testBeginData, testStopRunEvent, testCompletedData } from '../../../utils/live-case-events';
import { resolveIngestLimits } from '../../../utils/ingest-limits';
import { authorizeStreamToken, requireStreamingRun } from '../../../utils/stream-auth';
import { RUN_TOKEN_HEADER } from '@piwitests/core/wire';
import { wireCaseProblem } from '../../../utils/wire-case-problem';
import type { StreamEventPayload } from '#shared/types';
import { countFailedFromTally } from '#shared/utils/test-counts';
import { requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Submit test case events for a streaming run',
    description:
      "Submit test case begin, complete and step lifecycle events, and a test's stops (`test-stopped`, with its `stop`, and `test-resumed`, with `pausedMs`, from a run outside CI), for an active streaming test run. Requires the stream token. Supports both single and batch event submission for real-time progress updates. Test-attached step events (step-begin/step-end) are streamed to subscribers in the order submitted, without persistence; suite-level hook events keep the timeline shape. The response's `watched` is true while anyone has the run's live stream open; the reporter sends step events only then, and stop events whoever watches. A stop stays on its running test, for the stream's catch-up, until the test goes on or completes, and the time it stood stopped is left out of the run page's **Stuck?** mark. A `complete` event with a field of the wrong type is left out, and the rest of the batch stored. The answer's `ask` (`{ id, by }`, once) is a teammate's ask to watch the run (Ask to watch), the oldest of the run not handed over yet, for the reporter to put to the developer; the body's `askAnswer` (`{ id, answer: 'not-now' }`) is the developer's answer to an ask of this run. The body takes up to 10 MB (413 past it); a run that does not exist answers 404, and one that is neither running nor interrupted 409, before it is read.",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'X-Piwi-Run-Token',
        in: 'header',
        required: false,
        description:
          'The stream token of the body, checked before the body is read. A run of reporter 0.65.0 or later needs it: 401 without it, 403 for one that is not the run’s.',
        schema: { type: 'string' },
      },
    ],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              streamToken: { type: 'string' },
              testCases: { type: 'array', items: { type: 'object' } },
              testCase: { type: 'object' },
              askAnswer: {
                type: 'object',
                properties: { id: { type: 'string' }, answer: { type: 'string', enum: ['not-now'] } },
              },
            },
            required: ['streamToken'],
          },
        },
      },
    },
  },
});

/** Whether a streamed result can be stored; one that cannot leaves the run's running tests and is logged. */
function isStorableResult(runId: number, tc: StreamEventPayload): boolean {
  const problem = wireCaseProblem(tc);
  if (!problem) return true;
  runEventBus.clearRunningCase(runId, runningCaseKey(tc));
  console.warn(`[events] Run #${runId}: left out the result of "${tc.title}", whose ${problem} cannot be stored`);
  return false;
}

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const db = await getDatabase();
  // The body-limit middleware holds the batch to MAX_EVENT_BATCH_BYTES (server/utils/body-limit.ts).
  await requireStreamingRun(db, id, 'events', getRequestHeader(event, RUN_TOKEN_HEADER));

  const body = await readBody(event);

  // Validate stream token
  if (!body.streamToken) {
    throw apiError({
      statusCode: 401,
      message: 'Missing stream token',
    });
  }

  const { projectId } = await authorizeStreamToken(db, id, body.streamToken);
  liveAsks.answer(id, body.askAnswer);

  // Process test cases (supports single or batch)
  const testCaseEvents = Array.isArray(body.testCases) ? body.testCases : [body.testCase];

  // Playwright accepts an empty title.
  const validEvents = testCaseEvents.filter((tc: { title?: unknown }) => tc && typeof tc.title === 'string');

  // Split into begin and complete events; step events keep their batch order. A result whose fields the database
  // cannot hold is left out, so it fails neither the batch nor the reporter's retries of it.
  const beginEvents = validEvents.filter((tc: { type?: string }) => tc.type === 'begin');
  const completeEvents = validEvents.filter(
    (tc: StreamEventPayload) => tc.type === 'complete' && isStorableResult(id, tc),
  );
  const stepRunEvents = mapStepEventsToRunEvents(validEvents);

  // What each running case's last event in the batch is: a retry's begin may follow its previous attempt's complete,
  // and a short test's complete its begin, and the running case keeps the last.
  const lastOf = new Map<string, 'begin' | 'complete'>();
  for (const tc of validEvents as Array<{ type?: string } & Parameters<typeof runningCaseKey>[0]>) {
    if (tc.type === 'begin' || tc.type === 'complete') lastOf.set(runningCaseKey(tc), tc.type);
  }

  // --- Handle begin events (test started, no DB persistence needed) ---
  for (const tc of beginEvents) {
    // When the reporter sent no start, when the begin came: the run page and the stuck check count from it.
    const beginData = testBeginData(tc, Date.now(), resolveIngestLimits().locks);
    runEventBus.publish(id, { type: 'test-begin', data: beginData });
    // A running case has no DB row until it completes, so remember its begin
    // payload for the stream catch-up; the matching complete event clears it.
    if (lastOf.get(runningCaseKey(tc)) === 'begin') runEventBus.recordRunningCase(id, runningCaseKey(tc), beginData);
  }

  // --- Handle stop events (a test outside CI stopped, or went on), in batch order, after the begins ---
  for (const tc of validEvents as StreamEventPayload[]) {
    const stopEvent = testStopRunEvent(tc, runEventBus.getRunningCase(id, runningCaseKey(tc)));
    if (stopEvent) runEventBus.publish(id, stopEvent);
  }

  // --- Handle step events (live step readout + suite-level hooks), in batch order ---
  for (const stepEvent of stepRunEvents) runEventBus.publish(id, stepEvent);
  // The step each worker is in, for the stream's catch-up: steps and completions in batch order.
  runEventBus.noteLiveSteps(id, validEvents, body.streamToken);

  // --- Handle complete events (test finished, persist to DB) ---
  if (completeEvents.length === 0) {
    return {
      success: true,
      processed: beginEvents.length + stepRunEvents.length,
      watched: runEventBus.answerWatched(id, body.streamToken),
      ...liveAsks.handOverAnswer(id),
    };
  }

  const cases: RunCaseInput[] = completeEvents.map((tc: StreamEventPayload) => mapWireCaseToRunCase(tc));

  const insertedRunCases = await persistRunCases(db, projectId, id, cases);

  // Derive per-status counts from the newly inserted rows (the DB unique
  // constraint skips duplicates), to accumulate live progress counters.
  const insertedStatusCounts = insertedRunCases.reduce(
    (acc: Record<string, number>, row: { status: string }) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  // `totalTests` is the planned suite size set once at /start, so it is not
  // touched here — incrementing per inserted row would count retry attempts as
  // extra tests. The per-status counters still accumulate for live progress;
  // the reporter's distinct final counts replace them at /finish.
  const updatedRuns = await db
    .update(testRuns)
    .set({
      updatedAt: new Date(),
      passedTests: sql`${testRuns.passedTests} + ${insertedStatusCounts['passed'] || 0}`,
      failedTests: sql`${testRuns.failedTests} + ${countFailedFromTally(insertedStatusCounts)}`,
      skippedTests: sql`${testRuns.skippedTests} + ${insertedStatusCounts['skipped'] || 0}`,
      didNotRunTests: sql`${testRuns.didNotRunTests} + ${insertedStatusCounts['didnotrun'] || 0}`,
    })
    .where(eq(testRuns.id, id))
    .returning();

  const updatedRun = updatedRuns[0];

  // Publish test-completed events to SSE subscribers. The persisted execution
  // id rides along so the live run page can deep-link each row to its real
  // case page instead of a fabricated id (see persistRunCases' inputIndex).
  const persistedByInputIndex = new Map(
    insertedRunCases.filter((r) => r.inputIndex >= 0).map((r) => [r.inputIndex, r]),
  );

  for (const [index, tc] of (completeEvents as StreamEventPayload[]).entries()) {
    const persisted = persistedByInputIndex.get(index);
    // The case now has a DB row, so the catch-up will replay it as
    // `test-completed` — drop the running-case entry that stood in for it.
    if (lastOf.get(runningCaseKey(tc)) === 'complete') runEventBus.clearRunningCase(id, runningCaseKey(tc));
    runEventBus.publish(id, {
      type: 'test-completed',
      data: testCompletedData(tc, cases[index]!, persisted, resolveIngestLimits().locks),
    });
  }

  // Publish progress update
  if (updatedRun) {
    runEventBus.publish(id, {
      type: 'run-progress',
      data: {
        totalTests: updatedRun.totalTests,
        passedTests: updatedRun.passedTests,
        failedTests: updatedRun.failedTests,
        skippedTests: updatedRun.skippedTests,
        didNotRunTests: updatedRun.didNotRunTests,
      },
    });
    // Also broadcast globally so the desktop shell can show OS progress for a
    // run the user is watching (not just runs it launched itself).
    runEventBus.publishRunProgress({
      runId: id,
      projectId,
      totalTests: updatedRun.totalTests,
      passedTests: updatedRun.passedTests,
      failedTests: updatedRun.failedTests,
      skippedTests: updatedRun.skippedTests,
      didNotRunTests: updatedRun.didNotRunTests,
    });
  }

  return {
    success: true,
    processed: insertedRunCases.length + beginEvents.length,
    watched: runEventBus.answerWatched(id, body.streamToken),
    ...liveAsks.handOverAnswer(id),
  };
});
