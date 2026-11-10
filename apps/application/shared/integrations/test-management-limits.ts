/**
 * How fast Piwi calls a test management tool. Zephyr Scale Cloud rate limits each token, and the catalog read is a
 * loop over pages, so every call of a connection is spaced out by one in-process limiter. The default and the bounds
 * live here so the limiter and the env-var registry agree; the registry test asserts the default against this constant.
 */

/** Requests a minute, per connection, unless `PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE` says otherwise. */
export const DEFAULT_TEST_MANAGEMENT_REQUESTS_PER_MINUTE = 20;
export const MIN_TEST_MANAGEMENT_REQUESTS_PER_MINUTE = 1;
export const MAX_TEST_MANAGEMENT_REQUESTS_PER_MINUTE = 600;

/**
 * The requests a minute a raw setting asks for. `invalid` is true for a value that is set but unusable (not a whole
 * number in range), and then `value` is the default: the caller logs it once.
 */
export function resolveRequestsPerMinute(raw: string | undefined | null): { value: number; invalid: boolean } {
  const text = raw?.trim();
  if (!text) return { value: DEFAULT_TEST_MANAGEMENT_REQUESTS_PER_MINUTE, invalid: false };
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_TEST_MANAGEMENT_REQUESTS_PER_MINUTE ||
    value > MAX_TEST_MANAGEMENT_REQUESTS_PER_MINUTE
  ) {
    return { value: DEFAULT_TEST_MANAGEMENT_REQUESTS_PER_MINUTE, invalid: true };
  }
  return { value, invalid: false };
}
