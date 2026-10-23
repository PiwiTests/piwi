import { displayTitleOf, externalIdOf } from '../../../utils/test-case-match';
import { getDatabase } from '../../../database';
import { testRuns } from '../../../database/schema';
import { eq, sql } from 'drizzle-orm';
import { runEventBus } from '../../../utils/run-events';
import { parseLocation } from '#shared/parse-location';
import { persistRunCases, type RunCaseInput } from '../../../utils/persist-run-cases';
import { mapWireCaseToRunCase } from '../../../utils/map-wire-case';
import { resolveRepeatEachIndex } from '../../../utils/inserted-run-cases';
import { mapStepEventsToRunEvents } from '../../../utils/map-step-events';
import { authorizeStreamToken } from '../../../utils/stream-auth';
import type { StreamEventPayload } from '#shared/types';
import { countFailedFromTally } from '#shared/utils/test-counts';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Submit test case events for a streaming run',
    description:
      "Submit test case begin, complete and step lifecycle events for an active streaming test run. Requires the stream token. Supports both single and batch event submission for real-time progress updates. Test-attached step events (step-begin/step-end) are streamed to subscribers in the order submitted, without persistence; suite-level hook events keep the timeline shape. The response's `watched` is true while anyone has the run's live stream open; the reporter sends step events only then.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              streamToken: { type: 'string' },
              testCases: { type: 'array', items: { type: 'object' } },
              testCase: { type: 'object' },
            },
            required: ['streamToken'],
          },
        },
      },
    },
  },
});

const MAX_EVENT_BATCH_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Stable identity for a test case within a run, used to match a `begin` event
 * to its later `complete`. Mirrors the key the run page builds client-side
 * (title + location + browser + repeat), so recording on begin and clearing on
 * complete target the same running-case entry.
 */
function runningCaseKey(tc: {
  title?: string;
  location?: string | null;
  browser?: unknown;
  repeatEachIndex?: unknown;
}): string {
  return `${tc.title}\x1f${tc.location ?? ''}\x1f${JSON.stringify(tc.browser ?? null)}\x1f${resolveRepeatEachIndex(tc.repeatEachIndex)}`;
}

export default eventHandler(async (event) => {
  const id = parseInt(getRouterParam(event, 'id') || '0');

  if (!id) {
    throw apiError({
      statusCode: 400,
      message: 'Invalid test run ID',
    });
  }

  const contentLength = parseInt(getRequestHeader(event, 'content-length') ?? '0', 10);
  if (contentLength > MAX_EVENT_BATCH_BYTES) {
    throw apiError({ statusCode: 413, message: 'Event batch too large (max 10 MB)' });
  }

  const body = await readBody(event);

  // Validate stream token
  if (!body.streamToken) {
    throw apiError({
      statusCode: 401,
      message: 'Missing stream token',
    });
  }

  const db = await getDatabase();

  const { projectId } = await authorizeStreamToken(db, id, body.streamToken);

  // Process test cases (supports single or batch)
  const testCaseEvents = Array.isArray(body.testCases) ? body.testCases : [body.testCase];

  const validEvents = testCaseEvents.filter((tc: { title?: string }) => tc && tc.title);

  // Split into begin and complete events; step events keep their batch order
  const beginEvents = validEvents.filter((tc: { type?: string }) => tc.type === 'begin');
  const completeEvents = validEvents.filter((tc: { type?: string }) => tc.type === 'complete');
  const stepRunEvents = mapStepEventsToRunEvents(validEvents);

  // --- Handle begin events (test started, no DB persistence needed) ---
  for (const tc of beginEvents) {
    const loc = tc.location ? parseLocation(tc.location) : { filePath: 'unknown', line: null, column: null };
    const filePath = loc.filePath;
    const beginData = {
      title: tc.title,
      filePath,
      suitePath: (tc as { suitePath?: string[] | null }).suitePath ?? null,
      location: tc.location,
      workerIndex: tc.workerIndex ?? null,
      shardIndex: tc.shardIndex ?? null,
      startedAt: tc.startedAt ?? null,
      browser: tc.browser ?? null,
      repeatEachIndex: resolveRepeatEachIndex(tc.repeatEachIndex),
    };
    runEventBus.publish(id, { type: 'test-begin', data: beginData });
    // A running case has no DB row until it completes, so remember its begin
    // payload for the stream catch-up; the matching complete event clears it.
    runEventBus.recordRunningCase(id, runningCaseKey(tc), beginData);
  }

  // --- Handle step events (live step readout + suite-level hooks), in batch order ---
  for (const stepEvent of stepRunEvents) {
    runEventBus.publish(id, stepEvent);
  }

  // --- Handle complete events (test finished, persist to DB) ---
  if (completeEvents.length === 0) {
    return {
      success: true,
      processed: beginEvents.length + stepRunEvents.length,
      watched: runEventBus.isWatched(id),
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
    runEventBus.clearRunningCase(id, runningCaseKey(tc));
    runEventBus.publish(id, {
      type: 'test-completed',
      data: {
        title: tc.title,
        externalId: externalIdOf(cases[index]!) ?? null,
        displayTitle: displayTitleOf(cases[index]!, externalIdOf(cases[index]!)),
        filePath: cases[index]!.filePath,
        suitePath: tc.suitePath ?? null,
        status: tc.status,
        duration: tc.duration,
        location: tc.location,
        error: tc.error ?? null,
        stepEvents: tc.stepEvents ?? null,
        wastedTimeMs: tc.wastedTimeMs ?? null,
        workerIndex: tc.workerIndex ?? null,
        shardIndex: tc.shardIndex ?? null,
        startedAt: tc.startedAt ?? null,
        browser: tc.browser ?? null,
        // The attempt number rides along so the live page can tell a
        // passed-on-retry (flaky) test from a first-try pass.
        retries: tc.retries ?? null,
        repeatEachIndex: resolveRepeatEachIndex(tc.repeatEachIndex),
        executionId: persisted?.id ?? null,
        testCaseId: persisted?.testCaseId ?? null,
      },
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
    watched: runEventBus.isWatched(id),
  };
});
