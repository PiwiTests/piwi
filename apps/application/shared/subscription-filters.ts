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

/** The most characters the branch and environment patterns of one subscription hold together. */
const MAX_NAME_PATTERNS_TOTAL = 2000;

/** What a subscription whose branch and environment patterns are too long together answers. */
export const NAME_PATTERNS_TOTAL_LIMIT = `The branch and environment patterns of a subscription hold at most ${MAX_NAME_PATTERNS_TOTAL} characters together`;

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
export const subscriptionFiltersSchema = z
  .object({
    branches: namePatterns.optional(),
    environments: namePatterns.optional(),
    statuses: filterValues.optional(),
    defaultBranchOnly: z.boolean().optional(),
    owners: filterValues.optional(),
    flakinessThreshold: z.number().min(0).max(1).optional(),
    perfRegressionPct: z.number().min(0).optional(),
  })
  .refine(
    (filters) =>
      [...(filters.branches ?? []), ...(filters.environments ?? [])].reduce((sum, p) => sum + p.length, 0) <=
      MAX_NAME_PATTERNS_TOTAL,
    NAME_PATTERNS_TOTAL_LIMIT,
  ) satisfies z.ZodType<SubscriptionFilters>;

/** The refusals that name a limit, answered as they are. */
const LIMIT_MESSAGES: ReadonlySet<string> = new Set([NAME_PATTERN_LIMITS, NAME_PATTERNS_TOTAL_LIMIT]);

/** The message a subscription body `subscriptionFiltersSchema` refused answers with. */
export function subscriptionFiltersError(error: z.ZodError): string {
  return error.issues.find((issue) => LIMIT_MESSAGES.has(issue.message))?.message ?? 'Invalid request body';
}

/** When a digest subscription sends: a time of day, `HH:MM` (or `H:MM`), in UTC. */
export const digestAtSchema = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/);
