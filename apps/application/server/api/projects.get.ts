import { requireAuth } from '../utils/auth';
import { getProjectScope } from '../utils/project-access';
import { getDatabase } from '../database';
import { listProjects } from '#shared/handlers/projects';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'List all projects with stats',
    description: 'Returns all projects with their latest run, total runs count, total test cases, and tags',
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  const scope = await getProjectScope(db, user as any);
  const result = await listProjects(db, scope);
  const items = result.map((p: any) => {
    const { scmToken: _scm, ciServerToken: _ciServerToken, ...rest } = p;
    return rest;
  });
  return { items };
});
