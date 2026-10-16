/**
 * Code reach: the application source files whose functions ran during a test,
 * from Chromium's JavaScript coverage. A file counts when at least one of its
 * functions ran, not counting a script's top-level code (importing a module
 * runs its top level, so it says nothing about the test) and code that maps to
 * no source.
 *
 * Through a source map, a function belongs to the source its start maps to,
 * when some code inside it maps there too. Code a bundler or a dev server
 * generates (a module factory, a preload helper, a hot-reload hook) has no
 * mapping of its own and would otherwise take that of whatever precedes it;
 * it runs when a module is imported, so it counts for no file.
 *
 * The reporter feeds this with V8's function coverage, read over a CDP
 * session; this module holds the pure part.
 */
import { normalizeCoveragePath, type LineRange } from './coverage';
import { lineStarts, offsetToPosition, type SourceMapLookup } from './source-map';

/** One script of a JavaScript coverage report: V8's `Profiler.takePreciseCoverage` entry, with its source when read. */
export interface JsCoverageEntry {
  url: string;
  source?: string;
  functions: Array<{
    functionName: string;
    isBlockCoverage?: boolean;
    ranges: Array<{ startOffset: number; endOffset: number; count: number }>;
  }>;
}

/** Files reached per test at most. */
const MAX_CODE_REACH_FILES = 2000;

/**
 * The ranges of the functions that ran in a script, without its top-level
 * function (the one spanning the whole script).
 */
function executedFunctionRanges(entry: JsCoverageEntry): Array<{ start: number; end: number }> {
  const length = entry.source?.length ?? Number.POSITIVE_INFINITY;
  const out: Array<{ start: number; end: number }> = [];
  entry.functions.forEach((fn, i) => {
    const whole = fn.ranges[0];
    if (!whole || whole.count <= 0) return;
    const topLevel = whole.startOffset === 0 && (whole.endOffset >= length || (i === 0 && fn.functionName === ''));
    if (topLevel) return;
    out.push({ start: whole.startOffset, end: whole.endOffset });
  });
  return out;
}

/** The start offsets of the functions that ran in a script, without its top-level function. */
export function executedFunctionOffsets(entry: JsCoverageEntry): number[] {
  return executedFunctionRanges(entry).map((range) => range.start);
}

/** Whether any function of the script other than its top level ran. */
export function scriptRan(entry: JsCoverageEntry): boolean {
  return executedFunctionOffsets(entry).length > 0;
}

/** The sources (indexes into `map.sources`) of the functions that ran, through the script's source map. */
export function reachedSources(entry: JsCoverageEntry, map: SourceMapLookup): Set<number> {
  const ranges = executedFunctionRanges(entry);
  const reached = new Set<number>();
  if (!ranges.length || entry.source === undefined) return reached;
  const starts = lineStarts(entry.source);
  for (const range of ranges) {
    const start = offsetToPosition(starts, range.start);
    const source = map.sourceAt(start.line, start.column);
    if (source === null || reached.has(source)) continue;
    if (map.mapsBetween(source, start, offsetToPosition(starts, range.end))) reached.add(source);
  }
  return reached;
}

/**
 * The 1-based start and end line of each function that ran, not counting the
 * script's top-level code: through a source map, by the index of the source the
 * function starts in, from the original lines its code maps to there; without
 * one, lines of the script's own text, under index -1.
 */
export function reachedFunctionLines(entry: JsCoverageEntry, map: SourceMapLookup | null): Map<number, LineRange[]> {
  const out = new Map<number, LineRange[]>();
  const ranges = executedFunctionRanges(entry);
  if (!ranges.length || entry.source === undefined) return out;
  const add = (source: number, range: LineRange) => {
    const list = out.get(source);
    if (list) list.push(range);
    else out.set(source, [range]);
  };
  const starts = lineStarts(entry.source);
  for (const range of ranges) {
    const start = offsetToPosition(starts, range.start);
    if (!map) {
      const last = offsetToPosition(starts, Math.max(range.start, range.end - 1));
      add(-1, [start.line + 1, last.line + 1]);
      continue;
    }
    // The function starts on the line the code it begins in maps to, and ends on the last line its own code maps to.
    const at = map.originalAt(start.line, start.column);
    if (at === null) continue;
    const lines = map.originalLinesBetween(at.source, start, offsetToPosition(starts, range.end));
    if (lines) add(at.source, [Math.min(at.line, lines[0]) + 1, Math.max(at.line, lines[1]) + 1]);
  }
  return out;
}

/**
 * A reached file list as it goes on the wire: paths normalized by
 * {@link normalizeCoveragePath} (repository-relative POSIX, `node_modules`
 * and paths leaving the repository dropped), sorted, capped at
 * {@link MAX_CODE_REACH_FILES}.
 */
export function finalizeCodeReach(files: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const raw of files) {
    const file = normalizeCoveragePath(raw);
    if (file !== null) out.add(file);
  }
  return [...out].sort().slice(0, MAX_CODE_REACH_FILES);
}
