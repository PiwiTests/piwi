import { projects } from '../../../database/schema';
import { can } from '#shared/permissions';
import { requireRunTarget } from '../../../utils/run-requests';

defineRouteMeta({
  openAPI: {
    tags: ['Run requests'],
    summary: 'The projects a connected app may link a folder to',
    description:
      'The projects the owner of a connected desktop app can read, each `{ id, name }` (its label, else its name), sorted by name: the app offers them to link a folder of its machine to, so it can compare a test that fails there with that project’s CI (Compare with team instance). Authenticated with the key of a connected desktop app that holds `project:read`; refused (403) when the key lacks it (`RUN_TARGET_KEY_CANNOT_COMPARE`).',
    'x-required-permission': 'project:read',
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: '`{ projects }`' },
      403: { description: 'Not a connected app’s key, or a key that cannot compare' },
    },
  },
});

export default eventHandler(async (event) => {
  const caller = await requireRunTarget(event, { permission: 'project:read' });
  const rows = await caller.db.select({ id: projects.id, name: projects.name, label: projects.label }).from(projects);
  return {
    projects: rows
      .filter((row) => can(caller.access, 'project:read', row.id))
      .map((row) => ({ id: row.id, name: row.label || row.name }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id),
  };
});
