/**
 * The scenario-gap detectors that read code coverage, so coverage says what
 * test to write outside a pull request too:
 *
 * - *Code nobody executes*: the functions of a file, or the whole file, that no
 *   suite ran in the default branch's newest combined coverage (unit reports
 *   and the end-to-end run together). Dead code or a missing test; the sweep
 *   ranks it by the file's churn.
 * - *Single covering function*: the functions of a file that exactly one test
 *   runs in the tests' latest coverage on the default branch, or that only
 *   quarantined tests run. One refactor of that test and nothing runs them.
 * - *Error path never executed*: a `catch` block, a `throw` or an error return
 *   no suite ran, in a function that ran (a file that ran, when the coverage
 *   records it by line), from a scan of the file's source at the commit. The
 *   code-level form of *success only*.
 *
 * One gap per file, keyed by its path, so the Coverage tab's views (the gap's
 * code, the file tree's counts, the file's page) find it. The detectors are
 * pure; the loaders read the coverage and keep the files with the most to say.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { decodeFunctionRanges, intersectLineRanges, type LineRange } from '@piwitests/core/coverage';
import {
  coverageFragments,
  quarantinedTests,
  scenarioGaps,
  testCases,
  testCoverage,
} from '../../server/database/schema';
import {
  finalCommitTotals,
  latestCoverageCommit,
  loadCommitCoverage,
  type CommitCoverage,
} from '../../server/utils/coverage-totals';
import { findErrorPaths, type ErrorPath } from '../error-paths';
import type { DrizzleDB } from './db';
import type { DetectedGap, GapStatus } from './scenario-gaps';

/** The text of a repository file at a git blob, or null when it cannot be read. */
export type SourceReader = (path: string, blob: string) => Promise<string | null>;

/**
 * The default branch's newest combined coverage, which *code nobody executes*
 * and *error path never executed* read. Null when the default branch has no
 * coverage, or keeps only the commit's totals.
 */
export async function loadDefaultBranchCoverage(db: DrizzleDB, projectId: number): Promise<CommitCoverage | null> {
  const commit = await latestCoverageCommit(db, projectId, '');
  if (!commit || (await finalCommitTotals(db, projectId, commit))) return null;
  return loadCommitCoverage(db, projectId, commit);
}

const lineCount = (ranges: readonly LineRange[]) => ranges.reduce((n, [a, b]) => n + b - a + 1, 0);

/** Files each detector raises a gap for at most, those with the most functions first. */
export const MAX_CODE_GAPS = 30;
/** Function ranges an evidence line names at most. */
const LISTED_RANGES = 4;

