import { requireAuth } from '../utils/auth';
import { getDatabase } from '../database';
import { getProjectScope, runVisibilityReader, scopeAllows } from '../utils/project-access';
import { runEventBus } from '../utils/run-events';
import { runProgressThrottle } from '../utils/run-progress-throttle';
import { createSSEEndpoint } from '../utils/sse';

defineRouteMeta({
  openAPI: {
    tags: ['Stream'],
    summary: 'Server-sent events stream',
    description:
      "Subscribes to global run events over SSE: each run's lifecycle (`run-initializing`, `run-started`, `run-finalizing`, `run-finished`, `run-submitted`, `run-cancelled`, `rollup-updated`, `run-continued`) and a running run's tally (`{ type: 'run-progress', runId, projectId, totalTests, passedTests, failedTests, skippedTests, didNotRunTests }`, each result counted as it is reported, a retry again), at most once every 2 seconds per run, its latest tally winning and sent before the run's next lifecycle event. The stream starts with a comment line once it is subscribed: every event published after it arrives. Its first event, `{ type: 'stream-open', lastEventAt }`, says when this server last published a lifecycle event of a project the caller may read (milliseconds since the epoch, null for none since it started). Events of projects the caller cannot read, and of another person's private run, are left out.",
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  // The global run bus carries lifecycle events and tallies for every project. Compute the
  // caller's project scope once per connection and filter the fan-out to it, so
  // a user never receives run metadata (run id, project id, status) for projects
  // they cannot access. With auth disabled the instance is single-user (scope
  // 'all'), so nothing is filtered.
  const db = await getDatabase();
  const scope = await getProjectScope(db, user);
  // Another person's private run is left out, and the events go out in the order they were published.
  const sees = runVisibilityReader(db, user.id);
  let sent = Promise.resolve();
  return createSSEEndpoint(event, (controller, encoder) => {
    const deliver = (runId: number, payload: object) => {
      const visible = sees(runId);
      sent = sent.then(async () => {
        if (!(await visible)) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // Stream closed — unsubscribe is handled by SSE helper
        }
      });
    };
    const progress = runProgressThrottle((tally) => deliver(tally.runId, { type: 'run-progress', ...tally }));
    const unsubscribeLifecycle = runEventBus.subscribeGlobal((globalEvent) => {
      if (!scopeAllows(scope, globalEvent.projectId)) return;
      // The run's tally held back goes first, so the list's row ends on its last tally.
      progress.flush(globalEvent.runId);
      deliver(globalEvent.runId, globalEvent);
    });
    const unsubscribeProgress = runEventBus.subscribeRunProgress((tally) => {
      if (!scopeAllows(scope, tally.projectId)) return;
      progress.push(tally.runId, tally);
    });
    // A comment, which clients skip, sends the response now that it is subscribed: the stream opens in the browser
    // from the first moment it misses no event (`useRunEvents`' `onOpen`). Then when the last event went out, so a
    // page whose data is older than it reads that data again (`useRunStream`).
    controller.enqueue(encoder.encode(': subscribed\n\n'));
    const lastEventAt = runEventBus.lastGlobalEvent((projectId) => scopeAllows(scope, projectId));
    const opened = { type: 'stream-open', lastEventAt };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(opened)}\n\n`));
    return () => {
      unsubscribeLifecycle();
      unsubscribeProgress();
      progress.dispose();
    };
  });
});
