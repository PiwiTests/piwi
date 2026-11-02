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

/** The most characters kept of a run error's message, and of its stack. */
export const MAX_RUN_ERROR_CHARS = 4000;

/** The longest file path a run error's location keeps. */
const MAX_LOCATION_FILE_CHARS = 1000;

/** `text` with what may be a secret hidden, cut to {@link MAX_RUN_ERROR_CHARS} with a marker naming what was cut. */
function storedText(text: string): string {
  const hidden = hideSecretsInText(hideSecretsInError(text));
  if (hidden.length <= MAX_RUN_ERROR_CHARS) return hidden;
  return `${hidden.slice(0, MAX_RUN_ERROR_CHARS)}\n[truncated ${hidden.length - MAX_RUN_ERROR_CHARS} chars]`;
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
