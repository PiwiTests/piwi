/**
 * Test selections — resolving a declarative definition against a project's test
 * catalog, and the CRUD behind the stored definitions.
 *
 * Resolution is computed, never stored: the catalog is loaded once, predicates
 * are evaluated in memory (a project's test set is bounded, and OR-ed groups are
 * far clearer as plain code than as generated SQL), then pins, a budget and a
 * limit are applied in that order. The only persisted trace of a resolution is
 * the stamp on the runs it produces.
 */
import { and, eq, sql } from 'drizzle-orm';
import { testCases, testRunsCases, testSelections } from '../../server/database/schema';
import type { DrizzleDB } from './db';
import { getQuarantinedCaseIds } from './quarantine';
import { eligibleExecutionSql } from '../run-eligibility';
import { latestRunStatusSql } from './latest-run-status';
import { foldText } from '#shared/utils/fold-text';
import {
  BUILTIN_SELECTIONS,
  getBuiltinSelection,
  isBuiltinKey,
  materializeSelection,
  MAX_FAILED_IN_LAST_RUNS,
  partitionTestsIntoShards,
  locksSpanningTests,
  validateSelectionDefinition,
  validateSelectionKey,
  type MaterializedSelection,
  type ResolvedSelection,
  type ResolvedTest,
  type Selection,
  type SelectionDefinition,
  type SelectionFormat,
  type SelectionPredicateGroup,
  type SelectionRankBy,
  type SelectionWarning,
} from '../selection';

/** One catalog row: a test plus the aggregates a predicate can test against. */
export interface CatalogRow {
  id: number;
  filePath: string;
  suitePath: string;
  title: string;
  tags: string[];
  locks: string[];
  owner: string | null;
  priority: string | null;
  feature: string | null;
  avgDurationMs: number | null;
  passRate: number | null;
  totalRuns: number;
  flaky: boolean;
  lastStatus: string | null;
  lastLine: number | null;
  quarantined: boolean;
  neverRun: boolean;
  /** Recency rank (1 = most recent) of the newest failing execution, capped; null if none. */
  firstFailRank: number | null;
}

// ── Catalog loading ──────────────────────────────────────────────────────────

/**
 * Load every test in a project with the per-case aggregates a selection reads.
 * Only executions of runs the `selection-catalog` use reads count: lab runs,
 * bisect steps and reproductions stay out of every aggregate.
 */
