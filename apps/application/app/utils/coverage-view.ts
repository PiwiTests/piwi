/**
 * A test's coverage in a reader's words: the rows of the execution page's
 * Coverage section (server files by executed lines, browser files by path),
 * the summary sentence over them, each file's precision and counts, the
 * mark on a file the suspect lines name or the range changed, the names of
 * the functions that ran, and the route of a file's coverage view. Pure, so
 * the section, the source view and their tests read one wording.
 */
import {
  countLines,
  granularityOf,
  normalizeLineRanges,
  type CoverageCapture,
  type CoverageFile,
  type CoverageGranularity,
  type LineRange,
} from '@piwitests/core/coverage';
import { sameFilePath } from '@piwitests/core/locator-break';
import type { SuspectLinesAnswer } from '#shared/suspect-lines';

/** A row of the left bar the source view draws on an executable line that did not run: lighter than a line that ran. */
export const NOT_RUN_ROW_CLASS = 'shadow-[inset_3px_0_0_0_var(--ui-border-accented)]';

/** Rows a group shows before "Show all". */
export const COVERAGE_ROWS_SHOWN = 20;

/**
 * The route of a file's coverage view, the page that lists the tests running
 * the file: `/projects/:id/coverage?file=<path>`.
 */
export function coverageFileRoute(projectId: number | string, path: string): { path: string; query: { file: string } } {
  return { path: `/projects/${projectId}/coverage`, query: { file: path } };
}

/** What a row says about a file the failure's What changed card concerns. */
export type CoverageRowMark = { kind: 'suspect'; lines: LineRange[] } | { kind: 'changed' };

/** One file of a test's coverage as the section lists it. */
export interface CoverageRow {
  file: CoverageFile;
  granularity: CoverageGranularity;
  /** Executed lines, at line precision. */
  executedLines: number;
  /** Functions that ran, at line or function precision. */
  functionCount: number;
  /** The line the file opens at in the editor: its first executed line, else its first function's. */
  firstLine: number | null;
  /** The suspect lines the file holds, or that the range changed it; null otherwise. */
  mark: CoverageRowMark | null;
}

/** A test's coverage split into the section's two groups, each in its reading order. */
export interface CoverageGroups {
  server: CoverageRow[];
  browser: CoverageRow[];
}

/** The mark of a file: the suspect lines of it the answer names, else whether the range changed it. */
function markOf(path: string, suspects: SuspectLinesAnswer | null | undefined): CoverageRowMark | null {
  if (!suspects?.available) return null;
  const own = suspects.suspects.filter((s) => sameFilePath(s.path, path));
  if (own.length > 0) return { kind: 'suspect', lines: normalizeLineRanges(own.flatMap((s) => s.lines)) };
  return suspects.changedPaths?.some((changed) => sameFilePath(changed, path)) ? { kind: 'changed' } : null;
}

/**
 * A capture's files as the section's rows: server files by executed lines,
 * most first (then by functions that ran, then by path), browser files by
 * path. `suspects` marks the files the suspect lines name or the range
 * changed.
 */
export function coverageGroups(
  capture: CoverageCapture | null | undefined,
  suspects?: SuspectLinesAnswer | null,
): CoverageGroups {
  const rows = (capture?.files ?? []).map((file): CoverageRow => {
    const lines = file.lines ?? [];
    const functions = file.functions ?? [];
    return {
      file,
      granularity: granularityOf(file),
      executedLines: countLines(lines),
      functionCount: functions.length,
      firstLine: lines[0]?.[0] ?? functions[0]?.[0] ?? null,
      mark: markOf(file.path, suspects),
    };
  });
  const byPath = (a: CoverageRow, b: CoverageRow) =>
    a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0;
  return {
    server: rows
      .filter((r) => r.file.runtime === 'server')
      .sort((a, b) => b.executedLines - a.executedLines || b.functionCount - a.functionCount || byPath(a, b)),
    browser: rows.filter((r) => r.file.runtime === 'browser').sort(byPath),
  };
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * The summary sentence over the groups: "Ran 12 server files (184 lines) and
 * 5 browser files." The server count names the executed lines when any file
 * has them, else the functions that ran. Null when there is no file.
 */
export function coverageSummary(groups: CoverageGroups): string | null {
  const parts: string[] = [];
  if (groups.server.length > 0) {
    const lines = groups.server.reduce((n, r) => n + r.executedLines, 0);
    const functions = groups.server.reduce((n, r) => n + r.functionCount, 0);
    const detail =
      lines > 0 ? ` (${plural(lines, 'line')})` : functions > 0 ? ` (${plural(functions, 'function')})` : '';
    parts.push(`${plural(groups.server.length, 'server file')}${detail}`);
  }
  if (groups.browser.length > 0) parts.push(plural(groups.browser.length, 'browser file'));
  return parts.length > 0 ? `Ran ${parts.join(' and ')}.` : null;
}

/** A file's precision in words: what its coverage names. */
export const COVERAGE_PRECISION_LABEL: Record<CoverageGranularity, string> = {
  lines: 'by line',
  functions: 'by function',
  files: 'by file',
};

/** What a precision means, for the label's title. */
export const COVERAGE_PRECISION_TITLE: Record<CoverageGranularity, string> = {
  lines: 'Line coverage: the lines that ran and the functions they ran in',
  functions: 'Function coverage: the functions that ran, without their lines',
  files: 'File coverage: code of the file ran; no line numbers were recorded',
};

/** A row's counts: "6 lines, 1 function"; "2 functions"; "" for a file reached. */
export function coverageRowCounts(row: CoverageRow): string {
  if (row.granularity === 'lines') {
    const functions = row.functionCount > 0 ? `, ${plural(row.functionCount, 'function')}` : '';
    return `${plural(row.executedLines, 'line')}${functions}`;
  }
  if (row.granularity === 'functions') return plural(row.functionCount, 'function');
  return '';
}

/** Lines of normalized ranges `a` that are in no range of normalized ranges `b`, normalized. */
export function subtractLineRanges(a: LineRange[], b: LineRange[]): LineRange[] {
  const out: LineRange[] = [];
  let j = 0;
  for (const [start, end] of a) {
    let from = start;
    while (j < b.length && b[j]![1] < from) j++;
    let k = j;
    while (k < b.length && b[k]![0] <= end) {
      const [bStart, bEnd] = b[k]!;
      if (bStart > from) out.push([from, bStart - 1]);
      from = Math.max(from, bEnd + 1);
      k++;
    }
    if (from <= end) out.push([from, end]);
  }
  return out;
}

const NOT_NAMES = new Set([
  'if',
  'for',
  'foreach',
  'while',
  'switch',
  'catch',
  'using',
  'lock',
  'return',
  'function',
  'async',
  'await',
  'new',
  'typeof',
  'nameof',
  'sizeof',
]);

/**
 * The name of a function that ran, read from its first line: the variable a
 * function is assigned to, a property's name before `=>` or `{ get`, else the
 * identifier before the first parenthesis. Null when the line names none.
 */
export function functionNameAt(line: string | null | undefined): string | null {
  if (!line) return null;
  const assigned = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
  if (assigned) return assigned[1]!;
  const paren = line.indexOf('(');
  const head = paren === -1 ? line : line.slice(0, paren);
  const property = /([A-Za-z_]\w*)\s*(?:=>|\{\s*get\b)/.exec(head);
  if (property) return property[1]!;
  if (paren === -1) return null;
  const name = /([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*$/.exec(head)?.[1] ?? null;
  return name && !NOT_NAMES.has(name) ? name : null;
}
