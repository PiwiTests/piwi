import { getTraceFramesFromBlob, resolveCaseTraceBlobPath } from '../../../utils/trace-evidence';
import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';
import type { TraceFramesResponse } from '../../../../types/api';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: "The screencast frames of the execution's stored trace",
    description:
      "Lists the images of each page the trace's screencast recorded, which Playwright takes whenever the page paints something new (any trace recorded with `screenshots`, its default). Pages come in the order their first frame was recorded, the first 10 of them, and each frame carries `epochMs`, when the trace recorded it on the clock of the timeline's `origin`, its size, and the `name` that `GET /api/test-run-cases/:id/trace-frame` serves. Past 1,000 frames, each page lists an even sample of its frames, its first and last included; `capped` is true when the listed pages are sampled so, and `total` counts every frame the trace recorded, on every page. `startEpochMs` is when the test started on the trace's clock (its test runner's header, else its first browser context's), which places the frames of a trace recorded at another time than its execution. `no-frames` when the trace recorded no screencast or cannot be put on the clock, `no-trace` without a stored trace. Read-only.",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Test run case id' },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event): Promise<TraceFramesResponse> => {
  const id = requireRouteId(event, 'id', 'test run case ID');

  // Authorize by the execution's own project: this id may be opened from the
  // cluster page, where it can belong to a run in another project.
  const { db } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Test run case');

  const blobPath = await resolveCaseTraceBlobPath(db, id);
  if (!blobPath) return { status: 'no-trace', pages: [], total: 0, capped: false, startEpochMs: null };
  return getTraceFramesFromBlob(blobPath);
});
