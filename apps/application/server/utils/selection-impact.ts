/**
 * Impact-from-diff — map a set of changed files to the tests they affect,
 * resolved through observed edges rather than a build-time dependency graph.
 *
 * Three edges, all cheap and config-free:
 *  1. **Direct** — a changed file that IS a test file → the tests defined in it.
 *  2. **Reach** — a changed support file (page object, helper, app module) that
 *     a test's most recent execution ran through, per its captured
 *     `test_source_frames`.
 *  3. **Code reach** — a changed application file whose functions a test
 *     executed (`code_reach`), or the handler file of a route a test called.
 *
 * Honest by construction: it degrades in the safe direction, widening to the
 * full suite (with a warning) rather than silently skipping a test:
 *  - A changed file that maps to no test can't be ruled out, unless it is
 *    documentation (`DOCUMENTATION_EXTENSIONS`). Styles, markup, JSON and YAML
 *    widen too: no edge maps them.
 *  - A changed file mapped only through source frames widens. Source frames are
 *    recorded on failure only, so they name the tests that failed inside the
 *    file, never the passing tests that also use it.
 * Code reach only adds tests: it leaves out module top-level code, server
 * modules and type-only modules, so a file it never saw may still be run by
 * every test.
 *
 * **Line level.** When the caller sends a modified file's changed lines and its
 * base blob, the tests that reach it only through coverage are narrowed to
 * those whose recorded coverage of that version ran the changed lines
 * (`#shared/line-impact`); a test the coverage cannot rule out stays, at file
 * level. A test file, failure frames and route reach are never narrowed.
 */
import { eq, sql } from 'drizzle-orm';
import { testCases, testRunsCases } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { resolveCasePayloadContents } from './case-payloads';
import {
  MAX_COVERAGE_RANGES,
  normalizeLineRanges,
  type CoverageFile,
  type CoverageRuntime,
  type LineRange,
} from '@piwitests/core/coverage';
import { sameFilePath } from '@piwitests/core/locator-break';
import { loadCodeReachPairs } from './code-reach';
import { getFileVersions, getRecordedFragments, incompleteCoverageTests } from './coverage';
import { resolveSelectionDefinition } from '#shared/handlers/selections';
import { lineImpact, sameBlob, type LineImpactDecision, type LineImpactVersion } from '#shared/line-impact';
import type { ResolvedSelection, SelectionDefinition, SelectionFormat, SelectionRankBy } from '#shared/selection';

/** Documentation extensions: a changed file with one of these that maps to no test runs nothing. */
const DOCUMENTATION_EXTENSIONS = new Set(['md', 'mdx', 'markdown', 'txt', 'rst', 'adoc']);
/** Changed files read at line level at most; the others stay at file level. */
const MAX_LINE_LEVEL_FILES = 100;
/** Changes a request carries at most. */
const MAX_CHANGES = 5000;
/** Changed files the per-file breakdown lists at most, and tests per file. */
const MAX_IMPACT_FILES = 200;
const MAX_FILE_TESTS = 100;

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function fileExtension(p: string): string {
  const match = p.match(/\.([a-z0-9]+)$/i);
  return match ? match[1]!.toLowerCase() : '';
}

/** Two repo-relative paths match when equal or one is a path-suffix of the other. */
function pathsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith('/' + b) || b.endsWith('/' + a);
}

