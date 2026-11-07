import { requestsForTarget, requireRunTarget } from '../../utils/run-requests';
import {
  MAX_STREAMS_PER_TARGET,
  RUN_TARGET_RECHECK_MS,
  runTargetStreamCount,
  subscribeRunTarget,
  type RunTargetEvent,
} from '../../utils/run-target-events';
import { createSSEEndpoint } from '../../utils/sse';

defineRouteMeta({
  openAPI: {
    tags: ['Run requests'],
    summary: 'Stream the run requests and stops of a connected app',
    description:
      'For a run target (the desktop app, Piwi Runner), authenticated with the key the device flow gave it, which holds `run:receive` alone; any other credential is refused. Server-sent events, each a JSON object with a `type`: first `snapshot`, the `requests` and `stops` that `GET /api/run-targets/requests` answers; then `request` for each new request the target may take, `stop` with the `id` of a request it holds whose requester asked to stop it, `withdrawn` with the `id` of a request it was offered that no longer waits for it (stopped, or claimed by another of its owner’s apps), and `revoked` as the stream closes because the app’s key was revoked or deleted, with the app or with its owner. Each offered request carries `expiresAt`, when it stops waiting for a claim. A request can come twice, in the snapshot and as it is made: the target keys requests by id. A comment line is sent every 15 seconds, and the stream checks its key again every minute. While its stream is open the app calls `GET /api/run-targets/requests` every minute, which records it as seen: it shows as online in **Connected apps** while its stream is open and it was seen within two minutes. A target holds 3 streams at most (429). Where a proxy cuts long responses, the target polls `GET /api/run-targets/requests` instead.',
    'x-required-permission': 'run:receive',
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'An event stream (`text/event-stream`)' },
      401: { description: 'No key, or an unknown one' },
      403: { description: 'The key is not a connected run target’s, or the app was disconnected' },
      429: { description: 'The target already holds 3 streams open' },
    },
  },
});

/** Whether a refusal says the key or its app no longer counts, as against a passing failure to read it. */
function isRefusal(err: unknown): boolean {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  return status === 401 || status === 403;
}

export default eventHandler(async (event) => {
  const caller = await requireRunTarget(event);
  if (runTargetStreamCount(caller.target.id) >= MAX_STREAMS_PER_TARGET) {
    throw apiError({ statusCode: 429, message: `This app already holds ${MAX_STREAMS_PER_TARGET} streams open` });
  }
  return createSSEEndpoint(event, (controller, encoder) => {
    let closed = false;
    let ready = false;
    const held: RunTargetEvent[] = [];
    const send = (message: RunTargetEvent) => {
      if (closed) return;
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
      } catch {
        stop();
      }
    };
    const close = () => {
      stop();
      try {
        controller.close();
      } catch {
        // Already closed
      }
    };
    const revoke = () => {
      send({ type: 'revoked' });
      close();
    };
    const unsubscribe = subscribeRunTarget(caller.target.id, (message) => {
      if (message.type === 'revoked') return revoke();
      if (ready) send(message);
      else held.push(message);
    });
    const refused = (err: unknown) => (isRefusal(err) ? revoke() : close());
    const recheck = setInterval(() => {
      requireRunTarget(event, { seen: false }).catch(refused);
    }, RUN_TARGET_RECHECK_MS);
    recheck.unref?.();
    function stop() {
      closed = true;
      clearInterval(recheck);
      unsubscribe();
    }
    // Checked again once subscribed: a revoke between the first check and the subscription is heard by nobody.
    requireRunTarget(event, { seen: false }).then(
      (current) =>
        requestsForTarget(current).then(({ requests, stops }) => {
          send({ type: 'snapshot', requests, stops });
          ready = true;
          for (const message of held.splice(0)) send(message);
        }, close),
      refused,
    );
    return stop;
  });
});
