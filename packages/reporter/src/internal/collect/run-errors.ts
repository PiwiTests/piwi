import type { TestError } from '@playwright/test/reporter';
import { runErrorOfReported } from '@piwitests/core/run-errors';
import type { WireRunError } from '../../types/wire.js';
import { relativeTestPath } from '../support/test-paths.js';

/**
 * An error Playwright reported outside any test (`onError`), as the run keeps it (`runErrorOfReported`): its message
 * with its causes after it, the frames of its stack, and the place it was thrown, named relative to `base` (the
 * Playwright config's folder) as test files are. Null for an error with no message.
 */
export function runErrorOf(error: TestError, base: string): WireRunError | null {
  return runErrorOfReported(error, (file) => relativeTestPath(file, base));
}
