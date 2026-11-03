/**
 * The errors of a run outside any test (`WireRunError`), as the reporter sends them and the dashboard stores them:
 * at most {@link MAX_RUN_ERRORS}, each text with what may be a secret hidden as the error text of a test is
 * (`hideSecretsInError`), and credentials anywhere in it (`hideSecretsInText`), then cut to
 * {@link MAX_RUN_ERROR_CHARS}. The reporter applies it to each error it collects, and the dashboard to what it
 * receives.
 */
import { hideSecretsInError, hideSecretsInText } from './mask';
import type { WireRunError } from './wire';

/** The most errors outside any test a run keeps: the first ones, which the later ones usually follow from. */
export const MAX_RUN_ERRORS = 20;

/** The most characters kept of a run error's message, and of its stack, the marker of a cut text included. */
export const MAX_RUN_ERROR_CHARS = 4000;

/** The longest file path a run error's location keeps. */
const MAX_LOCATION_FILE_CHARS = 1000;

/** The marker that ends a cut text, naming how many characters were cut. */
const cutMarker = (cut: number) => `\n[truncated ${cut} chars]`;

/**
 * `text` with what may be a secret hidden, cut with a marker naming what was cut so that the two fit
 * {@link MAX_RUN_ERROR_CHARS}. A text that fits is kept whole, so a stored text read again stays as it is.
 */
function storedText(text: string): string {
  const hidden = hideSecretsInText(hideSecretsInError(text));
  if (hidden.length <= MAX_RUN_ERROR_CHARS) return hidden;
  const kept = MAX_RUN_ERROR_CHARS - cutMarker(hidden.length).length;
  return hidden.slice(0, kept) + cutMarker(hidden.length - kept);
}

function lineOrColumn(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null;
}

/** A run error's location read from untrusted input: a file, a line and a column, or null. */
function storedLocation(value: unknown): WireRunError['location'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { file, line, column } = value as { file?: unknown; line?: unknown; column?: unknown };
  const at = { line: lineOrColumn(line), column: lineOrColumn(column) };
  if (typeof file !== 'string' || !file || file.length > MAX_LOCATION_FILE_CHARS) return null;
  if (at.line === null || at.column === null) return null;
  return { file, line: at.line, column: at.column };
}

/**
 * One run error read from untrusted input, as it is kept: a message (else null), its stack and its location, each
 * text hidden and cut. Pure.
 */
export function sanitizeRunError(value: unknown): WireRunError | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { message, stack, location } = value as { message?: unknown; stack?: unknown; location?: unknown };
  if (typeof message !== 'string' || !message.trim()) return null;
  return {
    message: storedText(message),
    stack: typeof stack === 'string' && stack.trim() ? storedText(stack) : null,
    location: storedLocation(location),
  };
}

/**
 * An error as Playwright reports one (its `TestError`), live or read back from a blob report: the fields a run error is
 * made of, each read only when it has the expected type.
 */
export interface ReportedError {
  message?: unknown;
  value?: unknown;
  stack?: unknown;
  cause?: unknown;
  location?: unknown;
}

/** How many causes of an error its message names, as Playwright's terminal reporters write them (`[cause]: …`). */
const MAX_CAUSES = 3;

/** The lines of a stack before its first frame: its message. */
const FIRST_FRAME = /^\s*at\s/m;

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function reportedError(value: unknown): ReportedError | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ReportedError) : null;
}

/** An error's message: its own, the value thrown when it was not an `Error`, else the head of its stack. */
function messageOf(error: ReportedError): string {
  const own = textOf(error.message) || textOf(error.value);
  if (own) return own;
  const stack = textOf(error.stack);
  const frame = FIRST_FRAME.exec(stack);
  return (frame ? stack.slice(0, frame.index) : stack).trim();
}

/**
 * An error Playwright reported outside any test (`onError`), as the run keeps it ({@link sanitizeRunError}): its
 * message with its causes after it, the frames of its stack, and the place it was thrown, its file named by
 * `fileName` (relative to the Playwright config's folder, as test files are). Null for an error with no message. Pure.
 */
export function runErrorOfReported(error: ReportedError, fileName: (file: string) => string): WireRunError | null {
  let message = messageOf(error);
  let cause = reportedError(error.cause);
  for (let depth = 0; cause && depth < MAX_CAUSES; depth++, cause = reportedError(cause.cause)) {
    const said = messageOf(cause);
    if (said) message += `\n[cause]: ${said}`;
  }
  const stack = textOf(error.stack);
  const frame = FIRST_FRAME.exec(stack);
  const at = reportedError(error.location) as { file?: unknown; line?: unknown; column?: unknown } | null;
  const location =
    at && typeof at.file === 'string' && at.file ? { file: fileName(at.file), line: at.line, column: at.column } : null;
  return sanitizeRunError({ message, stack: frame ? stack.slice(frame.index).trimEnd() : null, location });
}

/** A run's errors read from untrusted input, as they are kept: the first {@link MAX_RUN_ERRORS}; null for none. Pure. */
export function sanitizeRunErrors(value: unknown): WireRunError[] | null {
  if (!Array.isArray(value)) return null;
  const kept: WireRunError[] = [];
  for (const item of value) {
    if (kept.length >= MAX_RUN_ERRORS) break;
    const error = sanitizeRunError(item);
    if (error) kept.push(error);
  }
  return kept.length > 0 ? kept : null;
}
