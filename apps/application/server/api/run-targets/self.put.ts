import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { runTargets } from '../../database/schema';
import { can } from '#shared/permissions';
import { requireRunTarget } from '../../utils/run-requests';

defineRouteMeta({
  openAPI: {
    tags: ['Run requests'],
    summary: 'Describe this connected app to the instance',
    description:
      'A run target tells the instance its platform, its version and the projects it has a folder for (`projectIds`, at most 200), which the dashboard shows beside it when the person picks where to run; a project where its owner lacks `run:receive` is left out. Each field is optional; a field left out keeps its value. Authenticated with the target’s key alone. Answers the target as stored.',
    'x-required-permission': 'run:receive',
    responses: {
      200: { description: 'The target' },
      400: { description: 'A field is out of bounds' },
    },
  },
});

const bodySchema = z
  .object({
    platform: z.string().trim().min(1).max(50).optional(),
    version: z.string().trim().min(1).max(50).optional(),
    projectIds: z.array(z.number().int().positive().max(2_147_483_647)).max(200).optional(),
  })
  .strict();

export default eventHandler(async (event) => {
  const { db, target, access } = await requireRunTarget(event);
  const parsed = bodySchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  }
  const { platform, version, projectIds } = parsed.data;
  const values = {
    ...(platform !== undefined ? { platform } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(projectIds !== undefined
      ? { projectIds: [...new Set(projectIds)].filter((id) => can(access, 'run:receive', id)).sort((a, b) => a - b) }
      : {}),
  };
  const [row] = Object.keys(values).length
    ? await db.update(runTargets).set(values).where(eq(runTargets.id, target.id)).returning()
    : [target];
  return {
    id: row!.id,
    kind: row!.kind,
    deviceName: row!.deviceName,
    platform: row!.platform,
    version: row!.version,
    projectIds: row!.projectIds ?? [],
    lastSeenAt: row!.lastSeenAt?.toISOString() ?? null,
  };
});
