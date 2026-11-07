import { z } from 'zod';
import { getDatabase } from '../database';
import { isAuthEnabled, requireAuth } from '../utils/auth';
import { getInstanceCapabilities, setInstanceDecisions } from '#shared/handlers/capabilities';
import { CAPABILITY_BY_ID, isOptInCapability, type CapabilityId } from '#shared/capabilities';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Set instance capability decisions',
    description:
      'Declines, turns on or clears optional capabilities at instance level. The body is `{ decisions }`, a map from capability id to `"declined"`, `"enabled"` (accepted only for a capability that is off until turned on, such as `machine-runs`, and for one that needs sign-in only while sign-in is on: 409 otherwise) or `null` to clear a stored decision. Returns the resolved states after the change. Requires `settings:manage` (administrators only).',
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

  const notOptIn = Object.entries(validation.data.decisions)
    .filter(([id, value]) => value === 'enabled' && !isOptInCapability(id))
    .map(([id]) => id);
  if (notOptIn.length) {
    throw apiError({
      statusCode: 400,
      message: `Only a capability that is off until turned on can be enabled: ${notOptIn.join(', ')}`,
    });
  }
  // Every id enabled here is an opt-in capability's, checked above.
  const needsSignIn = Object.entries(validation.data.decisions)
    .filter(([id, value]) => value === 'enabled' && CAPABILITY_BY_ID[id as CapabilityId].needsSignIn)
    .map(([id]) => id);
  if (needsSignIn.length && !isAuthEnabled(event)) {
    throw apiError({
      statusCode: 409,
      message: `Turn sign-in on (PIWI_AUTH_ENABLED) before turning on: ${needsSignIn.join(', ')}`,
    });
  }
  await setInstanceDecisions(db, validation.data.decisions);
  return getInstanceCapabilities(db);
});
