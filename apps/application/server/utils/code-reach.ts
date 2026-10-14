/**
 * Code reach on the server: the application source files each test executed.
 *
 * Every reach has a runtime (where the file's code ran, `browser` or `server`)
 * and a `via` (how it is known):
 * - `coverage`: measured. Stored in `code_reach`, one row per (test case,
 *   branch, runtime, file): the files of the test's coverage, or the files of
 *   its `codeReach` list (browser) when the execution sent no coverage. Per
 *   runtime, a test's rows on a branch hold the files of every execution of its
 *   latest run there (browser projects, retries, ingest batches), and replace
 *   the rows of older runs. A run without them leaves them as they are, so a
 *   nightly sample serves the whole day.
 * - `route`: inferred, on the server: the handler files of the routes the test
 *   reached, read from the Test Map's `reaches` and `handled-by` edges when
 *   asked, so an instrumented backend gets reach with no coverage of its own.
 *
 * `origin` names the same answer in fewer words: `client` for browser coverage,
 * `server` for any server reach.
 */
import { and, desc, eq, inArray, isNull, ne, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { finalizeCodeReach } from '@piwitests/core/code-reach';
import type { CoverageRuntime } from '@piwitests/core/coverage';
import { sameFilePath } from '@piwitests/core/locator-break';
import type { LocatorIndexTest } from '@piwitests/core/locator-index';
import { codeReach, graphEdges, testRuns } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { handlerNodeKey, testEndpointKey } from '#shared/graph';
import { indexTests, locatorBranchTag, resolveBranchView } from './locator-usages';
import { projectDefaultBranch } from './scm/stored-default-branch';

/** Longest path accepted in a code reach list. */
const MAX_PATH_LENGTH = 500;
const INSERT_CHUNK = 500;
/** Files and tests in the code index at most. */
const MAX_INDEX_FILES = 20_000;

export type CodeReachOrigin = 'client' | 'server';
/** How a reach is known: measured by coverage, or inferred from the routes a test called. */
export type CodeReachVia = 'coverage' | 'route';

/** How a test reaches a file. */
export interface ReachKind {
  runtime: CoverageRuntime;
  via: CodeReachVia;
  /** `client` for browser coverage, `server` for any server reach. */
  origin: CodeReachOrigin;
}

/** The kinds of reach, in the order answers list them and prefer them. */
const REACH_KINDS: ReachKind[] = [
  { runtime: 'browser', via: 'coverage', origin: 'client' },
  { runtime: 'server', via: 'coverage', origin: 'server' },
  { runtime: 'server', via: 'route', origin: 'server' },
];

function reachRank(runtime: CoverageRuntime, via: CodeReachVia): number {
  return REACH_KINDS.findIndex((k) => k.runtime === runtime && k.via === via);
}

/** A stored runtime value, read as a runtime. */
export function asRuntime(value: string): CoverageRuntime {
  return value === 'server' ? 'server' : 'browser';
}

/** The `origin` of a reach measured in a runtime. */
export function reachOrigin(runtime: CoverageRuntime): CodeReachOrigin {
  return runtime === 'browser' ? 'client' : 'server';
}

/** A test's `codeReach` field, cleaned: repository-relative paths, sorted, capped; null when absent or malformed. */
export function sanitizeCodeReach(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const files = raw.filter(
    (f): f is string => typeof f === 'string' && f.length > 0 && f.length <= MAX_PATH_LENGTH && !f.includes('\0'),
  );
  return finalizeCodeReach(files);
}

/** One execution's code reach in one runtime, as ingest hands it over. */
export interface CodeReachCase {
  testCaseId: number;
  runId: number;
  /** Where the files' code ran; `browser` when absent. */
  runtime?: CoverageRuntime;
  files: string[];
}

/** What a caller that has already read it hands {@link upsertCodeReach}, which reads the rest itself. */
export interface CodeReachLookups {
  /** The start and branch of every run the cases belong to. */
  runs?: Map<number, { startedAt: Date; branch: string | null }>;
  /** The project's stored default branch, resolved by the caller at most once. */
  defaultBranch?: () => Promise<string>;
}

/** One execution's items in one runtime, as {@link latestRunScopes} takes them. */
export interface RunItems<T> {
  testCaseId: number;
  runId: number;
  runtime: CoverageRuntime;
  items: Iterable<T>;
}

/** The items of one (test case, branch, runtime) from the latest run of a batch. */
export interface LatestRunScope<T> {
  testCaseId: number;
  runId: number;
  runtime: CoverageRuntime;
  /** The run's branch as stored: '' for the default branch. */
  tag: string;
  startedAt: Date;
  items: Set<T>;
}

/** The columns of a table holding latest-run rows per (test case, branch, runtime). */
export interface LatestRunRows {
  table: SQLiteTable;
  testCaseId: SQLiteColumn;
  branch: SQLiteColumn;
  runtime: SQLiteColumn;
  lastSeenRunId: SQLiteColumn;
  lastSeenAt: SQLiteColumn;
}

const CODE_REACH_ROWS: LatestRunRows = {
  table: codeReach,
  testCaseId: codeReach.testCaseId,
  branch: codeReach.branch,
  runtime: codeReach.runtime,
  lastSeenRunId: codeReach.lastSeenRunId,
  lastSeenAt: codeReach.lastSeenAt,
};

function scopeKey(testCaseId: number, tag: string, runtime: string): string {
  return `${testCaseId}\x00${tag}\x00${runtime}`;
}

/**
 * Per (test case, branch, runtime) in a batch: the latest run, and the items
 * of all its executions merged.
 */
export async function latestRunScopes<T>(
  db: DrizzleDB,
  projectId: number,
  cases: Array<RunItems<T>>,
  known: CodeReachLookups = {},
): Promise<Array<LatestRunScope<T>>> {
  if (cases.length === 0) return [];
  let runs = known.runs;
  if (!runs) {
    runs = new Map();
    const runIds = [...new Set(cases.map((c) => c.runId))];
    for (let i = 0; i < runIds.length; i += INSERT_CHUNK) {
      const rows = await db
        .select({ id: testRuns.id, startTime: testRuns.startTime, branch: testRuns.branch })
        .from(testRuns)
        .where(inArray(testRuns.id, runIds.slice(i, i + INSERT_CHUNK)));
      for (const r of rows) runs.set(r.id, { startedAt: new Date(r.startTime), branch: r.branch });
    }
  }
  const branched = [...runs.values()].some((r) => r.branch);
  const defaultBranch = branched ? await (known.defaultBranch?.() ?? projectDefaultBranch(db, projectId)) : null;

  const latest = new Map<string, LatestRunScope<T>>();
  for (const c of cases) {
    const run = runs.get(c.runId);
    if (!run) continue;
    const tag = locatorBranchTag(run.branch, defaultBranch);
    const key = scopeKey(c.testCaseId, tag, c.runtime);
    const current = latest.get(key);
    if (current && current.runId === c.runId) {
      for (const item of c.items) current.items.add(item);
    } else if (
      !current ||
      run.startedAt > current.startedAt ||
      (+run.startedAt === +current.startedAt && c.runId > current.runId)
    ) {
      latest.set(key, {
        testCaseId: c.testCaseId,
        runId: c.runId,
        runtime: c.runtime,
        tag,
        startedAt: run.startedAt,
        items: new Set(c.items),
      });
    }
  }
  return [...latest.values()];
}

/**
 * The scopes a batch replaces, after deleting their rows of other runs: a
 * scope whose stored rows are newer than the batch's run (an imported old
 * report) is left out and keeps its rows. Rows of the batch's own run (another
 * browser project, a retry, an earlier batch) stay and are merged into.
 */
export async function claimLatestRunScopes<T>(
  db: DrizzleDB,
  rows: LatestRunRows,
  scopes: Array<LatestRunScope<T>>,
): Promise<Array<LatestRunScope<T>>> {
  if (scopes.length === 0) return [];
  const testIds = [...new Set(scopes.map((s) => s.testCaseId))];
  const tags = [...new Set(scopes.map((s) => s.tag))];
  const newest = new Map<string, Date>();
  for (let i = 0; i < testIds.length; i += INSERT_CHUNK) {
    // The column itself, not a raw max(): its mapping reads the timestamp as stored on either database.
    const stored = await db
      .selectDistinct({ testCaseId: rows.testCaseId, branch: rows.branch, runtime: rows.runtime, at: rows.lastSeenAt })
      .from(rows.table)
      .where(and(inArray(rows.testCaseId, testIds.slice(i, i + INSERT_CHUNK)), inArray(rows.branch, tags)));
    for (const r of stored) {
      const key = scopeKey(r.testCaseId as number, r.branch as string, r.runtime as string);
      const at = r.at as Date;
      const known = newest.get(key);
      if (!known || at > known) newest.set(key, at);
    }
  }
  const fresh = scopes.filter((s) => {
    const at = newest.get(scopeKey(s.testCaseId, s.tag, s.runtime));
    return !at || at <= s.startedAt;
  });

  const groups = new Map<string, { runId: number; tag: string; runtime: CoverageRuntime; testIds: number[] }>();
  for (const s of fresh) {
    const key = `${s.runId}\x00${s.tag}\x00${s.runtime}`;
    const group = groups.get(key) ?? { runId: s.runId, tag: s.tag, runtime: s.runtime, testIds: [] };
    group.testIds.push(s.testCaseId);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    for (let i = 0; i < group.testIds.length; i += INSERT_CHUNK) {
      await db
        .delete(rows.table)
        .where(
          and(
            inArray(rows.testCaseId, group.testIds.slice(i, i + INSERT_CHUNK)),
            eq(rows.branch, group.tag),
            eq(rows.runtime, group.runtime),
            or(isNull(rows.lastSeenRunId), ne(rows.lastSeenRunId, group.runId)),
          ),
        );
    }
  }
  return fresh;
}

/**
 * Store the code reach of a batch of executions: per test case, branch and
 * runtime, the files of every execution of the latest run are merged, and
 * replace the rows of older runs. An execution older than the rows already
 * stored (an imported old report) changes nothing.
 */
export async function upsertCodeReach(
  db: DrizzleDB,
  projectId: number,
  cases: CodeReachCase[],
  known: CodeReachLookups = {},
): Promise<void> {
  const scopes = await latestRunScopes(
    db,
    projectId,
    cases.map((c) => ({ testCaseId: c.testCaseId, runId: c.runId, runtime: c.runtime ?? 'browser', items: c.files })),
    known,
  );
  const fresh = await claimLatestRunScopes(db, CODE_REACH_ROWS, scopes);
  const rows = fresh.flatMap((s) =>
    [...s.items].map((file) => ({
      projectId,
      testCaseId: s.testCaseId,
      branch: s.tag,
      runtime: s.runtime,
      file,
      origin: reachOrigin(s.runtime),
      lastSeenRunId: s.runId,
      lastSeenAt: s.startedAt,
    })),
  );
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db
      .insert(codeReach)
      .values(rows.slice(i, i + INSERT_CHUNK))
      .onConflictDoNothing();
  }
}