export async function loadSelectionCatalog(
  db: DrizzleDB,
  projectId: number,
  opts: { withFailRanks: boolean } = { withFailRanks: false },
): Promise<CatalogRow[]> {
  const passed = sql<number>`SUM(CASE WHEN ${testRunsCases.status} = 'passed' THEN 1 ELSE 0 END)`;
  const failed = sql<number>`SUM(CASE WHEN ${testRunsCases.status} IN ('failed', 'timedOut', 'timedout') THEN 1 ELSE 0 END)`;
  const recentFlaky = sql<number>`(
      SELECT COUNT(*) FROM (
        SELECT ${testRunsCases.status} AS s, ${testRunsCases.retries} AS r
        FROM ${testRunsCases}
        WHERE ${testRunsCases.testCaseId} = ${testCases.id} AND ${eligibleExecutionSql('selection-catalog', testRunsCases.testRunId)}
        ORDER BY ${testRunsCases.createdAt} DESC
        LIMIT 10
      ) AS recent WHERE s = 'passed' AND r > 0
    )`;
  // The latest run's status: failed when one of the test's repetitions failed there.
  const lastStatus = latestRunStatusSql(eligibleExecutionSql('selection-catalog', testRunsCases.testRunId));
  const lastLine = sql<number | null>`(
      SELECT ${testRunsCases.line}
      FROM ${testRunsCases}
      WHERE ${testRunsCases.testCaseId} = ${testCases.id} AND ${eligibleExecutionSql('selection-catalog', testRunsCases.testRunId)}
      ORDER BY ${testRunsCases.createdAt} DESC
      LIMIT 1
    )`;
  const passRate = sql<
    number | null
  >`CASE WHEN (${passed} + ${failed}) > 0 THEN (${passed} * 1.0) / (${passed} + ${failed}) END`;

  const rows: any[] = await db
    .select({
      id: testCases.id,
      filePath: testCases.filePath,
      suitePath: testCases.suitePath,
      title: testCases.title,
      tags: testCases.tags,
      locks: testCases.locks,
      owner: testCases.owner,
      priority: testCases.priority,
      feature: testCases.feature,
      totalRuns: sql<number>`COUNT(${testRunsCases.id})`,
      recentFlakyRuns: recentFlaky,
      passRate,
      avgDuration: sql<
        number | null
      >`AVG(CASE WHEN ${testRunsCases.status} NOT IN ('skipped', 'didnotrun') THEN ${testRunsCases.duration} END)`,
      lastStatus,
      lastLine,
    })
    .from(testCases)
    .leftJoin(
      testRunsCases,
      and(
        eq(testCases.id, testRunsCases.testCaseId),
        eligibleExecutionSql('selection-catalog', testRunsCases.testRunId),
      ),
    )
    .where(eq(testCases.projectId, projectId))
    .groupBy(testCases.id, testCases.filePath, testCases.suitePath, testCases.title);

  const quarantined = await getQuarantinedCaseIds(db, projectId);
  const failRanks = opts.withFailRanks ? await loadRecentFailRanks(db, projectId) : new Map<number, number>();

  return rows.map((row) => {
    const totalRuns = Number(row.totalRuns ?? 0);
    return {
      id: row.id,
      filePath: row.filePath,
      suitePath: row.suitePath ?? '',
      title: row.title,
      tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
      locks: Array.isArray(row.locks) ? (row.locks as string[]) : [],
      owner: row.owner ?? null,
      priority: row.priority ?? null,
      feature: row.feature ?? null,
      avgDurationMs: row.avgDuration != null ? Math.round(Number(row.avgDuration)) : null,
      passRate: row.passRate != null ? Number(row.passRate) : null,
      totalRuns,
      flaky: Number(row.recentFlakyRuns ?? 0) > 0,
      lastStatus: row.lastStatus ?? null,
      lastLine: row.lastLine != null ? Number(row.lastLine) : null,
      quarantined: quarantined.has(row.id),
      neverRun: totalRuns === 0,
      firstFailRank: failRanks.get(row.id) ?? null,
    } satisfies CatalogRow;
  });
}

/**
 * Recency rank of each test's most recent failure within its last
 * `MAX_FAILED_IN_LAST_RUNS` executions (1 = the latest execution). Computed with
 * a window function in one pass, only when a definition actually needs it.
 */
