/**
 * Suspect lines: the lines changed since a failing test's last passing run
 * that the failing tests executed, ranked by how many passing tests executed
 * them too.
 *
 * The unit is a hunk of the change, read on the head side (the commit the
 * failing run tested): its added lines and, for each run of removed lines no
 * added line replaces, the head lines on both sides of the deletion point. A
 * capture executed a hunk at the finest granularity its file has:
 *
 * - `lines`: the hunk's changed lines among the executed lines;
 * - `functions`: the hunk's changed lines inside a function that ran;
 * - `files`: the whole hunk, when the capture reached the file.
 *
 * A covered file whose blob differs from the change's head blob, when both are
 * known and of the same hash (SHA-1 or SHA-256), counts at `files` granularity
 * only: its line numbers refer to another version of the file. A changed path matches a covered path exactly, else by
 * the suffix rule of `sameFilePath` when the shorter path has a folder in it.
 *
 * Each hunk the failing captures executed is scored with the Ochiai
 * coefficient of spectrum-based fault localization:
 * `failing / sqrt(totalFailing × (failing + passing))`, where `failing` and
 * `passing` count the captures that executed the hunk and `totalFailing` the
 * failing captures with coverage. A hunk only failing tests executed scores 1.
 */
import {
  countLines,
  intersectLineRanges,
  normalizeLineRanges,
  type CoverageCapture,
  type CoverageFile,
  type CoverageGranularity,
  type CoverageRuntime,
  type LineRange,
} from './coverage';
import type { DiffFile, DiffHunk } from './diff-anchors';
import { sameFilePath } from './locator-break';

/** Suspects returned at most, unless the input sets a lower limit. */
export const MAX_SUSPECTS = 50;

/** One changed file of the range, as the diff gives it. */
export interface SuspectChange {
  /** Repository-relative path after the change. */
  path: string;
  status: DiffFile['status'];
  hunks: DiffHunk[];
  /** The git blob id of the file at the head commit, when known. */
  headBlob?: string;
}

export interface SuspectLinesInput {
  /** The changed files between the last passing run's commit and the failing run's commit (the head). */
  changes: SuspectChange[];
  /** The coverage of the failing executions. */
  failing: CoverageCapture[];
  /** The coverage of passing executions of the same run. */
  passing: CoverageCapture[];
  /** Suspects returned at most; {@link MAX_SUSPECTS} by default. */
  limit?: number;
}

/** One hunk the failing captures executed. */
export interface SuspectLine {
  path: string;
  runtime: CoverageRuntime;
  /** The first and last head line the hunk changes. */
  hunk: LineRange;
  /**
   * The changed lines the failing captures executed, at `granularity`: the
   * executed ones (`lines`), the ones inside a function that ran
   * (`functions`), or every changed line of the hunk (`files`).
   */
  lines: LineRange[];
  granularity: CoverageGranularity;
  /** Failing captures that executed the hunk. */
  failing: number;
  /** Passing captures that executed the hunk. */
  passing: number;
  /** The Ochiai score, 0 to 1, rounded to three decimals. */
  score: number;
}

export interface SuspectLinesSummary {
  /** Changed files with changed lines on the head side. */
  changedFiles: number;
  /** Changed lines on the head side. */
  changedLines: number;
  /** Hunks with changed lines on the head side. */
  hunks: number;
  /** Hunks the failing captures executed. */
  executedHunks: number;
  /** Changed lines the failing captures executed, counted where a capture has line granularity. */
  executedLines: number;
  /** Failing captures that have coverage. */
  failingWithCoverage: number;
  /** Passing captures that have coverage. */
  passingWithCoverage: number;
}

export interface SuspectLinesResult {
  summary: SuspectLinesSummary;
  /** Ranked by granularity (lines, functions, files), then score, then failing count, then path and line. */
  suspects: SuspectLine[];
}

const GRANULARITY_RANK: Record<CoverageGranularity, number> = { lines: 0, functions: 1, files: 2 };

