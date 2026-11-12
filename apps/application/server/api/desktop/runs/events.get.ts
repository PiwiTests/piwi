// Desktop-only: the window's stream of the runs the desktop shell starts. The
// window is a peer of the hub Piwi Picker reaches over its WebSocket: it hears
// each run as Piwi Picker does, the frames of the stops and lanes it watches and
// the layers of those lanes it asked for, and, alone, the code made at a stop,
// to copy. The events are written straight to the
// response, so what the window has not read yet is the response's own backlog
// (`writableLength`): past 1 MB a frame waits for it, and past 32 MB the stream
// is cut, as the hub does with a WebSocket (`MAX_HUB_BUFFERED`). Responds 404 on
// the normal server build.
import { requireAuth } from '../../../utils/auth';
import { apiError } from '../../../utils/api-error';
import { serveRunEvents } from '@piwitests/editor/shell-runs-http';
import { desktopRuns } from '../../../utils/desktop-runs';

defineRouteMeta({
  openAPI: {
    tags: ['Stream'],
    summary: 'The desktop window’s stream of its runs (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Server-sent events for the desktop app window: first `{ type: "hello", viewer }`, the id its commands (`POST /api/desktop/runs/commands`) name the stream by; the latest codes made at a stop (`{ type: "stop-code", code }`); then each live run and each change as Piwi Picker hears them on the hub (`{ type: "session", session }`), `{ type: "listed" }` once every run live as it opened was sent, what each code made at a stop came to (`{ type: "code" }`), the frames of the stops and the lanes the stream watches (`{ type: "frame" }`, `{ type: "lane-frame" }`) and the layers of those lanes its `watch` asked for (`{ type: "lane-layer" }`), what **Inspect** read of a lane the stream has it open on (`{ type: "inspect", ref, lane, attempt }`, with a page’s `snapshot`, its call and moment, or why none shows, `refused`; never a path), each new code made at a stop, and sentences about a run (`{ type: "notice" }`). A stream that leaves more than 1 MB unread gets no frame until it reads, and one that leaves 32 MB unread is cut. 503 while the hub does not listen, or with 16 streams open.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  await serveRunEvents(event.node.req, event.node.res, await desktopRuns());
});