async function loadRecentFailRanks(db: DrizzleDB, projectId: number): Promise<Map<number, number>> {
  const ranked = db.$with('ranked').as(
    db
      .select({
        testCaseId: testRunsCases.testCaseId,
        status: testRunsCases.status,
        rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${testRunsCases.testCaseId} ORDER BY ${testRunsCases.createdAt} DESC, ${testRunsCases.id} DESC)`.as(
          'rn',
        ),
      })
      .from(testRunsCases)
      .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
      .where(
        and(eq(testCases.projectId, projectId), eligibleExecutionSql('selection-catalog', testRunsCases.testRunId)),
      ),
  );

  const rows: any[] = await db
    .with(ranked)
    .select({ testCaseId: ranked.testCaseId, rank: sql<number>`MIN(${ranked.rn})` })
    .from(ranked)
    .where(
      and(sql`${ranked.status} IN ('failed', 'timedOut', 'timedout')`, sql`${ranked.rn} <= ${MAX_FAILED_IN_LAST_RUNS}`),
    )
    .groupBy(ranked.testCaseId);

  return new Map(rows.map((r) => [Number(r.testCaseId), Number(r.rank)]));
}

// ── Predicate evaluation ─────────────────────────────────────────────────────

/** Convert a glob (`**`, `*`, `?`) to an anchored regex over a POSIX path. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

function matchesGroup(row: CatalogRow, group: SelectionPredicateGroup): boolean {
  if (group.ids && !group.ids.includes(row.id)) return false;
  if (group.tags) {
    const have = new Set(row.tags.map((t) => t.toLowerCase()));
    if (!group.tags.every((t) => have.has(t.toLowerCase().replace(/^@+/, '')))) return false;
  }
  if (group.anyTags) {
    const have = new Set(row.tags.map((t) => t.toLowerCase()));
    if (!group.anyTags.some((t) => have.has(t.toLowerCase().replace(/^@+/, '')))) return false;
  }
  if (group.owner && !(row.owner && group.owner.includes(row.owner))) return false;
  if (group.priority && !(row.priority && group.priority.includes(row.priority as never))) return false;
  if (group.feature && !(row.feature && group.feature.includes(row.feature))) return false;
  if (group.files) {
    const posix = row.filePath.replace(/\\/g, '/');
    if (!group.files.some((g) => globToRegExp(g).test(posix))) return false;
  }
  if (group.suitePath && !foldText(row.suitePath).includes(foldText(group.suitePath))) return false;
  if (group.text) {
    const needle = foldText(group.text);
    if (!foldText(row.title).includes(needle) && !foldText(row.filePath).includes(needle)) return false;
  }
  if (group.quarantined !== undefined && row.quarantined !== group.quarantined) return false;
  if (group.flaky !== undefined && row.flaky !== group.flaky) return false;
  if (group.minPassRate !== undefined && !(row.passRate !== null && row.passRate >= group.minPassRate)) return false;
  if (group.maxPassRate !== undefined && !(row.passRate !== null && row.passRate <= group.maxPassRate)) return false;
  if (
    group.minAvgDurationMs !== undefined &&
    !(row.avgDurationMs !== null && row.avgDurationMs >= group.minAvgDurationMs)
  ) {
    return false;
  }
  if (
    group.maxAvgDurationMs !== undefined &&
    !(row.avgDurationMs !== null && row.avgDurationMs <= group.maxAvgDurationMs)
  ) {
    return false;
  }
  if (group.lastStatus && !(row.lastStatus && group.lastStatus.includes(row.lastStatus))) return false;
  if (
    group.failedInLastRuns !== undefined &&
    !(row.firstFailRank !== null && row.firstFailRank <= group.failedInLastRuns)
  ) {
    return false;
  }
  if (group.neverRun !== undefined && row.neverRun !== group.neverRun) return false;
  return true;
}

/** A test matches include when include is empty/absent, or it matches any include group. */
function matchesInclude(row: CatalogRow, include: SelectionPredicateGroup[] | undefined): boolean {
  if (!include || include.length === 0) return true;
  return include.some((group) => matchesGroup(row, group));
}

function matchesExclude(row: CatalogRow, exclude: SelectionPredicateGroup[] | undefined): boolean {
  if (!exclude || exclude.length === 0) return false;
  return exclude.some((group) => matchesGroup(row, group));
}

// ── Ranking, budget, limit ───────────────────────────────────────────────────

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function rankValue(row: CatalogRow, rankBy: SelectionRankBy): number {
  switch (rankBy) {
    case 'failureLikelihood':
      return -(row.passRate === null ? 0.5 : 1 - row.passRate);
    case 'recentFailure':
      return row.firstFailRank ?? Number.POSITIVE_INFINITY;
    case 'priority':
      return row.priority ? (PRIORITY_ORDER[row.priority] ?? 4) : 4;
    case 'slowest':
      return -(row.avgDurationMs ?? 0);
    case 'fastest':
      return row.avgDurationMs ?? Number.POSITIVE_INFINITY;
  }
}

/** Deterministic base order — file, then suite, then title, then id. */
function stableCompare(a: CatalogRow, b: CatalogRow): number {
  return (
    a.filePath.localeCompare(b.filePath) ||
    a.suitePath.localeCompare(b.suitePath) ||
    a.title.localeCompare(b.title) ||
    a.id - b.id
  );
}

function orderTests(rows: CatalogRow[], rankBy: SelectionRankBy | undefined): CatalogRow[] {
  const sorted = [...rows];
  if (rankBy) sorted.sort((a, b) => rankValue(a, rankBy) - rankValue(b, rankBy) || stableCompare(a, b));
  else sorted.sort(stableCompare);
  return sorted;
}

// ── Definition resolution ────────────────────────────────────────────────────

function toResolvedTest(row: CatalogRow): ResolvedTest {
  return {
    testCaseId: row.id,
    filePath: row.filePath,
    suitePath: row.suitePath,
    title: row.title,
    line: row.lastLine,
    avgDurationMs: row.avgDurationMs,
    locks: row.locks,
  };
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function definitionNeedsFailRanks(def: SelectionDefinition): boolean {
  const groups = [...(def.include ?? []), ...(def.exclude ?? [])];
  if (groups.some((g) => g.failedInLastRuns !== undefined)) return true;
  return def.budget?.rankBy === 'recentFailure';
}

export interface ResolveOptions {
  key?: string | null;
  version?: number | null;
  format?: SelectionFormat;
  pkgRunner?: string;
  /** Keep only this shard of the resolved list, balanced by summed average duration (1-based index). */
  shard?: { index: number; total: number };
  /**
   * Emit the resolved tests in this rank order (worst-first for the failure
   * ranks) — a fail-fast hint that influences Playwright's file order without
   * changing the set. Independent of a budget's own ranking; does not affect the
   * resolved hash, which is order-independent.
   */
  order?: SelectionRankBy;
  /**
   * A catalog already loaded by the caller, reused instead of querying again.
   * It must carry fail ranks (`withFailRanks: true`) so any definition resolves
   * correctly. Analytics resolves many selections against one shared catalog.
   */
  catalog?: CatalogRow[];
}

/**
 * Resolve a definition against the current catalog: match, exclude, pin, budget
 * and limit, then hash the stable identities and materialize a command.
 */
export async function resolveSelectionDefinition(
  db: DrizzleDB,
  projectId: number,
  definition: SelectionDefinition,
  options: ResolveOptions = {},
): Promise<ResolvedSelection> {
  const catalog =
    options.catalog ??
    (await loadSelectionCatalog(db, projectId, {
      withFailRanks: definitionNeedsFailRanks(definition) || options.order === 'recentFailure',
    }));
  const byId = new Map(catalog.map((row) => [row.id, row]));
  const warnings: SelectionWarning[] = [];

  // include → exclude
  const selected = new Map<number, CatalogRow>();
  for (const row of catalog) {
    if (matchesInclude(row, definition.include) && !matchesExclude(row, definition.exclude)) {
      selected.set(row.id, row);
    }
  }

  // pins
  const pinnedAdd = new Set(definition.pins?.add ?? []);
  for (const id of definition.pins?.remove ?? []) selected.delete(id);
  for (const id of pinnedAdd) {
    const row = byId.get(id);
    if (row) selected.set(id, row);
    else warnings.push({ code: 'pin-not-found', message: `Pinned test id ${id} no longer exists` });
  }

  // budget → limit
  let ordered = orderTests(
    [...selected.values()],
    definition.budget?.rankBy ?? (definition.budget ? 'failureLikelihood' : undefined),
  );
  const cap = definition.budget?.maxTotalDurationMs;
  if (cap !== undefined) {
    const kept: CatalogRow[] = [];
    let running = 0;
    for (const row of ordered) {
      const dur = row.avgDurationMs ?? 0;
      if (running + dur <= cap) {
        kept.push(row);
        running += dur;
      }
    }
    ordered = kept;
  }
  if (definition.limit !== undefined && ordered.length > definition.limit) {
    ordered = ordered.slice(0, definition.limit);
  }

  const finalIds = new Set(ordered.map((r) => r.id));
  for (const id of pinnedAdd) {
    if (!finalIds.has(id) && byId.has(id)) {
      warnings.push({ code: 'budget-evicted-pin', message: `Pinned test id ${id} was cut by the budget or limit` });
    }
  }

  // shard: keep only this shard's duration-balanced bucket of the final set,
  // with every test that shares a lock kept together in one shard.
  const shard = options.shard;
  if (shard && shard.total >= 1 && shard.index >= 1 && shard.index <= shard.total) {
    ordered = partitionTestsIntoShards(ordered, shard.total)[shard.index - 1] ?? [];
  }

  // fail-fast: emit worst-first, so the tests most likely to fail start first.
  if (options.order) ordered = orderTests(ordered, options.order);

  if (ordered.some((r) => r.quarantined)) {
    warnings.push({
      code: 'quarantined-included',
      message: 'The selection includes one or more quarantined tests',
    });
  }

  const spanningLocks = locksSpanningTests(ordered);
  if (spanningLocks.length > 0) {
    warnings.push({
      code: 'split-lock',
      message: `Lock(s) ${spanningLocks.join(', ')} are held by more than one test — sharding with Playwright's own "playwright test --shard" could split a lock across shards; run this selection with "piwi run --shard i/n" (lock-aware) to keep each lock in one shard`,
    });
  }

  const tests = ordered.map(toResolvedTest);
  const identities = [...ordered]
    .map((r) => `${r.filePath}\x1f${r.suitePath}\x1f${r.title}`)
    .sort()
    .join('\n');
  const resolvedHash = await sha256Hex(identities);

  const durations = ordered.map((r) => r.avgDurationMs).filter((d): d is number => d !== null);
  const totalDurationMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) : null;

  const format = options.format ?? 'args';
  const materialization: MaterializedSelection = materializeSelection(tests, format, { pkgRunner: options.pkgRunner });
  if (format !== 'json' && format !== 'files' && materialization.format !== format) {
    warnings.push({
      code: 'grep-overselects',
      message: `Materialization fell back to "${materialization.format}" because the ${format} command was too long`,
    });
  }

  return {
    key: options.key ?? null,
    version: options.version ?? null,
    tests,
    resolvedHash,
    estimate: { count: tests.length, totalDurationMs },
    warnings,
    materialization,
  };
}

