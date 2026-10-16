/**
 * Coverage storage: which functions and lines each test executed, per file and
 * runtime (`@piwitests/core/coverage`).
 *
 * - `coverage_fragments`: one file's coverage as one test recorded it, stored
 *   once per project under the SHA-256 of `canonicalCoverageFile`, so every
 *   test and execution that recorded the same coverage of a file shares a row.
 * - Per execution, `test_runs_cases.coverage_payload_id`: a `case_payloads` row
 *   holding the sorted JSON array of the execution's fragment ids, or
 *   `{ "fragments": [...], "incomplete": true }` for an incomplete capture, so
 *   identical executions share one payload.
 * - `test_coverage`: per test case, branch and runtime, the fragments of its
 *   latest run with coverage there, replaced like `code_reach`, whose rows are
 *   the files of the same coverage.
 * - `run_coverage`: a run's coverage per file, attributed to no test, merged
 *   across the requests that send it (one per shard).
 * - `coverage_executable`: per file version (path and blob), its executable
 *   lines and every function known in it, which depend on its content alone,
 *   stored once per version, the union of what run coverages named.
 * - Coverage reports (`server/utils/coverage-reports.ts`): another tool's
 *   coverage of one suite at one commit, whose files are fragments too, under
 *   the runtime `report`.
 *
 * A fragment no `test_coverage` row references is deleted once no execution
 * can reference it either ({@link unreferencedFragments}); an execution whose
 * fragment is gone reads as incomplete.
 */
import { and, eq, inArray, lt, ne, sql, type SQL } from 'drizzle-orm';
import {
  canonicalCoverageFile,
  coverageFiles,
  type CanonicalCoverageInput,
  decodeFunctionRanges,
  decodeLineRanges,
  encodeLineRanges,
  mergeCoverage,
  normalizeCoveragePath,
  normalizeFunctionRanges,
  normalizeLineRanges,
  MAX_COVERAGE_RANGES,
  type CoverageCapture,
  type CoverageFile,
  type CoverageRuntime,
  type LineRange,
} from '@piwitests/core/coverage';
import { itemsOfFile, sameFilePath } from '@piwitests/core/locator-break';
import type { LocatorIndexTest } from '@piwitests/core/locator-index';
import {
  codeReach,
  coverageExecutable,
  coverageFragments,
  coverageReportFiles,
  coverageReports,
  runCoverage,
  testCoverage,
  testRuns,
  testRunsCases,
} from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { isGitObjectId, sha256Hex } from '#shared/utils/hash';
import { resolveCasePayloadContents } from './case-payloads';
import {
  asRuntime,
  claimLatestRunScopes,
  latestRunScopes,
  sameBaseName,
  type CodeReachCase,
  type CodeReachLookups,
  type LatestRunRows,
} from './code-reach';
import { indexTests, resolveBranchView } from './locator-usages';

const RUNTIMES: CoverageRuntime[] = ['browser', 'server'];
/** The runtime of the fragments of a coverage report: where the code ran is not the report's to say. */
export const REPORT_RUNTIME = 'report';
/** Rows per insert: few enough columns times rows to stay under SQLite's bound-variable limit. */
const ROW_CHUNK = 200;
const ID_CHUNK = 500;
const HOUR_MS = 60 * 60 * 1000;
/** Branch-tagged coverage rows outlive their branch's last run by at most thirty days, like the Test Map's. */
const BRANCH_ROW_MAX_AGE_MS = 30 * 24 * HOUR_MS;

/** Files one run coverage request carries at most. */
export const MAX_RUN_COVERAGE_FILES = 20_000;
/** Largest run coverage request body read. */
export const MAX_RUN_COVERAGE_BYTES = 16 * 1024 * 1024;

const BLOB_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The code reach of one execution's coverage: its files, per runtime. */
export function codeReachOfCoverage(testCaseId: number, runId: number, capture: CoverageCapture): CodeReachCase[] {
  const out: CodeReachCase[] = [];
  for (const runtime of RUNTIMES) {
    const files = coverageFiles(capture, runtime);
    if (files.length > 0) out.push({ testCaseId, runId, runtime, files });
  }
  return out;
}

/** A stored fragment, as an execution references it. */
export interface StoredFragment {
  id: number;
  runtime: CoverageRuntime;
}

/** The columns of a fragment row, from a file of a capture or a report, normalized as its hash is. */
function fragmentColumns(file: CanonicalCoverageInput) {
  const functions = normalizeFunctionRanges(file.functions);
  const lines = normalizeLineRanges(file.lines);
  const executable = normalizeLineRanges(file.executable);
  const allFunctions = normalizeFunctionRanges(file.allFunctions);
  const ranged = functions.length > 0 || lines.length > 0 || executable.length > 0 || allFunctions.length > 0;
  return {
    runtime: file.runtime,
    path: file.path,
    blob: ranged && file.blob ? file.blob : null,
    functions: functions.length > 0 ? encodeLineRanges(functions) : null,
    lines: lines.length > 0 ? encodeLineRanges(lines) : null,
    executable: executable.length > 0 ? encodeLineRanges(executable) : null,
    allFunctions: allFunctions.length > 0 ? encodeLineRanges(allFunctions) : null,
  };
}

