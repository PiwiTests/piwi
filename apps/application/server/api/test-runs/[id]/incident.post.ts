import { parseSetRunIncident } from '#shared/run-incident';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../utils/project-access';
import { decideRunIncident } from '../../../utils/run-incident-decision';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Mark a run as an environment incident, or clear the flag',
    description:
      "A run flagged as an environment incident (its failures come from the environment under test being down, not from the tests or the code) is left out of baselines, fix verification, flaky scores, the selection catalog and auto-heal, and the gate answers `inconclusive` for it. `incident: true` marks the run, with an optional `reason`, and adds its incident marker; `incident: false` clears the flag and removes the marker Piwi added. The decision is kept on the run, so finalizing it again never overrides it. Returns the run's `incident` (`metadata.incident`, or null) and the `review` (`metadata.incidentReview`: who decided and when).",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': ['run:submit', 'run:control'],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['incident'],
            properties: {
              incident: { type: 'boolean', description: 'true marks the run as an incident; false clears the flag' },
              reason: {
                type: 'string',
                nullable: true,
                description: 'What happened (up to 500 characters); only accepted with incident: true',
              },
            },
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { db, user } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');

  const input = parseSetRunIncident(await readBody(event));
  if (typeof input === 'string') throw apiError({ statusCode: 400, message: input });

  const by = user.id ? user.name || user.username : null;
  try {
    return await decideRunIncident(db, id, input, by);
  } catch (err: any) {
    if (err?.message === 'Test run not found') throw apiError({ statusCode: 404, message: 'Test run not found' });
    throw err;
  }
});
