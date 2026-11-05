/**
 * Extract a worker index from a Playwright `TestResult`, falling back to
 * `parallelIndex` when `workerIndex` is absent. Returns `null` when neither is
 * set. Localizes the `as any` reach into Playwright's result object so the
 * cast lives in exactly one place.
 */
export function workerIndexOf(result: any): number | null {
  if (!result) return null;
  return result.workerIndex ?? result.parallelIndex ?? null;
}

/**
 * The worker's lane from a Playwright `TestResult`: its `parallelIndex`, the slot a worker Playwright starts again
 * after a failure keeps. `null` when it is not a non-negative integer.
 */
export function parallelIndexOf(result: any): number | null {
  const lane = result?.parallelIndex;
  return typeof lane === 'number' && Number.isInteger(lane) && lane >= 0 ? lane : null;
}
