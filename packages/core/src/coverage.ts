/**
 * Coverage: which source code ran during a test, per repository-relative
 * file, for code that ran in the browser or in the backend (the runtime). A
 * file names the functions that ran (their start and end lines) and, at line
 * granularity, the executed line ranges, against the git blob of the file
 * version those line numbers refer to. Code reach is the file-level view of it.
 *
 * Line ranges are 1-based and inclusive. Normalized line ranges are sorted,
 * with overlapping and adjacent ranges merged. Normalized function ranges are
 * sorted and deduplicated but never merged: each range is one function, and
 * nested or overlapping functions stay separate.
 */

/** Where the code ran: in the browser, or in the backend. */
export type CoverageRuntime = 'browser' | 'server';

/** What a coverage record names: files only, the functions that ran, or the executed lines too. */
export type CoverageGranularity = 'files' | 'functions' | 'lines';

/** A range of lines, 1-based and inclusive. */
export type LineRange = [start: number, end: number];

/** One file's coverage. */
export interface CoverageFile {
  /** Repository-relative POSIX path. */
  path: string;
  runtime: CoverageRuntime;
  /**
   * The git blob id (40 or 64 lowercase hex characters) of the file version the
   * line numbers refer to; absent when the file names no line numbers.
   */
  blob?: string;
  /** The start and end line of each function that ran. */
  functions?: LineRange[];
  /** The executed line ranges, at line granularity. */
  lines?: LineRange[];
}

/** A test's coverage: one entry per runtime and path, sorted by path then runtime. */
export interface CoverageCapture {
  v: 1;
  files: CoverageFile[];
  /** Part of the coverage is missing: a cap was hit, a collection failed, or entries disagreed on the file version. */
  incomplete?: boolean;
}

/** Files per capture at most. */
export const MAX_COVERAGE_FILES = 2000;

/** Line ranges plus function ranges per capture at most. */
export const MAX_COVERAGE_RANGES = 10_000;

/**
 * The colors of the coverage marks, the same in the dashboard and in the editors: a line the tests ran, and an
 * executable line no test runs. Neither is a test outcome color. The dashboard's `--color-coverage-*` tokens, the VS
 * Code extension's `piwi.coverage*Border` colors and the JetBrains color schemes' `PIWI_COVERAGE_*` keys restate them.
 */
export const COVERAGE_MARK_COLORS = {
  light: { run: '#0d9488', notRun: '#94a3b8' },
  dark: { run: '#14b8a6', notRun: '#64748b' },
} as const;

/** Highest line number accepted. */
const MAX_LINE = 1_000_000;

/** Longest path accepted. */
const MAX_PATH_LENGTH = 500;

const BLOB_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRuntime(value: unknown): value is CoverageRuntime {
  return value === 'browser' || value === 'server';
}

function isLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_LINE;
}

/** The well-formed ranges of untrusted input, as new pairs sorted by start then end. */
function validRanges(raw: unknown): LineRange[] {
  if (!Array.isArray(raw)) return [];
  const out: LineRange[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const [start, end] = item as unknown[];
    if (isLine(start) && isLine(end) && start <= end) out.push([start, end]);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * Line ranges from untrusted input: integer pairs with
 * `1 <= start <= end <= 1,000,000`, sorted, overlapping and adjacent ranges
 * merged. Anything else is dropped.
 */
export function normalizeLineRanges(ranges: unknown): LineRange[] {
  const out: LineRange[] = [];
  for (const range of validRanges(ranges)) {
    const last = out[out.length - 1];
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else out.push(range);
  }
  return out;
}

/**
 * Function ranges from untrusted input: the same pairs as
 * {@link normalizeLineRanges} accepts, sorted, identical pairs deduplicated,
 * never merged.
 */
export function normalizeFunctionRanges(ranges: unknown): LineRange[] {
  const out: LineRange[] = [];
  for (const range of validRanges(ranges)) {
    const last = out[out.length - 1];
    if (!last || last[0] !== range[0] || last[1] !== range[1]) out.push(range);
  }
  return out;
}

/**
 * A covered file's path as stored: backslashes turned into slashes, a leading
 * `./` removed. Null for anything that is not a repository-relative path:
 * empty, over 500 characters, containing NUL, leaving the repository (`../`),
 * absolute, starting with a drive letter, or under `node_modules`.
 */
export function normalizeCoveragePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_PATH_LENGTH || raw.includes('\0')) return null;
  const path = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!path || path.startsWith('../') || path.startsWith('/') || /^[A-Za-z]:\//.test(path)) return null;
  if (/(^|\/)node_modules\//.test(path)) return null;
  return path;
}

/** A file entry without its empty fields; the blob is kept only with line numbers. */
function fileEntry(
  path: string,
  runtime: CoverageRuntime,
  blob?: string,
  functions: LineRange[] = [],
  lines: LineRange[] = [],
): CoverageFile {
  const file: CoverageFile = { path, runtime };
  if (blob && (functions.length > 0 || lines.length > 0)) file.blob = blob;
  if (functions.length > 0) file.functions = functions;
  if (lines.length > 0) file.lines = lines;
  return file;
}

function captureOf(files: CoverageFile[], incomplete: boolean): CoverageCapture {
  return incomplete ? { v: 1, files, incomplete: true } : { v: 1, files };
}

function compareFiles(a: CoverageFile, b: CoverageFile): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.runtime !== b.runtime) return a.runtime < b.runtime ? -1 : 1;
  return 0;
}