/** Line ranges as people read them: `12–15, 40–52 and 2 more`. */
export function rangesText(ranges: readonly LineRange[]): string {
  const shown = ranges.slice(0, LISTED_RANGES).map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`));
  const more = ranges.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── Code nobody executes ─────────────────────────────────────────────────────

/** A file of the commit's combined coverage that no suite ran in part or in full. */
export interface UnexecutedFile {
  path: string;
  commit: string;
  /** Every function the coverage knows in the file; empty for a file recorded by line only. */
  knownFunctions: number;
  /** The functions no suite ran. */
  unrunFunctions: LineRange[];
  executableLines: number;
  executedLines: number;
}

/**
 * Code nobody executes: the functions of a file no suite ran, or, for a file
 * recorded by line only, a file none of whose lines ran. Blind spot.
 */
export function detectCodeNotExecuted(files: UnexecutedFile[]): DetectedGap[] {
  const gaps: DetectedGap[] = [];
  for (const f of files) {
    const at = f.commit.slice(0, 7);
    if (f.knownFunctions > 0 && f.unrunFunctions.length > 0) {
      const share = f.unrunFunctions.length / f.knownFunctions;
      gaps.push({
        detector: 'code-not-executed',
        kind: 'gap',
        class: 'blind-spot',
        key: f.path,
        title:
          f.unrunFunctions.length === f.knownFunctions
            ? `No suite runs ${f.path}`
            : `${f.unrunFunctions.length} of ${plural(f.knownFunctions, 'function')} of ${f.path} no suite runs`,
        evidence: [
          `Functions at lines ${rangesText(f.unrunFunctions)} · no suite ran them at ${at}: dead code, or a test to write.`,
        ],
        confidence: 0.4 + 0.3 * share,
        files: [f.path],
      });
    } else if (f.knownFunctions === 0 && f.executableLines > 0 && f.executedLines === 0) {
      gaps.push({
        detector: 'code-not-executed',
        kind: 'gap',
        class: 'blind-spot',
        key: f.path,
        title: `No suite runs ${f.path}`,
        evidence: [
          `${plural(f.executableLines, 'executable line')} · none ran at ${at}: dead code, or a test to write.`,
        ],
        confidence: 0.6,
        files: [f.path],
      });
    }
  }
  return gaps;
}

/**
 * The files of a commit's combined coverage with functions, or every line, no
 * suite ran: the {@link MAX_CODE_GAPS} with the most first.
 */
export function unexecutedFiles(coverage: CommitCoverage | null): UnexecutedFile[] {
  if (!coverage) return [];
  const files: UnexecutedFile[] = [];
  for (const f of coverage.combined.files) {
    const ran = new Set(f.runFunctions.map((r) => r[0]));
    const unrunFunctions = f.knownFunctions.filter((r) => !ran.has(r[0]));
    const executableLines = lineCount(f.executable);
    const executedLines = lineCount(f.executed);
    files.push({
      path: f.path,
      commit: coverage.commit,
      knownFunctions: f.knownFunctions.length,
      unrunFunctions,
      executableLines,
      executedLines,
    });
  }
  const weight = (f: UnexecutedFile) =>
    f.knownFunctions > 0 ? f.unrunFunctions.length : f.executedLines === 0 ? f.executableLines / 10 : 0;
  return files
    .filter((f) => weight(f) > 0)
    .sort((a, b) => weight(b) - weight(a) || a.path.localeCompare(b.path))
    .slice(0, MAX_CODE_GAPS);
}

// ── Single covering function ─────────────────────────────────────────────────

/** One function of a file and the one test that runs it, or the quarantined tests that alone do. */
export interface SingleCoveredFunction {
  range: LineRange;
  /** The one trusted test that runs it; null when only quarantined tests do. */
  test: { id: number; title: string } | null;
}

export interface SingleCoveredFile {
  path: string;
  functions: SingleCoveredFunction[];
}

/**
 * Single covering function: the functions of a file exactly one trusted test
 * runs, or only quarantined tests run. Fragile.
 */
export function detectSingleCoveringFunction(files: SingleCoveredFile[]): DetectedGap[] {
  return files
    .filter((f) => f.functions.length > 0)
    .map((f) => {
      const byTest = new Map<string, LineRange[]>();
      for (const fn of f.functions) {
        const who = fn.test ? fn.test.title : '';
        byTest.set(who, [...(byTest.get(who) ?? []), fn.range]);
      }
      const evidence = [...byTest].map(([title, ranges]) =>
        title
          ? `Only ${title} runs the functions at lines ${rangesText(ranges)}: a second test would make them resilient.`
          : `Only quarantined tests run the functions at lines ${rangesText(ranges)}.`,
      );
      const tests = new Set(f.functions.map((fn) => fn.test?.id ?? null));
      const only = tests.size === 1 ? [...tests][0] : null;
      return {
        detector: 'single-covering-function',
        kind: 'gap' as const,
        class: 'fragile' as const,
        key: f.path,
        title: `${plural(f.functions.length, 'function')} of ${f.path} ${f.functions.length === 1 ? 'runs' : 'run'} under one test only`,
        evidence,
        confidence: 0.5,
        files: [f.path],
        ...(only != null ? { testCaseId: only } : {}),
      };
    });
}

/**
 * The functions each test's latest coverage on the default branch runs, per
 * file at the version most tests recorded, kept where exactly one trusted test
 * runs a function, or only quarantined tests do: the {@link MAX_CODE_GAPS}
 * files with the most such functions.
 */
export async function loadSingleCoveredFiles(db: DrizzleDB, projectId: number): Promise<SingleCoveredFile[]> {
  const rows = await db
    .select({
      testCaseId: testCoverage.testCaseId,
      path: coverageFragments.path,
      blob: coverageFragments.blob,
      functions: coverageFragments.functions,
    })
    .from(testCoverage)
    .innerJoin(coverageFragments, eq(coverageFragments.id, testCoverage.fragmentId))
    .where(and(eq(testCoverage.projectId, projectId), eq(testCoverage.branch, '')));
  if (rows.length === 0) return [];

  // Per file, the version the most tests recorded: line numbers of two versions do not compare.
  const testsByVersion = new Map<string, Map<string, Set<number>>>();
  for (const r of rows) {
    if (!r.functions) continue;
    const versions = testsByVersion.get(r.path) ?? new Map<string, Set<number>>();
    const tests = versions.get(r.blob ?? '') ?? new Set<number>();
    tests.add(r.testCaseId);
    versions.set(r.blob ?? '', tests);
    testsByVersion.set(r.path, versions);
  }
  const versionOf = new Map<string, string>();
  for (const [path, versions] of testsByVersion) {
    const [best] = [...versions].sort((a, b) => b[1].size - a[1].size);
    if (best) versionOf.set(path, best[0]);
  }

  const quarantined = new Set(
    (
      await db
        .select({ id: quarantinedTests.testCaseId })
        .from(quarantinedTests)
        .where(and(eq(quarantinedTests.projectId, projectId), isNull(quarantinedTests.releasedAt)))
    ).map((q) => q.id),
  );

  // Per file and function start, its range and the tests that run it.
  const functionsOf = new Map<string, Map<number, { range: LineRange; tests: Set<number> }>>();
  for (const r of rows) {
    if (!r.functions || versionOf.get(r.path) !== (r.blob ?? '')) continue;
    const byStart = functionsOf.get(r.path) ?? new Map<number, { range: LineRange; tests: Set<number> }>();
    for (const range of decodeFunctionRanges(r.functions)) {
      const entry = byStart.get(range[0]) ?? { range, tests: new Set<number>() };
      entry.tests.add(r.testCaseId);
      byStart.set(range[0], entry);
    }
    functionsOf.set(r.path, byStart);
  }

  const singles: Array<{ path: string; functions: Array<{ range: LineRange; testId: number | null }> }> = [];
  for (const [path, byStart] of functionsOf) {
    const functions: Array<{ range: LineRange; testId: number | null }> = [];
    for (const { range, tests } of [...byStart.values()].sort((a, b) => a.range[0] - b.range[0])) {
      const trusted = [...tests].filter((id) => !quarantined.has(id));
      if (trusted.length === 1) functions.push({ range, testId: trusted[0]! });
      else if (trusted.length === 0) functions.push({ range, testId: null });
    }
    if (functions.length > 0) singles.push({ path, functions });
  }
  const kept = singles
    .sort((a, b) => b.functions.length - a.functions.length || a.path.localeCompare(b.path))
    .slice(0, MAX_CODE_GAPS);

  const ids = [...new Set(kept.flatMap((f) => f.functions.map((fn) => fn.testId)).filter((id) => id != null))];
  const titles = new Map<number, string>();
  for (let i = 0; i < ids.length; i += 500) {
    for (const t of await db
      .select({ id: testCases.id, title: testCases.title })
      .from(testCases)
      .where(inArray(testCases.id, ids.slice(i, i + 500)))) {
      titles.set(t.id, t.title);
    }
  }
  return kept.map((f) => ({
    path: f.path,
    functions: f.functions.map((fn) => ({
      range: fn.range,
      test: fn.testId == null ? null : { id: fn.testId, title: titles.get(fn.testId) ?? `test ${fn.testId}` },
    })),
  }));
}

// ── Error path never executed ────────────────────────────────────────────────

/** One error path no suite ran, and what did run around it. */
export interface UnrunErrorPath {
  path: ErrorPath;
  /** `function`: the function holding it ran; `file`: the file ran, recorded by line only. */
  ran: 'function' | 'file';
}

export interface ErrorPathFile {
  path: string;
  paths: UnrunErrorPath[];
}

/** Error paths an evidence list names at most; the rest are counted. */
const LISTED_ERROR_PATHS = 3;

/**
 * Error path never executed: the `catch` blocks, `throw`s and error returns of
 * a file no suite ran, inside code that ran. Blind spot.
 */
export function detectErrorPathNotExecuted(files: ErrorPathFile[]): DetectedGap[] {
  return files
    .filter((f) => f.paths.length > 0)
    .map((f) => {
      const evidence = f.paths.slice(0, LISTED_ERROR_PATHS).map(({ path, ran }) => {
        const [a, b] = path.range;
        const lines = a === b ? `Line ${a}` : `Lines ${a}–${b}`;
        return `${lines} · ${path.text} · ${ran === 'function' ? 'its function ran' : 'the file ran'}, this never did.`;
      });
      const more = f.paths.length - LISTED_ERROR_PATHS;
      if (more > 0) evidence.push(`And ${plural(more, 'more error path')} no suite ran.`);
      return {
        detector: 'error-path-not-executed',
        kind: 'gap' as const,
        class: 'blind-spot' as const,
        key: f.path,
        title: `${plural(f.paths.length, 'error path')} of ${f.path} never run`,
        evidence,
        confidence: 0.7,
        files: [f.path],
      };
    });
}

/**
 * The error paths no suite ran in the files of a commit's combined coverage
 * that ran in part: the {@link MAX_CODE_GAPS} with the most lines not run,
 * each read at its blob. `scanned` lists the files whose source was read, and
 * `settled` the files every line of which ran: a gap of theirs that is not
 * raised again closes; any other file's gap stays as it is.
 */
export async function loadErrorPathFiles(
  coverage: CommitCoverage | null,
  readSource: SourceReader,
): Promise<{ files: ErrorPathFile[]; scanned: string[]; settled: string[] }> {
  if (!coverage) return { files: [], scanned: [], settled: [] };
  const unrun = (f: CommitCoverage['combined']['files'][number]) => lineCount(f.executable) - lineCount(f.executed);
  const ran = coverage.combined.files.filter((f) => f.executed.length > 0);
  const settled = ran.filter((f) => unrun(f) <= 0).map((f) => f.path);
  const candidates = ran
    .filter((f) => f.blob && unrun(f) > 0)
    .sort((a, b) => unrun(b) - unrun(a) || a.path.localeCompare(b.path))
    .slice(0, MAX_CODE_GAPS);

  const files: ErrorPathFile[] = [];
  const scanned: string[] = [];
  for (const f of candidates) {
    const source = await readSource(f.path, f.blob!).catch(() => null);
    if (source === null) continue;
    scanned.push(f.path);
    const runStarts = new Set(f.runFunctions.map((r) => r[0]));
    const paths: UnrunErrorPath[] = [];
    for (const path of findErrorPaths(source)) {
      const span: LineRange[] = [path.range];
      if (intersectLineRanges(f.executable, span).length === 0) continue;
      if (intersectLineRanges(f.executed, span).length > 0) continue;
      if (f.knownFunctions.length === 0) {
        paths.push({ path, ran: 'file' });
        continue;
      }
      const holder = f.knownFunctions.find(([a, b]) => path.range[0] >= a && path.range[0] <= b);
      if (holder && runStarts.has(holder[0])) paths.push({ path, ran: 'function' });
    }
    if (paths.length > 0) files.push({ path: f.path, paths });
  }
  return { files, scanned, settled };
}

/**
 * Close the open gaps of *error path never executed* on `paths` (the files
 * scanned, and those every line of which ran) that the sweep did not raise.
 */
export async function closeUnraisedErrorPaths(
  db: DrizzleDB,
  projectId: number,
  paths: string[],
  raised: Set<string>,
  runId: number | null,
  statuses: GapStatus[],
): Promise<number> {
  const keys = paths.filter((p) => !raised.has(p));
  const now = new Date();
  let closed = 0;
  for (let i = 0; i < keys.length; i += 200) {
    const rows = await db
      .update(scenarioGaps)
      .set({ status: 'closed', closedAt: now, closedByRunId: runId, closeReason: 'not-detected', updatedAt: now })
      .where(
        and(
          eq(scenarioGaps.projectId, projectId),
          eq(scenarioGaps.detector, 'error-path-not-executed'),
          inArray(scenarioGaps.status, statuses),
          inArray(scenarioGaps.key, keys.slice(i, i + 200)),
        ),
      )
      .returning({ id: scenarioGaps.id });
    closed += rows.length;
  }
  return closed;
}
