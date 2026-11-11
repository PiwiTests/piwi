import { eq } from 'drizzle-orm';
import { requireAuth } from '../../utils/auth';
import { getDatabase } from '../../database';
import { testRuns } from '../../database/schema';
import { getProjectScope, runVisibilityReader, scopeAllows } from '../../utils/project-access';
import { runEventBus, type GlobalRunEvent } from '../../utils/run-events';
import { desktopRunFactsReader } from '../../utils/desktop-run-facts';
import { desktopRuns } from '../../utils/desktop-runs';
import { createSSEEndpoint } from '../../utils/sse';
import { subscribeDesktopOpenRequests } from '../../utils/desktop-handoff';
import { subscribeReproRequests, waitingReproRequests } from '../../utils/desktop-repro';
import { subscribePairings, waitingPairings } from '../../utils/desktop-pairing';
import { openWindowStream } from '@piwitests/editor/run-target-stream';
import { getActiveTestRuns } from '#shared/handlers/test-runs';

defineRouteMeta({
  openAPI: {
    tags: ['Stream'],
    summary: 'Desktop window event stream (desktop shell)',
    description:
      'Server-sent events for the desktop app window. Run progress, for the OS-level display (taskbar/Dock/tray): on connect a `snapshot` of the currently-active runs with their counts, then run lifecycle events and live progress tallies for every run in the caller scope — so a run the user is only watching (reported from CI or a terminal), not just one launched from the app, drives the progress. Once a run has begun, its messages and its entry in the snapshot also carry what launched it (`origin`, `originRef`), the name its launcher gave it (`name`, `PIWI_RUN_REF`, or null) and whether it is a step of a job (`job`: a reproduction, a bisect step, a Flake Lab or probe run). Hub runs: a `hub-runs` message with how many runs the hub of the runs the desktop shell starts has live (`live`), on connect and whenever it changes, in the desktop build alone; and an `editor-runs` message with the editors’ live runs the server observes (`runs`: each one’s editor, `client`, and its `session` as the editor’s hub tells it), on connect and whenever they change. Page requests: an `open-page` message with the app-relative `path` of a dashboard link the user opened in the system browser, which the window shows. Repro requests: a `repro-request` message with the `request` Piwi Picker or an editor sent, which the window asks the developer to run or decline; the ones still waiting are sent again on connect. Run on my machine, in the desktop build: a `run-target` message with the connection to the team instance this app takes run requests from, on connect and whenever it changes, a `run-request` message with each request the window asks the person about (the ones still asked about are sent again on connect), and `run-request-gone` with the `id` of one it no longer asks about. Pairings: a `picker-pairing` message with the `pairing` Piwi Picker asked for, which the window asks the developer to allow or deny, and again whenever it is answered or expires; the ones still waiting are sent again on connect. Run events are scoped to the caller like the global run stream; in the desktop build (auth off) that is the whole instance.',
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

    // Each message of a run that has begun waits on the one read of its facts, so a run's messages keep their order.
    const factsOf = desktopRunFactsReader(async (runId) => {
      const [row] = await db
        .select({ status: testRuns.status, metadata: testRuns.metadata })
        .from(testRuns)
        .where(eq(testRuns.id, runId));
      return row;
    });
    // The runs' messages heard before the snapshot is sent wait for it, in their order: a run that ended meanwhile
    // ends after the snapshot that may still hold it.
    let held: Array<() => void> | null = [];
    // Another person's private run is left out; the runs' messages go out in the order they were heard.
    const sees = runVisibilityReader(db, user.id);
    let sent = Promise.resolve();
    const sendRun = (runId: number, payload: Record<string, unknown>, facts = true) => {
      const deliver = () => {
        const visible = sees(runId);
        const told = facts ? factsOf(runId) : null;
        sent = sent
          .then(async () => {
            if (!(await visible)) return;
            const known = told ? await told : null;
            send(known ? { ...payload, ...known } : payload);
          })
          .catch(() => {});
      };
      if (held) held.push(deliver);
      else deliver();
    };

    // Subscribe first so no event is missed while the snapshot query runs.
    const unsubscribeLifecycle = runEventBus.subscribeGlobal((globalEvent: GlobalRunEvent) => {
      if (!scopeAllows(scope, globalEvent.projectId)) return;
      const bare = globalEvent.type === 'run-initializing' || globalEvent.type === 'rollup-updated';
      sendRun(globalEvent.runId, { ...globalEvent }, !bare);
    });
    const unsubscribeProgress = runEventBus.subscribeRunProgress((progress) => {
      if (!scopeAllows(scope, progress.projectId)) return;
      sendRun(progress.runId, { type: 'run-progress', ...progress });
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
    const unsubscribeRunTarget = process.env.PIWI_DESKTOP_TOKEN ? openWindowStream(send) : () => {};

    // Initial catch-up: the runs already in flight when the shell connects.
    void (async () => {
      try {
        const runs = await getActiveTestRuns(db, scope);
        const told = await Promise.all(
          runs.map(async (run) => {
            const facts = run.status === 'initializing' ? null : await factsOf(run.id);
            return facts ? { ...run, ...facts } : run;
          }),
        );
        send({ type: 'snapshot', runs: told });
      } catch {
        // A failed snapshot just means no initial runs; deltas still stream.
      }
      const waiting = held ?? [];
      held = null;
      for (const deliver of waiting) deliver();
    })();

    // The hub's live runs, so a window that reloads finds out whether its runs still go on.
    let closed = false;
    let unsubscribeHub: (() => void) | null = null;
    void desktopRuns()
      ?.then((hub) => {
        if (closed) return;
        // Each listener is let go with the stream, whatever comes after it.
        const listening: Array<() => void> = [];
        unsubscribeHub = () => {
          for (const unsubscribe of listening) unsubscribe();
        };
        send({ type: 'hub-runs', live: hub.liveRunCount() });
        listening.push(hub.onLiveRunCount((live) => send({ type: 'hub-runs', live })));
        // The editors' runs, which the shell's surfaces count: never steered from here.
        send({ type: 'editor-runs', runs: hub.editorRuns() });
        listening.push(hub.onEditorRuns((runs) => send({ type: 'editor-runs', runs })));
      })
      .catch(() => {});

    return () => {
      closed = true;
      unsubscribeLifecycle();
      unsubscribeProgress();
      unsubscribeOpenRequests();
      unsubscribeRepro();
      unsubscribePairings();
      unsubscribeRunTarget();
      unsubscribeHub?.();
    };
  });
});