/**
 * Coverage read from untrusted input. Requires `v: 1`; drops files with an
 * invalid path or runtime, and an invalid blob (keeping the file); normalizes
 * the ranges; merges entries of the same runtime and path as
 * {@link mergeCoverage} does; sorts files by path then runtime. Past
 * {@link MAX_COVERAGE_FILES} files the rest are dropped, and a file whose
 * ranges would exceed {@link MAX_COVERAGE_RANGES} in total keeps its path
 * only; either sets `incomplete`. Null when no valid file remains.
 */
export function sanitizeCoverage(raw: unknown): CoverageCapture | null {
  if (!isRecord(raw) || raw.v !== 1 || !Array.isArray(raw.files)) return null;
  const files: CoverageFile[] = [];
  for (const item of raw.files) {
    if (!isRecord(item) || !isRuntime(item.runtime)) continue;
    const path = normalizeCoveragePath(item.path);
    if (path === null) continue;
    const blob = typeof item.blob === 'string' && BLOB_ID.test(item.blob) ? item.blob : undefined;
    files.push(
      fileEntry(path, item.runtime, blob, normalizeFunctionRanges(item.functions), normalizeLineRanges(item.lines)),
    );
  }
  const merged = mergeCoverage(captureOf(files, raw.incomplete === true));
  if (!merged) return null;

  let incomplete = merged.incomplete === true || merged.files.length > MAX_COVERAGE_FILES;
  let budget = MAX_COVERAGE_RANGES;
  const capped = merged.files.slice(0, MAX_COVERAGE_FILES).map((file) => {
    const count = (file.functions?.length ?? 0) + (file.lines?.length ?? 0);
    if (count <= budget) {
      budget -= count;
      return file;
    }
    incomplete = true;
    return fileEntry(file.path, file.runtime);
  });
  return captureOf(capped, incomplete);
}

/**
 * The union of several captures, per runtime and path: line ranges merged,
 * function ranges deduplicated. A file keeps its blob when every entry that
 * has one agrees; otherwise the blob is dropped and the result is
 * `incomplete`, since the line numbers refer to different file versions. The
 * result is `incomplete` when any input is. Null when there is no file.
 */
export function mergeCoverage(...captures: Array<CoverageCapture | null | undefined>): CoverageCapture | null {
  const entries = new Map<
    string,
    { path: string; runtime: CoverageRuntime; blobs: Set<string>; functions: LineRange[]; lines: LineRange[] }
  >();
  let incomplete = false;
  for (const capture of captures) {
    if (!capture) continue;
    if (capture.incomplete) incomplete = true;
    for (const file of capture.files) {
      const key = `${file.runtime}:${file.path}`;
      let entry = entries.get(key);
      if (!entry) {
        entry = { path: file.path, runtime: file.runtime, blobs: new Set(), functions: [], lines: [] };
        entries.set(key, entry);
      }
      if (file.blob) entry.blobs.add(file.blob);
      for (const range of file.functions ?? []) entry.functions.push(range);
      for (const range of file.lines ?? []) entry.lines.push(range);
    }
  }
  if (entries.size === 0) return null;
  const files = [...entries.values()].map((entry) => {
    if (entry.blobs.size > 1) incomplete = true;
    const blob = entry.blobs.size === 1 ? [...entry.blobs][0] : undefined;
    return fileEntry(
      entry.path,
      entry.runtime,
      blob,
      normalizeFunctionRanges(entry.functions),
      normalizeLineRanges(entry.lines),
    );
  });
  return captureOf(files.sort(compareFiles), incomplete);
}

/** The paths a capture names, sorted and unique; only those of one runtime when given. */
export function coverageFiles(capture: CoverageCapture | null | undefined, runtime?: CoverageRuntime): string[] {
  if (!capture) return [];
  const paths = new Set<string>();
  for (const file of capture.files) {
    if (!runtime || file.runtime === runtime) paths.add(file.path);
  }
  return [...paths].sort();
}

