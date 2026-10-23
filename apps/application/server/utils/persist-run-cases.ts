import { projects, testRuns, testRunsCases, testSuites, networkRequests } from '../database/schema';
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import {
  buildNetworkRequestItems,
  buildNetworkRequestInsertValues,
  type NetworkRequestBuilder,
} from './network-request-helpers';
import {
  capArray,
  capSteps,
  countDroppedSteps,
  countDroppedConsoleEntries,
  capConsoleLogs,
  capErrorText,
  capSourceFrames,
  capText,
  sanitizeWebVitals,
  sanitizeConsoleLogs,
  sanitizeDialogs,
  sanitizePageState,
  sanitizeAiUsage,
} from './sanitize';
import { resolveIngestLimits } from './ingest-limits';
import { normalizeTestCaseStatus } from '#shared/utils/test-counts';
import { upsertCasePayloads } from './case-payloads';
import { GREEN_SAMPLE_MAX_AGE_MS } from '#shared/handlers/aria-sampling';
import { computeErrorFingerprint, type ErrorFingerprint } from '#shared/error-fingerprint';
import { isExpectedFailurePassed, resolveExpectedStatus } from '#shared/status-classify';
import {
  normalizeTestLocks,
  normalizeTestTags,
  parseTestMetadata,
  sanitizeTestMetadata,
} from '@piwitests/core/test-meta';
import { matchInsertedRunCases, resolveRepeatEachIndex } from './inserted-run-cases';
import { testCaseCache } from './test-case-cache';
import { syncTestCaseMetadata, type CaseMetaSnapshot } from './test-case-metadata-sync';
import { displayTitleOf, externalIdOf, recordExternalIdDuplicates, type TestCaseClaim } from './test-case-match';
import { testSuiteCache } from './test-suite-cache';
import { SUITE_PATH_SEP, joinSuitePath } from '#shared/utils/suites';
import { assignFailureClusters, type PendingCluster } from '#shared/handlers/failure-cluster-ops';
import { upsertLocatorSnapshots } from './locator-healing';
import { executionCreatedAt, type PersistRunCasesOptions } from './persist-options';
import { recordIngestHealth, storedDrops, type ExecutionDrops } from './ingest-health';
import {
  ingestRunGraph,
  ingestRequestGraph,
  upsertGraphSpecs,
  ingestPageInventoryGraph,
  collectRunGraphReaches,
  resolveRunBranchTagFromStored,
  runBaseUrls,
  projectRouteOrigins,
} from './graph-ingest';
import { collectOwnOrigins, originsFromDocumentRequests } from '#shared/graph';
import { isLabRun } from '#shared/handlers/probes';
import { eligibleExecutionSql, isEligibleRun } from '#shared/run-eligibility';
import { runFacts, upsertLocatorUsages, type LocatorUsageCase } from './locator-usages';
import { buildCodeReachGraph, sanitizeCodeReach, upsertCodeReach, type CodeReachCase } from './code-reach';
import {
  codeReachOfCoverage,
  coveragePayloadContent,
  upsertCoverageFragments,
  upsertTestCoverage,
  type TestCoverageCase,
} from './coverage';
import { sanitizeCoverage, type CoverageCapture } from '@piwitests/core/coverage';
import { sanitizeLocatorPages } from './locator-pages';
import type { LocatorPageUse } from '@piwitests/core/wire';
import type { LocatorSnapshot } from '#shared/locator-healing.types';
import { sanitizeExecutionResources } from '#shared/resource-report';
import { resolveStoredDefaultBranch } from './scm/stored-default-branch';
import type { DbClient as DB } from '../database';

/** Apply the canonical per-case status spelling to each attempt entry. */
function normalizeAttemptStatuses(attempts: unknown): unknown {
  if (!Array.isArray(attempts)) return attempts;
  return attempts.map((attempt) => {
    if (!attempt || typeof attempt !== 'object') return attempt;
    const status = (attempt as { status?: unknown }).status;
    if (typeof status !== 'string') return attempt;
    return { ...attempt, status: normalizeTestCaseStatus(status) };
  });
}

