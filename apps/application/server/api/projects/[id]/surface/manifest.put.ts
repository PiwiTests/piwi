import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDatabase } from '../../../../database';
import { projects } from '../../../../database/schema';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { resolveRunBranchTag } from '../../../../utils/graph-ingest';
import { ingestProjectManifest } from '../../../../utils/surface-manifest';
import { manifestLimitError } from '#shared/graph';

defineRouteMeta({
  openAPI: {
    tags: ['Scenario gaps'],
    summary: 'Upload a project’s declared surface manifest',
    description:
      'Stores a declared-surface manifest — the routes and pages the application says it exposes — as graph nodes with origin `manifest` (from the instrumentation `/__piwi/manifest` or a committed `piwi.manifest.json`) or `openapi`. A declared route or page no test reaches becomes a "declared, never hit" gap. Reach is observed reach, never instrumented coverage. Each pattern holds at most 2048 characters, and each of its segments at most 16 parameters: a manifest past either limit is refused with 400.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'run:submit',
  },
});

const manifestRouteSchema = z.object({
  method: z.string().min(1),
  pattern: z.string().min(1),
  handler: z.string().nullable().optional(),
  responses: z.array(z.number().int()).optional(),
});
const manifestPageSchema = z.object({
  pattern: z.string().min(1),
  name: z.string().nullable().optional(),
});
const uploadSchema = z.object({
  source: z.enum(['instrumentation', 'committed', 'openapi']),
  /** The run's branch, so a route added on a pull-request branch is tagged, not written canonically. */
  branch: z.string().min(1).max(255).nullable().optional(),
  manifest: z.object({
    routes: z.array(manifestRouteSchema).max(5000).optional(),
    pages: z.array(manifestPageSchema).max(5000).optional(),
  }),
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, projectId);
  const db = await getDatabase();

  const validation = uploadSchema.safeParse(await readBody(event));
  if (!validation.success) {
    throw apiError({ statusCode: 400, message: 'Invalid manifest', data: validation.error.issues });
  }

  const { source, manifest, branch: runBranch } = validation.data;
  const limit = manifestLimitError(manifest);
  if (limit) throw apiError({ statusCode: 400, message: limit });

  // Tag the manifest with the run's branch: canonical (null) on the default
  // branch, the branch name otherwise, so a pull-request route never lands on the
  // default-branch graph and fires a false "declared, never hit" on main.
  let branch: string | null = null;
  if (runBranch) {
    const [project] = await db
      .select({ id: projects.id, defaultBranch: projects.defaultBranch })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (project) branch = await resolveRunBranchTag(db, project, null, runBranch);
  }

  const ingested = await ingestProjectManifest(db, projectId, manifest, source, { branch });
  return {
    success: ingested,
    routes: manifest.routes?.length ?? 0,
    pages: manifest.pages?.length ?? 0,
  };
});