/** One (test, file) pair of reach. */
export interface CodeReachPair extends ReachKind {
  testCaseId: number;
  file: string;
}

/**
 * A SQL condition keeping the paths that may name `file` under `sameFilePath`:
 * those ending in its base name. Callers apply `sameFilePath` to what is left.
 */
export function sameBaseName(column: AnyColumn, file: string): SQL {
  const normalized = file.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const suffix = `%/${base.replace(/[\\%_]/g, (c) => `\\${c}`)}`;
  return or(eq(column, base), sql`${column} LIKE ${suffix} ESCAPE '\\'`)!;
}

/**
 * Every (test, file) pair of a project on a branch: the branch's own coverage
 * rows for the tests that have some in a runtime, the default branch's for the
 * others, and the handler files of the routes each test reached. With `file`,
 * only the pairs whose file matches it (`sameFilePath`).
 */
export async function loadCodeReachPairs(
  db: DrizzleDB,
  projectId: number,
  branch?: string | null,
  file?: string,
): Promise<CodeReachPair[]> {
  const view = await resolveBranchView(db, projectId, branch);
  const tag = view.tag ?? '';
  const inView = and(eq(codeReach.projectId, projectId), inArray(codeReach.branch, tag === '' ? [''] : ['', tag]));
  const rows = await db
    .select({
      testCaseId: codeReach.testCaseId,
      file: codeReach.file,
      branch: codeReach.branch,
      runtime: codeReach.runtime,
    })
    .from(codeReach)
    .where(file === undefined ? inView : and(inView, sameBaseName(codeReach.file, file)));
  // A test with rows of its own on the branch in a runtime reads only those in that runtime, whichever files they name.
  const onBranch = new Set<string>();
  if (tag !== '') {
    const own =
      file === undefined
        ? rows.filter((r) => r.branch === tag)
        : await db
            .selectDistinct({ testCaseId: codeReach.testCaseId, runtime: codeReach.runtime })
            .from(codeReach)
            .where(and(eq(codeReach.projectId, projectId), eq(codeReach.branch, tag)));
    for (const r of own) onBranch.add(`${r.testCaseId}\x00${r.runtime}`);
  }
  const pairs: CodeReachPair[] = rows
    .filter((r) => r.branch === tag || !onBranch.has(`${r.testCaseId}\x00${r.runtime}`))
    .filter((r) => file === undefined || sameFilePath(r.file, file))
    .map((r) => {
      const runtime = asRuntime(r.runtime);
      return { testCaseId: r.testCaseId, file: r.file, runtime, via: 'coverage', origin: reachOrigin(runtime) };
    });
  pairs.push(...(await serverReachPairs(db, projectId, file)));
  return pairs;
}