/**
 * Normalised test-case data ready to be persisted for a run. `filePath` + `suitePath` + `title`
 * identify the shared test case; the remaining fields are stored on the per-run
 * junction row (`test_runs_cases`).
 */
export interface RunCaseInput {
  filePath: string;
  suitePath?: string[] | null;
  suiteConfig?: Array<{ mode: string; annotations: Array<{ type: string; description?: string }> }> | null;
  testAnnotations?: Array<{ type: string; description?: string }> | null;
  /** Tags declared on the test — re-normalized here, so raw reporter input is fine. */
  tags?: unknown;
  /** Lock names the execution held — re-normalized here, so raw reporter input is fine. */
  locks?: unknown;
  /** `piwi:` metadata; re-derived from `testAnnotations` when absent. */
  testMeta?: unknown;
  /**
   * The external ID the reporter settled on, `null` for none. When the field is absent (an older reporter, a payload
   * built by hand) it is read from the `piwi:id` annotation instead.
   */
  externalId?: unknown;
  /** The title without its external ID, when the reporter removed it; `title` stays whole. */
  displayTitle?: unknown;
  title: string;
  status: string;
  duration?: number | null;
  /** Effective per-test timeout in ms (`TestCase.timeout`); `0` means unbounded, null when unknown. */
  timeout?: number | null;
  error?: string | null;
  retries?: number | null;
  /** Playwright's `repeatEachIndex`: which `--repeat-each` repetition the execution is, 0 when absent. */
  repeatEachIndex?: number | null;
  /** Per-attempt outcomes `{ retry, status, duration, startedAt }`, oldest first. */
  attempts?: unknown;
  line: number | null;
  column: number | null;
  steps?: unknown;
  stepEvents?: unknown;
  slowestStep?: string | null;
  slowestStepDuration?: number | null;
  wastedTimeMs?: number | null;
  networkRequests?: unknown;
  webVitals?: unknown;
  pageState?: unknown;
  /** Controls and links per visited page (passing runs) — stored through case_payloads. */
  pageInventory?: unknown;
  /** The page each locator call ran on — stored through case_payloads, joined to the locator index. */
  locatorPages?: unknown;
  /** The source files the test executed — stored through case_payloads, and per test in `code_reach` without `coverage`. */
  codeReach?: unknown;
  /**
   * The test's coverage (`CoverageCapture`) — its fragments in `coverage_fragments`, their ids per execution through
   * case_payloads, per test in `test_coverage`, and its files in `code_reach`.
   */
  coverage?: unknown;
  /** What the execution cost its worker and browsers (`piwi-resources`). */
  resources?: unknown;
  aiUsage?: unknown;
  consoleLogs?: unknown;
  dialogs?: unknown;
  ariaSnapshot?: string | null;
  ariaSnapshotJson?: string | null;
  testSource?: string | null;
  testSourceFrames?: unknown;
  workerIndex?: number | null;
  shardIndex?: number | null;
  startedAt?: number | null;
  browser?: unknown;
  /** Per-element locator snapshots to upsert into locator_snapshots (transient). */
  locatorSnapshots?: LocatorSnapshot[] | null;
  /** Why a `didnotrun` case never executed; null for tests that ran. */
  didNotRunReason?: string | null;
  /** Playwright's `TestCase.expectedStatus`; derived from the annotations when absent. */
  expectedStatus?: string | null;
  /** For a `previous-failure` cascade, the location of the failing test that blocked it. */
  blockedBy?: string | null;
}

function resolveBrowserName(browser: unknown): string | null {
  if (typeof browser === 'string') return browser;
  if (browser && typeof browser === 'object') {
    const b = browser as Record<string, unknown>;
    if (typeof b.projectName === 'string') return b.projectName;
  }
  return null;
}

/**
 * Resolve (upsert) all unique suite paths from the batch into `test_suites`.
 * Returns a map of `${filePath}\x00${suitePathStr}` → suiteId covering every
 * level of every suitePath in the batch.
 *
 * Cache hits still fire a background update so mode/annotations stay fresh
 * when a describe block's config changes between runs.
 */
