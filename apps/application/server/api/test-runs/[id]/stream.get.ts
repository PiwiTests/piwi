import { testRuns, testCases, testRunsCases, projects } from '../../../database/schema';
import { eq } from 'drizzle-orm';
import { runEventBus } from '../../../utils/run-events';
import { createSSEEndpoint } from '../../../utils/sse';
import { liveViewRelay } from '../../../utils/live-view';
import { liveResourcesSnapshot } from '#shared/live-resources';
import type { LiveViewRunState } from '#shared/live-view';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Stream test run events via SSE',
    description:
      'Subscribe to Server-Sent Events for a live test run. Sends an initial catch-up snapshot of current state and existing test cases, then streams real-time events (test-begin, test-completed, run-progress, resources, live-view, live-worker, run-finished) until the run completes. The catch-up includes what the run reporters measured so far (`resources`, one snapshot per reporter), whether the project enables live view and the run holds a live view key (`live-view`: `enabled`, `keyed`, including false values), then each worker in the run’s live view (`live-worker`: its `shard`, `worker`, whether it is `connected`, and its test’s stop in `paused` while it holds).',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');

  // Verify the run exists
  const testRunResults = await db.select().from(testRuns).where(eq(testRuns.id, id));
  const testRun = testRunResults[0];

  if (!testRun) {
    throw apiError({
      statusCode: 404,
      message: 'Test run not found',
    });
  }

  const [project] = await db
    .select({ liveView: projects.liveView })
    .from(projects)
    .where(eq(projects.id, testRun.projectId));

  return createSSEEndpoint(event, (controller, encoder) => {
    // Send initial state as catch-up event
    const initialData = {
      type: 'init',
      data: {
        id: testRun.id,
        status: testRun.status,
        totalTests: testRun.totalTests,
        passedTests: testRun.passedTests,
        failedTests: testRun.failedTests,
        skippedTests: testRun.skippedTests,
        didNotRunTests: testRun.didNotRunTests,
      },
      seq: 0,
      timestamp: Date.now(),
    };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialData)}\n\n`));

    // If the run is already in a final state, send that and close
    const isActive = testRun.status === 'running' || testRun.status === 'finalizing';
    if (!isActive) {
      const finishedData = {
        type: 'run-finished',
        data: {
          status: testRun.status,
          duration: testRun.duration,
          totalTests: testRun.totalTests,
          passedTests: testRun.passedTests,
          failedTests: testRun.failedTests,
          skippedTests: testRun.skippedTests,
          didNotRunTests: testRun.didNotRunTests,
        },
        seq: 1,
        timestamp: Date.now(),
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(finishedData)}\n\n`));
      controller.close();
      return;
    }

    // What the run's reporters measured so far, one snapshot per reporter, so
    // the workers timeline draws the run's resources from its start. Sent
    // before subscribing: the live posts that follow only add to it.
    for (const part of runEventBus.getLiveResources(id)) {
      const resourcesEvent = { type: 'resources', data: liveResourcesSnapshot(part), seq: 0, timestamp: Date.now() };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(resourcesEvent)}\n\n`));
    }
    // Whether the project's live view is on and the run holds a key, then the workers in its view now and their stops:
    // the live events that follow change them.
    const viewState: LiveViewRunState = { keyed: liveViewRelay.holdsKey(id), enabled: project?.liveView === true };
    const viewEvent = { type: 'live-view', data: viewState, seq: 0, timestamp: Date.now() };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(viewEvent)}\n\n`));
    for (const worker of liveViewRelay.workersOf(id)) {
      const workerEvent = { type: 'live-worker', data: worker, seq: 0, timestamp: Date.now() };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(workerEvent)}\n\n`));
    }

    // Also send existing test cases for catch-up (error omitted — large field, not shown in stream view)
    (async () => {
      try {
        const existingCases = await db
          .select({
            id: testRunsCases.id,
            testCaseId: testRunsCases.testCaseId,
            title: testCases.title,
            externalId: testCases.externalId,
            displayTitle: testCases.displayTitle,
            status: testRunsCases.status,
            duration: testRunsCases.duration,
            filePath: testCases.filePath,
            suitePath: testCases.suitePath,
            line: testRunsCases.line,
            column: testRunsCases.column,
            workerIndex: testRunsCases.workerIndex,
            shardIndex: testRunsCases.shardIndex,
            browser: testRunsCases.browser,
            retries: testRunsCases.retries,
            repeatEachIndex: testRunsCases.repeatEachIndex,
            didNotRunReason: testRunsCases.didNotRunReason,
            expectedStatus: testRunsCases.expectedStatus,
            blockedBy: testRunsCases.blockedBy,
          })
          .from(testRunsCases)
          .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
          .where(eq(testRunsCases.testRunId, id));

        for (const tc of existingCases) {
          const location = tc.line && tc.column ? `${tc.filePath}:${tc.line}:${tc.column}` : tc.filePath;
          const suitePath = tc.suitePath ? tc.suitePath.split('\x1f') : null;
          const caseEvent = {
            type: 'test-completed',
            data: {
              title: tc.title,
              externalId: tc.externalId ?? null,
              displayTitle: tc.displayTitle ?? null,
              filePath: tc.filePath,
              suitePath,
              status: tc.status,
              duration: tc.duration,
              location,
              workerIndex: tc.workerIndex ?? null,
              browser: tc.browser ?? null,
              retries: tc.retries ?? null,
              repeatEachIndex: tc.repeatEachIndex,
              didNotRunReason: tc.didNotRunReason ?? null,
              expectedStatus: tc.expectedStatus ?? null,
              blockedBy: tc.blockedBy ?? null,
              executionId: tc.id,
              testCaseId: tc.testCaseId,
            },
            seq: 0, // Catch-up events have seq 0
            timestamp: Date.now(),
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(caseEvent)}\n\n`));
        }

        // Replay cases that have begun but not yet completed. They have no DB
        // row, so a client that connects or refreshes mid-run would otherwise
        // not see them until their next live event. Enqueued after the
        // completed cases so a rare key collision (a retry re-running a
        // finished case) keeps the finished row.
        for (const running of runEventBus.getRunningCases(id)) {
          const beginEvent = {
            type: 'test-begin',
            data: running,
            seq: 0, // Catch-up events have seq 0
            timestamp: Date.now(),
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(beginEvent)}\n\n`));
        }
      } catch {
        // Ignore errors during catch-up
      }
    })();

    // Subscribe to live events
    return runEventBus.subscribe(id, (runEvent) => {
      try {
        controller.enqueue(encoder.encode(`id: ${runEvent.seq}\ndata: ${JSON.stringify(runEvent)}\n\n`));

        // Close stream when run finishes
        if (runEvent.type === 'run-finished') {
          setTimeout(() => {
            try {
              controller.close();
            } catch {
              // Already closed
            }
          }, 100);
        }
      } catch {
        // Stream was closed by client — unsubscribe is handled by SSE helper
      }
    });
  });
});