/** Per-test set of in-project files its most recent execution ran through. */
async function loadSourceReach(db: DrizzleDB, projectId: number): Promise<Map<number, string[]>> {
  const ranked = db.$with('ranked').as(
    db
      .select({
        testCaseId: testRunsCases.testCaseId,
        frames: testRunsCases.testSourceFrames,
        framesPayloadId: testRunsCases.testSourceFramesPayloadId,
        rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${testRunsCases.testCaseId} ORDER BY ${testRunsCases.createdAt} DESC, ${testRunsCases.id} DESC)`.as(
          'rn',
        ),
      })
      .from(testRunsCases)
      .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
      .where(eq(testCases.projectId, projectId)),
  );

  const rows: any[] = await db
    .with(ranked)
    .select({ testCaseId: ranked.testCaseId, frames: ranked.frames, framesPayloadId: ranked.framesPayloadId })
    .from(ranked)
    .where(sql`${ranked.rn} = 1`);

  const payloads = await resolveCasePayloadContents(
    db,
    rows.map((r) => r.framesPayloadId),
  );
  const reach = new Map<number, string[]>();
  for (const row of rows) {
    let frames: unknown = row.frames;
    if (row.framesPayloadId != null && payloads.has(row.framesPayloadId)) {
      try {
        frames = JSON.parse(payloads.get(row.framesPayloadId)!);
      } catch {
        // Malformed payload — fall back to whatever the inline column held.
      }
    }
    if (!Array.isArray(frames)) continue;
    const files = [
      ...new Set(
        frames
          .map((f) => (f && typeof f === 'object' ? (f as { file?: unknown }).file : undefined))
          .filter((f): f is string => typeof f === 'string')
          .map(normalizePath),
      ),
    ];
    if (files.length > 0) reach.set(Number(row.testCaseId), files);
  }
  return reach;
}

/** A modified file's change as a diff gives it, read on its base side. */
export interface ImpactChange {
  /** Repository-relative path. */
  filePath: string;
  /** The file's git blob id before the change, full or abbreviated. */
  blob: string;
  /** The changed lines on the base side (`hunkBaseLines`). */
  lines: LineRange[];
}

/**
 * The `changes` of an impact request: entries with a path, a hexadecimal blob
 * id of at least seven characters and well-formed line ranges, at most
 * {@link MAX_COVERAGE_RANGES} of them. Anything else is dropped whole, which
 * leaves its file at file level.
 */
export function parseImpactChanges(raw: unknown): ImpactChange[] {
  if (!Array.isArray(raw)) return [];
  const changes: ImpactChange[] = [];
  for (const entry of raw.slice(0, MAX_CHANGES)) {
    if (!entry || typeof entry !== 'object') continue;
    const { filePath, blob, lines } = entry as Record<string, unknown>;
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.length > 500) continue;
    if (typeof blob !== 'string' || !/^[0-9a-f]{7,64}$/i.test(blob)) continue;
    if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_COVERAGE_RANGES) continue;
    if (!lines.every((range) => normalizeLineRanges([range]).length === 1)) continue;
    changes.push({ filePath, blob: blob.toLowerCase(), lines: normalizeLineRanges(lines) });
  }
  return changes;
}

/**
 * How a test is selected through a changed file: it is the file's test file
 * (`test-file`), it failed inside it (`frames`), it called a route the file
 * handles (`route`), it ran a changed line (`lines`) or a function around one
 * (`functions`), or its coverage reaches the file and cannot rule it out (`file`).
 */
export type ImpactVia = 'test-file' | 'frames' | 'route' | LineImpactDecision['via'];

export interface ImpactFileTest {
  testCaseId: number;
  via: ImpactVia;
  /** The changed lines it ran, for `lines` and `functions`. */
  lines?: LineRange[];
}

/** What one changed file selects. */
export interface ImpactFile {
  filePath: string;
  /** `lines` when its coverage-reached tests were narrowed to the changed lines, `file` when not, `none` when no test maps to it. */
  level: 'lines' | 'file' | 'none';
  /** The tests it selects (capped), finest evidence first. */
  tests: ImpactFileTest[];
  testCount: number;
  /** At line level: tests that reach the file and ran none of its changed lines. */
  ruledOut?: number;
  /** At line level: changed lines outside every function known in the version, which select every test reaching it. */
  fileLevelLines?: LineRange[];
  /** At line level: changed lines inside functions no test reaching the file ran. */
  notRun?: LineRange[];
}

export interface ImpactResolution extends ResolvedSelection {
  impact: {
    changedFiles: number;
    /** Changed files that mapped to at least one test. */
    mappedFiles: number;
    /** True when files that could not be fully mapped forced a full-suite run. */
    widened: boolean;
    /** Changed files that forced the full suite (capped): mapped to no test, or only through source frames. */
    unmappedSourceFiles: string[];
    /** Changed files narrowed at line level. */
    lineLevelFiles: number;
    /** What each changed file selects (capped). */
    files: ImpactFile[];
  };
}

/** How a test reaches a changed file, before any narrowing: through coverage, in a runtime, or another edge. */
type Reach = 'test-file' | 'frames' | 'route' | CoverageRuntime;

const VIA_ORDER: ImpactVia[] = ['test-file', 'lines', 'functions', 'frames', 'route', 'file'];

/** Whether a test reaches a changed file through coverage alone, the only reach line level narrows. */
function coverageOnly(reach: Set<Reach>): boolean {
  for (const how of reach) if (how !== 'browser' && how !== 'server') return false;
  return true;
}

/** The reach a test is selected by at file level: its finest edge. */
function fileLevelVia(reach: Set<Reach>): ImpactVia {
  if (reach.has('test-file')) return 'test-file';
  if (reach.has('frames')) return 'frames';
  if (reach.has('browser') || reach.has('server')) return 'file';
  return 'route';
}

/**
 * Narrow the tests reaching one changed file through coverage alone to those
 * whose recorded coverage of the base version ran its changed lines. Null when
 * no test reaches the file through coverage alone, or no recorded coverage of
 * the file names its base version.
 */
async function narrowByLines(db: DrizzleDB, projectId: number, change: ImpactChange, reach: Map<number, Set<Reach>>) {
  const recorded = await getRecordedFragments(db, projectId, change.filePath, '');
  if (!recorded.some((r) => sameBlob(r.file.blob, change.blob))) return null;

  const tests = new Map<number, Map<CoverageRuntime, CoverageFile[]>>();
  const runs: Array<{ testCaseId: number; runId: number }> = [];
  // Coverage whose run is deleted cannot say whether its capture was complete.
  const unknownCapture = new Set<number>();
  for (const [testCaseId, how] of reach) {
    if (!coverageOnly(how)) continue;
    const runtimes = [...how].filter((r): r is CoverageRuntime => r === 'browser' || r === 'server');
    const byRuntime = new Map<CoverageRuntime, CoverageFile[]>(runtimes.map((r) => [r, []]));
    for (const fragment of recorded) {
      const runId = fragment.tests.get(testCaseId);
      if (runId === undefined) continue;
      byRuntime.get(fragment.file.runtime)?.push(fragment.file);
      if (runId === null) unknownCapture.add(testCaseId);
      else runs.push({ testCaseId, runId });
    }
    tests.set(testCaseId, byRuntime);
  }
  if (tests.size === 0) return null;

  const atBase = recorded.filter((r) => sameBlob(r.file.blob, change.blob));
  // The coverage of the tests reaching the file another way, which stay at file level.
  const others = atBase
    .filter((r) => [...r.tests.keys()].some((id) => reach.has(id) && !coverageOnly(reach.get(id)!)))
    .map((r) => r.file);
  const stored = await getFileVersions(
    db,
    projectId,
    atBase.map((r) => ({ path: r.file.path, runtime: r.file.runtime, blob: r.file.blob! })),
  );
  const versions: LineImpactVersion[] = (['browser', 'server'] as const).flatMap((runtime) => {
    const own = stored.filter((v) => v.runtime === runtime);
    if (own.length === 0) return [];
    return [{ runtime, executable: own.flatMap((v) => v.lines), functions: own.flatMap((v) => v.functions) }];
  });

  const first = lineImpact({
    changed: change.lines,
    blob: change.blob,
    tests,
    versions,
    incomplete: unknownCapture,
    others,
  });
  if (first.ruledOut.length === 0) return first;
  // A capture that was incomplete cannot say a line did not run.
  const ruledOut = new Set(first.ruledOut);
  const incomplete = await incompleteCoverageTests(
    db,
    runs.filter((r) => ruledOut.has(r.testCaseId)),
  );
  if (incomplete.size === 0) return first;
  for (const testCaseId of unknownCapture) incomplete.add(testCaseId);
  return lineImpact({ changed: change.lines, blob: change.blob, tests, versions, incomplete, others });
}

/**
 * Resolve which tests a set of changed files impacts, then materialize a command
 * for them via the normal resolver (through an `ids` selection, or the whole
 * suite when widening). `changes` adds the changed lines of modified files, which
 * narrows their coverage-reached tests at line level.
 */
export async function resolveImpact(
  db: DrizzleDB,
  projectId: number,
  changedFiles: string[],
  options: {
    format?: SelectionFormat;
    shard?: { index: number; total: number };
    order?: SelectionRankBy;
    changes?: ImpactChange[];
  } = {},
): Promise<ImpactResolution> {
  const files = [...new Set(changedFiles.map(normalizePath).filter(Boolean))];

  const cases = await db
    .select({ id: testCases.id, filePath: testCases.filePath })
    .from(testCases)
    .where(eq(testCases.projectId, projectId));
  const reach = await loadSourceReach(db, projectId);
  const codeReach = await loadCodeReachPairs(db, projectId);

  // Per changed file, each test that reaches it and how.
  const reachOf = new Map<string, Map<number, Set<Reach>>>(files.map((f) => [f, new Map()]));
  const addReach = (changed: string, testCaseId: number, how: Reach) => {
    const tests = reachOf.get(changed)!;
    const set = tests.get(testCaseId);
    if (set) set.add(how);
    else tests.set(testCaseId, new Set([how]));
  };
  const mappedFiles = new Set<string>();
  // Files mapped by an edge that names every test using them: the test file itself, or code reach.
  const fullyMappedFiles = new Set<string>();

  for (const testCase of cases) {
    const filePath = normalizePath(testCase.filePath);
    for (const changed of files) {
      if (pathsMatch(filePath, changed)) {
        addReach(changed, testCase.id, 'test-file');
        mappedFiles.add(changed);
        fullyMappedFiles.add(changed);
      }
    }
  }
  for (const [caseId, reachedFiles] of reach) {
    for (const changed of files) {
      if (reachedFiles.some((reached) => pathsMatch(reached, changed))) {
        addReach(changed, caseId, 'frames');
        mappedFiles.add(changed);
      }
    }
  }

  // Many tests reach the same files: match each distinct file once.
  const pairsByFile = new Map<string, typeof codeReach>();
  for (const pair of codeReach) {
    const pairs = pairsByFile.get(pair.file);
    if (pairs) pairs.push(pair);
    else pairsByFile.set(pair.file, [pair]);
  }
  for (const [file, pairs] of pairsByFile) {
    for (const changed of files) {
      if (!sameFilePath(file, changed)) continue;
      for (const pair of pairs) addReach(changed, pair.testCaseId, pair.via === 'route' ? 'route' : pair.runtime);
      mappedFiles.add(changed);
      fullyMappedFiles.add(changed);
    }
  }

  // Narrow each modified file's coverage-reached tests to the changed lines they ran.
  const changes = new Map<string, ImpactChange>();
  for (const change of options.changes ?? []) {
    const path = normalizePath(change.filePath);
    if (reachOf.has(path) && change.blob && change.lines.length > 0) changes.set(path, { ...change, filePath: path });
  }
  const matched = new Set<number>();
  const breakdown: ImpactFile[] = [];
  let lineLevelFiles = 0;
  let lineLevelReads = 0;
  for (const [changed, tests] of reachOf) {
    const change = changes.get(changed);
    const readLines = change && lineLevelReads < MAX_LINE_LEVEL_FILES && [...tests.values()].some(coverageOnly);
    if (readLines) lineLevelReads++;
    const narrowed = readLines ? await narrowByLines(db, projectId, change, tests) : null;
    if (narrowed) lineLevelFiles++;
    const ruledOut = new Set(narrowed?.ruledOut);
    const selected: ImpactFileTest[] = [];
    for (const [testCaseId, how] of tests) {
      const decision = narrowed?.selected.get(testCaseId);
      if (decision)
        selected.push({ testCaseId, via: decision.via, ...(decision.lines ? { lines: decision.lines } : {}) });
      else if (!ruledOut.has(testCaseId)) selected.push({ testCaseId, via: fileLevelVia(how) });
    }
    for (const t of selected) matched.add(t.testCaseId);
    selected.sort((a, b) => VIA_ORDER.indexOf(a.via) - VIA_ORDER.indexOf(b.via) || a.testCaseId - b.testCaseId);
    breakdown.push({
      filePath: changed,
      level: narrowed ? 'lines' : tests.size > 0 ? 'file' : 'none',
      tests: selected.slice(0, MAX_FILE_TESTS),
      testCount: selected.length,
      ...(narrowed
        ? { ruledOut: narrowed.ruledOut.length, fileLevelLines: narrowed.fileLevel, notRun: narrowed.notRun }
        : {}),
    });
  }

  const unmapped = files.filter((f) => !mappedFiles.has(f) && !DOCUMENTATION_EXTENSIONS.has(fileExtension(f)));
  const framesOnly = files.filter((f) => mappedFiles.has(f) && !fullyMappedFiles.has(f));
  const widening = [...unmapped, ...framesOnly];
  const widened = widening.length > 0;

  const definition: SelectionDefinition = widened ? {} : { include: [{ ids: [...matched] }] };
  const resolved = await resolveSelectionDefinition(db, projectId, definition, {
    key: 'impact',
    version: 0,
    format: options.format,
    shard: options.shard,
    order: options.order,
  });

  if (widened) {
    const reasons: string[] = [];
    if (unmapped.length > 0) {
      reasons.push(`${unmapped.length} changed file${unmapped.length === 1 ? '' : 's'} mapped to no test`);
    }
    if (framesOnly.length > 0) {
      reasons.push(
        `${framesOnly.length} changed file${framesOnly.length === 1 ? '' : 's'} mapped only through failure frames, which miss the passing tests that use ${framesOnly.length === 1 ? 'it' : 'them'}`,
      );
    }
    resolved.warnings.push({
      code: 'impact-widened',
      message: `${reasons.join('; ')} — running the full suite: ${widening.slice(0, 5).join(', ')}`,
    });
  }

  return {
    ...resolved,
    impact: {
      changedFiles: files.length,
      mappedFiles: mappedFiles.size,
      widened,
      unmappedSourceFiles: widening.slice(0, 50),
      lineLevelFiles,
      files: breakdown.slice(0, MAX_IMPACT_FILES),
    },
  };
}