async function resolveSuites(db: DB, projectId: number, cases: RunCaseInput[]): Promise<Map<string, number>> {
  // Collect unique (filePath, levelPath, mode, annotations) — one entry per
  // describe level per unique suitePath across all cases in the batch.
  type SuiteSpec = { filePath: string; levelPath: string; mode: string; annotations: unknown[] };
  const pending = new Map<string, SuiteSpec>(); // key → spec, deduped

  for (const c of cases) {
    const sp = c.suitePath ?? [];
    for (let i = 0; i < sp.length; i++) {
      const levelPath = sp.slice(0, i + 1).join(SUITE_PATH_SEP);
      const key = `${c.filePath}\x00${levelPath}`;
      if (!pending.has(key)) {
        pending.set(key, {
          filePath: c.filePath,
          levelPath,
          mode: c.suiteConfig?.[i]?.mode ?? 'default',
          annotations: c.suiteConfig?.[i]?.annotations ?? [],
        });
      }
    }
  }

  if (pending.size === 0) return new Map();

  const projectSuiteCache = await testSuiteCache.getProjectCache(db, projectId);
  const suiteIdMap = new Map<string, number>();
  const toUpsert: Array<{ key: string } & SuiteSpec> = [];
  const toUpdate: Array<{ id: number; mode: string; annotations: unknown[] }> = [];

  for (const [key, spec] of pending) {
    const cached = projectSuiteCache.get(`${spec.filePath}\x00${spec.levelPath}`);
    if (cached !== undefined) {
      suiteIdMap.set(key, cached);
      toUpdate.push({ id: cached, mode: spec.mode, annotations: spec.annotations });
    } else {
      toUpsert.push({ key, ...spec });
    }
  }

  // Upsert missing suites sequentially to avoid unique-constraint races
  for (const spec of toUpsert) {
    const result = await db
      .insert(testSuites)
      .values({
        projectId,
        filePath: spec.filePath,
        suitePath: spec.levelPath,
        mode: spec.mode,
        annotations: spec.annotations as any,
      })
      .onConflictDoUpdate({
        target: [testSuites.projectId, testSuites.filePath, testSuites.suitePath],
        set: { mode: spec.mode, annotations: spec.annotations as any, updatedAt: new Date() },
      })
      .returning({ id: testSuites.id });

    const id = result[0]?.id;
    if (id !== undefined) {
      suiteIdMap.set(spec.key, id);
      testSuiteCache.add(projectId, spec.filePath, spec.levelPath, id);
    }
  }

  // Fire-and-forget: refresh mode/annotations for cache hits (they can change between runs)
  if (toUpdate.length > 0) {
    Promise.all(
      toUpdate.map(({ id, mode, annotations }) =>
        db
          .update(testSuites)
          .set({ mode, annotations: annotations as any, updatedAt: new Date() })
          .where(eq(testSuites.id, id)),
      ),
    ).catch(() => {});
  }

  return suiteIdMap;
}

/**
 * Drop redundant green ARIA samples before they reach storage. A passing
 * execution's snapshot is kept only when the test has no other green snapshot
 * from the last {@link GREEN_SAMPLE_MAX_AGE_MS} — both against snapshots already
 * stored by runs eligible for shared state and against duplicates within this same
 * batch. Failing snapshots are never touched. Mutates `payloads[i].aria` in place; the rows keep their other
 * evidence, they just stop carrying a duplicate green page.
 */
