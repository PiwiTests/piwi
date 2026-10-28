// Desktop-only: the window's stream of the runs the desktop shell starts. The
// window is a peer of the hub Piwi Picker reaches over its WebSocket: it hears
// each run as Piwi Picker does, the frames of the stops it watches, and, alone,
// the code made at a stop, to copy. The events are written straight to the
// response, so what the window has not read yet is the response's own backlog
// (`writableLength`): past 1 MB a frame waits for it, and past 32 MB the stream
// is cut, as the hub does with a WebSocket (`MAX_HUB_BUFFERED`). Responds 404 on
// the normal server build.
import { requireAuth } from '../../../utils/auth';
import { apiError } from '../../../utils/api-error';
import { desktopRuns } from '../../../utils/desktop-runs';

/** Every how many milliseconds an open stream gets a comment, so a gone window is noticed. */
const HEARTBEAT_MS = 15_000;

defineRouteMeta({
  openAPI: {
    tags: ['Stream'],
    summary: 'The desktop window’s stream of its runs (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Server-sent events for the desktop app window: first `{ type: "hello", viewer }`, the id its commands (`POST /api/desktop/runs/commands`) name the stream by; the latest codes made at a stop (`{ type: "stop-code", code }`); then each live run and each change as Piwi Picker hears them on the hub (`{ type: "session", session }`), what each code made at a stop came to (`{ type: "code" }`), the frames of the stops the stream watches (`{ type: "frame" }`), each new code made at a stop, and sentences about a run (`{ type: "notice" }`). A stream that leaves more than 1 MB unread gets no frame until it reads, and one that leaves 32 MB unread is cut. 503 while the hub does not listen, or with 16 streams open.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  const runs = await desktopRuns();
  if (!runs) throw apiError({ statusCode: 503, message: 'The desktop runs’ hub is not listening' });

  const { req, res } = event.node;
  let gone = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let window: { close(): void } | null = null;
  const start = () => {
    if (res.headersSent) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    heartbeat = setInterval(() => {
      if (!gone) res.write(': heartbeat\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  };
  const leave = () => {
    if (gone) return;
    gone = true;
    if (heartbeat) clearInterval(heartbeat);
    window?.close();
  };
  req.on('close', leave);
  res.on('close', leave);
  res.on('error', leave);

  const opened = await runs.openWindow({
    send: (payload) => {
      if (gone) return;
      start();
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    buffered: () => res.writableLength,
    close: () => {
      if (gone) return;
      // What a window left unread would never be read: its stream is cut; one that read everything is ended.
      if (res.writableLength > 0) res.destroy();
      else res.end();
      leave();
    },
  });
  if (!opened) {
    if (!res.headersSent) {
      throw apiError({
        statusCode: 503,
        message: 'The desktop runs’ hub is not listening, or holds 16 window streams',
      });
    }
    res.end();
    return;
  }
  start();
  if (gone) opened.close();
  else window = opened;
});
