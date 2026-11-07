import { requestsForTarget, requireRunTarget } from '../../utils/run-requests';
import { RUN_TARGET_RECHECK_MS, subscribeRunTarget, type RunTargetEvent } from '../../utils/run-target-events';
import { createSSEEndpoint } from '../../utils/sse';

defineRouteMeta({
  openAPI: {
    tags: ['Run requests'],
    summary: 'Stream the run requests and stops of a connected app',
    description:
      'For a run target (the desktop app, Piwi Runner), authenticated with the key the device flow gave it, which holds `run:receive` alone; any other credential is refused. Server-sent events, each a JSON object with a `type`: first `snapshot`, the `requests` and `stops` that `GET /api/run-targets/requests` answers; then `request` for each new request the target may take, `stop` with the `id` of a request it holds whose requester asked to stop it, and `revoked` as the stream closes because the app was disconnected or its owner lost access. A request can come twice, in the snapshot and as it is made: the target keys requests by id. A comment line is sent every 15 seconds; the stream records that the target was seen, and checks its key again, every minute. While the stream is open the target shows as online in **Connected apps**. Where a proxy cuts long responses, the target polls `GET /api/run-targets/requests` instead.',
    'x-required-permission': 'run:receive',
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'An event stream (`text/event-stream`)' },
      401: { description: 'No key, or an unknown one' },
      403: { description: 'The key is not a connected run target’s, or the app was disconnected' },
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
    const recheck = setInterval(() => {
      requireRunTarget(event).catch((err) => (isRefusal(err) ? revoke() : close()));
    }, RUN_TARGET_RECHECK_MS);
    recheck.unref?.();
    function stop() {
      closed = true;
      clearInterval(recheck);
      unsubscribe();
    }
    requestsForTarget(caller)
      .then(({ requests, stops }) => {
        send({ type: 'snapshot', requests, stops });
        ready = true;
        for (const message of held.splice(0)) send(message);
      })
      .catch(close);
    return stop;
  });
});