async function dedupeGreenSamples(
  db: DB,
  rows: Array<typeof testRunsCases.$inferInsert>,
  payloads: Array<{ aria: string | null; ariaJson: string | null; source: string | null; framesJson: string | null }>,
  now: number = Date.now(),
): Promise<void> {
  const cutoff = now - GREEN_SAMPLE_MAX_AGE_MS;
  const seenInBatch = new Set<number>();
  const greenRows: Array<{ index: number; caseId: number }> = [];

  rows.forEach((row, i) => {
    if (row.status !== 'passed' || !payloads[i]!.aria || row.testCaseId == null) return;
    const caseId = row.testCaseId;
    // One green sample per test per batch is enough — drop the rest outright.
    if (seenInBatch.has(caseId)) {
      payloads[i]!.aria = null;
      payloads[i]!.ariaJson = null;
      return;
    }
    seenInBatch.add(caseId);
    greenRows.push({ index: i, caseId });
  });
  if (greenRows.length === 0) return;

  const caseIds = greenRows.map((r) => r.caseId);
  const existing = await db
    .select({
      testCaseId: testRunsCases.testCaseId,
      latest: sql<Date>`max(${testRunsCases.createdAt})`.mapWith(testRunsCases.createdAt),
    })
    .from(testRunsCases)
    .where(
      and(
        inArray(testRunsCases.testCaseId, caseIds),
        eq(testRunsCases.status, 'passed'),
        or(isNotNull(testRunsCases.ariaSnapshotPayloadId), isNotNull(testRunsCases.ariaSnapshot)),
        eligibleExecutionSql('shared-state', testRunsCases.testRunId),
      ),
    )
    .groupBy(testRunsCases.testCaseId);

  const freshById = new Map(existing.map((r) => [r.testCaseId, r.latest.getTime()]));
  for (const { index, caseId } of greenRows) {
    const latest = freshById.get(caseId);
    if (latest != null && latest >= cutoff) {
      payloads[index]!.aria = null;
      payloads[index]!.ariaJson = null;
    }
  }
}

/**
 * Get-or-create the shared `test_cases` rows for a batch and insert the per-run
 * `test_runs_cases` rows in a single statement. Network requests, web vitals and
 * console logs are sanitized here (stripping query strings from URLs). Failed
 * cases with error text are fingerprinted and linked to a `failure_clusters`
 * row so failures sharing a root cause can be grouped.
 *
 * Shared by the submit, upload, import and streaming-events endpoints. Returns
 * one entry per inserted junction row, each carrying the index of the input
 * case that produced it. A skipped duplicate has no entry, so callers link
 * attachments (e.g. trace files) and events to executions by `inputIndex`,
 * never by position in the returned array.
 *
 * Deduplication is enforced by a DB unique index on
 * `(test_run_id, test_case_id, repeat_each_index, retries, browser)`: the
 * `ON CONFLICT DO NOTHING` clause skips rows that would violate it, so a batch
 * sent twice stores its executions once, while each attempt, each Playwright
 * project and each `--repeat-each` repetition of a test is a row of its own.
 */
