// Desktop-only: the window's stream of the runs the desktop shell starts. The
// window is a peer of the hub Piwi Picker reaches over its WebSocket: it hears
// each run as Piwi Picker does, the frames of the stops it watches, and, alone,
// the code made at a stop, to copy. Responds 404 on the normal server build.
import { requireAuth } from '../../../utils/auth';
import { apiError } from '../../../utils/api-error';
import { desktopRuns } from '../../../utils/desktop-runs';
import { createSSEEndpoint } from '../../../utils/sse';

defineRouteMeta({
  openAPI: {
    tags: ['Stream'],
    summary: 'The desktop window’s stream of its runs (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Server-sent events for the desktop app window: first `{ type: "hello", viewer }`, the id its commands (`POST /api/desktop/runs/commands`) name the stream by; the latest codes made at a stop (`{ type: "stop-code", code }`); then each live run and each change as Piwi Picker hears them on the hub (`{ type: "session", session }`), what each code made at a stop came to (`{ type: "code" }`), the frames of the stops the stream watches (`{ type: "frame" }`), each new code made at a stop, and sentences about a run (`{ type: "notice" }`). 503 while the hub does not listen, or with 16 streams open.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  const runs = await desktopRuns();
  if (!runs) throw apiError({ statusCode: 503, message: 'The desktop runs’ hub is not listening' });

  return createSSEEndpoint(
    event,
    (controller, encoder) => {
      let closed = false;
      let window: { close(): void } | null = null;
      void runs
        .openWindow({
          send: (payload) => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            } catch {
              // Stream closed — the SSE helper unsubscribes.
            }
          },
          buffered: () => Math.max(0, -(controller.desiredSize ?? 0)),
          close: () => {
            try {
              controller.close();
            } catch {
              // Already closed.
            }
          },
        })
        .then((opened) => {
          if (!opened) {
            try {
              controller.close();
            } catch {
              // Already closed.
            }
            return;
          }
          if (closed) opened.close();
          else window = opened;
        });
      return () => {
        closed = true;
        window?.close();
      };
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 0 }),
  );
});