// ── Stored definitions (CRUD) ────────────────────────────────────────────────

function rowToSelection(row: any): Selection {
  return {
    key: row.key,
    name: row.name,
    description: row.description ?? null,
    definition: (typeof row.definition === 'string'
      ? JSON.parse(row.definition)
      : row.definition) as SelectionDefinition,
    version: row.version,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : (row.createdAt ?? null),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : (row.updatedAt ?? null),
  };
}

function builtinToSelection(key: string): Selection {
  const builtin = getBuiltinSelection(key)!;
  return {
    key: builtin.key,
    name: builtin.name,
    description: builtin.description,
    definition: builtin.definition,
    version: 0,
    builtin: true,
  };
}

/** Built-ins first, then the project's stored selections. */
export async function listSelections(db: DrizzleDB, projectId: number): Promise<Selection[]> {
  const rows = await db.select().from(testSelections).where(eq(testSelections.projectId, projectId));
  const builtins = BUILTIN_SELECTIONS.map((b) => builtinToSelection(b.key));
  return [...builtins, ...rows.map(rowToSelection)];
}

/** A listed selection with what it resolves to now: its tests' ids and the command that runs them. */
export interface ListedResolvedSelection extends Selection {
  resolved: Pick<ResolvedSelection, 'resolvedHash' | 'estimate' | 'warnings'> & {
    testCaseIds: number[];
    /** The `args` materialization's command, as the resolve endpoint's default gives it. */
    command: string;
  };
}