/**
 * Store fragments, each distinct one once, and mark each as seen now: the id
 * of each fragment by its hash (the SHA-256 of `canonicalCoverageFile`).
 */
export async function upsertFragmentRows(
  db: DrizzleDB,
  projectId: number,
  files: CanonicalCoverageInput[],
): Promise<{ hashes: string[]; ids: Map<string, { id: number; runtime: string }> }> {
  const byCanonical = new Map<string, string>();
  const fileByHash = new Map<string, CanonicalCoverageInput>();
  const hashes: string[] = [];
  for (const file of files) {
    const canonical = canonicalCoverageFile(file);
    let hash = byCanonical.get(canonical);
    if (hash === undefined) {
      hash = await sha256Hex(canonical);
      byCanonical.set(canonical, hash);
      fileByHash.set(hash, file);
    }
    hashes.push(hash);
  }
  const ids = new Map<string, { id: number; runtime: string }>();
  const now = new Date();
  // Sorted so concurrent batches lock shared rows in the same order.
  const sorted = [...fileByHash.keys()].sort();
  for (let i = 0; i < sorted.length; i += ROW_CHUNK) {
    const rows = sorted.slice(i, i + ROW_CHUNK).map((hash) => ({
      projectId,
      hash,
      ...fragmentColumns(fileByHash.get(hash)!),
      createdAt: now,
      lastSeenAt: now,
    }));
    const returned = await db
      .insert(coverageFragments)
      .values(rows)
      .onConflictDoUpdate({ target: [coverageFragments.projectId, coverageFragments.hash], set: { lastSeenAt: now } })
      .returning({ id: coverageFragments.id, hash: coverageFragments.hash, runtime: coverageFragments.runtime });
    for (const r of returned) ids.set(r.hash, { id: r.id, runtime: r.runtime });
  }
  return { hashes, ids };
}

/** A fragment row read back as a coverage file. */
function fragmentFile(row: {
  runtime: string;
  path: string;
  blob: string | null;
  functions: string | null;
  lines: string | null;
}): CoverageFile {
  const file: CoverageFile = { path: row.path, runtime: asRuntime(row.runtime) };
  const functions = decodeFunctionRanges(row.functions);
  const lines = decodeLineRanges(row.lines);
  if (row.blob && (functions.length > 0 || lines.length > 0)) file.blob = row.blob;
  if (functions.length > 0) file.functions = functions;
  if (lines.length > 0) file.lines = lines;
  return file;
}

function compareFiles(a: CoverageFile, b: CoverageFile): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.runtime !== b.runtime) return a.runtime < b.runtime ? -1 : 1;
  return 0;
}

/**
 * Store the fragments of a batch of captures, each distinct fragment once, and
 * mark each as seen now. Returns, per capture, its fragments sorted by id
 * (null for a capture that is null).
 */
export async function upsertCoverageFragments(
  db: DrizzleDB,
  projectId: number,
  captures: Array<CoverageCapture | null | undefined>,
): Promise<Array<StoredFragment[] | null>> {
  const files = captures.flatMap((capture) => capture?.files ?? []);
  const { hashes, ids } = await upsertFragmentRows(db, projectId, files);
  let at = 0;
  return captures.map((capture) => {
    if (!capture) return null;
    const byId = new Map<number, StoredFragment>();
    for (let i = 0; i < capture.files.length; i++) {
      const fragment = ids.get(hashes[at + i]!);
      if (fragment) byId.set(fragment.id, { id: fragment.id, runtime: asRuntime(fragment.runtime) });
    }
    at += capture.files.length;
    return [...byId.values()].sort((a, b) => a.id - b.id);
  });
}

/** The per-execution payload of a capture's fragments. */
export function coveragePayloadContent(fragments: StoredFragment[], incomplete: boolean): string {
  const ids = [...new Set(fragments.map((f) => f.id))].sort((a, b) => a - b);
  return JSON.stringify(incomplete ? { fragments: ids, incomplete: true } : ids);
}

/** A per-execution payload read back; null when it is not one. */
export function parseCoveragePayload(
  content: string | null | undefined,
): { fragmentIds: number[]; incomplete: boolean } | null {
  if (!content) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const ids = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.fragments : null;
  if (!Array.isArray(ids)) return null;
  return {
    fragmentIds: ids.filter((id): id is number => Number.isInteger(id)),
    incomplete: isRecord(parsed) && parsed.incomplete === true,
  };
}

/** One execution's stored fragments, as ingest hands them over. */
export interface TestCoverageCase {
  testCaseId: number;
  runId: number;
  fragments: StoredFragment[];
}

const TEST_COVERAGE_ROWS: LatestRunRows = {
  table: testCoverage,
  testCaseId: testCoverage.testCaseId,
  branch: testCoverage.branch,
  runtime: testCoverage.runtime,
  lastSeenRunId: testCoverage.lastSeenRunId,
  lastSeenAt: testCoverage.lastSeenAt,
};

/**
 * Store the test coverage of a batch of executions: per test case, branch and
 * runtime, the fragments of every execution of the latest run are merged, and
 * replace the rows of older runs, as `upsertCodeReach` does for files. An
 * execution older than the rows already stored changes nothing.
 */
