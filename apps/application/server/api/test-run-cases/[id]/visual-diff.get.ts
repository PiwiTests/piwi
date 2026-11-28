import { getOrComputeVisualDiff } from '../../../utils/visual-diff';
import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: 'Pixel-diff a failing screenshot against the last passing run',
    description:
      'Compares the failing execution screenshot with the same test case last passing execution screenshot (same browser). Computed lazily on first request and cached as a stored overlay artifact with changed-pixel metrics. Screenshots with different dimensions are compared on a padded union canvas and flagged dimensionMismatch. While the instance is read-only, a diff not stored yet answers `status: read-only`.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Test run case id' },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run case ID');

  // Authorize by the execution's own project: this id may be opened from the
  // cluster page, where it can belong to a run in another project.
  const { db } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Test run case');

  // Don't 404 — "no screenshot" / "no baseline" are valid answers
  return getOrComputeVisualDiff(db, id);
});
