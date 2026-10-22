/**
 * The locator index: which locator chain each test used, from which call site,
 * for which action, in which Playwright project. Rows are built from the steps
 * Playwright reports for every execution, so the index needs no capture beyond
 * what the reporter already sends, and works with locator healing turned off.
 *
 * With the capture fixtures, rows also carry the page the call ran on (see
 * `locator-pages.ts`), joined by call site and chain: a use made on two pages
 * is two rows. Without them the page is '' (unknown).
 *
 * Rows carry the branch of the run that recorded them: '' for the project's
 * default branch (and runs with no branch), else the branch name. A view of
 * one branch starts from the default branch's uses and, for each test and
 * Playwright project that ran on that branch, replaces them with what it did
 * there — a test not run on a branch is taken to be unchanged on it.
 *
 * Shared by the server ingest path and the demo mirror.
 */
import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  max,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { locatorUsages, projects, testCases, testRuns, testRunsCases } from '../database/schema';
import { resolveCasePayloadContents } from './case-payloads';
import { parseStoredLocatorPages } from './locator-pages';
import { collectOwnOrigins, projectRouteOrigins, runBaseUrls } from '#shared/graph';
import {
  extractStepLocatorUses,
  findLocationRoot,
  isAbsoluteLocation,
  locationRootOf,
  locatorScopes,
  locatorTarget,
  stepLocations,
  stripLocationRoot,
} from '#shared/locator-chain';
import { isLabRun } from '#shared/handlers/probes';
import { escapeLikePattern } from '#shared/utils/tag-filter';
import { foldedContains } from '#shared/utils/fold-text-sql';
import { decidesOutcome, testOutcomes } from '#shared/utils/test-counts';
import type { DrizzleDB } from '#shared/handlers/db';
import type {
  ExecutionLocatorUse,
  ExecutionLocatorsResult,
  LocatorUsageMatch,
  LocatorUsageSite,
  LocatorUsagesResult,
} from '#shared/locator-usages.types';
import {
  ALL_BRANCHES,
  type LocatorIndex,
  type LocatorIndexBranch,
  type LocatorIndexEntry,
  type LocatorIndexTest,
  type LocatorIndexTestStatus,
  type LocatorIndexViewport,
} from '#shared/locator-index';
import { projectDefaultBranch } from './scm/stored-default-branch';
import type { LocatorPageUse } from '@piwitests/core/wire';

/**
 * UTF-8 byte budgets for indexed text. A Postgres btree entry holds about
 * 2700 bytes, so the chain and the whole unique key stay well under it; a use
 * over budget is left out.
 */
const MAX_LOCATOR_BYTES = 1000;
const MAX_KEY_BYTES = 2000;
/** A page key longer than this is stored as unknown (''). */
const MAX_PAGE_BYTES = 300;
/** Pages listed per use in the index document; the rest is said with `pagesTruncated`. */
const MAX_PAGES_PER_USE = 50;
/** Rows per insert statement, well under SQLite's bound-parameter limit. */
const INSERT_CHUNK = 200;

const utf8 = new TextEncoder();
const byteLength = (value: string) => utf8.encode(value).length;

export interface LocatorUsageCase {
  caseId: number;
  /** The Playwright project the execution ran in (`test_runs_cases.browser_name`). */
  browserName: string | null;
  /** The stored steps of the execution. */
  steps: unknown;
  /** The test's project-relative file, used to make step locations relative. */
  filePath: string | null;
  /** The run that produced the steps. */
  runId: number;
  /**
   * The execution ran to the end and every step was kept, so a use missing
   * from it no longer exists in the test and may be removed.
   */
  complete: boolean;
  /** The page each locator call ran on, from the capture fixtures; null or absent when unknown. */
  locatorPages?: LocatorPageUse[] | null;
}

/** What the index needs to know about a run. */
export interface RunFacts {
  /** Orders uses across runs, including an old report imported late. */
  startedAt: Date;
  /** The checkout directory the reporter ran from, when it sent one. */
  root: string | null;
  /** A lab run (probe or flake experiment), whose executions are never indexed. */
  probe: boolean;
  /** The run's branch, trimmed; null when it had none. */
  branch: string | null;
  /** The run's Playwright `baseURL`s: the application's own pages, beside the project's route origins. */
  baseUrls: string[];
}

type UsageInsert = typeof locatorUsages.$inferInsert;

const usageKey = (
  caseId: number,
  browserName: string,
  branch: string,
  callSite: string,
  action: string,
  locator: string,
  page: string,
) => `${caseId}\x00${browserName}\x00${branch}\x00${callSite}\x00${action}\x00${locator}\x00${page}`;

/** The branch a run's uses are stored under: '' on the default branch or with no branch, else the branch. */
export function locatorBranchTag(runBranch: string | null | undefined, defaultBranch: string | null): string {
  const branch = runBranch?.trim() || '';
  return branch === '' || branch === defaultBranch ? '' : branch;
}

/** The index's facts about a run, from its row. */
export function runFacts(run: { startTime: Date; metadata: unknown; branch: string | null }): RunFacts {
  const metadata = run.metadata as Record<string, unknown> | null;
  return {
    startedAt: new Date(run.startTime),
    root: locationRootOf(metadata?.workingDir),
    probe: isLabRun(metadata),
    branch: run.branch?.trim() || null,
    baseUrls: runBaseUrls(metadata),
  };
}

async function loadRunFacts(db: DrizzleDB, runIds: number[]): Promise<Map<number, RunFacts>> {
  const out = new Map<number, RunFacts>();
  const ids = [...new Set(runIds)];
  for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
    const rows = await db
      .select({ id: testRuns.id, startTime: testRuns.startTime, metadata: testRuns.metadata, branch: testRuns.branch })
      .from(testRuns)
      .where(inArray(testRuns.id, ids.slice(i, i + INSERT_CHUNK)));
    for (const r of rows) out.set(r.id, runFacts(r));
  }
  return out;
}

