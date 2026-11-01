import { getDatabase } from '../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { loadDetectorPrecision } from '#shared/handlers/detector-precision';

defineRouteMeta({
  openAPI: {
    tags: ['Scenario gaps'],
    summary: 'Per-detector precision from triage verdicts',
    description:
      'For each detector on this project, the share of triage verdicts that went for it (accepted, covered-by) versus against it (dismissed as wrong, or a gap dismissed as covered elsewhere), and whether it has muted itself (below 60% with at least 20 verdicts). A muted detector leaves the pull-request comment, the digest and the feature map, and its gaps list last.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, projectId);
  const db = await getDatabase();
  return { items: await loadDetectorPrecision(db, projectId) };
});