/**
 * Every selection of {@link listSelections}, each resolved against one catalog
 * load (with fail ranks when a definition needs them), so resolving them all
 * costs one read of the run history, not one per selection.
 */
export async function listResolvedSelections(db: DrizzleDB, projectId: number): Promise<ListedResolvedSelection[]> {
  const selections = await listSelections(db, projectId);
  const catalog = await loadSelectionCatalog(db, projectId, {
    withFailRanks: selections.some((s) => definitionNeedsFailRanks(s.definition)),
  });
  const out: ListedResolvedSelection[] = [];
  for (const selection of selections) {
    const resolved = await resolveSelectionDefinition(db, projectId, selection.definition, {
      key: selection.key,
      version: selection.version,
      catalog,
    });
    out.push({
      ...selection,
      resolved: {
        testCaseIds: resolved.tests.map((t) => t.testCaseId),
        resolvedHash: resolved.resolvedHash,
        estimate: resolved.estimate,
        warnings: resolved.warnings,
        command: resolved.materialization.command,
      },
    });
  }
  return out;
}

/** One selection by key — a stored row, else a built-in, else null. */
export async function getSelection(db: DrizzleDB, projectId: number, key: string): Promise<Selection | null> {
  const [row] = await db
    .select()
    .from(testSelections)
    .where(and(eq(testSelections.projectId, projectId), eq(testSelections.key, key)));
  if (row) return rowToSelection(row);
  if (isBuiltinKey(key)) return builtinToSelection(key);
  return null;
}