/** Handler files of the routes each test reached, from the Test Map's canonical edges; with `file`, only that one. */
async function serverReachPairs(db: DrizzleDB, projectId: number, file?: string): Promise<CodeReachPair[]> {
  const handledBy = and(
    eq(graphEdges.projectId, projectId),
    eq(graphEdges.kind, 'handled-by'),
    eq(graphEdges.fromKind, 'route'),
    eq(graphEdges.toKind, 'handler'),
  );
  const handled = (
    await db
      .select({ route: graphEdges.fromKey, file: graphEdges.toKey })
      .from(graphEdges)
      .where(file === undefined ? handledBy : and(handledBy, sameBaseName(graphEdges.toKey, file)))
  ).filter((h) => file === undefined || sameFilePath(handlerNodeKey(h.file), file));
  if (handled.length === 0) return [];
  const filesOf = new Map<string, Set<string>>();
  for (const h of handled) filesOf.set(h.route, (filesOf.get(h.route) ?? new Set()).add(handlerNodeKey(h.file)));
  const reachesRoute = and(
    eq(graphEdges.projectId, projectId),
    eq(graphEdges.kind, 'reaches'),
    eq(graphEdges.fromKind, 'test'),
    eq(graphEdges.toKind, 'route'),
  );
  const routes = [...filesOf.keys()];
  const reaches: Array<{ test: string; route: string }> = [];
  if (file === undefined) {
    reaches.push(
      ...(await db.select({ test: graphEdges.fromKey, route: graphEdges.toKey }).from(graphEdges).where(reachesRoute)),
    );
  } else {
    for (let i = 0; i < routes.length; i += INSERT_CHUNK) {
      reaches.push(
        ...(await db
          .select({ test: graphEdges.fromKey, route: graphEdges.toKey })
          .from(graphEdges)
          .where(and(reachesRoute, inArray(graphEdges.toKey, routes.slice(i, i + INSERT_CHUNK))))),
      );
    }
  }
  const out = new Map<string, CodeReachPair>();
  for (const r of reaches) {
    const testCaseId = Number(r.test);
    if (!Number.isInteger(testCaseId)) continue;
    for (const f of filesOf.get(r.route) ?? []) {
      out.set(`${testCaseId}\x00${f}`, { testCaseId, file: f, runtime: 'server', via: 'route', origin: 'server' });
    }
  }
  return [...out.values()];
}

