import { eq } from 'drizzle-orm';
import { getDatabase } from '../../../database';
import { projects } from '../../../database/schema';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { resolveTagKeyPatterns } from '#shared/integrations/tag-keys';
import { lastCompleteRunTagOverlap } from '#shared/handlers/tag-key-overlap';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'List the tags both key patterns match',
    description:
      'The tags of the project’s last complete run (the whole suite, finished) that both of its tag key patterns match, which the integrations would read as an issue key and as a test case key: `overlaps` lists up to 20, each with the `tag` and the `testTitle` of a test that carries it, and `runId` is the run read (null when the project has no complete run). Empty while either pattern is off. Requires `project:manage` (Project admin on the project).',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:manage',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const db = await getDatabase();
  const [project] = await db.select({ tagKeys: projects.tagKeys }).from(projects).where(eq(projects.id, id));
  if (!project) throw apiError({ statusCode: 404, message: 'Project not found' });
  return await lastCompleteRunTagOverlap(db, id, resolveTagKeyPatterns(project.tagKeys));
});