export interface CreateSelectionInput {
  key: string;
  name: string;
  description?: string | null;
  definition: SelectionDefinition;
  createdBy?: number | null;
}

export class SelectionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export async function createSelection(
  db: DrizzleDB,
  projectId: number,
  input: CreateSelectionInput,
): Promise<Selection> {
  const keyCheck = validateSelectionKey(input.key);
  if (!keyCheck.valid) throw new SelectionError(keyCheck.error!, 400);
  if (isBuiltinKey(input.key)) throw new SelectionError(`"${input.key}" is a reserved built-in selection`, 409);
  if (!input.name || typeof input.name !== 'string') throw new SelectionError('name is required', 400);
  const defCheck = validateSelectionDefinition(input.definition);
  if (!defCheck.valid) throw new SelectionError(`Invalid definition: ${defCheck.errors.join('; ')}`, 400);

  const existing = await getSelection(db, projectId, input.key);
  if (existing && !existing.builtin)
    throw new SelectionError(`A selection with key "${input.key}" already exists`, 409);

  const now = new Date();
  const [row] = await db
    .insert(testSelections)
    .values({
      projectId,
      key: input.key,
      name: input.name.slice(0, 200),
      description: input.description ? String(input.description).slice(0, 1000) : null,
      definition: input.definition as never,
      version: 1,
      createdBy: typeof input.createdBy === 'number' && input.createdBy > 0 ? input.createdBy : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return rowToSelection(row);
}

export interface UpdateSelectionInput {
  name?: string;
  description?: string | null;
  definition?: SelectionDefinition;
}

/** Update a stored selection. Bumps `version` only when the definition changes. */
export async function updateSelection(
  db: DrizzleDB,
  projectId: number,
  key: string,
  patch: UpdateSelectionInput,
): Promise<Selection> {
  const [current] = await db
    .select()
    .from(testSelections)
    .where(and(eq(testSelections.projectId, projectId), eq(testSelections.key, key)));
  if (!current) throw new SelectionError('Selection not found', 404);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    if (!patch.name || typeof patch.name !== 'string') throw new SelectionError('name must be a non-empty string', 400);
    updates.name = patch.name.slice(0, 200);
  }
  if (patch.description !== undefined) {
    updates.description = patch.description ? String(patch.description).slice(0, 1000) : null;
  }
  if (patch.definition !== undefined) {
    const defCheck = validateSelectionDefinition(patch.definition);
    if (!defCheck.valid) throw new SelectionError(`Invalid definition: ${defCheck.errors.join('; ')}`, 400);
    const currentDef = typeof current.definition === 'string' ? current.definition : JSON.stringify(current.definition);
    if (JSON.stringify(patch.definition) !== currentDef) {
      updates.definition = patch.definition as never;
      updates.version = (current.version ?? 1) + 1;
    }
  }

  const [row] = await db
    .update(testSelections)
    .set(updates)
    .where(and(eq(testSelections.projectId, projectId), eq(testSelections.key, key)))
    .returning();
  return rowToSelection(row);
}

export async function deleteSelection(db: DrizzleDB, projectId: number, key: string): Promise<{ deleted: boolean }> {
  const rows = await db
    .delete(testSelections)
    .where(and(eq(testSelections.projectId, projectId), eq(testSelections.key, key)))
    .returning({ id: testSelections.id });
  return { deleted: rows.length > 0 };
}
