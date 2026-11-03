/**
 * What one attempt of a test wrote to one of its streams (Playwright's `TestResult.stdout` or `stderr`), as the
 * reporter sends it and the dashboard stores it: what may be a secret hidden (`hideSecretsInOutput`: as in the error
 * text of a test, credentials anywhere in it, and a value given a name like a credential's); past
 * {@link MAX_TEST_OUTPUT_CHARS}, its first and its last lines, with a line naming what was cut between them.
 */
import { hideSecretsInOutput } from './mask';

/** The most characters kept of one stream an attempt wrote: about half from its start, half from its end. */
export const MAX_TEST_OUTPUT_CHARS = 64 * 1024;

/** The part of the budget left for the line that names what was cut. */
const CUT_LINE_ROOM = 100;

/** The first `chars` characters of `text`, ending after a line break when that keeps half of them or more. */
function headOf(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const cut = text.slice(0, chars);
  const lineEnd = cut.lastIndexOf('\n');
  return lineEnd + 1 >= chars / 2 ? cut.slice(0, lineEnd + 1) : cut;
}

/** The last `chars` characters of `text`, starting after a line break when that keeps half of them or more. */
function tailOf(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const cut = text.slice(text.length - chars);
  const lineStart = cut.indexOf('\n');
  return lineStart !== -1 && cut.length - lineStart - 1 >= chars / 2 ? cut.slice(lineStart + 1) : cut;
}

function lineBreaks(text: string): number {
  let count = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++;
  return count;
}

/** The line that stands where the output was cut: the line breaks and the characters it left out. */
function cutLine(lines: number, chars: number): string {
  return lines > 0
    ? `[… ${lines} lines (${chars} characters) of output cut …]`
    : `[… ${chars} characters of output cut …]`;
}

/**
 * `text`, what an attempt wrote to one stream, as it is kept: null when it holds only white space; else with what
 * may be a secret hidden and, when that is longer than `max`, its head and its tail, each cut at a line break when
 * one is near, joined by a line naming how much was cut. An output more than four times `max` has its middle left
 * out before its secrets are hidden, so hiding them takes a bounded time; what is kept lies far from that cut. The
 * result is at most `max` characters long. Pure.
 */
export function boundTestOutput(text: string, max: number = MAX_TEST_OUTPUT_CHARS): string | null {
  if (!text.trim()) return null;
  const window = 2 * max;
  const long = text.length > 2 * window;
  const start = hideSecretsInOutput(long ? text.slice(0, window) : text);
  if (!long && start.length <= max) return start;
  const end = long ? hideSecretsInOutput(text.slice(text.length - window)) : start;
  const half = Math.max(1, Math.floor((max - CUT_LINE_ROOM) / 2));
  const head = headOf(start, half);
  const tail = tailOf(end, half);
  const skipped = long
    ? [start.slice(head.length), text.slice(window, text.length - window), end.slice(0, end.length - tail.length)]
    : [start.slice(head.length, start.length - tail.length)];
  const lines = skipped.reduce((sum, part) => sum + lineBreaks(part), 0);
  const chars = skipped.reduce((sum, part) => sum + part.length, 0);
  return `${head}${head.endsWith('\n') ? '' : '\n'}${cutLine(lines, chars)}\n${tail}`;
}

/** What an attempt wrote to one stream, read from untrusted input and kept as {@link boundTestOutput} keeps it. Pure. */
export function sanitizeTestOutput(value: unknown): string | null {
  return typeof value === 'string' ? boundTestOutput(value) : null;
}