/**
 * The project root of each execution's absolute step locations: the working
 * directory the reporter sent with the run, else the prefix revealed by a step
 * in the test's own file, else the one another execution of the same run
 * revealed (one run comes from one checkout).
 */
function locationRoots(cases: LocatorUsageCase[], runs: Map<number, RunFacts>): Array<string | null> {
  const own = cases.map((c) => runs.get(c.runId)?.root ?? findLocationRoot(stepLocations(c.steps), c.filePath));
  const byRun = new Map<number, string>();
  cases.forEach((c, i) => {
    const root = own[i];
    if (root && !byRun.has(c.runId)) byRun.set(c.runId, root);
  });
  return cases.map((c, i) => own[i] ?? byRun.get(c.runId) ?? null);
}

/** The project's own route origins, beside each run's Playwright `baseURL`s: what tells its pages from third-party ones. */
async function projectOrigins(db: DrizzleDB, projectId: number): Promise<string[]> {
  const [project] = await db
    .select({ routeOrigins: projects.routeOrigins })
    .from(projects)
    .where(eq(projects.id, projectId));
  return projectRouteOrigins(project?.routeOrigins);
}

/** `file:line` of a `file:line:col` call site: the stack a wrapper reads and a step's location can differ by column. */
function fileLine(callSite: string): string | null {
  const m = /^(.*:\d+):\d+$/.exec(callSite);
  return m ? m[1]! : null;
}

/**
 * The pages each (call site, chain) of one execution ran on, with whether a
 * call ran there on arrival, keyed exactly and by `file:line`. An own page
 * keeps its path key; a third-party page's key starts with its origin, so it
 * never matches a page of the application.
 */
function pagesByCall(
  entries: LocatorUsageCase['locatorPages'],
  root: string | null,
  ownOrigins: Set<string>,
): Map<string, Map<string, boolean>> {
  const out = new Map<string, Map<string, boolean>>();
  for (const entry of entries ?? []) {
    const callSite = stripLocationRoot(entry.location, root);
    const own = ownOrigins.size === 0 || ownOrigins.has(entry.origin);
    const page = own ? entry.page : `${entry.origin}${entry.page}`;
    if (byteLength(page) > MAX_PAGE_BYTES) continue;
    const keys = [`${callSite}\x00${entry.locator}`];
    const line = fileLine(callSite);
    if (line) keys.push(`${line}\x00${entry.locator}`);
    for (const key of keys) {
      let pages = out.get(key);
      if (!pages) out.set(key, (pages = new Map()));
      pages.set(page, (pages.get(page) ?? false) || entry.arrival);
    }
  }
  return out;
}

/**
 * The rows a batch of executions contributes, one per distinct use per test,
 * project and branch, and the cases that had a use left out: over the byte
 * budget, or at a call site that could not be made project-relative. Those
 * never purge.
 */
export function buildLocatorUsageRows(
  projectId: number,
  cases: LocatorUsageCase[],
  runs: Map<number, RunFacts> = new Map(),
  now = new Date(),
  defaultBranch: string | null = null,
  routeOrigins: string[] = [],
): { rows: UsageInsert[]; partial: Set<number> } {
  const rows = new Map<string, UsageInsert>();
  const partial = new Set<number>();
  const roots = locationRoots(cases, runs);
  cases.forEach((c, k) => {
    const browserName = c.browserName ?? '';
    const run = runs.get(c.runId);
    const branch = locatorBranchTag(run?.branch, defaultBranch);
    const seenAt = run?.startedAt ?? now;
    const pages = pagesByCall(c.locatorPages, roots[k]!, collectOwnOrigins(run?.baseUrls ?? [], routeOrigins));
    for (const use of extractStepLocatorUses(c.steps)) {
      const callSite = use.location ? stripLocationRoot(use.location, roots[k]!) : '';
      const bytes = byteLength(use.locator);
      if (
        isAbsoluteLocation(callSite) ||
        bytes > MAX_LOCATOR_BYTES ||
        bytes + byteLength(callSite) + byteLength(browserName) + byteLength(branch) + byteLength(use.action) >
          MAX_KEY_BYTES - MAX_PAGE_BYTES
      ) {
        partial.add(k);
        continue;
      }
      const line = fileLine(callSite);
      const onPages =
        pages.get(`${callSite}\x00${use.locator}`) ?? (line ? pages.get(`${line}\x00${use.locator}`) : undefined);
      for (const [page, arrival] of onPages?.size ? onPages : new Map([['', false]])) {
        const key = usageKey(c.caseId, browserName, branch, callSite, use.action, use.locator, page);
        const existing = rows.get(key);
        if (existing) {
          existing.arrival ||= arrival;
          continue;
        }
        rows.set(key, {
          projectId,
          testCaseId: c.caseId,
          browserName,
          branch,
          locator: use.locator,
          target: locatorTarget(use.chain),
          action: use.action,
          callSite,
          page,
          arrival,
          firstSeenRunId: c.runId,
          lastSeenRunId: c.runId,
          lastSeenAt: seenAt,
        });
      }
    }
  });
  return { rows: [...rows.values()], partial };
}

/**
 * Upsert the locator uses of a batch of executions. A use seen again keeps its
 * first-seen run, and moves to the newer of the two runs, so importing an old
 * report never rolls the index back.
 *
 * An execution that ran to the end with every step kept removes the uses its
 * test no longer has, in its own Playwright project and branch only (another
 * project can take other paths through the same test, another branch can have
 * other code), and only those last seen before its run started. A failed or
 * truncated execution never removes anything: it may have stopped before
 * reaching them.
 */
