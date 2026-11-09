import { getDatabase } from '../../database';
import { updateTag } from '#shared/handlers/tags';
import { z } from 'zod';
import { requireAuth } from '../../utils/auth';
import { requireRouteId } from '../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Tags'],
    summary: 'Update a tag',
    description: 'Updates the text and/or color of an existing tag. Requires `tags:manage` (administrators only).',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'tags:manage',
  },
});

const updateTagSchema = z.object({
  text: z.string().min(1).max(50).optional(),
  color: z.string().min(1).optional(),
});

export default eventHandler(async (event) => {
  await requireAuth(event);

  const id = requireRouteId(event, 'id', 'tag ID');

  const body = await readBody(event);
  const validation = updateTagSchema.safeParse(body);
  if (!validation.success) {
    throw apiError({
      statusCode: 400,
      message: 'Invalid request body',
      data: validation.error.issues,
    });
  }

  try {
    const db = await getDatabase();
    return await updateTag(db, id, validation.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update tag';
    const statusCode = message === 'Tag not found' ? 404 : 400;
    throw apiError({ statusCode, message });
  }
});
