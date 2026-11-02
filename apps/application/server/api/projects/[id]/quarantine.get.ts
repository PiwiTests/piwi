import { getDatabase } from '../../../database';
import { queryFlag } from '../../../utils/query-params';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { getProjectQuarantine } from '#shared/handlers/quarantine';

defineRouteMeta({
  openAPI: {
    tags: ['Test Cases'],
    summary: 'Quarantined tests, their exit progress, and candidates',
    description:
      'A quarantined test still runs and still reports — it is excluded from the CI gate’s verdict and nothing else. That is what makes the exit ramp work: `consecutivePasses` counts passing runs since quarantine, and `releaseProposed` turns true once a test has earned its way out. `debt` aggregates the cost of the list so it cannot quietly grow forever. `candidates` proposes tests worth quarantining, ranked by the CI time their flakiness wastes; each lists its `reasons`, and a completed AI diagnosis calling the test flaky with high confidence (not rated unhelpful) adds one, named in `diagnosis`. A dismissed proposal stays listed: `releaseDismissed` marks an entry whose proposed release was dismissed, which `debt.readyToRelease` leaves out, and `dismissed` a candidate dismissed since the newest run the candidates read (`POST /api/projects/:id/quarantine/:testCaseId/dismiss`). Set `?candidates=false` to skip that computation.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'candidates',
        in: 'query',
        required: false,
        schema: { type: 'boolean', default: true },
        description: 'Include quarantine proposals derived from flaky analysis',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, projectId);

  const db = await getDatabase();
  return getProjectQuarantine(db, projectId, { candidates: queryFlag(event, 'candidates', { default: true }) });
});
