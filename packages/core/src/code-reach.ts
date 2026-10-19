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
 * What the offsets of a script's coverage are read against: its length and the
 * offset each line starts at. Kept instead of the source by a caller that reads a
 * script once and resolves its coverage in many tests.
 */
export interface ScriptText {
  length: number;
  starts: ArrayLike<number>;
}

/** A script's text as its coverage offsets are read against it. */
export function scriptText(source: string): ScriptText {
  return { length: source.length, starts: Uint32Array.from(lineStarts(source)) };
}

const textOf = (entry: JsCoverageEntry, text: ScriptText | undefined): ScriptText | undefined =>
  text ?? (entry.source === undefined ? undefined : scriptText(entry.source));

/**
 * The ranges of the functions that ran in a script, or with `all` of every
 * function its coverage lists, run or not, without its top-level function (the
 * one spanning the whole script).
 */
function executedFunctionRanges(
  entry: JsCoverageEntry,
  length?: number,
  all = false,
): Array<{ start: number; end: number }> {
  length ??= entry.source?.length ?? Number.POSITIVE_INFINITY;
  const out: Array<{ start: number; end: number }> = [];
  entry.functions.forEach((fn, i) => {
    const whole = fn.ranges[0];
    if (!whole || (!all && whole.count <= 0)) return;
    const topLevel = whole.startOffset === 0 && (whole.endOffset >= length || (i === 0 && fn.functionName === ''));
    if (topLevel) return;
    out.push({ start: whole.startOffset, end: whole.endOffset });
  });
  return out;
}

/** Whether any function of the script other than its top level ran; `text` stands for its source when given. */
export function scriptRan(entry: JsCoverageEntry, text?: ScriptText): boolean {
  return executedFunctionRanges(entry, text?.length).length > 0;
}

/**
 * The 1-based start and end line of each function that ran, not counting the
 * script's top-level code: through a source map, by the index of the source the
 * function starts in, from the original lines its code maps to there; without
 * one, lines of the script's own text, under index -1. `text` stands for the
 * source when given.
 */
export function reachedFunctionLines(
  entry: JsCoverageEntry,
  map: SourceMapLookup | null,
  text?: ScriptText,
): Map<number, LineRange[]> {
  return functionLines(entry, map, text, false);
}

/**
 * The 1-based start and end line of every function the script's coverage
 * lists, whether it ran or not, as {@link reachedFunctionLines} gives them. V8
 * lists the functions a script declares that did not run, except those
 * nested in a function that never ran, which the outer function's range holds.
 */
export function knownFunctionLines(
  entry: JsCoverageEntry,
  map: SourceMapLookup | null,
  text?: ScriptText,
): Map<number, LineRange[]> {
  return functionLines(entry, map, text, true);
}

function functionLines(
  entry: JsCoverageEntry,
  map: SourceMapLookup | null,
  text: ScriptText | undefined,
  all: boolean,
): Map<number, LineRange[]> {
  const out = new Map<number, LineRange[]>();
  const read = textOf(entry, text);
  const ranges = executedFunctionRanges(entry, read?.length, all);
  if (!ranges.length || !read) return out;
  const add = (source: number, range: LineRange) => {
    const list = out.get(source);
    if (list) list.push(range);
    else out.set(source, [range]);
  };
  const starts = read.starts;
  for (const range of ranges) {
    const start = offsetToPosition(starts, range.start);
    if (!map) {
      const last = offsetToPosition(starts, Math.max(range.start, range.end - 1));
      add(-1, [start.line + 1, last.line + 1]);
      continue;
    }
    // The function starts on its header and ends on the last line its own code maps to; code mapped above the header
    // was inlined from elsewhere. The header is the line the code the function begins in maps to, when its own code
    // starts there or on the next line. Otherwise that mapping is the code before it on its generated line, the
    // function's beginning having no segment of its own, and the header is where its own code starts.
    const at = map.originalAt(start.line, start.column);
    if (at === null) continue;
    const end = offsetToPosition(starts, range.end);
    const first = map.firstOriginalLineBetween(at.source, start, end);
    if (first === null) continue;
    const header = first === at.line || first === at.line + 1 ? at.line : first;
    const lines = map.originalLinesBetween(at.source, start, end, header);
    if (lines) add(at.source, [header + 1, lines[1] + 1]);
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