/** The tests that reach a file (suffix match), with how. */
export interface FileReach {
  file: string;
  branch: string;
  /** Each test once, with the first way it reaches the file: browser coverage, server coverage, then a route. */
  tests: Array<LocatorIndexTest & ReachKind>;
}

/** Which tests reach one file on a branch. */
export async function getCodeReachForFile(
  db: DrizzleDB,
  projectId: number,
  file: string,
  branch?: string | null,
): Promise<FileReach> {
  const view = await resolveBranchView(db, projectId, branch);
  const pairs = await loadCodeReachPairs(db, projectId, branch, file);
  const rankOf = new Map<number, number>();
  for (const p of pairs) {
    const rank = reachRank(p.runtime, p.via);
    const known = rankOf.get(p.testCaseId);
    if (known === undefined || rank < known) rankOf.set(p.testCaseId, rank);
  }
  const tests = await indexTests(db, [...rankOf.keys()], view);
  return {
    file,
    branch: view.name ?? view.defaultBranch,
    tests: tests
      .map((t) => ({ ...t, ...REACH_KINDS[rankOf.get(t.id)!]! }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.title.localeCompare(b.title)),
  };
}

/** The whole map of a branch, for editors. */
export interface CodeIndex {
  projectId: number;
  branch: string;
  files: string[];
  tests: LocatorIndexTest[];
  /** Per file (a position in `files`) and kind of reach, the tests reaching it (positions in `tests`). */
  reach: Array<{ file: number; tests: number[] } & ReachKind>;
  /** When the newest coverage row was recorded; null when none was. */
  builtAt: string | null;
  truncated: boolean;
}

/** The code index of a project on a branch. */
export async function getCodeIndex(db: DrizzleDB, projectId: number, branch?: string | null): Promise<CodeIndex> {
  const view = await resolveBranchView(db, projectId, branch);
  const pairs = await loadCodeReachPairs(db, projectId, branch);
  // Per file, the tests of each kind of reach, by position in REACH_KINDS.
  const byFile = new Map<string, Array<Set<number>>>();
  for (const p of pairs) {
    const kinds = byFile.get(p.file) ?? REACH_KINDS.map(() => new Set<number>());
    kinds[reachRank(p.runtime, p.via)]!.add(p.testCaseId);
    byFile.set(p.file, kinds);
  }
  const files = [...byFile.keys()].sort();
  const truncated = files.length > MAX_INDEX_FILES;
  const kept = files.slice(0, MAX_INDEX_FILES);
  const testIds = [...new Set(kept.flatMap((f) => byFile.get(f)!.flatMap((ids) => [...ids])))];
  const tests = await indexTests(db, testIds, view);
  const position = new Map(tests.map((t, i) => [t.id, i]));
  const reach: CodeIndex['reach'] = [];
  kept.forEach((file, i) => {
    byFile.get(file)!.forEach((kindIds, rank) => {
      const ids = [...kindIds].filter((id) => position.has(id)).map((id) => position.get(id)!);
      if (ids.length) reach.push({ file: i, tests: ids.sort((a, b) => a - b), ...REACH_KINDS[rank]! });
    });
  });
  const [newest] = await db
    .select({ at: codeReach.lastSeenAt })
    .from(codeReach)
    .where(eq(codeReach.projectId, projectId))
    .orderBy(desc(codeReach.lastSeenAt))
    .limit(1);
  return {
    projectId,
    branch: view.name ?? view.defaultBranch,
    files: kept,
    tests,
    reach,
    builtAt: newest?.at ? newest.at.toISOString() : null,
    truncated,
  };
}

/** The graph specs of code reach: `file` nodes with origin `coverage` and `reaches` edges from each test. */
export function buildCodeReachGraph(cases: Array<{ testCaseId: number; files: string[] }>) {
  const nodes = new Map<string, { kind: 'file'; key: string; origin: 'coverage' }>();
  const edges: Array<{
    fromKind: 'test';
    fromKey: string;
    toKind: 'file';
    toKey: string;
    kind: 'reaches';
    origin: 'coverage';
    confidence: number;
  }> = [];
  for (const c of cases) {
    for (const file of c.files) {
      const key = handlerNodeKey(file);
      nodes.set(key, { kind: 'file', key, origin: 'coverage' });
      edges.push({
        fromKind: 'test',
        fromKey: testEndpointKey(c.testCaseId),
        toKind: 'file',
        toKey: key,
        kind: 'reaches',
        origin: 'coverage',
        confidence: 1,
      });
    }
  }
  return { nodes: [...nodes.values()], edges };
}