/**
 * The head line after which each run of removed lines no added line replaces
 * was deleted, 0 for a deletion at the file's start. A run is placed from the
 * context line before it, counting the hunk's added lines above that line; it
 * is replaced when an added line follows that line, since a diff writes a
 * block's removed lines before its added ones. A run that opens a hunk with no
 * added line has no context line before it: git writes that hunk
 * `@@ -a,b +n,0 @@`, with `n` the head line before the deletion (0 at the
 * file's start), as `-U0` diffs and `diffLines` give it; a hunk with context
 * opens on a removed line only at the file's start.
 */
function deletionPoints(hunk: DiffHunk): number[] {
  const added = hunk.added.map(({ line }) => line).sort((a, b) => a - b);
  const addedLines = new Set(added);
  const points: number[] = [];
  let previous = -1;
  hunk.removed.forEach(({ line }, removedBefore) => {
    const opensRun = line !== previous + 1;
    previous = line;
    if (!opensRun) return;
    let before: number;
    if (line === hunk.oldStart && added.length === 0) before = line === 1 ? 0 : hunk.newStart;
    else {
      before = hunk.newStart + (line - 1 - hunk.oldStart) - removedBefore;
      for (const addedLine of added) {
        if (addedLine > before) break;
        before++;
      }
    }
    if (!addedLines.has(before + 1)) points.push(before);
  });
  return points;
}

/**
 * A hunk's changed lines on the head side, as normalized line ranges: its
 * added lines and, for each run of removed lines no added line replaces, the
 * head lines on both sides of the deletion point (line 1 alone for a deletion
 * at the file's start).
 */
export function hunkHeadLines(hunk: DiffHunk): LineRange[] {
  const lines = hunk.added.map(({ line }): LineRange => [line, line]);
  for (const before of deletionPoints(hunk)) lines.push(before >= 1 ? [before, before + 1] : [1, 1]);
  return normalizeLineRanges(lines);
}

/**
 * A hunk's changed lines on the base side, as normalized line ranges: its
 * removed lines and, for each run of added lines that replaces no removed
 * line, the base lines on both sides of the insertion point (line 1 alone for
 * an insertion at the file's start). The mirror of {@link hunkHeadLines}: a
 * diff read backwards adds what it removed.
 */
export function hunkBaseLines(hunk: DiffHunk): LineRange[] {
  return hunkHeadLines({ oldStart: hunk.newStart, newStart: hunk.oldStart, removed: hunk.added, added: hunk.removed });
}

/** A modified file of a diff, read on its base side: the version tests ran before the change. */
export interface BaseLineChange {
  filePath: string;
  /** The file's git blob id before the change, as the diff's `index` line gives it. */
  blob: string;
  /** The changed lines on the base side ({@link hunkBaseLines}). */
  lines: LineRange[];
}

/**
 * What a diff gives impact-from-diff: every path it touches (a rename's old
 * path too), and the changed base lines of each modified file whose base blob
 * the diff names. Added, deleted and renamed files count as whole files.
 */
export function diffImpactInput(files: DiffFile[]): { changedFiles: string[]; changes: BaseLineChange[] } {
  const changedFiles = new Set<string>();
  const changes: BaseLineChange[] = [];
  for (const file of files) {
    changedFiles.add(file.path);
    if (file.oldPath) changedFiles.add(file.oldPath);
    if (file.status !== 'modified' || !file.oldBlob) continue;
    const lines = normalizeLineRanges(file.hunks.flatMap(hunkBaseLines));
    if (lines.length > 0) changes.push({ filePath: file.path, blob: file.oldBlob, lines });
  }
  return { changedFiles: [...changedFiles], changes };
}

/** The Ochiai coefficient of an element `failing` failing and `passing` passing captures executed, out of `totalFailing`. */
export function ochiai(failing: number, passing: number, totalFailing: number): number {
  if (failing === 0 || totalFailing === 0) return 0;
  return failing / Math.sqrt(totalFailing * (failing + passing));
}

/** A covered file, read once: its ranges merged for intersection, and whether its lines refer to the head. */
interface PreparedFile {
  path: string;
  runtime: CoverageRuntime;
  lines: LineRange[];
  functions: LineRange[];
  /** The line numbers refer to another version of the file than the head. */
  otherVersion: boolean;
}

