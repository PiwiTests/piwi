import { getDatabase } from '../database';
import { isAuthEnabled, requireAuth } from '../utils/auth';
import { getProjectAccessGrid } from '#shared/handlers/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: 'Get the permission grid',
    description:
      'Returns the data behind Settings → Permissions: every user (`instanceRole`, `groupIds`), every group (`memberCount`), every project, and every role binding. A binding gives its subject (`{ type: "user" | "group", id }`) one project role on one project, or on all projects, current and future, when `projectId` is null. A user also holds every role of their groups; an administrator opens every project without any binding. Users and groups are sorted by the name shown, projects by label.',
    'x-required-permission': 'users:manage',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);

  const grid = await getProjectAccessGrid(await getDatabase());
  return { ...grid, authEnabled: isAuthEnabled() };
});