/** What a caller that has already read it hands {@link upsertLocatorUsages}, which reads the rest itself. */
export interface LocatorUsageLookups {
  /** The facts of every run the cases belong to (see {@link runFacts}). */
  runs?: Map<number, RunFacts>;
  /** The project's stored default branch, resolved by the caller at most once. */
  defaultBranch?: () => Promise<string>;
  /** The project's route origins. */
  routeOrigins?: string[];
}

export async function upsertLocatorUsages(
  db: DrizzleDB,
  projectId: number,
  cases: LocatorUsageCase[],
  known: LocatorUsageLookups = {},
): Promise<void> {
  const runs =
    known.runs ??
    (await loadRunFacts(
      db,
      cases.map((c) => c.runId),
    ));
  const branched = [...runs.values()].some((r) => r.branch);
  const defaultBranch = branched ? await (known.defaultBranch?.() ?? projectDefaultBranch(db, projectId)) : null;
  const routeOrigins = cases.some((c) => c.locatorPages?.length)
    ? (known.routeOrigins ?? (await projectOrigins(db, projectId)))
    : [];
  const { rows, partial } = buildLocatorUsageRows(projectId, cases, runs, new Date(), defaultBranch, routeOrigins);

  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db
      .insert(locatorUsages)
      .values(rows.slice(i, i + INSERT_CHUNK))
      .onConflictDoUpdate({
        target: [
          locatorUsages.testCaseId,
          locatorUsages.browserName,
          locatorUsages.branch,
          locatorUsages.callSite,
          locatorUsages.action,
          locatorUsages.locator,
          locatorUsages.page,
        ],
        set: {
          lastSeenRunId: sql`CASE WHEN excluded.last_seen_at >= locator_usages.last_seen_at THEN excluded.last_seen_run_id ELSE locator_usages.last_seen_run_id END`,
          arrival: sql`CASE WHEN excluded.last_seen_at >= locator_usages.last_seen_at THEN excluded.arrival ELSE locator_usages.arrival END`,
          lastSeenAt: sql`CASE WHEN excluded.last_seen_at >= locator_usages.last_seen_at THEN excluded.last_seen_at ELSE locator_usages.last_seen_at END`,
        },
      });
  }

  // (test case, Playwright project, branch) → the start of the latest complete run seen for it.
  const purgeBefore = new Map<string, Date>();
  cases.forEach((c, k) => {
    if (!c.complete || partial.has(k) || !Array.isArray(c.steps) || c.steps.length === 0) return;
    const run = runs.get(c.runId);
    if (!run) return;
    const startedAt = run.startedAt;
    const key = `${c.caseId}\x00${c.browserName ?? ''}\x00${locatorBranchTag(run.branch, defaultBranch)}`;
    const current = purgeBefore.get(key);
    if (!current || startedAt > current) purgeBefore.set(key, startedAt);
  });
  if (purgeBefore.size === 0) return;

  const seen = new Set(
    rows.map((r) =>
      usageKey(r.testCaseId, r.browserName, r.branch ?? '', r.callSite, r.action, r.locator, r.page ?? ''),
    ),
  );
  const caseIds = [...new Set([...purgeBefore.keys()].map((k) => Number(k.split('\x00')[0])))];
  const existing = await db
    .select({
      id: locatorUsages.id,
      testCaseId: locatorUsages.testCaseId,
      browserName: locatorUsages.browserName,
      branch: locatorUsages.branch,
      callSite: locatorUsages.callSite,
      action: locatorUsages.action,
      locator: locatorUsages.locator,
      page: locatorUsages.page,
      lastSeenAt: locatorUsages.lastSeenAt,
    })
    .from(locatorUsages)
    .where(inArray(locatorUsages.testCaseId, caseIds));
  const stale = existing
    .filter((r) => {
      const before = purgeBefore.get(`${r.testCaseId}\x00${r.browserName}\x00${r.branch}`);
      return (
        before !== undefined &&
        new Date(r.lastSeenAt) < before &&
        !seen.has(usageKey(r.testCaseId, r.browserName, r.branch, r.callSite, r.action, r.locator, r.page))
      );
    })
    .map((r) => r.id);
  for (let i = 0; i < stale.length; i += INSERT_CHUNK) {
    await db.delete(locatorUsages).where(inArray(locatorUsages.id, stale.slice(i, i + INSERT_CHUNK)));
  }
}

interface ExecutionRef {
  id: number;
  testCaseId: number;
  browserName: string | null;
  status: string;
  testRunId: number;
  /** Branch tag of the run (see `locatorBranchTag`). */
  branch: string;
}

/**
 * The execution to index for each (test case, Playwright project, branch): the
 * latest passed one, which reached every locator, else the latest one. Probe
 * runs replay tests with injected faults and are skipped. Newest groups first.
 */
function pickExecutions(refs: ExecutionRef[], probeRuns: Set<number>, maxCases: number): ExecutionRef[] {
  const picked = new Map<string, { latest: ExecutionRef; passed: ExecutionRef | null }>();
  for (const ref of refs) {
    if (probeRuns.has(ref.testRunId)) continue;
    const key = `${ref.testCaseId}\x00${ref.browserName ?? ''}\x00${ref.branch}`;
    const entry = picked.get(key);
    if (!entry) {
      if (picked.size >= maxCases) continue;
      picked.set(key, { latest: ref, passed: ref.status === 'passed' ? ref : null });
    } else if (!entry.passed && ref.status === 'passed') {
      entry.passed = ref;
    }
  }
  return [...picked.values()].map((e) => e.passed ?? e.latest);
}