/** How one capture executed one hunk. */
interface Evidence {
  granularity: CoverageGranularity;
  runtime: CoverageRuntime;
  lines: LineRange[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function prepare(file: CoverageFile, headBlob: string | undefined): PreparedFile {
  return {
    path: file.path,
    runtime: file.runtime,
    lines: normalizeLineRanges(file.lines ?? []),
    functions: normalizeLineRanges(file.functions ?? []),
    otherVersion: Boolean(
      headBlob &&
      file.blob &&
      file.blob.length === headBlob.length &&
      file.blob.toLowerCase() !== headBlob.toLowerCase(),
    ),
  };
}

/** How a covered file executed a hunk's changed lines, at the finest granularity it has; null when it did not. */
function evidenceOf(file: PreparedFile, changed: LineRange[]): Evidence | null {
  if (!file.otherVersion && file.lines.length > 0) {
    const hit = intersectLineRanges(changed, file.lines);
    return hit.length > 0 ? { granularity: 'lines', runtime: file.runtime, lines: hit } : null;
  }
  if (!file.otherVersion && file.functions.length > 0) {
    const hit = intersectLineRanges(changed, file.functions);
    return hit.length > 0 ? { granularity: 'functions', runtime: file.runtime, lines: hit } : null;
  }
  return { granularity: 'files', runtime: file.runtime, lines: changed };
}

/** The finest evidence among a capture's files for a hunk; files of equal granularity unite their lines. */
function bestEvidence(files: PreparedFile[], changed: LineRange[]): Evidence | null {
  let best: Evidence | null = null;
  for (const file of files) {
    const evidence = evidenceOf(file, changed);
    if (!evidence) continue;
    const rank = GRANULARITY_RANK[evidence.granularity];
    if (!best || rank < GRANULARITY_RANK[best.granularity]) best = evidence;
    else if (rank === GRANULARITY_RANK[best.granularity]) {
      best = {
        granularity: best.granularity,
        runtime: compareText(evidence.runtime, best.runtime) < 0 ? evidence.runtime : best.runtime,
        lines: normalizeLineRanges([...best.lines, ...evidence.lines]),
      };
    }
  }
  return best;
}

interface HeadHunk {
  lines: LineRange[];
  failing: Evidence[];
  passing: number;
}

interface HeadFile {
  change: SuspectChange;
  hunks: HeadHunk[];
  /** The covered paths this change matches. */
  covered: Set<string>;
}

function hasCoverage(capture: CoverageCapture): boolean {
  return capture.files.length > 0;
}

/**
 * Whether two paths name the same file by the suffix rule of `sameFilePath`,
 * the shorter one with a folder in it: a bare file name (`index.ts`) names no
 * file in another folder.
 */
function sameFileBySuffix(a: string, b: string): boolean {
  const shorter = a.length <= b.length ? a : b;
  return shorter.includes('/') && sameFilePath(a, b);
}

/** The covered paths a changed path matches: the same path, else the paths {@link sameFileBySuffix} matches. */
function matchCovered(path: string, coveredPaths: string[]): Set<string> {
  if (coveredPaths.includes(path)) return new Set([path]);
  return new Set(coveredPaths.filter((covered) => sameFileBySuffix(covered, path)));
}

/** Each capture's files grouped by path, read once. */
function filesByPath(capture: CoverageCapture): Map<string, CoverageFile[]> {
  const byPath = new Map<string, CoverageFile[]>();
  for (const file of capture.files) {
    const list = byPath.get(file.path);
    if (list) list.push(file);
    else byPath.set(file.path, [file]);
  }
  return byPath;
}

/** A capture's files for one changed file, prepared against its head blob, in path then runtime order. */
function filesFor(byPath: Map<string, CoverageFile[]>, file: HeadFile): PreparedFile[] {
  const out: PreparedFile[] = [];
  for (const path of file.covered) {
    for (const covered of byPath.get(path) ?? []) out.push(prepare(covered, file.change.headBlob));
  }
  return out.sort((a, b) => compareText(a.path, b.path) || compareText(a.runtime, b.runtime));
}

/** The runtime most failing captures executed a hunk in, at its granularity; `browser` before `server` on a tie. */
function majorityRuntime(evidence: Evidence[]): CoverageRuntime {
  let browser = 0;
  let server = 0;
  for (const e of evidence) {
    if (e.runtime === 'browser') browser++;
    else server++;
  }
  return server > browser ? 'server' : 'browser';
}

function compareSuspects(a: SuspectLine & { exact: number }, b: SuspectLine & { exact: number }): number {
  return (
    GRANULARITY_RANK[a.granularity] - GRANULARITY_RANK[b.granularity] ||
    b.exact - a.exact ||
    b.failing - a.failing ||
    compareText(a.path, b.path) ||
    a.hunk[0] - b.hunk[0] ||
    compareText(a.runtime, b.runtime)
  );
}

/**
 * The suspect lines of a change for the coverage of its failing and passing
 * executions: a summary and the hunks the failing captures executed, ranked by
 * granularity (lines, then functions, then files), then score, then failing
 * count, then path and line, at most `limit` of them. Deleted files have no
 * head side and are left out; captures with no file count as without coverage.
 */
export function suspectLines(input: SuspectLinesInput): SuspectLinesResult {
  const limit = Math.max(0, Math.min(input.limit ?? MAX_SUSPECTS, MAX_SUSPECTS));
  const failing = input.failing.filter(hasCoverage);
  const passing = input.passing.filter(hasCoverage);

  const coveredPaths = [...new Set([...failing, ...passing].flatMap((c) => c.files.map((f) => f.path)))].sort(
    compareText,
  );
  const files: HeadFile[] = [];
  for (const change of input.changes) {
    if (change.status === 'deleted') continue;
    const hunks = change.hunks
      .map((hunk): HeadHunk => ({ lines: hunkHeadLines(hunk), failing: [], passing: 0 }))
      .filter((hunk) => hunk.lines.length > 0);
    if (hunks.length > 0) files.push({ change, hunks, covered: matchCovered(change.path, coveredPaths) });
  }

  const record = (capture: CoverageCapture, onEvidence: (hunk: HeadHunk, evidence: Evidence) => void) => {
    const byPath = filesByPath(capture);
    for (const file of files) {
      if (file.covered.size === 0) continue;
      const prepared = filesFor(byPath, file);
      if (prepared.length === 0) continue;
      for (const hunk of file.hunks) {
        const evidence = bestEvidence(prepared, hunk.lines);
        if (evidence) onEvidence(hunk, evidence);
      }
    }
  };
  for (const capture of failing) record(capture, (hunk, evidence) => hunk.failing.push(evidence));
  for (const capture of passing) record(capture, (hunk) => hunk.passing++);

  const summary: SuspectLinesSummary = {
    changedFiles: files.length,
    changedLines: 0,
    hunks: 0,
    executedHunks: 0,
    executedLines: 0,
    failingWithCoverage: failing.length,
    passingWithCoverage: passing.length,
  };
  const ranked: Array<SuspectLine & { exact: number }> = [];
  for (const file of files) {
    summary.hunks += file.hunks.length;
    summary.changedLines += countLines(normalizeLineRanges(file.hunks.flatMap((h) => h.lines)));
    const executed: LineRange[] = [];
    for (const hunk of file.hunks) {
      if (hunk.failing.length === 0) continue;
      summary.executedHunks++;
      for (const e of hunk.failing) if (e.granularity === 'lines') executed.push(...e.lines);
      const rank = Math.min(...hunk.failing.map((e) => GRANULARITY_RANK[e.granularity]));
      const finest = hunk.failing.filter((e) => GRANULARITY_RANK[e.granularity] === rank);
      const exact = ochiai(hunk.failing.length, hunk.passing, failing.length);
      ranked.push({
        path: file.change.path,
        runtime: majorityRuntime(finest),
        hunk: [hunk.lines[0]![0], hunk.lines[hunk.lines.length - 1]![1]],
        lines: normalizeLineRanges(finest.flatMap((e) => e.lines)),
        granularity: finest[0]!.granularity,
        failing: hunk.failing.length,
        passing: hunk.passing,
        score: Math.round(exact * 1000) / 1000,
        exact,
      });
    }
    summary.executedLines += countLines(normalizeLineRanges(executed));
  }

  const suspects = ranked
    .sort(compareSuspects)
    .slice(0, limit)
    .map(({ exact: _exact, ...suspect }) => suspect);
  return { summary, suspects };
}
