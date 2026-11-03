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
 * At line granularity, V8's block coverage tells which code ran inside a
 * function: at each offset, the innermost range around it (a function or a
 * block) gives its count. A source line is executable when a source map
 * segment maps to it, and it ran when one of those segments starts at an
 * offset that ran. A script with no map counts the lines holding code inside
 * the functions V8 lists, its top level left out, and one of them ran when
 * code on it ran.
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
  /**
   * Per line, the columns its code starts and ends at (end excluded), -1 for a line with no code: whitespace only.
   * Kept with `code: true`, for a script read without a source map.
   */
  code?: { starts: ArrayLike<number>; ends: ArrayLike<number> };
}

const isSpace = (ch: number) => ch === 32 || ch === 9 || ch === 13 || ch === 11 || ch === 12 || ch === 0xfeff;

/** A script's text as its coverage offsets are read against it; with `code`, the columns of each line's code too. */
export function scriptText(source: string, options: { code?: boolean } = {}): ScriptText {
  const starts = Uint32Array.from(lineStarts(source));
  if (!options.code) return { length: source.length, starts };
  const codeStarts = new Int32Array(starts.length).fill(-1);
  const codeEnds = new Int32Array(starts.length).fill(-1);
  for (let line = 0; line < starts.length; line++) {
    const from = starts[line]!;
    let to = line + 1 < starts.length ? starts[line + 1]! - 1 : source.length;
    let first = from;
    while (first < to && isSpace(source.charCodeAt(first))) first++;
    while (to > first && isSpace(source.charCodeAt(to - 1))) to--;
    if (first < to) {
      codeStarts[line] = first - from;
      codeEnds[line] = to - from;
    }
  }
  return { length: source.length, starts, code: { starts: codeStarts, ends: codeEnds } };
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

/** Offsets of a script, half-open (`[start, end)`), sorted, disjoint and never adjacent. */
export type OffsetRange = [start: number, end: number];

/** One coverage range: a function's whole range, or a block inside it. */
type CountedRange = { startOffset: number; endOffset: number; count: number };

/**
 * The offsets of a script that ran, from its block coverage (V8's coverage with
 * `detailed: true`): every range of every function, the innermost range around
 * an offset giving its count, an offset ran when that count is above zero. V8's
 * ranges nest: a block inside a function, a function inside another. Without
 * block coverage, a function's whole range stands for all of it.
 */
export function executedOffsets(functions: JsCoverageEntry['functions']): OffsetRange[] {
  const ranges: CountedRange[] = [];
  for (const fn of functions)
    for (const range of fn.ranges) if (range.endOffset > range.startOffset) ranges.push(range);
  ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const out: OffsetRange[] = [];
  const emit = (from: number, to: number, count: number) => {
    if (to <= from || count <= 0) return;
    const last = out[out.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  };
  const open: CountedRange[] = [];
  let at = 0;
  const close = (until: number) => {
    while (open.length > 0 && open[open.length - 1]!.endOffset <= until) {
      const top = open.pop()!;
      emit(at, top.endOffset, top.count);
      at = Math.max(at, top.endOffset);
    }
  };
  for (const range of ranges) {
    close(range.startOffset);
    const parent = open[open.length - 1];
    // A range that reaches past its parent's end is not nested in it: V8 nests them, so it is cut there.
    const end = parent ? Math.min(range.endOffset, parent.endOffset) : range.endOffset;
    if (parent) emit(at, range.startOffset, parent.count);
    at = Math.max(at, range.startOffset);
    open.push(end === range.endOffset ? range : { ...range, endOffset: end });
  }
  close(Number.POSITIVE_INFINITY);
  return out;
}

/** The offsets in either of two offset ranges, as offset ranges. */
export function unionOffsets(a: readonly OffsetRange[], b: readonly OffsetRange[]): OffsetRange[] {
  const all = [...a, ...b].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: OffsetRange[] = [];
  for (const [start, end] of all) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** Whether any offset in `[from, to)` is in sorted offset ranges, by binary search. */
function ranBetween(executed: readonly OffsetRange[], from: number, to: number): boolean {
  let low = 0;
  let high = executed.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = executed[mid]!;
    if (end <= from) low = mid + 1;
    else if (start >= to) high = mid - 1;
    else return true;
  }
  return false;
}

/** A source's lines at line granularity: those holding code, and those of them that ran. */
export interface SourceLines {
  /** The executable lines, 1-based. */
  executable: LineRange[];
  /** The executable lines that ran. */
  lines: LineRange[];
}

/** Sorted 0-based line numbers as 1-based line ranges, consecutive lines merged. */
function toLineRanges(lines: Iterable<number>): LineRange[] {
  const sorted = [...lines].sort((a, b) => a - b);
  const out: LineRange[] = [];
  for (const line of sorted) {
    const last = out[out.length - 1];
    if (last && line + 1 <= last[1] + 1) last[1] = Math.max(last[1], line + 1);
    else out.push([line + 1, line + 1]);
  }
  return out;
}

/**
 * A script's executable lines and those that ran, per source, from the offsets
 * that ran ({@link executedOffsets}). Through a source map, by the index of the
 * source: the original lines a segment maps to, a line ran when one of its
 * segments starts at an offset that ran. Without one, under index -1: the lines
 * of the script's own text with code on them (`text.code`) inside the functions
 * its coverage lists, its top level left out; a line ran when an offset of its
 * code ran. Empty when the text is not known.
 */
export function scriptLines(
  entry: JsCoverageEntry,
  executed: readonly OffsetRange[],
  map: SourceMapLookup | null,
  text?: ScriptText,
): Map<number, SourceLines> {
  const out = new Map<number, SourceLines>();
  const read = textOf(entry, text);
  if (!read) return out;
  const starts = read.starts;
  if (map) {
    const executable = new Map<number, Set<number>>();
    const ran = new Map<number, Set<number>>();
    const add = (into: Map<number, Set<number>>, source: number, line: number) => {
      let set = into.get(source);
      if (!set) into.set(source, (set = new Set()));
      set.add(line);
    };
    map.forEachMapping((line, column, source, originalLine) => {
      if (line >= starts.length || originalLine < 0) return;
      add(executable, source, originalLine);
      const offset = starts[line]! + column;
      if (offset < read.length && ranBetween(executed, offset, offset + 1)) add(ran, source, originalLine);
    });
    for (const [source, lines] of executable) {
      out.set(source, { executable: toLineRanges(lines), lines: toLineRanges(ran.get(source) ?? []) });
    }
    return out;
  }
  const code = read.code ?? (entry.source !== undefined ? scriptText(entry.source, { code: true }).code : undefined);
  if (!code) return out;
  /** Each executable line, with the offsets of its code inside each function holding part of it. */
  const executable = new Map<number, OffsetRange[]>();
  for (const range of executedFunctionRanges(entry, read.length, true)) {
    const first = offsetToPosition(starts, range.start).line;
    const last = offsetToPosition(starts, Math.max(range.start, range.end - 1)).line;
    for (let line = first; line <= last; line++) {
      if (code.starts[line]! < 0) continue;
      // A function may start or end mid-line: the line's code before or after it is the code around it.
      const from = Math.max(starts[line]! + code.starts[line]!, range.start);
      const to = Math.min(starts[line]! + code.ends[line]!, range.end);
      if (from >= to) continue;
      const parts = executable.get(line);
      if (parts) parts.push([from, to]);
      else executable.set(line, [[from, to]]);
    }
  }
  const ran: number[] = [];
  for (const [line, parts] of executable) {
    if (parts.some(([from, to]) => ranBetween(executed, from, to))) ran.push(line);
  }
  if (executable.size > 0) out.set(-1, { executable: toLineRanges(executable.keys()), lines: toLineRanges(ran) });
  return out;
}
