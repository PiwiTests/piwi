import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { getDatabase } from '../../../database';
import { listProjectUrlPatterns } from '#shared/handlers/url-patterns';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'List a project’s URL patterns',
    description:
      'The addresses the project’s application is served at, in order, each with an optional environment (`environment`, its label as written, and `environmentId`, the environment of the project it resolves to), branch, path prefix and tests’ path prefix. `pathPrefix` is the part of the site’s path the tests never saw, such as `/app`: Piwi Picker removes it before comparing the page with the pages the tests recorded. `testPathPrefix` is the part the tests ran under and the site does not: Piwi Picker puts it in front of the page’s path. Piwi Picker resolves the project of the page it is on from them. A pattern is a glob over the whole URL: `*` within one path segment, `**` across segments.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  return { items: await listProjectUrlPatterns(await getDatabase(), id) };
});
