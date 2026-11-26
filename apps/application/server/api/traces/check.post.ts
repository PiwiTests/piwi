import { getDatabase } from '../../database';
import { projects } from '../../database/schema';
import { eq } from 'drizzle-orm';
import { requireAuth } from '../../utils/auth';
import { canAccessProject } from '../../utils/project-access';
import { checkExistingBlobs } from '../../utils/trace-blobs';

defineRouteMeta({
  openAPI: {
    tags: ['Traces'],
    summary: 'Check trace blob existence',
    description:
      'Checks which trace blob SHA-256 hashes already exist in storage for a given project. Accepts projectName and hashes array in the request body.',
    'x-required-permission': 'run:submit',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);

  const body = await readBody<{ projectName?: unknown; hashes?: unknown }>(event);
  const projectName = body?.projectName as string | undefined;
  const hashes = body?.hashes as unknown[] | undefined;

  if (!projectName || typeof projectName !== 'string') {
    throw apiError({ statusCode: 400, message: 'Missing projectName' });
  }
  if (!Array.isArray(hashes)) {
    throw apiError({ statusCode: 400, message: 'hashes must be an array' });
  }

  // Validate: only accept well-formed SHA-256 hex strings
  const validHashes = hashes.filter((h): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/i.test(h));

  const db = await getDatabase();
  const projectRows = await db.select({ id: projects.id }).from(projects).where(eq(projects.name, projectName));
  const project = projectRows[0];

  // Unknown project — or one the caller cannot access — returns all-missing, so
  // this endpoint can't be used as a cross-project oracle for blob (or project)
  // existence. With auth disabled the instance is single-user, so access is
  // granted and behavior is unchanged.
  if (!project || !(await canAccessProject(db, user, project.id, 'run:submit'))) {
    return { existing: [], missing: validHashes };
  }

  const existingSet = await checkExistingBlobs(project.id, validHashes);
  return {
    existing: validHashes.filter((h) => existingSet.has(h)),
    missing: validHashes.filter((h) => !existingSet.has(h)),
  };
});