export async function upsertTestCoverage(
  db: DrizzleDB,
  projectId: number,
  cases: TestCoverageCase[],
  known: CodeReachLookups = {},
): Promise<void> {
  const items = cases.flatMap((c) =>
    RUNTIMES.map((runtime) => ({
      testCaseId: c.testCaseId,
      runId: c.runId,
      runtime,
      items: c.fragments.filter((f) => f.runtime === runtime).map((f) => f.id),
    })).filter((item) => item.items.length > 0),
  );
  const scopes = await latestRunScopes(db, projectId, items, known);
  const fresh = await claimLatestRunScopes(db, TEST_COVERAGE_ROWS, scopes);
  const rows = fresh.flatMap((s) =>
    [...s.items].map((fragmentId) => ({
      projectId,
      testCaseId: s.testCaseId,
      branch: s.tag,
      runtime: s.runtime,
      fragmentId,
      lastSeenRunId: s.runId,
      lastSeenAt: s.startedAt,
    })),
  );
  for (let i = 0; i < rows.length; i += ROW_CHUNK) {
    await db
      .insert(testCoverage)
      .values(rows.slice(i, i + ROW_CHUNK))
      .onConflictDoNothing();
  }
}

async function loadFragments(db: DrizzleDB, ids: number[]) {
  const rows: Array<{
    id: number;
    runtime: string;
    path: string;
    blob: string | null;
    functions: string | null;
    lines: string | null;
  }> = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    rows.push(
      ...(await db
        .select({
          id: coverageFragments.id,
          runtime: coverageFragments.runtime,
          path: coverageFragments.path,
          blob: coverageFragments.blob,
          functions: coverageFragments.functions,
          lines: coverageFragments.lines,
        })
        .from(coverageFragments)
        .where(inArray(coverageFragments.id, ids.slice(i, i + ID_CHUNK)))),
    );
  }
  return rows;
}

/**
 * One execution's coverage, read from its payload's fragments; an execution
 * without coverage has no files. `incomplete` when the capture was, or when a
 * fragment it names no longer exists. Null when there is no such execution.
 */
export async function getExecutionCoverage(db: DrizzleDB, executionId: number): Promise<CoverageCapture | null> {
  return (await getExecutionsCoverage(db, [executionId])).get(executionId) ?? null;
}

/** A repository-relative path's file name, the part `sameFilePath` always compares. */
function baseName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/** Whether a path matches one of the given paths by `sameFilePath`, looked up by file name. */
function pathMatcher(paths: string[]): (path: string) => boolean {
  const byName = new Map<string, string[]>();
  for (const path of paths) {
    const name = baseName(path);
    byName.set(name, [...(byName.get(name) ?? []), path]);
  }
  return (path) => (byName.get(baseName(path)) ?? []).some((candidate) => sameFilePath(path, candidate));
}

/**
 * The coverage of several executions, read in bulk, by execution id; an
 * execution without coverage has no files, and an id with no execution is
 * left out. `incomplete` as {@link getExecutionCoverage} sets it. With
 * `rangesFor`, only the files matching one of those paths (`sameFilePath`)
 * keep their blob and ranges; the others keep their path and runtime, all a
 * reader joining on those paths needs.
 */
export async function getExecutionsCoverage(
  db: DrizzleDB,
  executionIds: number[],
  opts: { rangesFor?: string[] } = {},
): Promise<Map<number, CoverageCapture>> {
  const ids = [...new Set(executionIds)];
  const rows: Array<{ id: number; payloadId: number | null }> = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    rows.push(
      ...(await db
        .select({ id: testRunsCases.id, payloadId: testRunsCases.coveragePayloadId })
        .from(testRunsCases)
        .where(inArray(testRunsCases.id, ids.slice(i, i + ID_CHUNK)))),
    );
  }
  const contents = await resolveCasePayloadContents(
    db,
    rows.map((r) => r.payloadId),
  );
  const payloads = new Map(
    rows.map((r) => [r.id, r.payloadId == null ? null : parseCoveragePayload(contents.get(r.payloadId))]),
  );
  const fragmentIds = [...new Set([...payloads.values()].flatMap((p) => p?.fragmentIds ?? []))];

  const files = new Map<number, CoverageFile>();
  if (opts.rangesFor) {
    const matches = pathMatcher(opts.rangesFor);
    const heads: Array<{ id: number; runtime: string; path: string }> = [];
    for (let i = 0; i < fragmentIds.length; i += ID_CHUNK) {
      heads.push(
        ...(await db
          .select({ id: coverageFragments.id, runtime: coverageFragments.runtime, path: coverageFragments.path })
          .from(coverageFragments)
          .where(inArray(coverageFragments.id, fragmentIds.slice(i, i + ID_CHUNK)))),
      );
    }
    const ranged: number[] = [];
    for (const head of heads) {
      if (matches(head.path)) ranged.push(head.id);
      else files.set(head.id, { path: head.path, runtime: asRuntime(head.runtime) });
    }
    for (const fragment of await loadFragments(db, ranged)) files.set(fragment.id, fragmentFile(fragment));
  } else {
    for (const fragment of await loadFragments(db, fragmentIds)) files.set(fragment.id, fragmentFile(fragment));
  }

  const out = new Map<number, CoverageCapture>();
  for (const row of rows) {
    const payload = payloads.get(row.id);
    if (row.payloadId == null) {
      out.set(row.id, { v: 1, files: [] });
      continue;
    }
    if (!payload) {
      out.set(row.id, { v: 1, files: [], incomplete: true });
      continue;
    }
    const own = [...new Set(payload.fragmentIds)];
    const found = own.flatMap((id) => {
      const file = files.get(id);
      return file ? [file] : [];
    });
    const capture: CoverageCapture = { v: 1, files: found.sort(compareFiles) };
    if (payload.incomplete || found.length < own.length) capture.incomplete = true;
    out.set(row.id, capture);
  }
  return out;
}

