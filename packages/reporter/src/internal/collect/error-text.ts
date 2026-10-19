import type { TestResult } from '@playwright/test/reporter';
import { joinErrorMessages, appendErrorLocation } from '@piwitests/core/error-text';
import { relativeTestPath } from '../support/test-paths.js';

/**
 * Build the stored error text for a test result: every error message deduped
 * and joined, plus a synthetic `at file:line:col` frame when the text carries
 * no stack frame. The assembly rules live in `@piwitests/core/error-text` so
 * imported blob reports produce byte-identical text; only the path resolution,
 * relative to `base` (the Playwright config's folder), is reporter-specific.
 */
export function buildErrorText(result: TestResult, base: string = process.cwd()): string | null {
  const text = joinErrorMessages(result.errors);
  if (!text) return null;

  const loc = result.error?.location;
  if (!loc?.file) return text;

  return appendErrorLocation(text, { file: relativeTestPath(loc.file, base), line: loc.line, column: loc.column });
}
