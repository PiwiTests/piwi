import { z } from 'zod';
import { getDatabase } from '../database';
import { requireAuth } from '../utils/auth';
import { getInstanceCapabilities, setInstanceDecisions } from '#shared/handlers/capabilities';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Set instance capability decisions',
    description:
      'Declines, turns on or clears optional capabilities at instance level. The body is `{ decisions }`, a map from capability id to `"declined"`, `"enabled"` (accepted only for a capability that is off until turned on, such as `machine-runs`) or `null` to clear a stored decision. Returns the resolved states after the change. Requires `settings:manage` (administrators only).',
    'x-required-permission': 'settings:manage',
  },
});

const bodySchema = z.object({
  decisions: z.record(z.string(), z.union([z.literal('declined'), z.literal('enabled'), z.null()])),
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const db = await getDatabase();

  const validation = bodySchema.safeParse(await readBody(event));
  if (!validation.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: validation.error.issues });
  }

  await setInstanceDecisions(db, validation.data.decisions);
  return getInstanceCapabilities(db);
});
