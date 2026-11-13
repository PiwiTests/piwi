// Desktop-only: what a window with Inspect open on a lane of a run the desktop
// shell started hears as it opens it: the attempt Inspect follows, the calls
// whose page it read from the test's own trace so far, and why none shows. The
// window hears each later one on its stream (`inspect`). Responds 404 on the
// normal server build.
import { requireAuth } from '../../../../utils/auth';
import { apiError } from '../../../../utils/api-error';
import { readDesktopInspectLane } from '../../../../utils/desktop-inspect';
import { desktopRuns } from '../../../../utils/desktop-runs';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'The calls Inspect read of a lane of the desktop app’s run (desktop app)',
    description:
      'Desktop build only — 404 on the server build. For a window that opened **Inspect** on a lane of a run the desktop shell started (`{ type: "inspect", ref, lane, on: true }` on `POST /api/desktop/runs/commands`): the attempt Inspect follows (`attempt`, the lane’s running test’s id and retry, null between tests), the snapshots of the test’s pages it read from the test’s own trace on this machine so far, the latest 600, each with its call’s id and title, its moment (`before`, `action`, `after`), its page and frame (`heard`), and why no page shows (`refused`, null when none was said). No path and no page’s content: each page is served rendered by `GET /api/desktop/runs/inspect/page`. `viewer` is the id the window’s stream (`GET /api/desktop/runs/events`) opened with, `ref` the run and `lane` its worker’s lane (Playwright’s `parallelIndex`). 400 for a stream, run or lane named wrongly; 404 for a window that has no Inspect open on that lane; 503 while the hub does not listen.',
    parameters: [
      { name: 'viewer', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'ref', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'lane', in: 'query', required: true, schema: { type: 'integer', minimum: 0 } },
    ],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  const runs = await desktopRuns();
  if (!runs) throw apiError({ statusCode: 503, message: 'The desktop runs’ hub is not listening' });
  const lane = readDesktopInspectLane(getQuery(event));
  if (!lane) throw apiError({ statusCode: 400, message: 'Name the window’s stream, the run and its lane' });
  const calls = runs.inspects.calls(lane.viewer, lane.ref, lane.lane);
  if (!calls) throw apiError({ statusCode: 404, message: 'This window has no Inspect open on that lane' });
  return calls;
});
