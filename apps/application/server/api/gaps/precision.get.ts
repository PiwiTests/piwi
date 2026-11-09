import { inArray } from 'drizzle-orm';
import { requireAuth } from '../../utils/auth';
import { getProjectScope } from '../../utils/project-access';
import { getDatabase } from '../../database';
import { projects } from '../../database/schema';
import { loadDetectorPrecision } from '#shared/handlers/detector-precision';

defineRouteMeta({
  openAPI: {
    tags: ['Scenario gaps'],
    summary: 'Per-detector precision across projects',
    description:
      "For every visible project, each detector's precision from triage verdicts, whether it has muted itself, and how many of the gaps it raised on a pull request were acted on there. Drives the admin stats view of the scenario-gap learning loop.",
    parameters: [],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  const scope = await getProjectScope(db, user as any);

  const rows =
    scope === 'all'
      ? await db.select({ id: projects.id, name: projects.name }).from(projects)
      : scope.size === 0
        ? []
        : await db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(inArray(projects.id, [...scope]));

  const items = [];
  for (const p of rows) {
    const detectors = await loadDetectorPrecision(db, p.id);
    if (detectors.length > 0) items.push({ projectId: p.id, projectName: p.name, detectors });
  }
  return { items };
});
