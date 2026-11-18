import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { getDatabase } from '../../../database';
import { replaceProjectUrlPatterns, urlPatternListSchema } from '#shared/handlers/url-patterns';
import { urlPatternWriteError } from '../../../utils/url-pattern-errors';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Replace a project’s URL patterns',
    description:
      'Body: `{ items: [{ pattern, environment?, branch?, pathPrefix?, testPathPrefix? }] }`, in the order Piwi Picker tries them. `environment` resolves as in `POST /api/projects/:id/url-patterns`. Each pattern starts with `http://`, `https://` or a wildcard. `pathPrefix` and `testPathPrefix` are each a plain path of at most 4 segments (`/app`), stored with a leading slash and no trailing one; 400 for a query, a hash, a full URL or a wildcard in either. 409 when a pattern appears twice.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:manage',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const parsed = urlPatternListSchema.safeParse(await readBody(event));
  if (!parsed.success) throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  const result = await replaceProjectUrlPatterns(await getDatabase(), id, parsed.data.items);
  if (!result.ok) throw urlPatternWriteError(result);
  return { items: result.items };
});
