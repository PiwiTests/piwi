import { z } from 'zod';
import type { SubscriptionFilters } from '#shared/notification-events';

/** Most values one filter list holds, and the longest value. */
const MAX_FILTER_VALUES = 100;
const MAX_FILTER_VALUE_LENGTH = 256;

/** A list of filter values: owners, statuses. */
const filterValues = z.array(z.string().max(MAX_FILTER_VALUE_LENGTH)).max(MAX_FILTER_VALUES);

/** Branch or environment names, each an exact name or a `*` pattern. */
const namePatterns = z.array(z.string().trim().min(1).max(MAX_FILTER_VALUE_LENGTH)).max(MAX_FILTER_VALUES);

/** The delivery filters a subscription stores, as the create and update endpoints validate them. */
export const subscriptionFiltersSchema = z.object({
  branches: namePatterns.optional(),
  environments: namePatterns.optional(),
  statuses: filterValues.optional(),
  defaultBranchOnly: z.boolean().optional(),
  owners: filterValues.optional(),
  flakinessThreshold: z.number().min(0).max(1).optional(),
  perfRegressionPct: z.number().min(0).optional(),
}) satisfies z.ZodType<SubscriptionFilters>;

/** When a digest subscription sends: a time of day, `HH:MM` (or `H:MM`), in UTC. */
export const digestAtSchema = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/);