/** The executable lines of one version of a file, as the run coverages naming that version recorded them. */
export interface FileExecutableLines {
  path: string;
  runtime: CoverageRuntime;
  blob: string;
  lines: LineRange[];
}

/** What one version of a file holds: its executable lines and every function known in it, run or not. */
export interface FileVersion {
  path: string;
  runtime: CoverageRuntime;
  blob: string;
  lines: LineRange[];
  functions: LineRange[];
}

const versionKey = (v: { runtime: string; path: string; blob: string }) => `${v.runtime}\x00${v.path}\x00${v.blob}`;

/**
 * The stored versions of the given files (`coverage_executable`), per runtime,
 * path and blob; a version no run coverage named is left out.
 */
export async function getFileVersions(
  db: DrizzleDB,
  projectId: number,
  versions: Array<{ path: string; runtime: CoverageRuntime; blob: string }>,
): Promise<FileVersion[]> {
  if (versions.length === 0) return [];
  const wanted = new Set(versions.map(versionKey));
  const paths = [...new Set(versions.map((v) => v.path))];
  const out: FileVersion[] = [];
  for (let i = 0; i < paths.length; i += ID_CHUNK) {
    const rows = await db
      .select({
        runtime: coverageExecutable.runtime,
        path: coverageExecutable.path,
        blob: coverageExecutable.blob,
        lines: coverageExecutable.lines,
        functions: coverageExecutable.functions,
      })
      .from(coverageExecutable)
      .where(
        and(
          eq(coverageExecutable.projectId, projectId),
          inArray(coverageExecutable.path, paths.slice(i, i + ID_CHUNK)),
        ),
      );
    for (const row of rows) {
      if (!wanted.has(versionKey(row))) continue;
      out.push({
        path: row.path,
        runtime: asRuntime(row.runtime),
        blob: row.blob,
        lines: decodeLineRanges(row.lines),
        functions: decodeFunctionRanges(row.functions),
      });
    }
  }
  return out.sort((x, y) => compareFiles(x, y) || (x.blob < y.blob ? -1 : x.blob > y.blob ? 1 : 0));
}

/**
 * Store what file versions hold, united with what is stored: the shards and
 * backends of a run each name the lines of the modules they load, and a
 * browser run lists more of a script's functions as more of it runs. Returns
 * how many rows changed.
 */
export async function storeFileVersions(db: DrizzleDB, projectId: number, versions: FileVersion[]): Promise<number> {
  const incoming = new Map<string, FileVersion>();
  for (const v of versions) {
    if (v.lines.length === 0 && v.functions.length === 0) continue;
    const key = versionKey(v);
    const known = incoming.get(key);
    incoming.set(
      key,
      known
        ? {
            ...known,
            lines: normalizeLineRanges([...known.lines, ...v.lines]),
            functions: normalizeFunctionRanges([...known.functions, ...v.functions]),
          }
        : v,
    );
  }
  if (incoming.size === 0) return 0;
  const stored = new Map((await getFileVersions(db, projectId, [...incoming.values()])).map((v) => [versionKey(v), v]));
  const rows: Array<typeof coverageExecutable.$inferInsert> = [];
  const now = new Date();
  for (const [key, v] of incoming) {
    const known = stored.get(key);
    const lines = normalizeLineRanges([...(known?.lines ?? []), ...v.lines]);
    const functions = normalizeFunctionRanges([...(known?.functions ?? []), ...v.functions]);
    if (
      known &&
      encodeLineRanges(known.lines) === encodeLineRanges(lines) &&
      encodeLineRanges(known.functions) === encodeLineRanges(functions)
    ) {
      continue;
    }
    rows.push({
      projectId,
      runtime: v.runtime,
      path: v.path,
      blob: v.blob,
      lines: lines.length > 0 ? encodeLineRanges(lines) : null,
      functions: functions.length > 0 ? encodeLineRanges(functions) : null,
      createdAt: now,
    });
  }
  for (let i = 0; i < rows.length; i += ROW_CHUNK) {
    await db
      .insert(coverageExecutable)
      .values(rows.slice(i, i + ROW_CHUNK))
      .onConflictDoUpdate({
        target: [
          coverageExecutable.projectId,
          coverageExecutable.runtime,
          coverageExecutable.path,
          coverageExecutable.blob,
        ],
        set: { lines: sql`excluded.lines`, functions: sql`excluded.functions` },
      });
  }
  return rows.length;
}

