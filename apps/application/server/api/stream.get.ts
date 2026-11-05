import { requireAuth } from '../utils/auth';
import { getDatabase } from '../database';
import { getProjectScope, scopeAllows } from '../utils/project-access';
import { runEventBus } from '../utils/run-events';
import { createSSEEndpoint } from '../utils/sse';

defineRouteMeta({
  openAPI: {
    tags: ['Stream'],
    summary: 'Server-sent events stream',
    description:
      "Subscribes to global run events (status changes, case updates) over SSE. The stream starts with a comment line once it is subscribed: every event published after it arrives. Its first event, `{ type: 'stream-open', lastEventAt }`, says when this server last published a run event (milliseconds since the epoch, null for none since it started).",
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  // The global run bus carries lifecycle events for every project. Compute the
  // caller's project scope once per connection and filter the fan-out to it, so
  // a user never receives run metadata (run id, project id, status) for projects
  // they cannot access. With auth disabled the instance is single-user (scope
  // 'all'), so nothing is filtered.
  const db = await getDatabase();
  const scope = await getProjectScope(db, user);
  return createSSEEndpoint(event, (controller, encoder) => {
    const unsubscribe = runEventBus.subscribeGlobal((globalEvent) => {
      if (!scopeAllows(scope, globalEvent.projectId)) return;
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(globalEvent)}\n\n`));
      } catch {
        // Stream closed — unsubscribe is handled by SSE helper
      }
    });
    // A comment, which clients skip, sends the response now that it is subscribed: the stream opens in the browser
    // from the first moment it misses no event (`useRunEvents`' `onOpen`). Then when the last event went out, so a
    // page whose data is older than it reads that data again (`useRunStream`).
    controller.enqueue(encoder.encode(': subscribed\n\n'));
    const opened = { type: 'stream-open', lastEventAt: runEventBus.lastGlobalEvent() };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(opened)}\n\n`));
    return unsubscribe;
  });
});