/**
 * Build a project's index from the executions already stored, then mark the
 * project as indexed. Reads the most recent executions (newest first, bounded
 * by `maxExecutions`) and indexes one per test case, Playwright project and
 * branch, up to `maxCases`. Idempotent, so running it on a filled index only
 * refreshes it; `reset` empties the project's index first, dropping the uses
 * of executions no longer stored.
 */
export async function backfillLocatorUsages(
  db: DrizzleDB,
  projectId: number,
  opts: { maxCases?: number; maxExecutions?: number; reset?: boolean } = {},
): Promise<{ casesProcessed: number; usages: number }> {
  const defaultBranch = await projectDefaultBranch(db, projectId);
  const stored = await db
    .select({
      id: testRunsCases.id,
      testCaseId: testRunsCases.testCaseId,
      browserName: testRunsCases.browserName,
      status: testRunsCases.status,
      testRunId: testRunsCases.testRunId,
      runBranch: testRuns.branch,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testCases.id, testRunsCases.testCaseId))
    .innerJoin(testRuns, eq(testRuns.id, testRunsCases.testRunId))
    .where(and(eq(testCases.projectId, projectId), isNotNull(testRunsCases.steps)))
    .orderBy(desc(testRunsCases.id))
    .limit(opts.maxExecutions ?? 50_000);
  const refs: ExecutionRef[] = stored.map(({ runBranch, ...ref }) => ({
    ...ref,
    branch: locatorBranchTag(runBranch, defaultBranch),
  }));
  if (opts.reset) await db.delete(locatorUsages).where(eq(locatorUsages.projectId, projectId));

  // Only the runs of the picked executions are checked for lab runs (probes,
  // flake experiments); a lab run found moves its groups to their next execution, whose run is checked next.
  const maxCases = opts.maxCases ?? 5000;
  const probeRuns = new Set<number>();
  const checked = new Set<number>();
  let chosen = pickExecutions(refs, probeRuns, maxCases);
  for (;;) {
    const unchecked = [...new Set(chosen.map((r) => r.testRunId))].filter((id) => !checked.has(id));
    if (unchecked.length === 0) break;
    const facts = await loadRunFacts(db, unchecked);
    let found = false;
    for (const id of unchecked) {
      checked.add(id);
      if (facts.get(id)?.probe) {
        probeRuns.add(id);
        found = true;
      }
    }
    if (!found) break;
    chosen = pickExecutions(refs, probeRuns, maxCases);
  }

  const ids = chosen.map((r) => r.id);
  let casesProcessed = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const executions = await db
      .select({
        testCaseId: testRunsCases.testCaseId,
        browserName: testRunsCases.browserName,
        testRunId: testRunsCases.testRunId,
        steps: testRunsCases.steps,
        filePath: testCases.filePath,
        locatorPagesPayloadId: testRunsCases.locatorPagesPayloadId,
      })
      .from(testRunsCases)
      .innerJoin(testCases, eq(testCases.id, testRunsCases.testCaseId))
      .where(inArray(testRunsCases.id, ids.slice(i, i + 100)));
    // The pages each call ran on were stored with the execution, so a rebuild keeps them.
    const pagePayloads = await resolveCasePayloadContents(
      db,
      executions.map((e) => e.locatorPagesPayloadId),
    );
    await upsertLocatorUsages(
      db,
      projectId,
      executions.map((e) => ({
        caseId: e.testCaseId,
        browserName: e.browserName,
        steps: e.steps,
        filePath: e.filePath,
        runId: e.testRunId,
        complete: false,
        locatorPages:
          e.locatorPagesPayloadId != null ? parseStoredLocatorPages(pagePayloads.get(e.locatorPagesPayloadId)) : null,
      })),
    );
    casesProcessed += executions.length;
  }

  await db.update(projects).set({ locatorIndexBuiltAt: new Date() }).where(eq(projects.id, projectId));
  const [total] = await db.select({ n: count() }).from(locatorUsages).where(eq(locatorUsages.projectId, projectId));
  return { casesProcessed, usages: Number(total?.n ?? 0) };
}

/**
 * Build the index of every project not built yet, for the history stored
 * before the index existed. The server runs it once at startup, the demo when
 * its database opens; a restart only picks up the projects still unmarked.
 */
export async function backfillUnindexedProjects(
  db: DrizzleDB,
): Promise<Array<{ projectId: number; name: string; casesProcessed: number; usages: number }>> {
  const pending = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(isNull(projects.locatorIndexBuiltAt));
  const out = [];
  for (const project of pending) {
    out.push({ projectId: project.id, name: project.name, ...(await backfillLocatorUsages(db, project.id)) });
  }
  return out;
}

/** Which rows of the index a read looks at. */
export interface BranchView {
  /** The branch described, or null for every branch together. */
  name: string | null;
  /** The stored tag of that branch: '' for the default branch, null for every branch. */
  tag: string | null;
  defaultBranch: string;
}

/** A view of `requested` (a branch name, `*` for every branch, nothing for the default branch). */
export async function resolveBranchView(
  db: DrizzleDB,
  projectId: number,
  requested?: string | null,
): Promise<BranchView> {
  const defaultBranch = await projectDefaultBranch(db, projectId);
  if (requested === ALL_BRANCHES) return { name: null, tag: null, defaultBranch };
  const name = requested?.trim() || defaultBranch;
  return { name, tag: locatorBranchTag(name, defaultBranch), defaultBranch };
}

/** The rows a view reads, before `branchFilter` drops the default branch's rows a branch replaces. */
function branchCondition(view: BranchView): SQL | undefined {
  if (view.tag === null) return undefined;
  if (view.tag === '') return eq(locatorUsages.branch, '');
  return inArray(locatorUsages.branch, ['', view.tag]);
}