/** The coverage of one file on a branch, and the tests that recorded it. */
export interface FileCoverage {
  file: string;
  branch: string;
  /** Each distinct coverage of the file the tests in view recorded; `tests` are positions in `tests`. */
  fragments: Array<CoverageFile & { tests: number[] }>;
  tests: LocatorIndexTest[];
  /** The executable lines of each version of the file the fragments name, where a run's coverage recorded them. */
  executable: FileExecutableLines[];
}

/**
 * The executable lines of the given versions of a file, per runtime, path and
 * blob. A file version's executable lines depend on its content alone, so any
 * branch's run answers.
 */
export async function getExecutableLines(
  db: DrizzleDB,
  projectId: number,
  versions: Array<{ path: string; runtime: CoverageRuntime; blob: string }>,
): Promise<FileExecutableLines[]> {
  return (await getFileVersions(db, projectId, versions))
    .filter((v) => v.lines.length > 0)
    .map(({ path, runtime, blob, lines }) => ({ path, runtime, blob, lines }));
}

/**
 * The coverage of one file on a branch: per runtime, a test with rows on the
 * branch reads them, the others the default branch's. `file` matches a stored
 * path, else a path it is a suffix of or that is a suffix of it (`itemsOfFile`).
 */
export async function getFileCoverage(
  db: DrizzleDB,
  projectId: number,
  file: string,
  branch?: string | null,
): Promise<FileCoverage> {
  const view = await resolveBranchView(db, projectId, branch);
  const answer: FileCoverage = {
    file,
    branch: view.name ?? view.defaultBranch,
    fragments: [],
    tests: [],
    executable: [],
  };
  const tag = view.tag ?? '';
  const candidates = await db
    .select({
      id: coverageFragments.id,
      runtime: coverageFragments.runtime,
      path: coverageFragments.path,
      blob: coverageFragments.blob,
      functions: coverageFragments.functions,
      lines: coverageFragments.lines,
    })
    .from(coverageFragments)
    .where(and(eq(coverageFragments.projectId, projectId), sameBaseName(coverageFragments.path, file)));
  const fragments = itemsOfFile(candidates, file);
  if (fragments.length === 0) return answer;

  const branches = tag === '' ? [''] : ['', tag];
  const rows: Array<{ testCaseId: number; fragmentId: number; branch: string; runtime: string }> = [];
  const fragmentIds = fragments.map((f) => f.id);
  for (let i = 0; i < fragmentIds.length; i += ID_CHUNK) {
    rows.push(
      ...(await db
        .select({
          testCaseId: testCoverage.testCaseId,
          fragmentId: testCoverage.fragmentId,
          branch: testCoverage.branch,
          runtime: testCoverage.runtime,
        })
        .from(testCoverage)
        .where(
          and(
            inArray(testCoverage.fragmentId, fragmentIds.slice(i, i + ID_CHUNK)),
            inArray(testCoverage.branch, branches),
          ),
        )),
    );
  }
  // A test with rows of its own on the branch in a runtime reads only those in that runtime.
  const onBranch = new Set<string>();
  if (tag !== '') {
    const own = await db
      .selectDistinct({ testCaseId: testCoverage.testCaseId, runtime: testCoverage.runtime })
      .from(testCoverage)
      .where(and(eq(testCoverage.projectId, projectId), eq(testCoverage.branch, tag)));
    for (const r of own) onBranch.add(`${r.testCaseId}\x00${r.runtime}`);
  }
  const testsOf = new Map<number, Set<number>>();
  for (const r of rows) {
    if (r.branch !== tag && onBranch.has(`${r.testCaseId}\x00${r.runtime}`)) continue;
    testsOf.set(r.fragmentId, (testsOf.get(r.fragmentId) ?? new Set()).add(r.testCaseId));
  }
  if (testsOf.size === 0) return answer;

  const tests = (await indexTests(db, [...new Set([...testsOf.values()].flatMap((ids) => [...ids]))], view)).sort(
    (a, b) => a.file.localeCompare(b.file) || a.title.localeCompare(b.title) || a.id - b.id,
  );
  const position = new Map(tests.map((t, i) => [t.id, i]));
  answer.tests = tests;
  answer.fragments = fragments
    .filter((f) => testsOf.has(f.id))
    .map((f) => ({
      fragment: f,
      file: fragmentFile(f),
      tests: [...testsOf.get(f.id)!]
        .filter((id) => position.has(id))
        .map((id) => position.get(id)!)
        .sort((a, b) => a - b),
    }))
    .sort((a, b) => compareFiles(a.file, b.file) || a.fragment.id - b.fragment.id)
    .map(({ file: covered, tests: positions }) => ({ ...covered, tests: positions }));
  answer.executable = await getExecutableLines(
    db,
    projectId,
    answer.fragments.flatMap((f) => (f.blob ? [{ path: f.path, runtime: f.runtime, blob: f.blob }] : [])),
  );
  return answer;
}

/**
 * One file of a run's coverage: a coverage file with, for server files, the
 * executable line ranges, and every function known in the file, run or not
 * (the browser's, at `coverage.browser: 'functions'`).
 */
export interface RunCoverageFile extends CoverageFile {
  executable?: LineRange[];
  allFunctions?: LineRange[];
}

