import { getDatabase } from '../../database';
import { subscriptions, notificationChannels } from '../../database/schema';
import { getRequestAccess, requireAuth, isAuthEnabled } from '../../utils/auth';
import { getProjectScope, scopeAllows } from '../../utils/project-access';
import { formatSubscription } from '../../utils/subscriptions';
import { NOTIFICATION_EVENTS } from '#shared/notification-events';
import { digestAtSchema, subscriptionFiltersError, subscriptionFiltersSchema } from '#shared/subscription-filters';
import { isAdministrator } from '#shared/permissions';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

defineRouteMeta({
  openAPI: {
    tags: ['Notifications'],
    summary: 'Create a subscription',
    description:
      'Creates a new subscription for the current user. Administrators can create global (instance-wide) subscriptions; with authentication disabled every subscription is global. Optional `filters` narrow what is delivered: `branches` and `environments` (exact names or `*` patterns such as `release/*`, each of at most 200 characters and 10 `*` and all of them at most 2,000 characters together, matched against the run every run-scoped event comes from), `statuses`, `defaultBranchOnly`, `owners`, `flakinessThreshold` and `perfRegressionPct`.',
    'x-required-permission': 'signed-in',
  },
});

const schema = z.object({
  channelId: z.number().int(),
  projectId: z.number().int().nullable().optional(),
  events: z.array(z.enum(NOTIFICATION_EVENTS)).min(1).max(NOTIFICATION_EVENTS.length),
  filters: subscriptionFiltersSchema.optional(),
  mode: z.enum(['realtime', 'digest']).optional(),
  digestAt: digestAtSchema.optional(),
  global: z.boolean().optional(), // admin only: instance-wide (userId=null) subscription
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const body = await readBody(event);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: subscriptionFiltersError(parsed.error), data: parsed.error.issues });
  }

  const { channelId, projectId, events, filters, mode, digestAt, global: requestedGlobal } = parsed.data;

  const db = await getDatabase();
  const [channel] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
  if (!channel) throw apiError({ statusCode: 404, message: 'Channel not found' });

  const isAdmin = isAdministrator(await getRequestAccess(event));
  if (channel.userId !== null && channel.userId !== user.id && !isAdmin) {
    throw apiError({ statusCode: 403, message: "Cannot subscribe to another user's channel" });
  }

  if (requestedGlobal && !isAdmin) {
    throw apiError({ statusCode: 403, message: 'Only administrators can create global subscriptions' });
  }

  // Without auth there is no user row to own a subscription — everything is global.
  const isGlobal = requestedGlobal || !isAuthEnabled(event);

  // A global subscription delivers with no per-user access check, so it must
  // target a channel that is itself global — a personal channel would leak
  // other projects' failures to its owner.
  if (isGlobal && channel.userId !== null) {
    throw apiError({ statusCode: 400, message: 'Global subscriptions require a global channel' });
  }

  // Only let the caller subscribe to projects they can access. A null projectId
  // is a wildcard across every project, so it is reserved for global scope —
  // otherwise notifications (failing-test titles, files, error excerpts) would
  // leak from projects the subscriber is not a member of.
  const scope = await getProjectScope(db, user);
  if (projectId == null) {
    if (scope !== 'all') {
      throw apiError({
        statusCode: 403,
        message: 'Only users with access to all projects can subscribe to every project',
      });
    }
  } else if (!scopeAllows(scope, projectId)) {
    throw apiError({ statusCode: 403, message: 'No access to this project' });
  }

  const [sub] = await db
    .insert(subscriptions)
    .values({
      userId: isGlobal ? null : user.id,
      channelId,
      projectId: projectId ?? null,
      events: events as unknown as string[],
      filters: filters ?? null,
      mode: mode || 'realtime',
      digestAt: digestAt || null,
      active: true,
    })
    .returning();

  return { success: true, subscription: formatSubscription(sub!, channel) };
});
