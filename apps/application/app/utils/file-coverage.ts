/**
 * A file's coverage as its coverage page reads it
 * (`/projects/:id/coverage?file=`): the versions of the file the tests
 * recorded, each with the tests behind it, the lines they ran and the
 * executable lines none of them runs; how many tests ran each line; the tests
 * that ran a selected line or range; and the words the page says about them.
 * Pure, so the page and its tests read one computation; the nearest test to
 * copy for a line no test runs is `nearestTest` (`#shared/coverage-insights`).
 */
import {
  countLines,
  granularityOf,
  intersectLineRanges,
  normalizeLineRanges,
  type CoverageFile,
  type CoverageGranularity,
  type CoverageRuntime,
  type LineRange,
} from '@piwitests/core/coverage';
import { subtractLineRanges, unionLineRanges, type NearestTest } from '#shared/coverage-insights';

/** One distinct coverage of the file and the positions, in the answer's `tests`, of the tests that recorded it. */
export type FileCoverageFragment = CoverageFile & { tests: number[] };

/** What `GET /api/projects/:id/coverage` answers, as far as the versions need it. */
export interface FileCoverageInput {
  fragments: FileCoverageFragment[];
  executable: Array<{ path: string; runtime: CoverageRuntime; blob: string; lines: LineRange[] }>;
}

/** One version of the file the tests recorded: a path, a runtime and the git blob its line numbers refer to. */
export interface FileCoverageVersion {
  /** `runtime`, `path` and `blob`, the page's handle on the version. */
  key: string;
  path: string;
  runtime: CoverageRuntime;
  /** The git blob the line numbers refer to; null for coverage that names no lines. */
  blob: string | null;
  /** The finest precision a test recorded the version at. */
  granularity: CoverageGranularity;
  fragments: FileCoverageFragment[];
  /** Positions of the tests that recorded the version, ascending. */
  tests: number[];
  /** The lines a test ran: executed lines, and the functions that ran where a test recorded no lines. */
  executed: LineRange[];
  /** The functions that ran, each once, by first line. */
  functions: LineRange[];
  /** The version's executable lines, when a run recorded them. */
  executable: LineRange[] | null;
  /** The executable lines no test runs, when the executable lines are known. */
  notExecuted: LineRange[] | null;
}

const GRANULARITY_RANK: Record<CoverageGranularity, number> = { files: 0, functions: 1, lines: 2 };

/** The lines a fragment says ran: its lines, else its functions. */
function fragmentRanges(fragment: CoverageFile): LineRange[] {
  if (fragment.lines?.length) return normalizeLineRanges(fragment.lines);
  return normalizeLineRanges(fragment.functions ?? []);
}

/**
 * The versions of the file the fragments name, the one the most tests
 * recorded first (then one with line numbers, then by blob and path).
 */