/** Ranges of untrusted input, or none past {@link MAX_COVERAGE_RANGES}. */
function cappedRanges(ranges: LineRange[]): LineRange[] {
  return ranges.length > MAX_COVERAGE_RANGES ? [] : ranges;
}

/** A run coverage file without its empty fields; the blob is kept only with line numbers. */
function runFileEntry(
  path: string,
  runtime: CoverageRuntime,
  blob: string | undefined,
  functions: LineRange[],
  lines: LineRange[],
  executable: LineRange[] = [],
  allFunctions: LineRange[] = [],
): RunCoverageFile {
  const file: RunCoverageFile = { path, runtime };
  if (blob && (functions.length > 0 || lines.length > 0 || executable.length > 0 || allFunctions.length > 0)) {
    file.blob = blob;
  }
  if (functions.length > 0) file.functions = functions;
  if (lines.length > 0) file.lines = lines;
  if (executable.length > 0) file.executable = executable;
  if (allFunctions.length > 0) file.allFunctions = allFunctions;
  return file;
}

/** Two run coverage files of the same runtime and path, united; a blob they disagree on is dropped. */
function mergeRunFiles(a: RunCoverageFile, b: RunCoverageFile): RunCoverageFile {
  const merged = mergeCoverage({ v: 1, files: [a] }, { v: 1, files: [b] })!.files[0]!;
  const blobs = new Set([a.blob, b.blob].filter((blob): blob is string => !!blob));
  return runFileEntry(
    a.path,
    a.runtime,
    blobs.size === 1 ? [...blobs][0] : undefined,
    merged.functions ?? [],
    merged.lines ?? [],
    normalizeLineRanges([...(a.executable ?? []), ...(b.executable ?? [])]),
    normalizeFunctionRanges([...(a.allFunctions ?? []), ...(b.allFunctions ?? [])]),
  );
}

/**
 * The files of a run coverage request (`{ v: 1, files: [...] }`), cleaned like
 * `sanitizeCoverage` cleans a test's: invalid paths and runtimes dropped,
 * ranges normalized, entries of the same runtime and path merged. A file's
 * function, line, executable or known function ranges past
 * {@link MAX_COVERAGE_RANGES} are dropped. An error message when the body is
 * not one.
 */
export function parseRunCoverage(body: unknown): RunCoverageFile[] | string {
  if (!isRecord(body) || body.v !== 1 || !Array.isArray(body.files)) {
    return 'Expected { "v": 1, "files": [...] }';
  }
  if (body.files.length > MAX_RUN_COVERAGE_FILES) return `At most ${MAX_RUN_COVERAGE_FILES} files per request`;
  const files = new Map<string, RunCoverageFile>();
  for (const item of body.files) {
    if (!isRecord(item) || (item.runtime !== 'browser' && item.runtime !== 'server')) continue;
    const path = normalizeCoveragePath(item.path);
    if (path === null) continue;
    const file = runFileEntry(
      path,
      item.runtime,
      typeof item.blob === 'string' && BLOB_ID.test(item.blob) ? item.blob : undefined,
      cappedRanges(normalizeFunctionRanges(item.functions)),
      cappedRanges(normalizeLineRanges(item.lines)),
      cappedRanges(normalizeLineRanges(item.executable)),
      cappedRanges(normalizeFunctionRanges(item.allFunctions)),
    );
    const key = `${file.runtime}\x00${file.path}`;
    const known = files.get(key);
    files.set(key, known ? mergeRunFiles(known, file) : file);
  }
  return [...files.values()].sort(compareFiles);
}

/** A run's coverage as `GET /api/test-runs/:id/coverage` answers it. */
export interface RunCoverage {
  runId: number;
  /** The run's executions that recorded coverage of their own. */
  executionsWithCoverage: number;
  /** The files of the run's coverage per runtime, whatever `file` and `limit` keep. */
  fileCounts: Record<CoverageRuntime, number>;
  /** The run's coverage per file, sorted by path then runtime: those matching `file`, at most `limit`. */
  files: RunCoverageFile[];
}

/**
 * The run's files with what their versions hold: the executable lines of each
 * file with a blob, and every function known in it, from `coverage_executable`,
 * or from the row itself for a run stored before versions were.
 */
async function withFileVersions(
  db: DrizzleDB,
  projectId: number,
  files: RunCoverageFile[],
): Promise<RunCoverageFile[]> {
  const versions = await getFileVersions(
    db,
    projectId,
    files.flatMap((f) => (f.blob ? [{ path: f.path, runtime: f.runtime, blob: f.blob }] : [])),
  );
  const byKey = new Map(versions.map((v) => [versionKey(v), v]));
  return files.map((file) => {
    const version = file.blob ? byKey.get(versionKey({ ...file, blob: file.blob })) : undefined;
    return runFileEntry(
      file.path,
      file.runtime,
      file.blob,
      file.functions ?? [],
      file.lines ?? [],
      version && file.runtime === 'server' ? version.lines : (file.executable ?? []),
      version?.functions ?? file.allFunctions ?? [],
    );
  });
}

/**
 * A run's coverage, attributed to no test (`run_coverage`): every file, or
 * those whose path matches `file` (`itemsOfFile`), at most `limit`; with the
 * number of the run's executions that recorded coverage of their own. Null
 * when there is no such run.
 */