type BranchRow = { testCaseId: number; browserName: string; branch: string };

/**
 * Keeps the rows a view shows: in a view of a branch, the default branch's
 * rows of a test and Playwright project that ran on that branch give way to
 * the branch's own.
 */
async function branchFilter(db: DrizzleDB, projectId: number, view: BranchView): Promise<(row: BranchRow) => boolean> {
  if (view.tag === null || view.tag === '') return () => true;
  const tag = view.tag;
  const own = await db
    .selectDistinct({ testCaseId: locatorUsages.testCaseId, browserName: locatorUsages.browserName })
    .from(locatorUsages)
    .where(and(eq(locatorUsages.projectId, projectId), eq(locatorUsages.branch, tag)));
  const ran = new Set(own.map((r) => `${r.testCaseId}\x00${r.browserName}`));
  return (row) => row.branch === tag || !ran.has(`${row.testCaseId}\x00${row.browserName}`);
}

/** The branch a stored tag stands for. */
function branchName(tag: string, view: BranchView): string {
  return tag === '' ? view.defaultBranch : tag;
}

/** Distinct tests per value of `column` in a view, for the given values of that column. */
async function countTestsBy(
  db: DrizzleDB,
  projectId: number,
  column: typeof locatorUsages.locator | typeof locatorUsages.target,
  values: string[],
  view: BranchView,
): Promise<Map<string, number>> {
  const keep = await branchFilter(db, projectId, view);
  const tests = new Map<string, Set<number>>();
  for (let i = 0; i < values.length; i += INSERT_CHUNK) {
    const rows = await db
      .selectDistinct({
        value: column,
        testCaseId: locatorUsages.testCaseId,
        browserName: locatorUsages.browserName,
        branch: locatorUsages.branch,
      })
      .from(locatorUsages)
      .where(
        and(
          eq(locatorUsages.projectId, projectId),
          inArray(column, values.slice(i, i + INSERT_CHUNK)),
          branchCondition(view),
        ),
      );
    for (const r of rows) {
      if (!keep(r)) continue;
      let set = tests.get(r.value);
      if (!set) tests.set(r.value, (set = new Set()));
      set.add(r.testCaseId);
    }
  }
  return new Map([...tests.entries()].map(([value, set]) => [value, set.size]));
}

/**
 * The locators one execution used, in step order, each with how many tests in
 * the project use the same chain and the same target. Null when the execution
 * does not exist.
 */
