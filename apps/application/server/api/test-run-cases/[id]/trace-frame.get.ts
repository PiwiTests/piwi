import { getTraceFrameFromBlob, resolveCaseTraceBlobPath } from '../../../utils/trace-evidence';
import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: "One screencast frame of the execution's stored trace",
    description:
      "Serves one image of the trace's screencast, addressed by the `name` that `GET /api/test-run-cases/:id/trace-frames` lists (a JPEG, as Playwright records them). Only a frame the trace's events name is served. 404 when the trace has no such frame.",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Test run case id' },
      {
        name: 'name',
        in: 'query',
        required: true,
        schema: { type: 'string' },
        description: 'The frame, as the frame list names it',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run case ID');

  // Authorize by the execution's own project: this id may be opened from the
  // cluster page, where it can belong to a run in another project.
  const { db } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Test run case');

  const name = getQuery(event).name;
  if (typeof name !== 'string' || !name) throw apiError({ statusCode: 400, message: 'name is required' });

  const blobPath = await resolveCaseTraceBlobPath(db, id);
  const frame = blobPath ? await getTraceFrameFromBlob(blobPath, name) : null;
  if (!frame) throw apiError({ statusCode: 404, message: 'Frame not found' });

  setResponseHeader(event, 'Content-Type', frame.contentType);
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff');
  // A trace's frames never change, so the browser may cache them hard.
  setResponseHeader(event, 'Cache-Control', 'private, max-age=31536000, immutable');
  return frame.bytes;
});