export async function getRunCoverage(
  db: DrizzleDB,
  runId: number,
  opts: { file?: string | null; limit?: number } = {},
): Promise<RunCoverage | null> {
  const [run] = await db
    .select({ id: testRuns.id, projectId: testRuns.projectId })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  if (!run) return null;
  const [withCoverage, counted, rows] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)` })
      .from(testRunsCases)
      .where(and(eq(testRunsCases.testRunId, runId), sql`${testRunsCases.coveragePayloadId} IS NOT NULL`)),
    db
      .select({ runtime: runCoverage.runtime, n: sql<number>`count(*)` })
      .from(runCoverage)
      .where(eq(runCoverage.runId, runId))
      .groupBy(runCoverage.runtime),
    opts.limit === 0
      ? Promise.resolve([])
      : db
          .select({
            runtime: runCoverage.runtime,
            path: runCoverage.path,
            blob: runCoverage.blob,
            functions: runCoverage.functions,
            lines: runCoverage.lines,
            executable: runCoverage.executable,
          })
          .from(runCoverage)
          .where(
            opts.file
              ? and(eq(runCoverage.runId, runId), sameBaseName(runCoverage.path, opts.file))
              : eq(runCoverage.runId, runId),
          ),
  ]);
  const fileCounts: Record<CoverageRuntime, number> = { browser: 0, server: 0 };
  for (const row of counted) fileCounts[asRuntime(row.runtime)] += Number(row.n);
  // The blob is kept until what the version holds is read: a file nothing ran names its version only.
  const files: RunCoverageFile[] = (opts.file ? itemsOfFile(rows, opts.file) : rows)
    .map((row) => ({
      path: row.path,
      runtime: asRuntime(row.runtime),
      ...(row.blob ? { blob: row.blob } : {}),
      functions: decodeFunctionRanges(row.functions),
      lines: decodeLineRanges(row.lines),
      executable: decodeLineRanges(row.executable),
    }))
    .sort(compareFiles);
  const kept = opts.limit != null ? files.slice(0, opts.limit) : files;
  return {
    runId,
    executionsWithCoverage: Number(withCoverage[0]?.n ?? 0),
    fileCounts,
    files: await withFileVersions(db, run.projectId, kept),
  };
}

const runLocks = new Map<number, Promise<unknown>>();

/** Run `fn` after every earlier call for the same key has finished, within this server process. */
export async function withCoverageLock<K, T>(
  locks: Map<K, Promise<unknown>>,
  key: K,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  const run = prior.then(
    () => fn(),
    () => fn(),
  );
  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}

/**
 * Merge files into a run's coverage: per runtime and path, the union of what
 * the run already holds and the new file. What a file's version holds (its
 * executable lines, every function known in it) goes to `coverage_executable`,
 * once per version, united. Returns how many files were written.
 */
export async function storeRunCoverage(
  db: DrizzleDB,
  runId: number,
  projectId: number,
  files: RunCoverageFile[],
): Promise<number> {
  if (files.length === 0) return 0;
  await storeFileVersions(
    db,
    projectId,
    files.flatMap((f) =>
      f.blob && (f.executable?.length || f.allFunctions?.length)
        ? [
            {
              path: f.path,
              runtime: f.runtime,
              blob: f.blob,
              lines: f.runtime === 'server' ? (f.executable ?? []) : [],
              functions: f.allFunctions ?? [],
            },
          ]
        : [],
    ),
  );
  return withCoverageLock(runLocks, runId, async () => {
    const stored = new Map<string, RunCoverageFile>();
    const paths = [...new Set(files.map((f) => f.path))];
    for (let i = 0; i < paths.length; i += ID_CHUNK) {
      const rows = await db
        .select({
          runtime: runCoverage.runtime,
          path: runCoverage.path,
          blob: runCoverage.blob,
          functions: runCoverage.functions,
          lines: runCoverage.lines,
        })
        .from(runCoverage)
        .where(and(eq(runCoverage.runId, runId), inArray(runCoverage.path, paths.slice(i, i + ID_CHUNK))));
      for (const r of rows) {
        const runtime = asRuntime(r.runtime);
        stored.set(
          `${runtime}\x00${r.path}`,
          runFileEntry(
            r.path,
            runtime,
            r.blob ?? undefined,
            decodeFunctionRanges(r.functions),
            decodeLineRanges(r.lines),
          ),
        );
      }
    }
    const rows = files.map((file) => {
      // The blob stays with a file that names only what its version holds, so its row says which version ran nothing.
      const own = runFileEntry(
        file.path,
        file.runtime,
        file.blob,
        file.functions ?? [],
        file.lines ?? [],
        file.executable ?? [],
        file.allFunctions ?? [],
      );
      const known = stored.get(`${file.runtime}\x00${file.path}`);
      const merged = known ? mergeRunFiles(known, own) : own;
      return {
        runId,
        projectId,
        runtime: merged.runtime,
        path: merged.path,
        blob: merged.blob ?? null,
        functions: merged.functions ? encodeLineRanges(merged.functions) : null,
        lines: merged.lines ? encodeLineRanges(merged.lines) : null,
        executable: null,
      };
    });
    for (let i = 0; i < rows.length; i += ROW_CHUNK) {
      await db
        .insert(runCoverage)
        .values(rows.slice(i, i + ROW_CHUNK))
        .onConflictDoUpdate({
          target: [runCoverage.runId, runCoverage.runtime, runCoverage.path],
          set: {
            blob: sql`excluded.blob`,
            functions: sql`excluded.functions`,
            lines: sql`excluded.lines`,
            executable: sql`excluded.executable`,
          },
        });
    }
    return rows.length;
  });
}

/**
 * The fragments nothing references any more, as a condition on
 * `coverage_fragments`: no `test_coverage` row and no coverage report file
 * references the fragment, and it
 * was last seen before the oldest run its project keeps was created (or the
 * project keeps no run). A fragment's `last_seen_at` moves forward on every
 * ingest that references it, and every execution belongs to a run created
 * before it was ingested, so no remaining execution's payload can name such a
 * fragment. The hour gate spares the fragments of an ingest in flight.
 */
export function unreferencedFragments(now: Date = new Date()): SQL {
  return and(
    lt(coverageFragments.lastSeenAt, new Date(now.getTime() - HOUR_MS)),
    sql`NOT EXISTS (SELECT 1 FROM ${testCoverage} WHERE ${testCoverage.fragmentId} = ${coverageFragments.id})`,
    sql`NOT EXISTS (SELECT 1 FROM ${coverageReportFiles} WHERE ${coverageReportFiles.fragmentId} = ${coverageFragments.id})`,
    sql`(NOT EXISTS (SELECT 1 FROM ${testRuns} WHERE ${testRuns.projectId} = ${coverageFragments.projectId})
      OR ${coverageFragments.lastSeenAt} < (SELECT min(${testRuns.createdAt}) FROM ${testRuns} WHERE ${testRuns.projectId} = ${coverageFragments.projectId}))`,
  )!;
}

/**
 * Delete a branch's `code_reach` and `test_coverage` rows and its coverage
 * reports, for a branch whose pull request closed or merged. Returns how many
 * rows went.
 */
export async function deleteBranchCoverageRows(db: DrizzleDB, projectId: number, branch: string): Promise<number> {
  if (!branch) return 0;
  const reach = await db
    .delete(codeReach)
    .where(and(eq(codeReach.projectId, projectId), eq(codeReach.branch, branch)))
    .returning({ id: codeReach.id });
  const coverage = await db
    .delete(testCoverage)
    .where(and(eq(testCoverage.projectId, projectId), eq(testCoverage.branch, branch)))
    .returning({ id: testCoverage.id });
  const reports = await db
    .delete(coverageReports)
    .where(and(eq(coverageReports.projectId, projectId), eq(coverageReports.branch, branch)))
    .returning({ id: coverageReports.id });
  return reach.length + coverage.length + reports.length;
}

/**
 * Delete the branch-tagged `code_reach` and `test_coverage` rows last seen more
 * than thirty days ago; the default branch's rows ('' branch) stay. Returns how
 * many rows went.
 */
export async function pruneStaleBranchCoverageRows(db: DrizzleDB, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - BRANCH_ROW_MAX_AGE_MS);
  const reach = await db
    .delete(codeReach)
    .where(and(ne(codeReach.branch, ''), lt(codeReach.lastSeenAt, cutoff)))
    .returning({ id: codeReach.id });
  const coverage = await db
    .delete(testCoverage)
    .where(and(ne(testCoverage.branch, ''), lt(testCoverage.lastSeenAt, cutoff)))
    .returning({ id: testCoverage.id });
  return reach.length + coverage.length;
}

/**
 * The `path` and `blob` of a read of a file's source at a blob
 * (`GET /api/projects/:id/source`), checked; an error message when one is not
 * valid.
 */
export function parseSourceQuery(path: unknown, blob: unknown): { path: string; blob: string } | { error: string } {
  const file = normalizeCoveragePath(typeof path === 'string' ? path.trim() : '');
  if (!file || file.split('/').includes('..')) {
    return { error: 'path must be a repository-relative path (at most 500 characters)' };
  }
  const id = typeof blob === 'string' ? blob.trim() : '';
  if (!isGitObjectId(id)) return { error: 'blob must be a git object id' };
  return { path: file, blob: id };
}

/**
 * The `file` and `limit` of a read of a run's coverage
 * (`GET /api/test-runs/:id/coverage`), checked: a present `limit` that is no
 * integer is an error, any other clamped to `0` to {@link MAX_RUN_COVERAGE_FILES}.
 */
export function parseRunCoverageQuery(
  file: unknown,
  limit: unknown,
): { file: string | null; limit: number | undefined } | { error: string } {
  const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);
  file = first(file);
  limit = first(limit);
  const path = typeof file === 'string' && file.trim() ? file.trim() : null;
  if (path && path.length > 500) return { error: 'file is at most 500 characters' };
  const raw = typeof limit === 'string' ? limit.trim() : '';
  if (!raw) return { file: path, limit: undefined };
  const n = Number(raw);
  if (!Number.isInteger(n)) return { error: 'Invalid query parameter "limit": expected an integer' };
  return { file: path, limit: Math.min(Math.max(n, 0), MAX_RUN_COVERAGE_FILES) };
}