export async function getExecutionLocators(db: DrizzleDB, runCaseId: number): Promise<ExecutionLocatorsResult | null> {
  const [row] = await db
    .select({
      steps: testRunsCases.steps,
      filePath: testCases.filePath,
      projectId: testCases.projectId,
      runMetadata: testRuns.metadata,
      runBranch: testRuns.branch,
      locatorPagesPayloadId: testRunsCases.locatorPagesPayloadId,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testCases.id, testRunsCases.testCaseId))
    .innerJoin(testRuns, eq(testRuns.id, testRunsCases.testRunId))
    .where(eq(testRunsCases.id, runCaseId));
  if (!row) return null;

  const found = extractStepLocatorUses(row.steps);
  const metadata = row.runMetadata as Record<string, unknown> | null;
  const root = locationRootOf(metadata?.workingDir) ?? findLocationRoot(stepLocations(row.steps), row.filePath);
  const storedPages =
    row.locatorPagesPayloadId != null
      ? parseStoredLocatorPages(
          (await resolveCasePayloadContents(db, [row.locatorPagesPayloadId])).get(row.locatorPagesPayloadId),
        )
      : null;
  const pages = storedPages
    ? pagesByCall(storedPages, root, collectOwnOrigins(runBaseUrls(metadata), await projectOrigins(db, row.projectId)))
    : null;
  const byKey = new Map<string, ExecutionLocatorUse>();
  found.forEach((use) => {
    const callSite = use.location ? stripLocationRoot(use.location, root) : null;
    const key = `${callSite ?? ''}\x00${use.action}\x00${use.locator}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.occurrences++;
      return;
    }
    const line = callSite ? fileLine(callSite) : null;
    const onPages =
      pages?.get(`${callSite ?? ''}\x00${use.locator}`) ?? (line ? pages?.get(`${line}\x00${use.locator}`) : undefined);
    byKey.set(key, {
      stepIndex: use.stepIndex,
      occurrences: 1,
      action: use.action,
      locator: use.locator,
      target: locatorTarget(use.chain),
      scopes: locatorScopes(use.chain),
      callSite,
      sameLocatorTests: 0,
      sameTargetTests: 0,
      ...(onPages?.size ? { pages: [...onPages.keys()] } : {}),
    });
  });
  const uses = [...byKey.values()];

  const view = await resolveBranchView(db, row.projectId, row.runBranch);
  const [byLocator, byTarget] = await Promise.all([
    countTestsBy(db, row.projectId, locatorUsages.locator, [...new Set(uses.map((u) => u.locator))], view),
    countTestsBy(db, row.projectId, locatorUsages.target, [...new Set(uses.map((u) => u.target))], view),
  ]);
  for (const use of uses) {
    use.sameLocatorTests = byLocator.get(use.locator) ?? 0;
    use.sameTargetTests = byTarget.get(use.target) ?? 0;
  }

  return {
    projectId: row.projectId,
    branch: row.runBranch?.trim() || null,
    uses,
    hasSteps: Array.isArray(row.steps) && row.steps.length > 0,
  };
}

/**
 * The call sites and tests that use matching chains:
 * - `locator`: exactly this chain;
 * - `target`: any chain ending on this call, whatever its containers;
 * - `scope`: this chain and every chain that continues inside it;
 * - `search`: chains containing the text, case-insensitively.
 *
 * In the view of `opts.branch` (a branch name, `*` for every branch, nothing
 * for the default branch).
 */
export async function getLocatorUsages(
  db: DrizzleDB,
  projectId: number,
  match: LocatorUsageMatch,
  value: string,
  opts: { limit?: number; branch?: string | null } = {},
): Promise<LocatorUsagesResult> {
  const limit = opts.limit ?? 1000;
  const view = await resolveBranchView(db, projectId, opts.branch);
  const keep = await branchFilter(db, projectId, view);
  const condition =
    match === 'locator'
      ? eq(locatorUsages.locator, value)
      : match === 'target'
        ? eq(locatorUsages.target, value)
        : match === 'scope'
          ? or(
              eq(locatorUsages.locator, value),
              sql`${locatorUsages.locator} LIKE ${`${escapeLikePattern(value)}.%`} ESCAPE '\\'`,
            )
          : foldedContains(locatorUsages.locator, value);

  const rows = await db
    .select({
      testCaseId: locatorUsages.testCaseId,
      browserName: locatorUsages.browserName,
      branch: locatorUsages.branch,
      locator: locatorUsages.locator,
      action: locatorUsages.action,
      callSite: locatorUsages.callSite,
      page: locatorUsages.page,
      lastSeenAt: locatorUsages.lastSeenAt,
      title: testCases.title,
      filePath: testCases.filePath,
      suitePath: testCases.suitePath,
    })
    .from(locatorUsages)
    .innerJoin(testCases, eq(testCases.id, locatorUsages.testCaseId))
    .where(and(eq(locatorUsages.projectId, projectId), condition, branchCondition(view)))
    .orderBy(desc(locatorUsages.lastSeenAt))
    .limit(limit + 1);

  const truncated = rows.length > limit;
  // SQLite's LIKE ignores ASCII case; a scope match is a case-sensitive prefix.
  const kept = rows
    .slice(0, limit)
    .filter((r) => keep(r))
    .filter((r) => match !== 'scope' || r.locator === value || r.locator.startsWith(`${value}.`));

  const sites = new Map<string, LocatorUsageSite>();
  const tests = new Set<number>();
  for (const r of kept) {
    tests.add(r.testCaseId);
    const key = `${r.callSite}\x00${r.locator}`;
    let site = sites.get(key);
    if (!site) {
      site = {
        callSite: r.callSite || null,
        locator: r.locator,
        actions: [],
        tests: [],
        lastSeenAt: new Date(r.lastSeenAt).toISOString(),
      };
      sites.set(key, site);
    }
    if (!site.actions.includes(r.action)) site.actions.push(r.action);
    if (r.page) {
      site.pages ??= [];
      if (!site.pages.includes(r.page)) site.pages.push(r.page);
    }
    if (!site.tests.some((t) => t.testCaseId === r.testCaseId)) {
      site.tests.push({ testCaseId: r.testCaseId, title: r.title, filePath: r.filePath, suitePath: r.suitePath });
    }
  }

  // Call sites shared by the most tests first: a page-object line is one fix for all of them.
  const ordered = [...sites.values()].sort((a, b) => b.tests.length - a.tests.length);
  return { match, value, branch: view.name, testCount: tests.size, sites: ordered, truncated };
}

/**
 * Tests as the locator index and the code index serve them: title, file,
 * describe blocks and the latest outcome on the view's branch.
 */
export async function indexTests(db: DrizzleDB, testIds: number[], view: BranchView): Promise<LocatorIndexTest[]> {
  const tests: LocatorIndexTest[] = [];
  for (let i = 0; i < testIds.length; i += 500) {
    const chunk = testIds.slice(i, i + 500);
    const [cases, latest] = await Promise.all([
      db
        .select({
          id: testCases.id,
          title: testCases.title,
          filePath: testCases.filePath,
          suitePath: testCases.suitePath,
        })
        .from(testCases)
        .where(inArray(testCases.id, chunk)),
      latestExecutions(db, chunk, view),
    ]);
    const latestIds = [...latest.values()];
    const latestRuns = latestIds.length
      ? await db
          .select({ testCaseId: testRunsCases.testCaseId, testRunId: testRunsCases.testRunId })
          .from(testRunsCases)
          .where(inArray(testRunsCases.id, latestIds))
      : [];
    // Each test's outcome in the run of its latest execution, over every repetition and project
    // (`decidesOutcome`): a failed one first, then a pass after a retry.
    const latestRunOf = new Map(latestRuns.map((r) => [r.testCaseId, r.testRunId]));
    const attempts = latestRuns.length
      ? await db
          .select({
            testCaseId: testRunsCases.testCaseId,
            testRunId: testRunsCases.testRunId,
            browserName: testRunsCases.browserName,
            repeatEachIndex: testRunsCases.repeatEachIndex,
            status: testRunsCases.status,
            retries: testRunsCases.retries,
          })
          .from(testRunsCases)
          .where(
            and(
              inArray(testRunsCases.testRunId, [...new Set(latestRunOf.values())]),
              inArray(testRunsCases.testCaseId, [...latestRunOf.keys()]),
            ),
          )
      : [];
    const outcomes = new Map<number, (typeof attempts)[number]>();
    for (const o of testOutcomes(attempts.filter((a) => latestRunOf.get(a.testCaseId) === a.testRunId))) {
      if (decidesOutcome(o, outcomes.get(o.testCaseId))) outcomes.set(o.testCaseId, o);
    }
    const statusOf = new Map([...outcomes].map(([id, o]) => [id, indexTestStatus(o.status, o.retries)]));
    for (const c of cases) {
      tests.push({
        id: c.id,
        title: c.title,
        file: c.filePath,
        suite: c.suitePath ? c.suitePath.split('\x1f').filter(Boolean) : [],
        status: statusOf.get(c.id) ?? null,
      });
    }
  }
  return tests;
}

/** The index as one latest-outcome word per test: a pass after retries is flaky, a timeout or interruption failed. */
function indexTestStatus(status: string | null, retries: number | null): LocatorIndexTestStatus | null {
  if (status === 'passed') return (retries ?? 0) > 0 ? 'flaky' : 'passed';
  if (status === 'failed' || status === 'timedout' || status === 'timedOut' || status === 'interrupted')
    return 'failed';
  if (status === 'skipped') return 'skipped';
  return null;
}

/**
 * The attributes `getByTestId` reads in a project: Playwright's `testIdAttribute`
 * as the reporter recorded it with the most recent runs (a value may list
 * several, comma-separated). Null when no recent run reported one.
 */
async function projectTestIdAttributes(db: DrizzleDB, projectId: number): Promise<string[] | null> {
  const runs = await db
    .select({ metadata: testRuns.metadata })
    .from(testRuns)
    .where(eq(testRuns.projectId, projectId))
    .orderBy(desc(testRuns.startTime))
    .limit(10);
  const names = new Set<string>();
  for (const run of runs) {
    const projectsMeta = (
      run.metadata as { htmlReport?: { projects?: Array<{ use?: { testIdAttribute?: unknown } }> } } | null
    )?.htmlReport?.projects;
    for (const project of projectsMeta ?? []) {
      const value = project?.use?.testIdAttribute;
      if (typeof value !== 'string') continue;
      for (const name of value.split(',')) if (name.trim()) names.add(name.trim());
    }
    if (names.size > 0) break;
  }
  return names.size > 0 ? [...names] : null;
}

/**
 * The viewports of a project's Playwright projects (`use.viewport`), as the
 * most recent run reporting any recorded them. Empty when none did.
 */
async function projectViewports(db: DrizzleDB, projectId: number): Promise<LocatorIndexViewport[]> {
  const runs = await db
    .select({ metadata: testRuns.metadata })
    .from(testRuns)
    .where(eq(testRuns.projectId, projectId))
    .orderBy(desc(testRuns.startTime))
    .limit(10);
  for (const run of runs) {
    const projectsMeta = (
      run.metadata as { htmlReport?: { projects?: Array<{ name?: unknown; use?: { viewport?: unknown } }> } } | null
    )?.htmlReport?.projects;
    const viewports: LocatorIndexViewport[] = [];
    for (const project of projectsMeta ?? []) {
      const viewport = project?.use?.viewport as { width?: unknown; height?: unknown } | null | undefined;
      const { width, height } = viewport ?? {};
      if (typeof project?.name !== 'string' || typeof width !== 'number' || typeof height !== 'number') continue;
      if (width > 0 && height > 0 && !viewports.some((v) => v.project === project.name)) {
        viewports.push({ project: project.name, width, height });
      }
    }
    if (viewports.length > 0) return viewports;
  }
  return [];
}

/**
 * A project's locator index as one document: every distinct chain its tests
 * used, with each test's actions, call sites, Playwright projects and
 * branches, the chains reaching the most tests first. Carries each test's
 * latest outcome and the test id attributes the project reads, so a client can
 * resolve the chains against a live page on its own. Describes `opts.branch`
 * (a branch name, `*` for every branch, nothing for the default branch). Null
 * when the project does not exist.
 */
export async function getLocatorIndex(
  db: DrizzleDB,
  projectId: number,
  opts: { maxLocators?: number; maxRows?: number; branch?: string | null } = {},
): Promise<LocatorIndex | null> {
  const [project] = await db
    .select({ id: projects.id, name: projects.name, builtAt: projects.locatorIndexBuiltAt })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) return null;

  const view = await resolveBranchView(db, projectId, opts.branch);
  const keep = await branchFilter(db, projectId, view);
  const maxRows = opts.maxRows ?? 200_000;
  const rows = await db
    .select({
      testCaseId: locatorUsages.testCaseId,
      locator: locatorUsages.locator,
      action: locatorUsages.action,
      browserName: locatorUsages.browserName,
      branch: locatorUsages.branch,
      callSite: locatorUsages.callSite,
      page: locatorUsages.page,
      arrival: locatorUsages.arrival,
      lastSeenAt: locatorUsages.lastSeenAt,
    })
    .from(locatorUsages)
    .where(and(eq(locatorUsages.projectId, projectId), branchCondition(view)))
    .orderBy(desc(locatorUsages.lastSeenAt))
    .limit(maxRows + 1);
  let truncated = rows.length > maxRows;

  interface DraftUse {
    actions: string[];
    callSites: string[];
    projects: string[];
    branches: string[];
    /** Page key → whether a call ran there on arrival. */
    pages: Map<string, boolean>;
  }
  interface Draft {
    lastSeenAt: number;
    uses: Map<number, DraftUse>;
  }
  const drafts = new Map<string, Draft>();
  for (const r of rows.slice(0, maxRows)) {
    if (!keep(r)) continue;
    const seenAt = new Date(r.lastSeenAt).getTime();
    let draft = drafts.get(r.locator);
    if (!draft) drafts.set(r.locator, (draft = { lastSeenAt: seenAt, uses: new Map() }));
    if (seenAt > draft.lastSeenAt) draft.lastSeenAt = seenAt;
    let use = draft.uses.get(r.testCaseId);
    if (!use) {
      draft.uses.set(
        r.testCaseId,
        (use = { actions: [], callSites: [], projects: [], branches: [], pages: new Map() }),
      );
    }
    if (r.page) use.pages.set(r.page, (use.pages.get(r.page) ?? false) || r.arrival);
    if (!use.actions.includes(r.action)) use.actions.push(r.action);
    if (r.callSite && !use.callSites.includes(r.callSite)) use.callSites.push(r.callSite);
    if (r.browserName && !use.projects.includes(r.browserName)) use.projects.push(r.browserName);
    const branch = branchName(r.branch, view);
    if (!use.branches.includes(branch)) use.branches.push(branch);
  }

  const maxLocators = opts.maxLocators ?? 20_000;
  const ranked = [...drafts.entries()].sort(
    ([a, da], [b, db2]) =>
      db2.uses.size - da.uses.size || db2.lastSeenAt - da.lastSeenAt || (a < b ? -1 : a > b ? 1 : 0),
  );
  if (ranked.length > maxLocators) truncated = true;
  const kept = ranked.slice(0, maxLocators);

  const testIds = [...new Set(kept.flatMap(([, d]) => [...d.uses.keys()]))];
  const tests = await indexTests(db, testIds, view);
  const position = new Map(tests.map((t, i) => [t.id, i]));

  // Page keys, those the most uses were recorded on first.
  const pageUses = new Map<string, number>();
  for (const [, draft] of kept) {
    for (const use of draft.uses.values())
      for (const page of use.pages.keys()) pageUses.set(page, (pageUses.get(page) ?? 0) + 1);
  }
  const pages = [...pageUses.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([page]) => page);
  const pagePosition = new Map(pages.map((page, i) => [page, i]));

  const locators: LocatorIndexEntry[] = kept.map(([locator, draft]) => ({
    locator,
    lastSeenAt: new Date(draft.lastSeenAt).toISOString(),
    uses: [...draft.uses.entries()]
      .filter(([testCaseId]) => position.has(testCaseId))
      .map(([testCaseId, { pages: onPages, ...use }]) => {
        const out: LocatorIndexEntry['uses'][number] = { test: position.get(testCaseId)!, ...use };
        if (onPages.size === 0) return out;
        const listed = [...onPages.keys()]
          .map((page) => pagePosition.get(page)!)
          .sort((a, b) => a - b)
          .slice(0, MAX_PAGES_PER_USE);
        out.pages = listed;
        const arrival = listed.filter((i) => onPages.get(pages[i]!));
        if (arrival.length) out.arrival = arrival;
        if (onPages.size > MAX_PAGES_PER_USE) out.pagesTruncated = true;
        return out;
      }),
  }));

  const viewports = await projectViewports(db, projectId);
  return {
    projectId: project.id,
    projectName: project.name,
    branch: view.name,
    defaultBranch: view.defaultBranch,
    branches: await indexedBranches(db, projectId),
    builtAt: project.builtAt ? new Date(project.builtAt).toISOString() : null,
    generatedAt: new Date().toISOString(),
    testIdAttributes: await projectTestIdAttributes(db, projectId),
    ...(viewports.length ? { viewports } : {}),
    ...(pages.length ? { pages } : {}),
    tests,
    locators,
    truncated,
  };
}

/** Runs on the default branch: its name, or no branch at all. */
function defaultBranchRuns(defaultBranch: string): SQL {
  return or(isNull(testRuns.branch), eq(testRuns.branch, ''), eq(testRuns.branch, defaultBranch))!;
}

/**
 * Each test's latest execution id in a view: on the branch viewed, else on the
 * default branch; on any branch for every branch together.
 */
async function latestExecutions(db: DrizzleDB, testCaseIds: number[], view: BranchView): Promise<Map<number, number>> {
  const latestWhere = async (condition: SQL | undefined, ids: number[]) =>
    ids.length === 0
      ? []
      : db
          .select({ testCaseId: testRunsCases.testCaseId, id: max(testRunsCases.id) })
          .from(testRunsCases)
          .innerJoin(testRuns, eq(testRuns.id, testRunsCases.testRunId))
          .where(and(inArray(testRunsCases.testCaseId, ids), condition))
          .groupBy(testRunsCases.testCaseId);
  const out = new Map<number, number>();
  const add = (rows: Array<{ testCaseId: number; id: number | null }>) => {
    for (const r of rows) if (r.id != null) out.set(r.testCaseId, r.id);
  };
  if (view.tag === null) {
    add(await latestWhere(undefined, testCaseIds));
    return out;
  }
  if (view.tag !== '') add(await latestWhere(eq(testRuns.branch, view.tag), testCaseIds));
  add(
    await latestWhere(
      defaultBranchRuns(view.defaultBranch),
      testCaseIds.filter((id) => !out.has(id)),
    ),
  );
  return out;
}

/** Cap on the branches an index lists. */
const MAX_INDEXED_BRANCHES = 50;

/** Branches with uses of their own, most recently seen first. */
async function indexedBranches(db: DrizzleDB, projectId: number): Promise<LocatorIndexBranch[]> {
  const rows = await db
    .select({
      name: locatorUsages.branch,
      lastSeenAt: max(locatorUsages.lastSeenAt),
      tests: countDistinct(locatorUsages.testCaseId),
    })
    .from(locatorUsages)
    .where(and(eq(locatorUsages.projectId, projectId), ne(locatorUsages.branch, '')))
    .groupBy(locatorUsages.branch)
    .orderBy(desc(max(locatorUsages.lastSeenAt)))
    .limit(MAX_INDEXED_BRANCHES);
  return rows.map((r) => ({
    name: r.name,
    lastSeenAt: new Date(r.lastSeenAt ?? 0).toISOString(),
    tests: Number(r.tests),
  }));
}
