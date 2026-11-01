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
 *
 * One gap per file, keyed by its path, so the Coverage tab's views (the gap's
 * code, the file tree's counts, the file's page) find it. The detectors are
 * pure; the loaders read the coverage and keep the files with the most to say.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { decodeFunctionRanges, type LineRange } from '@piwitests/core/coverage';
import { coverageFragments, quarantinedTests, testCases, testCoverage } from '../../server/database/schema';
import { finalCommitTotals, latestCoverageCommit, loadCommitCoverage } from '../../server/utils/coverage-totals';
import type { DrizzleDB } from './db';
import type { DetectedGap } from './scenario-gaps';

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
 * The files of the default branch's newest combined coverage with functions,
 * or every line, no suite ran: the {@link MAX_CODE_GAPS} with the most first.
 * None when the default branch has no coverage, or keeps only its totals.
 */
export async function loadUnexecutedFiles(db: DrizzleDB, projectId: number): Promise<UnexecutedFile[]> {
  const commit = await latestCoverageCommit(db, projectId, '');
  if (!commit || (await finalCommitTotals(db, projectId, commit))) return [];
  const coverage = await loadCommitCoverage(db, projectId, commit);
  if (!coverage) return [];
  const files: UnexecutedFile[] = [];
  for (const f of coverage.combined.files) {
    const ran = new Set(f.runFunctions.map((r) => r[0]));
    const unrunFunctions = f.knownFunctions.filter((r) => !ran.has(r[0]));
    const executableLines = f.executable.reduce((n, [a, b]) => n + b - a + 1, 0);
    const executedLines = f.executed.reduce((n, [a, b]) => n + b - a + 1, 0);
    files.push({
      path: f.path,
      commit,
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
