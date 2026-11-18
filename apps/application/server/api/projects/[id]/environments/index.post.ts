import { createEnvironment } from '#shared/handlers/environments';
import { environmentInputSchema } from '#shared/environments';
import { getDatabase } from '../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Add an environment to a project',
    description:
      'Body: `{ key, name, description?, aliases?, runVariables?, appFromCheckout?, protected?, requiredTags?, envFile?, position? }`. `key` is the label its runs report, 1 to 80 characters of letters, digits, spaces and `_ - . , : / @ + =`, unique in the project ignoring case; `aliases` are other labels or `*` patterns that resolve to it; `runVariables` follow the rules of `PATCH /api/projects/:id`; a protected environment needs at least one required tag (`@smoke`); `envFile` is a file name such as `.env.staging`, never a folder. A discovered environment whose key the new one names is taken over, its runs with it. 409 when a key or an alias already names another environment.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:manage',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const parsed = environmentInputSchema.safeParse(await readBody(event));
  if (!parsed.success) throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  const result = await createEnvironment(await getDatabase(), id, parsed.data);
  if (!result.ok) throw apiError({ statusCode: result.statusCode, message: result.problems.join(' ') });
  setResponseStatus(event, 201);
  return { environment: result.environment };
});
