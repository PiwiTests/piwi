/**
 * The error paths of a source file, from a scan of its text: a `catch` block, a
 * `throw`, or a statement that returns or sets an error status (a named result
 * such as `TypedResults.NotFound()`, `res.status(422)`). Brace-language syntax
 * (TypeScript, JavaScript, C#, Java); a comment line is skipped, and a string
 * that holds a brace can end a `catch` block early. Pure: the *error path never
 * executed* detector matches what it finds against the lines the suites ran.
 */
import { errorStatusesOfLine } from './change-time';
import type { LineRange } from '@piwitests/core/coverage';

export type ErrorPathKind = 'catch' | 'throw' | 'error-return';

/** One error path: its lines, 1-based and inclusive, and its first line as written. */
export interface ErrorPath {
  kind: ErrorPathKind;
  range: LineRange;
  text: string;
}

/** Lines a statement is read across at most, looking for its end. */
const MAX_STATEMENT_LINES = 12;

const COMMENT = /^\s*(\/\/|\/\*|\*|#)/;
const CATCH = /\bcatch\b\s*(\(|\{)/;
const THROW = /\bthrow\b/;
const RETURN = /\breturn\b/;

/** The line a statement starting at `start` ends on: its first `;`, else its own line. */
function statementEnd(lines: readonly string[], start: number): number {
  for (let i = start; i < Math.min(lines.length, start + MAX_STATEMENT_LINES); i++) {
    if (lines[i]!.includes(';')) return i;
  }
  return start;
}

/** The line the block opening on or after `start` closes on, by counting braces. */
function blockEnd(lines: readonly string[], start: number): number {
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}' && opened) {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return start;
}

/**
 * The error paths of `source`, in line order. A path inside a `catch` block is
 * part of the block, not one of its own.
 */
export function findErrorPaths(source: string): ErrorPath[] {
  const lines = source.split('\n');
  const found: ErrorPath[] = [];
  const inside = (line: number) => found.some((p) => p.kind === 'catch' && line >= p.range[0] && line <= p.range[1]);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (COMMENT.test(line) || inside(i + 1)) continue;
    const text = line.trim().slice(0, 80);
    if (CATCH.test(line)) {
      found.push({ kind: 'catch', range: [i + 1, blockEnd(lines, i) + 1], text });
    } else if (THROW.test(line)) {
      found.push({ kind: 'throw', range: [i + 1, statementEnd(lines, i) + 1], text });
    } else if (RETURN.test(line) || /setResponseStatus|\.status\(|StatusCode/.test(line)) {
      const end = statementEnd(lines, i);
      const statement = lines.slice(i, end + 1).join(' ');
      if (errorStatusesOfLine(statement).length > 0)
        found.push({ kind: 'error-return', range: [i + 1, end + 1], text });
    }
  }
  return found;
}
