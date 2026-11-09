import { eq } from 'drizzle-orm';
import { getDatabase } from '../../../database';
import { projects } from '../../../database/schema';
import { requireAuth } from '../../../utils/auth';
import { getProjectScope, scopeAllows } from '../../../utils/project-access';
import { resolveMaxImportBytes } from '../../../utils/upload-limits';
import { findImportedHashes, judgeImportFiles } from '#shared/handlers/import-runs';
import type { ImportCheckResponse } from '#shared/import.types';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Check blob-report archives before importing them',
    description:
      'Judge a batch of archives from their name, size and SHA-256 alone: too large for this server, already imported into the project, or safe to upload. Lets a client skip uploads that would be rejected or ignored.',
    'x-required-permission': 'storage:manage',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              projectName: { type: 'string' },
              files: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    size: { type: 'integer' },
                    hash: { type: 'string', description: 'Lower-case hex SHA-256 of the file' },
                  },
                  required: ['name', 'size', 'hash'],
                },
              },
            },
            required: ['projectName', 'files'],
          },
        },
      },
    },
  },
});

/** Guards the batch against a client asking about an unreasonable number of files. */
const MAX_FILES_PER_CHECK = 500;

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const body = await readBody(event);

  const projectName = typeof body?.projectName === 'string' ? body.projectName.trim() : '';
  if (!projectName) throw apiError({ statusCode: 400, message: 'Missing required field: projectName' });

  const requested: unknown[] = Array.isArray(body?.files) ? body.files : [];
  if (requested.length > MAX_FILES_PER_CHECK) {
    throw apiError({ statusCode: 400, message: `Too many files in one check (max ${MAX_FILES_PER_CHECK})` });
  }

  const db = await getDatabase();
  const scope = await getProjectScope(db, user as any);
  const maxBytes = resolveMaxImportBytes();

  const existingProjects = await db.select().from(projects).where(eq(projects.name, projectName));
  const project = existingProjects[0];

  if (project) {
    if (!scopeAllows(scope, project.id)) {
      throw apiError({ statusCode: 403, message: 'No access to this project' });
    }
  } else if (scope !== 'all') {
    throw apiError({ statusCode: 403, message: 'Cannot create a new project — no global access' });
  }

  const hashes = requested
    .map((raw) => (raw as { hash?: unknown } | null)?.hash)
    .filter((hash): hash is string => typeof hash === 'string')
    .map((hash) => hash.toLowerCase());

  const alreadyImported = project ? await findImportedHashes(db, project.id, hashes) : new Map<string, number>();
  const results = judgeImportFiles(requested, {
    maxBytes,
    alreadyImported,
    tooLargeSuffix: " — this server's limit.",
  });

  return { maxBytes, results } satisfies ImportCheckResponse;
});
