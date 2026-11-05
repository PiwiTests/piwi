import { requireAuth } from '../../utils/auth';
import { getDatabase } from '../../database';
import { getProjectScope, scopeAllows } from '../../utils/project-access';
import { runEventBus } from '../../utils/run-events';
import { desktopRunEvents } from '../../utils/desktop-run-events';
import { createSSEEndpoint } from '../../utils/sse';
import { subscribeDesktopOpenRequests } from '../../utils/desktop-handoff';
import { subscribeReproRequests, waitingReproRequests } from '../../utils/desktop-repro';
import { subscribePairings, waitingPairings } from '../../utils/desktop-pairing';
import { getActiveTestRuns } from '#shared/handlers/test-runs';

defineRouteMeta({
  openAPI: {
    tags: ['Stream'],
    summary: 'Desktop window event stream (desktop shell)',
    description:
      'Server-sent events for the desktop app window. Run progress, for the OS-level display (taskbar/Dock/tray): on connect a `snapshot` of the currently-active runs with their counts, then run lifecycle events and live progress tallies for every run in the caller scope, in the order they happened — so a run the user is only watching (reported from CI or a terminal), not just one launched from the app, drives the progress. Each run of the snapshot and each lifecycle event names what launched the run: `origin` (`desktop`, `bisect`, `ci`…), `originRef` (what it was launched for) and `runName` (the name its launcher gave it, `PIWI_RUN_REF`), null when it has none. Page requests: an `open-page` message with the app-relative `path` of a dashboard link the user opened in the system browser, which the window shows. Repro requests: a `repro-request` message with the `request` Piwi Picker or an editor sent, which the window asks the developer to run or decline; the ones still waiting are sent again on connect. Pairings: a `picker-pairing` message with the `pairing` Piwi Picker asked for, which the window asks the developer to allow or deny, and again whenever it is answered or expires; the ones still waiting are sent again on connect. Run events are scoped to the caller like the global run stream; in the desktop build (auth off) that is the whole instance.',
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  const scope = await getProjectScope(db, user);

  return createSSEEndpoint(event, (controller, encoder) => {
    const send = (payload: unknown) => {
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      } catch {
        // Stream closed — the SSE helper handles unsubscribe.
      }
    };

    // The runs already in flight when the shell connects go first, then each
    // run event heard from now on, in order; the client upserts by run id, so a
    // run in both the snapshot and an event reconciles cleanly.
    const runEvents = desktopRunEvents(db, send);
    runEvents.snapshot(() => getActiveTestRuns(db, scope));
    const unsubscribeLifecycle = runEventBus.subscribeGlobal((globalEvent) => {
      if (scopeAllows(scope, globalEvent.projectId)) runEvents.lifecycle(globalEvent);
    });
    const unsubscribeProgress = runEventBus.subscribeRunProgress((progress) => {
      if (scopeAllows(scope, progress.projectId)) runEvents.progress(progress);
    });
    const unsubscribeOpenRequests = subscribeDesktopOpenRequests((path) => {
      send({ type: 'open-page', path });
    });
    const unsubscribeRepro = subscribeReproRequests((request) => {
      send({ type: 'repro-request', request });
    });
    for (const request of waitingReproRequests()) send({ type: 'repro-request', request });
    const unsubscribePairings = subscribePairings((pairing) => {
      send({ type: 'picker-pairing', pairing });
    });
    for (const pairing of waitingPairings()) send({ type: 'picker-pairing', pairing });

    return () => {
      unsubscribeLifecycle();
      unsubscribeProgress();
      unsubscribeOpenRequests();
      unsubscribeRepro();
      unsubscribePairings();
    };
  });
});
