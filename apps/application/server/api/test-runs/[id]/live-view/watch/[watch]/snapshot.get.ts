import { readLiveWorkerId, liveWorkerKey } from '@piwitests/core/live-view';
import { isLayerCallId } from '@piwitests/core/live-layers';
import type { SnapshotPhase } from '@piwitests/core/live-inspect';
import { isAuthEnabled } from '../../../../../../utils/auth';
import { snapshotFrameDocument, snapshotFrameMode } from '../../../../../../utils/dom-snapshot-frame';
import { liveViewRelay } from '../../../../../../utils/live-view';
import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveRunProjectId,
} from '../../../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'The page of a live run’s worker at a call, for Inspect',
    description:
      "The page a worker of a live run was on at one of its calls, for a page's watch of the run (`GET …/live-view/watch`) with **Inspect** open: rendered from the DOM snapshot the worker sent, as the snapshot view of a stored trace renders one, its stylesheets, fonts and images the worker sent embedded as `data:` URIs. Served as a self-contained HTML document, the interactive locator picker (`mode=pick`, the default) or the read-only render (`mode=readonly`), with a `Content-Security-Policy` that sandboxes it (`sandbox allow-scripts`), runs only its own nonce-marked script and loads nothing from the network; or, with `format=json`, the viewport the page was taken at (`{ viewport }`, null when the snapshot does not say). The page's scripts, inline handlers and script URLs are never included, a password field's value is masked, the worker removed the values of the page's secret fields before sending it, and nothing is stored: the instance keeps a worker's latest 32 MB of snapshots and the run's last used 64 MB of resources in memory until the run ends. `watch` is the id the watch's stream opened with; `worker` and `shard` name the worker as the watch's messages do, `call` its call (Playwright's id) and `phase` the moment: before the call, at its action, or after it. 400 for a worker, call or moment named wrongly; 404 for a watch this person does not hold in this run, or a moment the worker sent no page of; 409 for a watch without Inspect open; 410 for a page the instance no longer keeps, or a run that is no longer live.",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'watch', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'worker', in: 'query', required: true, schema: { type: 'integer', minimum: 0 } },
      { name: 'shard', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
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
    'x-required-permission': 'project:read',
  },
});

const PHASES: readonly string[] = ['before', 'action', 'after'];

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { user } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');
  const query = getQuery(event);
  const worker = readLiveWorkerId(query.shard, query.worker);
  if (!worker) throw apiError({ statusCode: 400, message: 'Name the worker: worker from 0, and shard from 1' });
  const { call, phase } = query;
  if (!isLayerCallId(call) || typeof phase !== 'string' || !PHASES.includes(phase)) {
    throw apiError({ statusCode: 400, message: 'Name the call by its id, and the moment: before, action or after' });
  }
  const watch = getRouterParam(event, 'watch') ?? '';
  const person = isAuthEnabled(event) ? user.id : null;
  const inspect = liveViewRelay.inspectOf(id, watch, person);
  if ('status' in inspect) throw apiError({ statusCode: inspect.status, message: inspect.message });
  const key = liveWorkerKey(worker);
  if (query.format === 'json') {
    const viewport = inspect.viewport(key, call, phase as SnapshotPhase);
    if (viewport && 'status' in viewport) throw apiError({ statusCode: viewport.status, message: viewport.message });
    return { viewport };
  }
  const page = await inspect.render(key, call, phase as SnapshotPhase);
  if ('status' in page) throw apiError({ statusCode: page.status, message: page.message });
  return snapshotFrameDocument(event, page.html, snapshotFrameMode(query));
});
