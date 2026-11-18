import { requireRunRequestId, requireRunTarget, runVariablesForTarget } from '../../../../utils/run-requests';

defineRouteMeta({
  openAPI: {
    tags: ['Run requests'],
    summary: 'Get the run variables of a claimed request',
    description:
      'The run variables of a request this target claimed, `{ runVariables: [{ name, value }], environment }`: the project’s, and when the request names an environment, the environment’s over them (an empty list for none), the environment variables its run gets; `environment` is `{ id, key, name, protected, requiredTags, envFile }`, or null for none. The target sets `PIWI_ENVIRONMENT` to its key, limits a protected environment’s run to its required tags, checks every name and field again with the rules of `PATCH /api/projects/:id` and `@piwitests/core/environments`, shows them in its confirmation and runs nothing when one fails. Authenticated with the target’s key alone.',
    'x-required-permission': 'run:receive',
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The run variables' },
      403: {
        description:
          'Not a run target’s key, the project does not allow it, or its environment is protected and the owner does not manage the project',
      },
      404: { description: 'No request this target claimed has this id, or its environment was archived' },
      409: { description: 'The run variables or the environment no longer pass the rules' },
    },
  },
});

export default eventHandler(async (event) => {
  const caller = await requireRunTarget(event);
  const id = requireRunRequestId(event);
  const answered = await runVariablesForTarget(caller, id);
  if (!answered.ok) throw apiError({ statusCode: answered.statusCode, message: answered.message });
  return { runVariables: answered.runVariables, environment: answered.environment };
});
