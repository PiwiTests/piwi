import { getDatabase } from '../../database';
import { listUserItems, listUserSummaries } from '#shared/handlers/project-access';
import { getRequestAccess, isAuthEnabled, requireAuth } from '../../utils/auth';
import { getProjectScope } from '../../utils/project-access';
import { can } from '#shared/permissions';

defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: 'List users',
    description:
      "An administrator gets every user (password fields excluded), with each user's email, instance role (`instanceRole`) and groups (`groupIds`). A Project admin, who needs the names to add people to their project, gets `{ id, username, name }` of the users who can open a project they can open, administrators included; `lookup` adds the user whose username is that value, ignoring letter case, so someone who holds no role yet can be added.",
    parameters: [
      {
        name: 'lookup',
        in: 'query',
        required: false,
        description: 'A username to add to a Project admin’s list, matched whole and ignoring letter case.',
        schema: { type: 'string' },
      },
    ],
    'x-required-permission': ['users:manage', 'project:members'],
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  const access = await getRequestAccess(event);
  // The early check let in an administrator or someone holding project:members on a project.
  if (can(access, 'users:manage')) return { items: await listUserItems(db), authEnabled: isAuthEnabled(event) };
  // A Project admin lists the users who share a project they can open.
  const { lookup } = getQuery(event);
  const items = await listUserSummaries(
    db,
    await getProjectScope(db, user, 'project:read'),
    typeof lookup === 'string' ? lookup : null,
  );
  return { items, authEnabled: isAuthEnabled(event) };
});