export function fileCoverageVersions(view: FileCoverageInput): FileCoverageVersion[] {
  const groups = new Map<string, FileCoverageFragment[]>();
  for (const fragment of view.fragments) {
    const key = `${fragment.runtime}:${fragment.path}:${fragment.blob ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), fragment]);
  }
  const versions = [...groups.entries()].map(([key, fragments]): FileCoverageVersion => {
    const { path, runtime } = fragments[0]!;
    const blob = fragments[0]!.blob ?? null;
    let granularity: CoverageGranularity = 'files';
    for (const fragment of fragments) {
      const own = granularityOf(fragment);
      if (GRANULARITY_RANK[own] > GRANULARITY_RANK[granularity]) granularity = own;
    }
    const executed = unionLineRanges(...fragments.map(fragmentRanges));
    const distinct = new Map<string, LineRange>();
    for (const [start, end] of fragments.flatMap((f) => f.functions ?? []))
      distinct.set(`${start}-${end}`, [start, end]);
    const functions = [...distinct.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const recorded = blob
      ? view.executable.find((e) => e.path === path && e.runtime === runtime && e.blob === blob)
      : undefined;
    const executable = recorded ? normalizeLineRanges(recorded.lines) : null;
    return {
      key,
      path,
      runtime,
      blob,
      granularity,
      fragments,
      tests: [...new Set(fragments.flatMap((f) => f.tests))].sort((a, b) => a - b),
      executed,
      functions,
      executable,
      notExecuted: executable ? subtractLineRanges(executable, executed) : null,
    };
  });
  return versions.sort(
    (a, b) =>
      b.tests.length - a.tests.length ||
      Number(b.blob !== null) - Number(a.blob !== null) ||
      (a.blob ?? '').localeCompare(b.blob ?? '') ||
      a.path.localeCompare(b.path) ||
      a.runtime.localeCompare(b.runtime),
  );
}

/** How many tests ran each line of the version: the lines of each fragment, or its functions where it names no lines. */
export function lineTestCounts(version: FileCoverageVersion): Map<number, number> {
  const counts = new Map<number, number>();
  for (const fragment of version.fragments) {
    if (fragment.tests.length === 0) continue;
    for (const [start, end] of fragmentRanges(fragment)) {
      for (let line = start; line <= end; line++) counts.set(line, (counts.get(line) ?? 0) + fragment.tests.length);
    }
  }
  return counts;
}

/** Positions of the tests that ran at least one line of `range`, ascending. */
export function testsOnLines(version: FileCoverageVersion, range: LineRange): number[] {
  const tests = new Set<number>();
  for (const fragment of version.fragments) {
    if (intersectLineRanges(fragmentRanges(fragment), [range]).length > 0) {
      for (const test of fragment.tests) tests.add(test);
    }
  }
  return [...tests].sort((a, b) => a - b);
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** A version in the version selector: "a1b2c3d · 8 tests", with its path when the versions differ in path. */
export function fileVersionLabel(version: FileCoverageVersion, withPath = false): string {
  const name = version.blob ? version.blob.slice(0, 7) : 'by file';
  return `${withPath ? `${version.path} · ` : ''}${name} · ${plural(version.tests.length, 'test')}`;
}

/**
 * What the tests run of the version, in one sentence: "3 tests run 9 of its
 * 34 executable lines on main."
 */
export function fileCoverageSentence(version: FileCoverageVersion, branch: string): string {
  const tests = plural(version.tests.length, 'test');
  const run = version.tests.length === 1 ? 'runs' : 'run';
  if (version.granularity === 'files') return `${tests} ${run} code of this file on ${branch}, by file only.`;
  if (version.granularity === 'functions') {
    return `${tests} ${run} ${plural(version.functions.length, 'function')} of this file on ${branch}.`;
  }
  if (version.executable) {
    const ran = countLines(intersectLineRanges(version.executed, version.executable));
    return `${tests} ${run} ${ran} of its ${countLines(version.executable)} executable lines on ${branch}.`;
  }
  return `${tests} ${run} ${plural(countLines(version.executed), 'line')} of this file on ${branch}.`;
}

/** Lines in words: "line 51", "lines 50 to 52". */
export function linesText([start, end]: LineRange): string {
  return start === end ? `line ${start}` : `lines ${start} to ${end}`;
}

/**
 * What the nearest test runs around the selected lines: "It runs 6 lines of
 * ListUsers, the function around line 51." `functionName` is the function's
 * name as its first line gives it, when the source is known.
 */
export function nearestTestSentence(nearest: NearestTest, selection: LineRange, functionName: string | null): string {
  const lines = plural(nearest.executedLines, 'line');
  if (!nearest.sameVersion) return `It runs ${lines} of another version of this file.`;
  if (!nearest.function) return `It runs ${lines} of ${linesText(selection)}.`;
  const [start, end] = nearest.function;
  if (!functionName)
    return `It runs ${lines} of the function around ${linesText(selection)} (lines ${start} to ${end}).`;
  return `It runs ${lines} of ${functionName}, the function around ${linesText(selection)}.`;
}

/** A line or a range from the page's `?line=` (`40`, `40-42`); null when it names none. */
export function parseLineSelection(raw: unknown): LineRange | null {
  const match = typeof raw === 'string' ? /^(\d{1,7})(?:-(\d{1,7}))?$/.exec(raw.trim()) : null;
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  if (start < 1 || end < 1) return null;
  return start <= end ? [start, end] : [end, start];
}

/** A selection as `?line=` writes it. */
export function lineSelectionQuery([start, end]: LineRange): string {
  return start === end ? String(start) : `${start}-${end}`;
}
