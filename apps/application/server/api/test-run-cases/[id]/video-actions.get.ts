import { getVideoActions } from '#shared/handlers/video-actions';
import { actionsFromTrace } from '#shared/video-actions';
import { loadStoredTraceActionEvents, resolveCaseTraceBlobPath } from '../../../utils/trace-evidence';
import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: 'The actions of an execution, placed in its recorded video',
    description:
      "The clicks, key presses, fills, selections, checks, hovers and navigations the test took, each with when it started in the video (`atMs`, which can be negative or past the video's end for an action outside it) and a masked label. Read from the stored trace when the execution has one, else from its stored steps (`source`). Never carries what a fill or a typing wrote (only how many characters), the values of a selection, or the query string and fragment of a navigation; a key press shows a named key or a combo, and any single character as `a key`. Lists up to 500 actions; `capped` is true when the test took more. `source: none` when there are none to read. Read-only.",
    'x-required-permission': 'project:read',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Test run case id' },
    ],
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run case ID');
  // Authorize by the execution's own project: the id may come from a page of another run.
  const { db } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Test run case');
  return getVideoActions(db, id, async () => {
    const blobPath = await resolveCaseTraceBlobPath(db, id);
    // Only the `.trace` entries are inflated, and the shared trace cache is left as it is.
    const parsed = blobPath ? await loadStoredTraceActionEvents(blobPath) : null;
    return parsed ? actionsFromTrace(parsed.actions, parsed.contexts) : null;
  });
});
