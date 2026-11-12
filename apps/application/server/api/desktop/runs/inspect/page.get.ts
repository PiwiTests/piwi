// Desktop-only: the page a lane's running test was on at one of its calls, for
// a window with Inspect open on the lane: read from the test's own trace on this
// machine and rendered as the run page's Inspect renders a live page, in the
// same sandboxed frame document. Responds 404 on the normal server build.
import { requireAuth } from '../../../../utils/auth';
import { apiError } from '../../../../utils/api-error';
import { readDesktopInspectLane, readDesktopInspectMoment } from '../../../../utils/desktop-inspect';
import { desktopRuns } from '../../../../utils/desktop-runs';
import { snapshotFrameDocument, snapshotFrameMode } from '../../../../utils/dom-snapshot-frame';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'The page of a lane of the desktop app’s run at a call, for Inspect (desktop app)',
    description:
      'Desktop build only — 404 on the server build. The page a lane’s running test was on at one of its calls, for a window with **Inspect** open on the lane (`GET /api/desktop/runs/inspect/calls`): rendered from the DOM snapshot the test’s own trace took on this machine, as the run page’s Inspect renders a live page, its stylesheets, fonts and images from the trace embedded as `data:` URIs, never a script, a document nor an SVG. Served as a self-contained HTML document, the interactive locator picker (`mode=pick`, the default) or the read-only render (`mode=readonly`), with a `Content-Security-Policy` that sandboxes it (`sandbox allow-scripts`), runs only its own nonce-marked script and loads nothing from the network; or, with `format=json`, the viewport the page was taken at (`{ viewport }`). The page’s scripts, inline handlers and script URLs are never included, and the values of its secret fields, and of what the test typed into one, are removed. Nothing is stored: the server keeps a lane’s pages of its running test in memory, its latest 32 MB, until the test ends or the last window closes Inspect. `viewer`, `ref` and `lane` name the window’s stream, the run and the lane as the calls do, `call` the call (Playwright’s id) and `phase` the moment: before the call, at its action, or after it. 400 for a stream, run, lane, call or moment named wrongly; 404 for a moment the trace holds no page of; 409 for a window that has no Inspect open on that lane; 410, with a sentence that says why, for a page no longer kept, one built on a page not kept, or one too large to render; 503 while the hub does not listen.',
    parameters: [
      { name: 'viewer', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'ref', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'lane', in: 'query', required: true, schema: { type: 'integer', minimum: 0 } },
      { name: 'call', in: 'query', required: true, schema: { type: 'string' } },
      {
        name: 'phase',
        in: 'query',
        required: true,
        schema: { type: 'string', enum: ['before', 'action', 'after'] },
      },
      {
        name: 'mode',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['pick', 'readonly'] },
        description: 'The interactive locator picker (default) or the read-only render',
      },
      {
        name: 'format',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['json'] },
        description: 'The viewport the page was taken at, as JSON, in place of the page',
      },
    ],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  const runs = await desktopRuns();
  if (!runs) throw apiError({ statusCode: 503, message: 'The desktop runs’ hub is not listening' });
  const query = getQuery(event);
  const lane = readDesktopInspectLane(query);
  const moment = readDesktopInspectMoment(query);
  if (!lane || !moment) {
    throw apiError({
      statusCode: 400,
      message: 'Name the window’s stream, the run, its lane, the call and the moment',
    });
  }
  if (query.format === 'json') {
    const viewport = runs.inspects.viewport(lane.viewer, lane.ref, lane.lane, moment.call, moment.phase);
    if (viewport && 'status' in viewport) throw apiError({ statusCode: viewport.status, message: viewport.message });
    return { viewport };
  }
  const page = await runs.inspects.page(lane.viewer, lane.ref, lane.lane, moment.call, moment.phase);
  if ('status' in page) throw apiError({ statusCode: page.status, message: page.message });
  return snapshotFrameDocument(event, page.html, snapshotFrameMode(query), { offline: true });
});
