import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { getDatabase } from '../../../database';
import { addProjectUrlPattern, urlPatternInputSchema } from '#shared/handlers/url-patterns';
import { urlPatternWriteError } from '../../../utils/url-pattern-errors';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Add a URL pattern to a project',
    description:
      'Body: `{ pattern, environment?, branch?, pathPrefix?, testPathPrefix? }`, appended after the project’s other patterns. `environment` names one of the project’s environments by its key, an alias or a run’s label, resolved as a run’s label is (a label nothing takes creates a discovered environment); none applies the pattern to every environment. Piwi Picker calls it to add the site of the current tab. `pathPrefix` and `testPathPrefix` follow the rules of the list endpoint. 409 when the project has this pattern already.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:manage',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const parsed = urlPatternInputSchema.safeParse(await readBody(event));
  if (!parsed.success) throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  const result = await addProjectUrlPattern(await getDatabase(), id, parsed.data);
  if (!result.ok) throw urlPatternWriteError(result);
  setResponseStatus(event, 201);
  return { items: result.items };
});