/** The granularity a file's entry carries: `lines` when it has line ranges, `functions` when it has function ranges. */
export function granularityOf(file: CoverageFile): CoverageGranularity {
  if (file.lines?.length) return 'lines';
  if (file.functions?.length) return 'functions';
  return 'files';
}

/**
 * A capture cut down to a granularity: `files` keeps the paths only (no
 * ranges, no blob), `functions` drops the line ranges, `lines` keeps
 * everything.
 */
export function reduceCoverage(capture: CoverageCapture, granularity: CoverageGranularity): CoverageCapture {
  const files = capture.files.map((file) =>
    fileEntry(
      file.path,
      file.runtime,
      file.blob,
      granularity === 'files' ? [] : file.functions,
      granularity === 'lines' ? file.lines : [],
    ),
  );
  return captureOf(files, capture.incomplete === true);
}

/** Ranges as text, in the order given and without merging: `12-15,20,33-35`, a single line without a dash. */
export function encodeLineRanges(ranges: LineRange[]): string {
  return ranges.map(([start, end]) => (start === end ? String(start) : `${start}-${end}`)).join(',');
}

/** The ranges of a text in the form {@link encodeLineRanges} writes; malformed parts are skipped. */
function parseRanges(text: string | null | undefined): LineRange[] {
  if (typeof text !== 'string') return [];
  const out: LineRange[] = [];
  for (const part of text.split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (match) out.push([Number(match[1]), Number(match[2] ?? match[1])]);
  }
  return out;
}

/** Line ranges read from {@link encodeLineRanges} text, normalized; malformed parts are ignored. */
export function decodeLineRanges(text: string | null | undefined): LineRange[] {
  return normalizeLineRanges(parseRanges(text));
}

/** Function ranges read from {@link encodeLineRanges} text, normalized as function ranges (never merged). */
export function decodeFunctionRanges(text: string | null | undefined): LineRange[] {
  return normalizeFunctionRanges(parseRanges(text));
}

/**
 * A deterministic string of a file's content, to hash a fragment by: runtime,
 * path, blob, function ranges and line ranges, normalized, so the same
 * content gives the same string whatever the order of its ranges. A file of
 * a coverage report also names its executable lines and every function its
 * tool knows: they follow, as a sixth and seventh element, only when either
 * is present, so the string of a file without them is unchanged.
 */
export function canonicalCoverageFile(file: CanonicalCoverageInput): string {
  const executable = normalizeLineRanges(file.executable);
  const allFunctions = normalizeFunctionRanges(file.allFunctions);
  const known = executable.length > 0 || allFunctions.length > 0;
  const entry = fileEntry(
    file.path,
    file.runtime as CoverageRuntime,
    known ? undefined : file.blob,
    normalizeFunctionRanges(file.functions),
    normalizeLineRanges(file.lines),
  );
  const blob = known ? (file.blob ?? '') : (entry.blob ?? '');
  return JSON.stringify([
    entry.runtime,
    entry.path,
    blob,
    encodeLineRanges(entry.functions ?? []),
    encodeLineRanges(entry.lines ?? []),
    ...(known ? [encodeLineRanges(executable), encodeLineRanges(allFunctions)] : []),
  ]);
}

/**
 * What {@link canonicalCoverageFile} reads: a coverage file, or a coverage
 * report's, whose runtime names the report rather than where the code ran.
 */
export type CanonicalCoverageInput = Omit<CoverageFile, 'runtime'> & {
  runtime: string;
  executable?: LineRange[];
  allFunctions?: LineRange[];
};

/** Whether a line is in normalized line ranges, by binary search. */
export function lineInRanges(ranges: LineRange[], line: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = ranges[mid]!;
    if (line < start) high = mid - 1;
    else if (line > end) low = mid + 1;
    else return true;
  }
  return false;
}

/** The lines two normalized line ranges have in common, as normalized line ranges. */
export function intersectLineRanges(a: LineRange[], b: LineRange[]): LineRange[] {
  const out: LineRange[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const [aStart, aEnd] = a[i]!;
    const [bStart, bEnd] = b[j]!;
    const start = Math.max(aStart, bStart);
    const end = Math.min(aEnd, bEnd);
    if (start <= end) out.push([start, end]);
    if (aEnd < bEnd) i++;
    else j++;
  }
  return out;
}

/** The number of lines in normalized line ranges. */
export function countLines(ranges: LineRange[]): number {
  let count = 0;
  for (const [start, end] of ranges) count += end - start + 1;
  return count;
}