export async function persistRunCases(
  db: DB,
  projectId: number,
  testRunId: number,
  cases: RunCaseInput[],
  options: PersistRunCasesOptions = {},
): Promise<Array<{ id: number; status: string; testCaseId: number; inputIndex: number }>> {
  if (cases.length === 0) return [];

  const limits = resolveIngestLimits();

  // --- Step 1: Resolve all suites referenced in this batch ---
  const suiteIdMap = await resolveSuites(db, projectId, cases);

  // --- Step 2: Resolve test case IDs and build junction rows ---

  const claims: TestCaseClaim[] = cases.map((c) => {
    const suitePath = joinSuitePath(c.suitePath);
    const externalId = externalIdOf(c);
    return {
      filePath: c.filePath,
      suitePath,
      suiteId: suitePath ? (suiteIdMap.get(`${c.filePath}\x00${suitePath}`) ?? null) : null,
      title: c.title,
      externalId,
      displayTitle: displayTitleOf(c, externalId),
      line: c.line,
    };
  });
  // The run decides what this batch may change on the stored tests: a lab run or an import of an older run matches
  // its tests without renaming, moving or giving an ID to any of them.
  const [run] = await db
    .select({ metadata: testRuns.metadata, branch: testRuns.branch, startTime: testRuns.startTime })
    .from(testRuns)
    .where(eq(testRuns.id, testRunId));
  const writesTestState = isEligibleRun(
    { metadata: run?.metadata, historicalImport: options.keepTestState },
    'shared-state',
  );
  const resolved = await testCaseCache.resolve(db, projectId, testRunId, claims, { readOnly: !writesTestState });

  const fingerprintResults = await Promise.all(
    cases.map((c) =>
      // An expected failure that passed is good news about one test, not a
      // failure mode: it forms no cluster.
      c.error &&
      c.status !== 'passed' &&
      c.status !== 'skipped' &&
      !isExpectedFailurePassed(c.status, resolveExpectedStatus(c.expectedStatus, c.testAnnotations))
        ? computeErrorFingerprint(c.error)
        : Promise.resolve(null),
    ),
  );

  const runCasesRows: Array<typeof testRunsCases.$inferInsert> = [];
  // Input index of each row in `runCasesRows`, so inserted rows can be mapped
  // back to the batch entry that produced them after the insert.
  const rowInputIndices: number[] = [];
  // Capped payload strings per row, deduplicated into case_payloads after the
  // loop; the junction rows store only the payload ids (inline columns stay
  // null on new rows — readers coalesce via inlineCasePayloads).
  const rowPayloads: Array<{
    aria: string | null;
    ariaJson: string | null;
    source: string | null;
    framesJson: string | null;
    inventory: string | null;
    locatorPages: string | null;
    codeReach: string | null;
    coverage: string | null;
  }> = [];
  // Each row's coverage, stored as fragments once the loop has built every row.
  const rowCoverage: Array<CoverageCapture | null> = [];
  // The pages each row ran locator calls on, which the feature graph reads as reach.
  const rowLocatorPages: Array<LocatorPageUse[] | null> = [];
  const networkRequestBuilders: NetworkRequestBuilder[] = [];
  const rowFingerprints: Array<ErrorFingerprint | null> = [];
  // What the caps left out of each row, recorded on the run for the rows stored.
  const rowDrops: ExecutionDrops[] = [];
  const pendingClusters = new Map<string, PendingCluster>();
  // Locator snapshots to upsert, grouped by resolved test case id; the shared
  // helper handles row building, upsert, and stale-location purge after insert.
  const perCaseLocators: Array<{
    caseId: number;
    snapshots: LocatorSnapshot[] | null | undefined;
    purge?: boolean;
  }> = [];
  // Latest tags/metadata per resolved test case, mirrored onto test_cases once
  // the batch is built. A test appearing twice (retries, browsers, repeats)
  // declares the same values, so last-write-wins is safe.
  const caseMetaSnapshots = new Map<number, CaseMetaSnapshot>();
  // Locator uses read from each execution's steps, indexed after the insert.
  const perCaseUsages: LocatorUsageCase[] = [];
  const perCaseReach: CodeReachCase[] = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const fingerprint = fingerprintResults[i] ?? null;
    const caseId = resolved.caseIds[i];

    if (caseId === undefined) continue;

    // Re-normalize on arrival: a payload can reach the ingest API without ever
    // passing through the reporter, so the reporter's normalization is a
    // convenience rather than a guarantee. Annotations win over a supplied
    // `testMeta` because they are the declared source.
    const tags = normalizeTestTags(c.tags);
    const locks = normalizeTestLocks(c.locks).slice(0, limits.locks);
    const testMeta = parseTestMetadata(c.testAnnotations) ?? sanitizeTestMetadata(c.testMeta);
    caseMetaSnapshots.set(caseId, { tags, locks, meta: testMeta, displayTitle: resolved.displayTitles[i] ?? null });

    // Collect locator snapshots; upserted in one batch after the case insert.
    // Only a passed case may purge stale locations — a failed run can stop
    // before reaching later locators (see upsertLocatorSnapshots).
    if (c.locatorSnapshots?.length)
      perCaseLocators.push({ caseId, snapshots: c.locatorSnapshots, purge: c.status === 'passed' });

    // A use missing from a passed execution whose steps were all kept has left
    // the test; any other execution only adds.
    const cappedSteps = capSteps(c.steps, limits);
    rowDrops.push({
      steps: countDroppedSteps(c.steps, limits),
      consoleEntries: countDroppedConsoleEntries(c.consoleLogs, limits),
    });
    const locatorPages = sanitizeLocatorPages(c.locatorPages);
    perCaseUsages.push({
      caseId,
      browserName: resolveBrowserName(c.browser),
      steps: cappedSteps,
      locatorPages,
      filePath: c.filePath,
      runId: testRunId,
      complete: c.status === 'passed' && Array.isArray(c.steps) && c.steps.length <= limits.steps,
    });

    // Code reach comes from the coverage's files when the execution sent coverage, else from its list.
    const coverage = sanitizeCoverage(c.coverage);
    const reached = sanitizeCodeReach(c.codeReach);
    if (coverage) perCaseReach.push(...codeReachOfCoverage(caseId, testRunId, coverage));
    else if (reached) perCaseReach.push({ testCaseId: caseId, runId: testRunId, files: reached });

    if (fingerprint) {
      const pending = pendingClusters.get(fingerprint.fingerprint);
      if (pending) {
        pending.count++;
      } else {
        // The fingerprint is computed from the raw error above; only storage is capped.
        pendingClusters.set(fingerprint.fingerprint, {
          fp: fingerprint,
          sampleError: capText(c.error, limits.sampleErrorChars)!,
          count: 1,
        });
      }
    }
    rowFingerprints.push(fingerprint);

    const aria = capText(c.ariaSnapshot, limits.ariaSnapshotChars);
    const ariaJson = capText(c.ariaSnapshotJson, limits.ariaSnapshotChars);
    const source = capText(c.testSource, limits.testSourceChars);
    const frames = capSourceFrames(c.testSourceFrames, limits);
    const inventory = c.pageInventory != null ? JSON.stringify(c.pageInventory) : null;
    rowLocatorPages.push(locatorPages);
    rowPayloads.push({
      aria,
      ariaJson,
      source,
      framesJson: frames != null ? JSON.stringify(frames) : null,
      inventory,
      locatorPages: locatorPages ? JSON.stringify(locatorPages) : null,
      codeReach: reached ? JSON.stringify(reached) : null,
      coverage: null,
    });
    rowCoverage.push(coverage);

    runCasesRows.push({
      testRunId,
      testCaseId: caseId,
      status: normalizeTestCaseStatus(c.status),
      duration: c.duration ?? null,
      timeout: c.timeout ?? null,
      error: capErrorText(c.error, limits.errorChars),
      retries: c.retries ?? 0,
      repeatEachIndex: resolveRepeatEachIndex(c.repeatEachIndex),
      attempts: capArray(normalizeAttemptStatuses(c.attempts), 30),
      line: c.line,
      column: c.column,
      steps: cappedSteps,
      stepEvents: capArray(c.stepEvents, limits.stepEvents),
      slowestStep: c.slowestStep ?? null,
      slowestStepDuration: c.slowestStepDuration ?? null,
      wastedTimeMs: c.wastedTimeMs ?? null,
      webVitals: sanitizeWebVitals(c.webVitals as Record<string, unknown> | null | undefined) ?? null,
      resources: sanitizeExecutionResources(c.resources),
      pageState: sanitizePageState(c.pageState),
      aiUsage: sanitizeAiUsage(c.aiUsage),
      consoleLogs:
        capConsoleLogs(
          sanitizeConsoleLogs(c.consoleLogs as Array<Record<string, unknown>> | null | undefined),
          limits,
        ) ?? null,
      dialogs: capArray(sanitizeDialogs(c.dialogs), limits.dialogs) ?? null,
      ariaSnapshot: null,
      ariaSnapshotJson: null,
      testSource: null,
      testSourceFrames: null,
      testAnnotations: (c.testAnnotations as any) ?? null,
      tags: tags.length ? tags : null,
      locks: locks.length ? locks : null,
      testMeta,
      browser: c.browser ?? null,
      browserName: resolveBrowserName(c.browser),
      workerIndex: c.workerIndex ?? null,
      shardIndex: c.shardIndex ?? null,
      startedAt: c.startedAt ?? null,
      didNotRunReason: c.didNotRunReason ?? null,
      expectedStatus: resolveExpectedStatus(c.expectedStatus, c.testAnnotations),
      blockedBy: c.blockedBy ?? null,
      ...(options.datedFrom ? { createdAt: executionCreatedAt(c.startedAt, options.datedFrom) } : {}),
    });
    rowInputIndices.push(i);

    const nrItems = buildNetworkRequestItems(c.networkRequests as Array<Record<string, unknown>> | null | undefined);
    networkRequestBuilders.push({ items: nrItems });
  }

  if (runCasesRows.length === 0) return [];

  // A lab run's (probe or flake experiment) failures are injected, not real: it never counts as a real
  // run, so it forms no clusters (exactly as imports are silent). The tests' stored state (locator
  // snapshots, the locator index, code reach, tags and locks) is written only by runs eligible for it.
  const probeRun = isLabRun(run?.metadata);
  const sharedState = isEligibleRun({ metadata: run?.metadata }, 'shared-state');
  // The run above, and the project here, are read once for every helper below,
  // and the project's stored default branch is resolved at most once, on first
  // use. A lab run reaches none of the helpers that read the project.
  const [project] = probeRun
    ? []
    : await db
        .select({ id: projects.id, defaultBranch: projects.defaultBranch, routeOrigins: projects.routeOrigins })
        .from(projects)
        .where(eq(projects.id, projectId));
  let storedDefault: Promise<string> | undefined;
  const storedDefaultBranch = () => (storedDefault ??= resolveStoredDefaultBranch(db, project ?? { id: projectId }));

  // Keep at most one green ARIA sample per test per day: a passing snapshot is
  // dropped when the test already has a recent one, so many runs a day stay bounded.
  await dedupeGreenSamples(db, runCasesRows, rowPayloads);

  // Coverage fragments land first, so each execution's payload can name them.
  const rowFragments = await upsertCoverageFragments(db, projectId, rowCoverage);
  const perCaseCoverage: TestCoverageCase[] = [];
  rowFragments.forEach((fragments, i) => {
    if (!fragments) return;
    rowPayloads[i]!.coverage = coveragePayloadContent(fragments, rowCoverage[i]!.incomplete === true);
    perCaseCoverage.push({ testCaseId: runCasesRows[i]!.testCaseId, runId: testRunId, fragments });
  });

  // Payloads land first so the junction rows can reference them.
  const payloadIds = await upsertCasePayloads(
    db,
    projectId,
    rowPayloads.flatMap((p) => [
      p.aria,
      p.ariaJson,
      p.source,
      p.framesJson,
      p.inventory,
      p.locatorPages,
      p.codeReach,
      p.coverage,
    ]),
  );
  runCasesRows.forEach((row, i) => {
    const p = rowPayloads[i]!;
    row.ariaSnapshotPayloadId = p.aria ? (payloadIds.get(p.aria) ?? null) : null;
    row.ariaSnapshotJsonPayloadId = p.ariaJson ? (payloadIds.get(p.ariaJson) ?? null) : null;
    row.testSourcePayloadId = p.source ? (payloadIds.get(p.source) ?? null) : null;
    row.testSourceFramesPayloadId = p.framesJson ? (payloadIds.get(p.framesJson) ?? null) : null;
    row.pageInventoryPayloadId = p.inventory ? (payloadIds.get(p.inventory) ?? null) : null;
    row.locatorPagesPayloadId = p.locatorPages ? (payloadIds.get(p.locatorPages) ?? null) : null;
    row.codeReachPayloadId = p.codeReach ? (payloadIds.get(p.codeReach) ?? null) : null;
    row.coveragePayloadId = p.coverage ? (payloadIds.get(p.coverage) ?? null) : null;
  });

  if (!probeRun) {
    await assignFailureClusters(db, projectId, testRunId, pendingClusters, runCasesRows, rowFingerprints, {
      wakeSnoozed: !options.keepSnoozed,
    });
  }

  const insertedCases = matchInsertedRunCases(
    runCasesRows,
    await db.insert(testRunsCases).values(runCasesRows).onConflictDoNothing().returning({
      id: testRunsCases.id,
      status: testRunsCases.status,
      testCaseId: testRunsCases.testCaseId,
      retries: testRunsCases.retries,
      repeatEachIndex: testRunsCases.repeatEachIndex,
      browserName: testRunsCases.browserName,
    }),
  );

  const result = insertedCases.map((r) => ({
    id: r.id,
    status: r.status,
    testCaseId: r.testCaseId,
    inputIndex: rowInputIndices[r.rowIndex]!,
  }));

  const nrValues = buildNetworkRequestInsertValues(networkRequestBuilders, insertedCases, testRunId);
  if (nrValues.length > 0) {
    await db.insert(networkRequests).values(nrValues);
  }

  if (writesTestState) await upsertLocatorSnapshots(db, perCaseLocators, testRunId);
  // The index is derived data: a failure to update it degrades to a warning and
  // never fails the ingest.
  if (sharedState) {
    await upsertLocatorUsages(db, projectId, perCaseUsages, {
      runs: new Map(run ? [[testRunId, runFacts(run)]] : []),
      defaultBranch: storedDefaultBranch,
      routeOrigins: projectRouteOrigins(project?.routeOrigins),
    }).catch((err) => console.warn('[locator-usages] failed to index the locators of this batch', err));
    const runLookups = {
      runs: new Map(run ? [[testRunId, { startedAt: new Date(run.startTime), branch: run.branch }]] : []),
      defaultBranch: storedDefaultBranch,
    };
    await upsertCodeReach(db, projectId, perCaseReach, runLookups).catch((err) =>
      console.warn('[code-reach] failed to store the code reach of this batch', err),
    );
    await upsertTestCoverage(db, projectId, perCaseCoverage, runLookups).catch((err) =>
      console.warn('[coverage] failed to store the test coverage of this batch', err),
    );
  }
  if (writesTestState) await syncTestCaseMetadata(db, caseMetaSnapshots);
  await recordExternalIdDuplicates(db, testRunId, resolved.duplicates);
  await recordIngestHealth(
    db,
    testRunId,
    storedDrops(
      rowDrops,
      insertedCases.map((r) => r.rowIndex),
    ),
  );

  // Feed the feature graph from the same rows: route nodes from the network
  // requests (own-origin only), page nodes from page state, and a `reaches` edge
  // per test case, tagged with the run's branch.
  //
  // Scheduled off the request path (fire-and-forget after the caller has its
  // result), so a large run's graph write — seconds on a big upload — never
  // blocks the ingest response; the nightly rebuild reconstructs it from the DB
  // if a write is ever lost. A graph failure degrades to a warning and never
  // surfaces as an ingest error.
  //
  // A lab run replays a test with an injected fault or condition, so its statuses
  // and network traffic are synthetic: it never feeds the canonical graph, or it
  // would mint false orphan-test gaps and turn injected faults into evidence.
  void (async () => {
    try {
      if (probeRun) return;
      let origins = collectOwnOrigins(runBaseUrls(run?.metadata), projectRouteOrigins(project?.routeOrigins));
      // Older reporters recorded no Playwright baseURL; fall back to the origins of
      // this batch's own document requests so route nodes still form from
      // first-party traffic instead of keeping every third-party beacon.
      if (origins.size === 0) {
        origins = originsFromDocumentRequests(networkRequestBuilders.flatMap((b) => b.items));
      }
      // Resolved from stored project fields only — no SCM call on the ingest path.
      const branch = project
        ? await resolveRunBranchTagFromStored(db, project, run?.metadata, run?.branch, storedDefaultBranch)
        : null;

      await ingestRunGraph(
        db,
        projectId,
        testRunId,
        collectRunGraphReaches(
          runCasesRows.map((row, k) => ({
            testCaseId: row.testCaseId,
            pageState: row.pageState,
            locatorPages: rowLocatorPages[k],
          })),
          networkRequestBuilders,
          { origins },
        ),
        { branch },
      );
      // Handler and dependency breadth: `handled-by` and `calls` edges from the
      // server spans forwarded with each request. A no-op for uninstrumented runs.
      await ingestRequestGraph(db, projectId, testRunId, networkRequestBuilders, origins, { branch });
      // The files each test executed, as `file` nodes (origin `coverage`) the test reaches.
      if (perCaseReach.length) {
        await upsertGraphSpecs(db, projectId, testRunId, buildCodeReachGraph(perCaseReach), { branch });
      }

      // Control, link and page-load breadth from the page inventory attached on
      // passing runs. Builders align with runCasesRows; map each back to its input
      // case for its inventory. A no-op when no case carried an inventory.
      const inventoryCases = runCasesRows.map((_, k) => ({
        pageInventory: cases[rowInputIndices[k]!]?.pageInventory,
        networkItems: networkRequestBuilders[k]?.items ?? [],
      }));
      await ingestPageInventoryGraph(db, projectId, testRunId, inventoryCases, origins, { branch });
    } catch (err) {
      console.warn('[graph-ingest] failed to update the feature graph', err);
    }
  })();

  return result;
}
