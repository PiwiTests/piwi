import { z } from 'zod';
import type { SubscriptionFilters } from '#shared/notification-events';

/** Most values one filter list holds, and the longest value. */
const MAX_FILTER_VALUES = 100;
const MAX_FILTER_VALUE_LENGTH = 256;

/** A list of filter values: owners, statuses. */
const filterValues = z.array(z.string().max(MAX_FILTER_VALUE_LENGTH)).max(MAX_FILTER_VALUES);

/** The longest branch or environment pattern, and the most `*` one holds. */
const MAX_NAME_PATTERN_LENGTH = 200;
const MAX_NAME_PATTERN_STARS = 10;

/** What a refused branch or environment pattern answers. */
export const NAME_PATTERN_LIMITS = `A branch or environment pattern holds at most ${MAX_NAME_PATTERN_LENGTH} characters and ${MAX_NAME_PATTERN_STARS} "*"`;

/** Branch or environment names, each an exact name or a `*` pattern. */
const namePatterns = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(MAX_NAME_PATTERN_LENGTH, NAME_PATTERN_LIMITS)
      .refine((pattern) => pattern.split('*').length - 1 <= MAX_NAME_PATTERN_STARS, NAME_PATTERN_LIMITS),
  )
  .max(MAX_FILTER_VALUES);

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

/** The message a subscription body `subscriptionFiltersSchema` refused answers with. */
export function subscriptionFiltersError(error: z.ZodError): string {
  return error.issues.some((issue) => issue.message === NAME_PATTERN_LIMITS)
    ? NAME_PATTERN_LIMITS
    : 'Invalid request body';
}

/** When a digest subscription sends: a time of day, `HH:MM` (or `H:MM`), in UTC. */
export const digestAtSchema = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/);
