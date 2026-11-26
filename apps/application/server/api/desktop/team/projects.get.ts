import { getDatabase } from '../../../database';
import { desktopTeamProjects } from '../../../utils/desktop-team-projects';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Compare with team instance: the team projects a folder can be linked to (desktop app)',
    description:
      'Desktop build only — 404 on the server build. `{ status: "ok", instance, teamProjects, folders }`: the projects of the connected team instance its owner can read (`{ id, name }`), and each project of this app with a folder on this machine (`{ projectId, projectName, folder, teamProjectId }`, the team project its folder is linked to, else null). `{ status: "unavailable", problem, message, folders }` when the instance does not list its projects (`not-connected`, `reconnect`, `refused`, `not-supported`, `unreachable`).',
    'x-required-permission': 'settings:manage',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  const db = await getDatabase();
  setResponseHeader(event, 'cache-control', 'no-store');
  return desktopTeamProjects(db);
});
