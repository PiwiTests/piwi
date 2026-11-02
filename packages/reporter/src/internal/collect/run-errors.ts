import type { TestError } from '@playwright/test/reporter';
import { sanitizeRunError } from '@piwitests/core/run-errors';
import type { WireRunError } from '../../types/wire.js';
import { relativeTestPath } from '../support/test-paths.js';

/** How many causes of an error its message names, as Playwright's terminal reporters write them (`[cause]: …`). */
const MAX_CAUSES = 3;

/** The lines of a stack before its first frame: its message. */
const FIRST_FRAME = /^\s*at\s/m;

/** An error's message: its own, the value thrown when it was not an `Error`, else the head of its stack. */
function messageOf(error: TestError): string {
  const own = error.message || error.value;
  if (own) return own;
  const stack = error.stack ?? '';
  const frame = FIRST_FRAME.exec(stack);
  return (frame ? stack.slice(0, frame.index) : stack).trim();
}

/**
 * An error Playwright reported outside any test (`onError`), as the run keeps it (`sanitizeRunError`): its message
 * with its causes after it, the frames of its stack, and the place it was thrown, named relative to `base` (the
 * Playwright config's folder) as test files are. Null for an error with no message.
 */
export function runErrorOf(error: TestError, base: string): WireRunError | null {
  let message = messageOf(error);
  let cause = error.cause;
  for (let depth = 0; cause && depth < MAX_CAUSES; depth++, cause = cause.cause) {
    const said = messageOf(cause);
    if (said) message += `\n[cause]: ${said}`;
  }
  const stack = error.stack ?? '';
  const frame = FIRST_FRAME.exec(stack);
  const location = error.location?.file
    ? {
        file: relativeTestPath(error.location.file, base),
        line: error.location.line,
        column: error.location.column,
      }
    : null;
  return sanitizeRunError({ message, stack: frame ? stack.slice(frame.index).trimEnd() : null, location });
}
