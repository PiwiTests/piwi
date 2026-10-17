/**
 * Client-side implementations of the reporter streaming endpoints for demo mode.
 *
 * These mirror the server handlers in server/api/test-runs/ (setup, begin,
 * events, finish) so the demo can replay the exact protocol a Piwi reporter
 * speaks while a Playwright run executes. They run inside the service worker
 * against the in-browser SQLite database and publish the same lifecycle
 * events as the server's runEventBus, transported over a BroadcastChannel
 * (see app/demo/run-events.ts).
 */

import { eq, and, or, inArray, sql } from 'drizzle-orm';
import { getDemoDb } from '../db.client';
import { publishDemoGlobalEvent, publishDemoRunEvent } from '../run-events';
import {
  projects,
  testRuns,
  testCases,
  testRunsCases,
  testSuites,
  networkRequests,
} from '~~/server/database/schema.sqlite';
import { parseLocation } from '#shared/parse-location';
import { mapCompleteEventToRunCase } from '~~/server/utils/map-complete-event';
import { mapStepEventsToRunEvents } from '~~/server/utils/map-step-events';
import {
  buildNetworkRequestItems,
  buildNetworkRequestInsertValues,
  type NetworkRequestBuilder,
} from '~~/server/utils/network-request-helpers';
import { matchInsertedRunCases } from '~~/server/utils/inserted-run-cases';
import { upsertLocatorSnapshots } from '~~/server/utils/locator-healing';
import { executionCreatedAt, type PersistRunCasesOptions } from '~~/server/utils/persist-options';
import { carryIngestHealth } from '#shared/ingest-health';
import { recordIngestHealth, storedDrops, type ExecutionDrops } from '~~/server/utils/ingest-health';
import { upsertLocatorUsages, type LocatorUsageCase } from '~~/server/utils/locator-usages';
import { sanitizeLocatorPages } from '~~/server/utils/locator-pages';
import { sanitizeCodeReach, upsertCodeReach, type CodeReachCase } from '~~/server/utils/code-reach';
import {
  codeReachOfCoverage,
  coveragePayloadContent,
  upsertCoverageFragments,
  upsertTestCoverage,
  type TestCoverageCase,
} from '~~/server/utils/coverage';
import { sanitizeCoverage, type CoverageCapture } from '@piwitests/core/coverage';
import { upsertCasePayloads } from '~~/server/utils/case-payloads';
import { resolveRunBranch } from '~~/server/utils/run-branch';
import { runCommit, runOrigin } from '#shared/run-eligibility';
import { applyReporterKeep } from '#shared/handlers/run-keep';
import type { LocatorSnapshot } from '#shared/locator-healing.types';
import {
  capArray,
  capSteps,
  countDroppedSteps,
  countDroppedConsoleEntries,
  capConsoleLogs,
  capErrorText,
  capSourceFrames,
  capText,
  sanitizeAiUsage,
  sanitizeMetadata,
  sanitizeWebVitals,
  sanitizeConsoleLogs,
  sanitizeDialogs,
  sanitizePageState,
} from '~~/server/utils/sanitize';
import { DEFAULT_INGEST_LIMITS } from '#shared/ingest-limits';
import { computeErrorFingerprint, type ErrorFingerprint } from '#shared/error-fingerprint';
import { isExpectedFailurePassed, resolveExpectedStatus } from '#shared/status-classify';
import { durationStats } from '#shared/utils/stats';
import { countFailedFromTally, distinctRunCountsFromAttempts, sumFailedAndTimedOut } from '#shared/utils/test-counts';
import { syncAutoMarkersForRun } from '#shared/handlers/markers';
import { recordRunHealth } from '#shared/handlers/run-health';
import { upsertDailyRollup } from '#shared/handlers/analytics/rollups';
import { recordRunResourceFindings } from '#shared/handlers/resource-findings';
import { joinSuitePath, SUITE_PATH_SEP } from '#shared/utils/suites';
import {
  normalizeTestLocks,
  normalizeTestTags,
  parseTestMetadata,
  sanitizeTestMetadata,
  type TestMetadata,
} from '@piwitests/core/test-meta';
import {
  cancelInstanceRuns as sharedCancelInstanceRuns,
  assignFailureClusters,
  type PendingCluster,
} from '#shared/handlers/failure-cluster-ops';
import type { StreamEventPayload, TestRunFinishPayload, TestRunStartPayload } from '#shared/types';
import { demoHttpError } from './http-error';
import { sanitizeExecutionResources, sanitizeResourceReport } from '#shared/resource-report';
import { saveResourceReportPart } from '#shared/handlers/resource-reports';

type DemoDb = Awaited<ReturnType<typeof getDemoDb>>;

/** Per-run set of shard tokens (mirrors server's RunEventBus.shardTokens) */
const demoShardTokens = new Map<number, Set<string>>();

function randomToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate a run's stream token for events/heartbeat/finish, mirroring the
 * server's `validateAndReviveRun`: an `interrupted` run keeps its stream token,
 * and a request carrying it (or a shard token) revives the run to `running`;
 * anything else must be running with a matching token.
 */
async function validateAndReviveDemoRun(
  db: DemoDb,
  testRun: { id: number; status: string; streamToken: string | null },
  bodyStreamToken: string | null | undefined,
  isValidShardToken: boolean,
): Promise<void> {
  const isInterrupted = testRun.status === 'interrupted';

  if (testRun.status !== 'running' && !isInterrupted) {
    throw demoHttpError(409, 'Test run is not in running state');
  }
  if (!bodyStreamToken) {
    throw demoHttpError(403, 'Missing stream token');
  }
  if (testRun.streamToken !== bodyStreamToken && !isValidShardToken) {
    throw demoHttpError(403, 'Invalid stream token');
  }
  if (isInterrupted) {
    await db.update(testRuns).set({ status: 'running', updatedAt: new Date() }).where(eq(testRuns.id, testRun.id));
    testRun.status = 'running';
  }
}

/** Read shard tokens from a run's metadata JSON (mirrors server shard-tokens.ts). */
function readShardTokensFromMeta(metadata: unknown): Set<string> | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const meta = metadata as Record<string, unknown>;
  const tokens = meta.shardTokens;
  if (!Array.isArray(tokens)) return undefined;
  const strTokens = tokens.filter((t): t is string => typeof t === 'string');
  return strTokens.length > 0 ? new Set(strTokens) : undefined;
}

/** Append a shard token to a run's stored metadata (mirrors server shard-tokens.ts). */
async function persistDemoShardToken(
  db: DemoDb,
  runId: number,
  token: string,
  existingMetadata?: Record<string, unknown> | null,
): Promise<void> {
  let meta: Record<string, unknown>;
  if (existingMetadata) {
    meta = { ...existingMetadata };
  } else {
    const row = await db.select({ metadata: testRuns.metadata }).from(testRuns).where(eq(testRuns.id, runId));
    meta = (row[0]?.metadata as Record<string, unknown>) ?? {};
  }

  const tokens: string[] = Array.isArray(meta.shardTokens) ? [...meta.shardTokens] : [];
  if (tokens.includes(token)) return;
  tokens.push(token);
  meta.shardTokens = tokens;

  await db
    .update(testRuns)
    .set({ metadata: meta, origin: runOrigin(meta), commit: runCommit(meta), updatedAt: new Date() })
    .where(eq(testRuns.id, runId));
}

/** Remove a shard token from a run's stored metadata (mirrors server shard-tokens.ts). */
async function removeStoredDemoShardToken(db: DemoDb, runId: number, token: string): Promise<void> {
  const row = await db.select({ metadata: testRuns.metadata }).from(testRuns).where(eq(testRuns.id, runId));

  const meta = (row[0]?.metadata as Record<string, unknown>) ?? {};
  const tokens: string[] = Array.isArray(meta.shardTokens) ? meta.shardTokens : [];
  const filtered = tokens.filter((t) => t !== token);
  if (filtered.length === tokens.length) return;

  if (filtered.length > 0) {
    meta.shardTokens = filtered;
  } else {
    delete meta.shardTokens;
  }

  await db
    .update(testRuns)
    .set({ metadata: meta, origin: runOrigin(meta), commit: runCommit(meta), updatedAt: new Date() })
    .where(eq(testRuns.id, runId));
}

async function cancelInstanceRuns(
  db: DemoDb,
  projectId: number,
  instanceId: string | null,
  excludeRunId?: number,
  isShardedRun?: boolean,
): Promise<void> {
  const cancelledRuns = await sharedCancelInstanceRuns(db, projectId, instanceId, excludeRunId, isShardedRun);
  for (const run of cancelledRuns) {
    publishDemoGlobalEvent({ type: 'run-cancelled', runId: run.id, projectId: run.projectId, status: 'cancelled' });
  }
}

/** POST /api/test-runs/setup */
/**
 * `scope` is where the acting user holds `run:submit`, with the server's rules
 * (`resolveIngestProject`): an existing project must be in it, and creating
 * one takes it on all projects.
 */
export async function apiSetupTestRun(body: TestRunStartPayload, scope: 'all' | Set<number> = 'all') {
  if (!body?.projectName) {
    throw demoHttpError(400, 'Missing required field: projectName');
  }

  const db = await getDemoDb();

  const existingProjects = await db.select().from(projects).where(eq(projects.name, body.projectName));
  let project = existingProjects[0];

  if (project && scope !== 'all' && !scope.has(project.id)) {
    throw demoHttpError(403, 'No access to this project');
  }
  if (!project && scope !== 'all') {
    throw demoHttpError(403, 'Cannot create a new project — no global access');
  }
  if (!project) {
    const result = await db
      .insert(projects)
      .values({
        name: body.projectName,
        description: body.projectDescription || null,
      })
      .returning();
    project = result[0];
  }

  if (!project) {
    throw new Error('Failed to create or retrieve project');
  }

  const instanceId = body.instanceId || null;
  const shardTotal = body.shardTotal;
  const isSharded = !!(shardTotal && shardTotal > 1);

  if (isSharded && instanceId) {
    const existingRuns = await db
      .select()
      .from(testRuns)
      .where(
        and(
          eq(testRuns.projectId, project.id),
          eq(testRuns.instanceId, instanceId),
          or(eq(testRuns.status, 'running'), eq(testRuns.status, 'initializing')),
        ),
      );

    const existingShardedRun = existingRuns.find((r) => r.shardTotal && r.shardTotal > 1);
    if (existingShardedRun) {
      const setupToken = randomToken();
      const tokens = demoShardTokens.get(existingShardedRun.id) ?? new Set();
      tokens.add(setupToken);
      demoShardTokens.set(existingShardedRun.id, tokens);
      await applyReporterKeep(db, existingShardedRun.id, body.keep);
      return { success: true, runId: existingShardedRun.id, projectId: project.id, setupToken };
    }

    await cancelInstanceRuns(db, project.id, instanceId, undefined, true);

    const setupToken = randomToken();
    const metadata = { shardTokens: [setupToken] } as Record<string, unknown>;
    const testRunResult = await db
      .insert(testRuns)
      .values({
        projectId: project.id,
        status: 'initializing',
        startTime: new Date(body.startTime || new Date().toISOString()),
        duration: null,
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        environment: body.environment || null,
        branch: resolveRunBranch(body.metadata),
        label: body.label || null,
        metadata,
        origin: runOrigin(metadata),
        commit: runCommit(metadata),
        instanceId,
        playwrightVersion: body.playwrightVersion || null,
        reporterVersion: body.reporterVersion || null,
        streamToken: setupToken,
        shardTotal,
        shardIndex: body.shardIndex ?? null,
        shardsFinished: 0,
        isFullRun: body.isFullRun !== false ? 1 : 0,
        filterDetails: body.filterDetails ?? null,
      })
      .returning();

    const testRun = testRunResult[0];
    if (!testRun) throw new Error('Failed to create test run');
    await applyReporterKeep(db, testRun.id, body.keep);
    publishDemoGlobalEvent({ type: 'run-initializing', runId: testRun.id, projectId: project.id });
    return { success: true, runId: testRun.id, projectId: project.id, setupToken };
  }

  await cancelInstanceRuns(db, project.id, instanceId);

  const setupToken = randomToken();

  const testRunResult = await db
    .insert(testRuns)
    .values({
      projectId: project.id,
      status: 'initializing',
      startTime: new Date(body.startTime || new Date().toISOString()),
      duration: null,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      skippedTests: 0,
      environment: body.environment || null,
      branch: resolveRunBranch(body.metadata),
      label: body.label || null,
      metadata: null,
      origin: runOrigin(null),
      commit: runCommit(null),
      instanceId,
      playwrightVersion: body.playwrightVersion || null,
      reporterVersion: body.reporterVersion || null,
      streamToken: setupToken,
      isFullRun: body.isFullRun !== false ? 1 : 0,
      filterDetails: body.filterDetails ?? null,
    })
    .returning();

  const testRun = testRunResult[0];
  if (!testRun) {
    throw new Error('Failed to create test run');
  }
  await applyReporterKeep(db, testRun.id, body.keep);

  publishDemoGlobalEvent({ type: 'run-initializing', runId: testRun.id, projectId: project.id });

  return { success: true, runId: testRun.id, projectId: project.id, setupToken };
}

/** POST /api/test-runs/:id/begin */
export async function apiBeginTestRun(
  id: number,
  body: {
    setupToken: string;
    totalTests?: number;
    metadata?: Record<string, unknown> | null;
    playwrightVersion?: string | null;
    reporterVersion?: string | null;
    shardIndex?: number;
    shardTotal?: number;
    isFullRun?: boolean;
    filterDetails?: Record<string, unknown> | null;
  },
) {
  const db = await getDemoDb();

  const testRunResults = await db.select().from(testRuns).where(eq(testRuns.id, id));
  const testRun = testRunResults[0];

  if (!testRun) throw demoHttpError(404, 'Test run not found');

  const isSharded = !!(testRun.shardTotal && testRun.shardTotal > 1);

  // Parallel worker processes race to /begin on the same run; a running run is
  // tolerated and handed back its existing stream token (server behavior). A
  // sharded run also takes a shard after the stale-run sweep marked it interrupted.
  const canBegin =
    testRun.status === 'initializing' ||
    testRun.status === 'running' ||
    (isSharded && testRun.status === 'interrupted');
  if (!canBegin) {
    throw demoHttpError(409, 'Test run cannot be transitioned to running state');
  }

  // Validate token: main streamToken or shard token
  const shardTokenSet = demoShardTokens.get(id);
  const isValidShardSetupToken = isSharded && shardTokenSet?.has(body.setupToken);
  if (testRun.streamToken !== body.setupToken && !isValidShardSetupToken) {
    throw demoHttpError(403, 'Invalid setup token');
  }
  // A setup token opens one /begin.
  shardTokenSet?.delete(body.setupToken);

  const streamToken = randomToken();

  if (testRun.status === 'initializing') {
    if (isSharded) {
      // A shard's stream token is one of the run's shard tokens, so two shards
      // that begin at once both keep theirs (server behavior).
      const tokens = demoShardTokens.get(id) ?? new Set();
      tokens.add(streamToken);
      demoShardTokens.set(id, tokens);
    }

    await cancelInstanceRuns(db, testRun.projectId, testRun.instanceId, id, isSharded);

    const metadata = carryIngestHealth(
      sanitizeMetadata(body.metadata || (testRun.metadata as Record<string, unknown> | null)),
      testRun.metadata,
    );
    await db
      .update(testRuns)
      .set({
        status: 'running',
        streamToken,
        totalTests: body.totalTests || 0,
        branch: resolveRunBranch(body.metadata || testRun.metadata),
        metadata,
        origin: runOrigin(metadata),
        commit: runCommit(metadata),
        playwrightVersion: body.playwrightVersion || (testRun.playwrightVersion as string | null),
        reporterVersion: body.reporterVersion || (testRun.reporterVersion as string | null),
        isFullRun: body.isFullRun !== false ? 1 : 0,
        filterDetails: body.filterDetails ?? (testRun.filterDetails as Record<string, unknown> | null),
      })
      .where(eq(testRuns.id, id));

    publishDemoGlobalEvent({ type: 'run-started', runId: testRun.id, projectId: testRun.projectId });
  } else if (isSharded) {
    // Subsequent shard in a sharded run: register the per-shard stream token
    // in memory and in the run's stored metadata (so a service-worker restart
    // mid-run keeps accepting the shard's events), and add the shard's slice
    // of the planned suite to the run's total.
    const tokens = demoShardTokens.get(id) ?? new Set();
    tokens.add(streamToken);
    demoShardTokens.set(id, tokens);
    await persistDemoShardToken(db, id, streamToken, testRun.metadata as Record<string, unknown> | null);
    if (body.totalTests) {
      await db
        .update(testRuns)
        .set({ totalTests: sql`${testRuns.totalTests} + ${body.totalTests}` })
        .where(eq(testRuns.id, id));
    }
  } else {
    // Already running — the caller keeps streaming on the stored token.
    return {
      success: true,
      runId: testRun.id,
      projectId: testRun.projectId,
      streamToken: testRun.streamToken ?? streamToken,
    };
  }

  return { success: true, runId: testRun.id, projectId: testRun.projectId, streamToken };
}

// ── persistRunCases (mirrors server/utils/persist-run-cases.ts) ────────────

export interface RunCaseInput {
  filePath: string;
  /** Describe blocks wrapping the test; part of a case's identity. */
  suitePath?: string[] | null;
  suiteConfig?: Array<{ mode: string; annotations: Array<{ type: string; description?: string }> }> | null;
  title: string;
  timeout?: number | null;
  wastedTimeMs?: number | null;
  testSource?: string | null;
  testSourceFrames?: unknown;
  testAnnotations?: unknown;
  tags?: unknown;
  locks?: unknown;
  testMeta?: unknown;
  status: string;
  duration?: number | null;
  error?: string | null;
  retries?: number | null;
  attempts?: unknown;
  line: number | null;
  column: number | null;
  steps?: unknown;
  stepEvents?: unknown;
  slowestStep?: string | null;
  slowestStepDuration?: number | null;
  networkRequests?: unknown;
  webVitals?: unknown;
  pageState?: unknown;
  /** The page each locator call ran on (capture fixtures). */
  locatorPages?: unknown;
  /** The source files the test executed (code reach). */
  codeReach?: unknown;
  /** The test's coverage (`CoverageCapture`). */
  coverage?: unknown;
  /** What the execution cost its worker and browsers (`piwi-resources`). */
  resources?: unknown;
  aiUsage?: unknown;
  consoleLogs?: unknown;
  dialogs?: unknown;
  ariaSnapshot?: string | null;
  ariaSnapshotJson?: string | null;
  workerIndex?: number | null;
  shardIndex?: number | null;
  startedAt?: number | null;
  browser?: unknown;
  locatorSnapshots?: unknown;
  didNotRunReason?: string | null;
  expectedStatus?: string | null;
  blockedBy?: string | null;
}

/** Browser identity for the unique (run, case, retries, browser) key. */
function resolveBrowserName(browser: unknown): string | null {
  if (typeof browser === 'string') return browser;
  if (browser && typeof browser === 'object') {
    const b = browser as Record<string, unknown>;
    if (typeof b.projectName === 'string') return b.projectName;
  }
  return null;
}

/**
 * Resolve (upsert) all unique suite paths from the batch into `test_suites`,
 * mirroring the server's `resolveSuites` (without its project cache — the demo
 * DB is small enough to query the unique index directly).
 */
async function resolveSuites(db: DemoDb, projectId: number, cases: RunCaseInput[]): Promise<Map<string, number>> {
  type SuiteSpec = { filePath: string; levelPath: string; mode: string; annotations: unknown[] };
  const pending = new Map<string, SuiteSpec>();

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

  const suiteIdMap = new Map<string, number>();
  for (const [key, spec] of pending) {
    const result = await db
      .insert(testSuites)
      .values({
        projectId,
        filePath: spec.filePath,
        suitePath: spec.levelPath,
        mode: spec.mode,
        annotations: spec.annotations as never,
      })
      .onConflictDoUpdate({
        target: [testSuites.projectId, testSuites.filePath, testSuites.suitePath],
        set: { mode: spec.mode, annotations: spec.annotations as never, updatedAt: new Date() },
      })
      .returning({ id: testSuites.id });
    const id = result[0]?.id;
    if (id !== undefined) suiteIdMap.set(key, id);
  }
  return suiteIdMap;
}

/** Latest-known tags, locks + `piwi:` metadata for one test case, as stored. */
interface CaseMetaSnapshot {
  tags: string[];
  locks: string[];
  meta: TestMetadata | null;
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameSnapshot(stored: CaseMetaSnapshot, incoming: CaseMetaSnapshot): boolean {
  if (!sameStringList(stored.tags, incoming.tags)) return false;
  if (!sameStringList(stored.locks, incoming.locks)) return false;
  const a = stored.meta ?? {};
  const b = incoming.meta ?? {};
  return a.owner === b.owner && a.priority === b.priority && a.feature === b.feature && a.link === b.link;
}

/** Mirror each reported test's tags/`piwi:` metadata onto its `test_cases` row. */
async function syncTestCaseMetadata(db: DemoDb, incoming: Map<number, CaseMetaSnapshot>): Promise<void> {
  if (incoming.size === 0) return;

  const ids = [...incoming.keys()];
  const stored = await db
    .select({
      id: testCases.id,
      tags: testCases.tags,
      locks: testCases.locks,
      owner: testCases.owner,
      priority: testCases.priority,
      feature: testCases.feature,
      link: testCases.link,
    })
    .from(testCases)
    .where(inArray(testCases.id, ids));

  const storedById = new Map<number, CaseMetaSnapshot>(
    stored.map((row) => [
      row.id,
      {
        tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
        locks: Array.isArray(row.locks) ? (row.locks as string[]) : [],
        meta: sanitizeTestMetadata({
          owner: row.owner,
          priority: row.priority,
          feature: row.feature,
          link: row.link,
        }),
      },
    ]),
  );

  for (const [caseId, next] of incoming) {
    const current = storedById.get(caseId);
    if (current && sameSnapshot(current, next)) continue;

    await db
      .update(testCases)
      .set({
        tags: next.tags.length ? next.tags : null,
        locks: next.locks.length ? next.locks : null,
        owner: next.meta?.owner ?? null,
        priority: next.meta?.priority ?? null,
        feature: next.meta?.feature ?? null,
        link: next.meta?.link ?? null,
        updatedAt: new Date(),
      })
      .where(eq(testCases.id, caseId));
  }
}

export async function persistRunCases(
  db: DemoDb,
  projectId: number,
  testRunId: number,
  cases: RunCaseInput[],
  deduplicate?: boolean,
  options: PersistRunCasesOptions = {},
): Promise<Array<{ id: number; status: string; testCaseId: number; inputIndex: number }>> {
  if (cases.length === 0) return [];

  const suiteIdMap = await resolveSuites(db, projectId, cases);

  const uniqueFilePaths = [...new Set(cases.map((c) => c.filePath))];
  const existingCaseRows = await db
    .select()
    .from(testCases)
    .where(and(eq(testCases.projectId, projectId), inArray(testCases.filePath, uniqueFilePaths)));

  const existingCaseMap = new Map<string, (typeof existingCaseRows)[0]>();
  for (const tc of existingCaseRows) {
    existingCaseMap.set(`${tc.filePath}::${tc.suitePath ?? ''}::${tc.title}`, tc);
  }

  let existingRunCaseSet: Set<string> | null = null;
  if (deduplicate) {
    const existingRunCases = await db
      .select({
        testCaseId: testRunsCases.testCaseId,
        retries: testRunsCases.retries,
        browserName: testRunsCases.browserName,
      })
      .from(testRunsCases)
      .where(eq(testRunsCases.testRunId, testRunId));
    // Same composite key as the DB unique index (run, case, retries, browser).
    existingRunCaseSet = new Set(existingRunCases.map((r) => `${r.testCaseId}::${r.retries}::${r.browserName ?? ''}`));
  }

  const runCasesRows: Array<typeof testRunsCases.$inferInsert> = [];
  // Input index of each row in `runCasesRows`, so inserted rows can be mapped
  // back to the batch entry that produced them after the insert.
  const rowInputIndices: number[] = [];
  const networkRequestBuilders: NetworkRequestBuilder[] = [];
  const rowFingerprints: Array<ErrorFingerprint | null> = [];
  const rowDrops: ExecutionDrops[] = [];
  const pendingClusters = new Map<string, PendingCluster>();
  const perCaseLocators: Array<{
    caseId: number;
    snapshots: LocatorSnapshot[] | null | undefined;
    purge?: boolean;
  }> = [];
  const perCaseUsages: LocatorUsageCase[] = [];
  // The page each locator call ran on, per row: stored through case_payloads,
  // like the server, so a rebuild of the index keeps them.
  const rowLocatorPages: Array<string | null> = [];
  const rowCodeReach: Array<string | null> = [];
  const perCaseReach: CodeReachCase[] = [];
  const rowCoverage: Array<CoverageCapture | null> = [];
  const caseMetaSnapshots = new Map<number, CaseMetaSnapshot>();

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const suitePath = joinSuitePath(c.suitePath);
    const cacheKey = `${c.filePath}::${suitePath}::${c.title}`;
    let shared = existingCaseMap.get(cacheKey);

    if (!shared) {
      const result = await db
        .insert(testCases)
        .values({
          projectId,
          filePath: c.filePath,
          suitePath,
          suiteId: suitePath ? (suiteIdMap.get(`${c.filePath}\x00${suitePath}`) ?? null) : null,
          title: c.title,
        })
        .returning();
      shared = result[0];
      if (shared) existingCaseMap.set(cacheKey, shared);
    } else {
      await db.update(testCases).set({ updatedAt: new Date() }).where(eq(testCases.id, shared.id));
    }

    if (!shared) continue;

    // Re-normalize on arrival, like the server — annotations win over a
    // supplied `testMeta` because they are the declared source.
    const tags = normalizeTestTags(c.tags);
    const locks = normalizeTestLocks(c.locks).slice(0, DEFAULT_INGEST_LIMITS.locks);
    const testMeta = parseTestMetadata(c.testAnnotations) ?? sanitizeTestMetadata(c.testMeta);
    caseMetaSnapshots.set(shared.id, { tags, locks, meta: testMeta });

    if (deduplicate && existingRunCaseSet) {
      const rowKey = `${shared.id}::${c.retries ?? 0}::${resolveBrowserName(c.browser) ?? ''}`;
      if (existingRunCaseSet.has(rowKey)) continue;
    }

    let fingerprint: ErrorFingerprint | null = null;
    const expectedStatus = resolveExpectedStatus(c.expectedStatus, c.testAnnotations);
    if (
      c.error &&
      c.status !== 'passed' &&
      c.status !== 'skipped' &&
      !isExpectedFailurePassed(c.status, expectedStatus)
    ) {
      fingerprint = await computeErrorFingerprint(c.error);
      const pending = pendingClusters.get(fingerprint.fingerprint);
      if (pending) {
        pending.count++;
      } else {
        // The fingerprint is computed from the raw error above; only storage is capped.
        pendingClusters.set(fingerprint.fingerprint, {
          fp: fingerprint,
          sampleError: capText(c.error, DEFAULT_INGEST_LIMITS.sampleErrorChars)!,
          count: 1,
        });
      }
    }
    rowFingerprints.push(fingerprint);

    const cappedSteps = capSteps(c.steps, DEFAULT_INGEST_LIMITS);
    rowDrops.push({
      steps: countDroppedSteps(c.steps, DEFAULT_INGEST_LIMITS),
      consoleEntries: countDroppedConsoleEntries(c.consoleLogs, DEFAULT_INGEST_LIMITS),
    });
    const locatorPages = sanitizeLocatorPages(c.locatorPages);
    rowLocatorPages.push(locatorPages ? JSON.stringify(locatorPages) : null);
    const coverage = sanitizeCoverage(c.coverage);
    rowCoverage.push(coverage);
    const reached = sanitizeCodeReach(c.codeReach);
    rowCodeReach.push(reached ? JSON.stringify(reached) : null);
    if (coverage) perCaseReach.push(...codeReachOfCoverage(shared.id, testRunId, coverage));
    else if (reached) perCaseReach.push({ testCaseId: shared.id, runId: testRunId, files: reached });
    perCaseUsages.push({
      caseId: shared.id,
      browserName: resolveBrowserName(c.browser),
      steps: cappedSteps,
      locatorPages,
      filePath: c.filePath,
      runId: testRunId,
      complete: c.status === 'passed' && Array.isArray(c.steps) && c.steps.length <= DEFAULT_INGEST_LIMITS.steps,
    });

    if (Array.isArray(c.locatorSnapshots) && c.locatorSnapshots.length)
      perCaseLocators.push({
        caseId: shared.id,
        snapshots: c.locatorSnapshots as LocatorSnapshot[],
        purge: c.status === 'passed',
      });

    runCasesRows.push({
      testRunId,
      testCaseId: shared.id,
      status: c.status,
      duration: c.duration ?? null,
      error: capErrorText(c.error, DEFAULT_INGEST_LIMITS.errorChars),
      retries: c.retries ?? 0,
      attempts: capArray(c.attempts, 30),
      line: c.line,
      column: c.column,
      steps: cappedSteps,
      stepEvents: capArray(c.stepEvents, DEFAULT_INGEST_LIMITS.stepEvents),
      slowestStep: c.slowestStep ?? null,
      slowestStepDuration: c.slowestStepDuration ?? null,
      webVitals: sanitizeWebVitals(c.webVitals as Record<string, unknown> | null | undefined) ?? null,
      pageState: sanitizePageState(c.pageState),
      aiUsage: sanitizeAiUsage(c.aiUsage),
      consoleLogs:
        capConsoleLogs(
          sanitizeConsoleLogs(c.consoleLogs as Array<Record<string, unknown>> | null | undefined),
          DEFAULT_INGEST_LIMITS,
        ) ?? null,
      dialogs: capArray(sanitizeDialogs(c.dialogs), DEFAULT_INGEST_LIMITS.dialogs) ?? null,
      // Demo-mode rows keep writing inline (never case_payloads), which
      // permanently exercises the readers' payload → inline fallback.
      ariaSnapshot: capText(c.ariaSnapshot, DEFAULT_INGEST_LIMITS.ariaSnapshotChars),
      ariaSnapshotJson: capText(c.ariaSnapshotJson, DEFAULT_INGEST_LIMITS.ariaSnapshotChars),
      testSource: capText(c.testSource, DEFAULT_INGEST_LIMITS.testSourceChars),
      testSourceFrames: capSourceFrames(c.testSourceFrames, DEFAULT_INGEST_LIMITS),
      testAnnotations: (c.testAnnotations as never) ?? null,
      tags: tags.length ? tags : null,
      locks: locks.length ? locks : null,
      testMeta,
      browser: c.browser ?? null,
      browserName: resolveBrowserName(c.browser),
      timeout: c.timeout ?? null,
      wastedTimeMs: c.wastedTimeMs ?? null,
      resources: sanitizeExecutionResources(c.resources),
      workerIndex: c.workerIndex ?? null,
      shardIndex: c.shardIndex ?? null,
      startedAt: c.startedAt ?? null,
      didNotRunReason: c.didNotRunReason ?? null,
      expectedStatus,
      blockedBy: c.blockedBy ?? null,
      ...(options.datedFrom ? { createdAt: executionCreatedAt(c.startedAt, options.datedFrom) } : {}),
    });
    rowInputIndices.push(i);

    const nrItems = buildNetworkRequestItems(c.networkRequests as Array<Record<string, unknown>> | null | undefined);
    networkRequestBuilders.push({ items: nrItems });
  }

  if (runCasesRows.length === 0) return [];

  const rowFragments = await upsertCoverageFragments(db, projectId, rowCoverage);
  const rowCoveragePayload = rowFragments.map((fragments, i) =>
    fragments ? coveragePayloadContent(fragments, rowCoverage[i]!.incomplete === true) : null,
  );
  const perCaseCoverage: TestCoverageCase[] = [];
  rowFragments.forEach((fragments, i) => {
    if (fragments) perCaseCoverage.push({ testCaseId: runCasesRows[i]!.testCaseId, runId: testRunId, fragments });
  });
  const pagePayloadIds = await upsertCasePayloads(db, projectId, [
    ...rowLocatorPages,
    ...rowCodeReach,
    ...rowCoveragePayload,
  ]);
  runCasesRows.forEach((row, i) => {
    const content = rowLocatorPages[i];
    row.locatorPagesPayloadId = content ? (pagePayloadIds.get(content) ?? null) : null;
    const reach = rowCodeReach[i];
    row.codeReachPayloadId = reach ? (pagePayloadIds.get(reach) ?? null) : null;
    const coverage = rowCoveragePayload[i];
    row.coveragePayloadId = coverage ? (pagePayloadIds.get(coverage) ?? null) : null;
  });

  await assignFailureClusters(db, projectId, testRunId, pendingClusters, runCasesRows, rowFingerprints, {
    wakeSnoozed: !options.keepSnoozed,
  });

  // ON CONFLICT DO NOTHING + the (run, case, retries, browser) unique index keep
  // this idempotent across batch retries and same-test-different-browser rows.
  const insertedCases = matchInsertedRunCases(
    runCasesRows,
    await db.insert(testRunsCases).values(runCasesRows).onConflictDoNothing().returning({
      id: testRunsCases.id,
      status: testRunsCases.status,
      testCaseId: testRunsCases.testCaseId,
      retries: testRunsCases.retries,
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

  if (!options.keepTestState) await upsertLocatorSnapshots(db, perCaseLocators, testRunId);
  await upsertLocatorUsages(db, projectId, perCaseUsages).catch(() => {});
  await upsertCodeReach(db, projectId, perCaseReach).catch(() => {});
  await upsertTestCoverage(db, projectId, perCaseCoverage).catch(() => {});
  if (!options.keepTestState) await syncTestCaseMetadata(db, caseMetaSnapshots);
  await recordIngestHealth(
    db,
    testRunId,
    storedDrops(
      rowDrops,
      insertedCases.map((r) => r.rowIndex),
    ),
  );

  return result;
}

/**
 * The `watched` flag of the events and heartbeat answers. The demo cannot see
 * who listens on its BroadcastChannel, so it always answers that someone does,
 * which keeps a reporter's step events flowing.
 */
const DEMO_RUN_WATCHED = true;

/** POST /api/test-runs/:id/events */
export async function apiPostRunEvents(
  id: number,
  body: { streamToken: string; testCases?: StreamEventPayload[]; testCase?: StreamEventPayload },
) {
  const db = await getDemoDb();

  const testRunResults = await db.select().from(testRuns).where(eq(testRuns.id, id));
  const testRun = testRunResults[0];

  if (!testRun) throw demoHttpError(404, 'Test run not found');
  const shardTokenSet = demoShardTokens.get(id) ?? readShardTokensFromMeta(testRun.metadata);
  const isValidShardToken = body.streamToken ? shardTokenSet?.has(body.streamToken) : false;
  await validateAndReviveDemoRun(db, testRun, body.streamToken, !!isValidShardToken);

  const testCaseEvents = Array.isArray(body.testCases) ? body.testCases : [body.testCase];
  const validEvents = testCaseEvents.filter((tc): tc is StreamEventPayload => Boolean(tc && tc.title));

  const beginEvents = validEvents.filter((tc) => tc.type === 'begin');
  const completeEvents = validEvents.filter((tc) => tc.type === 'complete');
  const stepRunEvents = mapStepEventsToRunEvents(validEvents);

  for (const tc of beginEvents) {
    const loc = tc.location ? parseLocation(tc.location) : { filePath: 'unknown', line: null, column: null };
    const filePath = loc.filePath;
    publishDemoRunEvent(id, {
      type: 'test-begin',
      data: {
        title: tc.title,
        filePath,
        suitePath: (tc as { suitePath?: string[] | null }).suitePath ?? null,
        location: tc.location,
        workerIndex: tc.workerIndex ?? null,
        shardIndex: tc.shardIndex ?? null,
        startedAt: tc.startedAt ?? null,
        browser: tc.browser ?? null,
      },
    });
  }

  // Step events publish in batch order through the helper the server's events
  // handler (server/api/test-runs/[id]/events.post.ts) uses.
  for (const stepEvent of stepRunEvents) {
    publishDemoRunEvent(id, stepEvent);
  }

  if (completeEvents.length === 0) {
    return { success: true, processed: beginEvents.length + stepRunEvents.length, watched: DEMO_RUN_WATCHED };
  }

  const parsedEvents = completeEvents.map((tc) => {
    const { filePath, line, column } = tc.location
      ? parseLocation(tc.location)
      : { filePath: 'unknown', line: null, column: null };
    return { ...tc, filePath, line, column };
  });

  // Use the shared wire-field → RunCaseInput mapping so demo-mode ingest cannot
  // drift from the live server ingest (a prior drift here dropped stepEvents,
  // which made timeline wasted-time bars disappear after a reload).
  const cases: RunCaseInput[] = parsedEvents.map((tc) => mapCompleteEventToRunCase(tc));

  const insertedRunCases = await persistRunCases(db, testRun.projectId, id, cases, true);

  // Derive status counts from the actually inserted rows (the unique index can
  // skip duplicates), matching the server's events handler.
  const insertedStatusCounts = insertedRunCases.reduce(
    (acc: Record<string, number>, row: { status: string }) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  // `totalTests` is the planned suite size set at /start, so it is left as-is
  // here — incrementing per row would count retry attempts as extra tests
  // (mirrors the server's events handler).
  const updatedRuns = await db
    .update(testRuns)
    .set({
      updatedAt: new Date(),
      passedTests: sql`${testRuns.passedTests} + ${insertedStatusCounts['passed'] || 0}`,
      failedTests: sql`${testRuns.failedTests} + ${countFailedFromTally(insertedStatusCounts)}`,
      skippedTests: sql`${testRuns.skippedTests} + ${insertedStatusCounts['skipped'] || 0}`,
      didNotRunTests: sql`${testRuns.didNotRunTests} + ${insertedStatusCounts['didnotrun'] || 0}`,
    })
    .where(eq(testRuns.id, id))
    .returning();

  const updatedRun = updatedRuns[0] ?? testRun;

  // The persisted execution id rides along so the live run page can deep-link
  // each row to its real case page instead of a fabricated id (mirrors the
  // server's events handler).
  const persistedByInputIndex = new Map(
    insertedRunCases.filter((r) => r.inputIndex >= 0).map((r) => [r.inputIndex, r]),
  );

  for (const [index, tc] of parsedEvents.entries()) {
    const persisted = persistedByInputIndex.get(index);
    publishDemoRunEvent(id, {
      type: 'test-completed',
      data: {
        title: tc.title,
        filePath: tc.filePath,
        suitePath: (tc as { suitePath?: string[] | null }).suitePath ?? null,
        status: tc.status,
        duration: tc.duration,
        location: tc.location,
        error: tc.error ?? null,
        stepEvents: (tc as { stepEvents?: unknown }).stepEvents ?? null,
        wastedTimeMs: (tc as { wastedTimeMs?: number | null }).wastedTimeMs ?? null,
        workerIndex: tc.workerIndex ?? null,
        shardIndex: tc.shardIndex ?? null,
        startedAt: tc.startedAt ?? null,
        browser: tc.browser ?? null,
        // Mirrors the server: the attempt number lets the live page mark a
        // passed-on-retry (flaky) test as passing rather than failing.
        retries: (tc as { retries?: number | null }).retries ?? null,
        executionId: persisted?.id ?? null,
        testCaseId: persisted?.testCaseId ?? null,
      },
    });
  }

  publishDemoRunEvent(id, {
    type: 'run-progress',
    data: {
      totalTests: updatedRun.totalTests,
      passedTests: updatedRun.passedTests,
      failedTests: updatedRun.failedTests,
      skippedTests: updatedRun.skippedTests,
      didNotRunTests: updatedRun.didNotRunTests,
    },
  });

  return { success: true, processed: insertedRunCases.length + beginEvents.length, watched: DEMO_RUN_WATCHED };
}

/** POST /api/test-runs/:id/heartbeat */
export async function apiHeartbeatTestRun(id: number, body: { streamToken?: string }) {
  const db = await getDemoDb();

  const testRunResults = await db.select().from(testRuns).where(eq(testRuns.id, id));
  const testRun = testRunResults[0];

  if (!testRun) throw demoHttpError(404, 'Test run not found');
  const shardTokenSet = demoShardTokens.get(id) ?? readShardTokensFromMeta(testRun.metadata);
  const isValidShardToken = body.streamToken ? shardTokenSet?.has(body.streamToken) : false;
  await validateAndReviveDemoRun(db, testRun, body.streamToken, !!isValidShardToken);

  await db.update(testRuns).set({ updatedAt: new Date() }).where(eq(testRuns.id, id));

  return { success: true, watched: DEMO_RUN_WATCHED };
}

/** POST /api/test-runs/:id/finish (demo mode has no pending uploads) */
export async function apiFinishTestRun(id: number, body: TestRunFinishPayload) {
  const db = await getDemoDb();

  const testRunResults = await db.select().from(testRuns).where(eq(testRuns.id, id));
  const testRun = testRunResults[0];

  if (!testRun) throw demoHttpError(404, 'Test run not found');
  const streamToken = body.streamToken;
  const shardTokenSet = demoShardTokens.get(id) ?? readShardTokensFromMeta(testRun.metadata);
  const isValidShardToken = streamToken ? shardTokenSet?.has(streamToken) : false;
  await validateAndReviveDemoRun(db, testRun, streamToken, !!isValidShardToken);
  await applyReporterKeep(db, id, body.keep);

  const isSharded = !!(testRun.shardTotal && testRun.shardTotal > 1);
  // This reporter's resource report, in its own row next to the other shards'.
  const incomingResources = sanitizeResourceReport(body.resourceReport);
  if (incomingResources) await saveResourceReportPart(db, id, incomingResources);

  if (isSharded) {
    const flakyTests = body.flakyTests ?? 0;
    const duration = body.duration ?? Date.now() - new Date(testRun.startTime).getTime();

    // Merge this shard's durations with any previously accumulated ones
    const allDurations: number[] = [];
    const currentMeta = (testRun.metadata as Record<string, unknown>) ?? {};
    const prevDurations = currentMeta.shardDurations as number[] | undefined;
    if (prevDurations) allDurations.push(...prevDurations);
    if (body.durations && Array.isArray(body.durations)) allDurations.push(...body.durations);

    await db
      .update(testRuns)
      .set({
        updatedAt: new Date(),
        status: 'running',
        // `totalTests` is the planned total set at /begin; the per-status
        // counters track live progress and are recomputed distinctly once all
        // shards finish.
        passedTests: sql`${testRuns.passedTests} + ${body.passedTests ?? 0}`,
        failedTests: sql`${testRuns.failedTests} + ${sumFailedAndTimedOut(body.failedTests, body.timedOutTests)}`,
        skippedTests: sql`${testRuns.skippedTests} + ${body.skippedTests ?? 0}`,
        didNotRunTests: sql`${testRuns.didNotRunTests} + ${body.didNotRunTests ?? 0}`,
        flakyTests: sql`${testRuns.flakyTests} + ${flakyTests}`,
        shardsFinished: sql`${testRuns.shardsFinished} + 1`,
        duration: sql`MAX(coalesce(${testRuns.duration}, 0), ${duration})`,
        metadata: { ...currentMeta, shardDurations: allDurations },
        origin: runOrigin(currentMeta),
        commit: runCommit(currentMeta),
        // The first shard to report a branch names the run's branch.
        branch: sql`COALESCE(${testRuns.branch}, ${resolveRunBranch(body.metadata)})`,
        ...(body.setupSteps && { setupSteps: body.setupSteps }),
        ...(body.isFullRun !== undefined && { isFullRun: body.isFullRun !== false ? 1 : 0 }),
        ...(body.filterDetails !== undefined && { filterDetails: body.filterDetails ?? null }),
      })
      .where(eq(testRuns.id, id));

    // This shard is done — drop its token so it cannot send more events.
    if (streamToken) {
      demoShardTokens.get(id)?.delete(streamToken);
      await removeStoredDemoShardToken(db, id, streamToken);
    }

    const updated = await db.select().from(testRuns).where(eq(testRuns.id, id));
    const updatedRun = updated[0];

    let finalStatus: string | undefined;

    if (
      updatedRun &&
      updatedRun.shardsFinished != null &&
      updatedRun.shardTotal != null &&
      updatedRun.shardsFinished >= updatedRun.shardTotal
    ) {
      // Recompute distinct-test counters from the persisted rows (the per-shard
      // events counted attempts), so a flaky-only sharded run reads as passed —
      // mirrors the server's finish handler.
      const attemptRows = await db
        .select({
          testCaseId: testRunsCases.testCaseId,
          browserName: testRunsCases.browserName,
          retries: testRunsCases.retries,
          status: testRunsCases.status,
        })
        .from(testRunsCases)
        .where(eq(testRunsCases.testRunId, id));
      const counts = distinctRunCountsFromAttempts(attemptRows);
      finalStatus = counts.failedTests > 0 ? 'failed' : 'passed';

      let avgTestDuration: number | null = null;
      let p90TestDuration: number | null = null;
      if (allDurations.length > 0) {
        const stats = durationStats(allDurations);
        if (stats) {
          avgTestDuration = stats.avg;
          p90TestDuration = stats.p90;
        }
      }

      const existingMeta = (updatedRun.metadata as Record<string, unknown>) ?? {};
      const finalMeta = { ...existingMeta, shardDurations: allDurations };

      await db
        .update(testRuns)
        .set({
          status: finalStatus,
          streamToken: null,
          totalTests: counts.totalTests,
          passedTests: counts.passedTests,
          failedTests: counts.failedTests,
          skippedTests: counts.skippedTests,
          didNotRunTests: counts.didNotRunTests,
          flakyTests: counts.flakyTests,
          avgTestDuration,
          p90TestDuration,
          metadata: finalMeta,
          origin: runOrigin(finalMeta),
          commit: runCommit(finalMeta),
          updatedAt: new Date(),
        })
        .where(eq(testRuns.id, id));

      publishDemoRunEvent(id, {
        type: 'run-finished',
        data: {
          status: finalStatus,
          duration: updatedRun.duration,
          totalTests: counts.totalTests,
          passedTests: counts.passedTests,
          failedTests: counts.failedTests,
          skippedTests: counts.skippedTests,
          didNotRunTests: counts.didNotRunTests,
          flakyTests: counts.flakyTests,
        },
      });

      publishDemoGlobalEvent({ type: 'run-finished', runId: id, projectId: testRun.projectId, status: finalStatus });

      await recordRunHealth(db, id).catch(() => {});
      await syncAutoMarkersForRun(db, id).catch(() => {});
      await recordRunResourceFindings(db, id).catch(() => {});
      await upsertDailyRollup(db, id).catch(() => {});
      publishDemoGlobalEvent({ type: 'rollup-updated', runId: id, projectId: testRun.projectId });
    } else {
      publishDemoRunEvent(id, {
        type: 'run-progress',
        data: {
          totalTests: updatedRun?.totalTests ?? testRun.totalTests,
          passedTests: updatedRun?.passedTests ?? testRun.passedTests,
          failedTests: updatedRun?.failedTests ?? testRun.failedTests,
          skippedTests: updatedRun?.skippedTests ?? testRun.skippedTests,
          didNotRunTests: updatedRun?.didNotRunTests ?? testRun.didNotRunTests,
          shardsFinished: updatedRun?.shardsFinished ?? 0,
          shardTotal: updatedRun?.shardTotal,
        },
      });
    }

    return { success: true, runId: id, status: finalStatus ?? 'running' };
  }

  // Non-sharded
  const status = body.status ?? 'failed';
  const duration = body.duration ?? Date.now() - new Date(testRun.startTime).getTime();

  let avgTestDuration: number | null = null;
  let p90TestDuration: number | null = null;

  if (body.durations && Array.isArray(body.durations)) {
    const stats = durationStats(body.durations);
    if (stats) {
      avgTestDuration = stats.avg;
      p90TestDuration = stats.p90;
    }
  }

  const flakyTests = body.flakyTests ?? 0;

  // Fold timed-out into failed (see shared/utils/test-counts.ts).
  const hasBodyFailed = body.failedTests !== undefined || body.timedOutTests !== undefined;
  const failedTestsValue = hasBodyFailed
    ? sumFailedAndTimedOut(body.failedTests, body.timedOutTests)
    : testRun.failedTests;

  const reportedMetadata = body.metadata ? carryIngestHealth(sanitizeMetadata(body.metadata), testRun.metadata) : null;

  await db
    .update(testRuns)
    .set({
      status,
      duration,
      streamToken: null,
      ...(body.totalTests !== undefined && { totalTests: body.totalTests }),
      ...(body.passedTests !== undefined && { passedTests: body.passedTests }),
      ...(hasBodyFailed && { failedTests: failedTestsValue }),
      ...(body.skippedTests !== undefined && { skippedTests: body.skippedTests }),
      ...(body.didNotRunTests !== undefined && { didNotRunTests: body.didNotRunTests }),
      ...(body.flakyTests !== undefined && { flakyTests }),
      ...(avgTestDuration !== null && { avgTestDuration }),
      ...(p90TestDuration !== null && { p90TestDuration }),
      ...(body.metadata && {
        metadata: reportedMetadata,
        origin: runOrigin(reportedMetadata),
        commit: runCommit(reportedMetadata),
        branch: resolveRunBranch(body.metadata),
      }),
      ...(body.label !== undefined && { label: body.label }),
      ...(body.playwrightVersion && { playwrightVersion: body.playwrightVersion }),
      ...(body.reporterVersion && { reporterVersion: body.reporterVersion }),
      ...(body.setupSteps && { setupSteps: body.setupSteps }),
      ...(body.isFullRun !== undefined && { isFullRun: body.isFullRun !== false ? 1 : 0 }),
      ...(body.filterDetails !== undefined && { filterDetails: body.filterDetails ?? null }),
    })
    .where(eq(testRuns.id, id));

  publishDemoRunEvent(id, {
    type: 'run-finished',
    data: {
      status,
      duration,
      totalTests: body.totalTests ?? testRun.totalTests,
      passedTests: body.passedTests ?? testRun.passedTests,
      failedTests: failedTestsValue,
      skippedTests: body.skippedTests ?? testRun.skippedTests,
      didNotRunTests: body.didNotRunTests ?? testRun.didNotRunTests,
      flakyTests,
    },
  });

  publishDemoGlobalEvent({ type: 'run-finished', runId: id, projectId: testRun.projectId, status });

  await recordRunHealth(db, id).catch(() => {});
  await syncAutoMarkersForRun(db, id).catch(() => {});
  await recordRunResourceFindings(db, id).catch(() => {});
  await upsertDailyRollup(db, id).catch(() => {});
  publishDemoGlobalEvent({ type: 'rollup-updated', runId: id, projectId: testRun.projectId });

  return { success: true, runId: id, status };
}

/**
 * POST /api/demo/cancel-stale-runs — demo-only endpoint.
 *
 * Cancels runs left in a non-terminal state by an aborted simulation (e.g.
 * the page was reloaded mid-run, so no finish call ever arrived). Called by
 * the simulator UI on mount.
 */
export async function apiCancelStaleSimulatorRuns(body: { instanceId?: string }) {
  if (!body?.instanceId) return { success: true, cancelled: 0 };

  const db = await getDemoDb();

  const cancelledRuns = await db
    .update(testRuns)
    .set({ status: 'cancelled', streamToken: null, updatedAt: new Date() })
    .where(
      and(
        eq(testRuns.instanceId, body.instanceId),
        or(eq(testRuns.status, 'running'), eq(testRuns.status, 'initializing'), eq(testRuns.status, 'finalizing')),
      ),
    )
    .returning({ id: testRuns.id, projectId: testRuns.projectId });

  for (const run of cancelledRuns) {
    publishDemoGlobalEvent({ type: 'run-cancelled', runId: run.id, projectId: run.projectId, status: 'cancelled' });
  }

  return { success: true, cancelled: cancelledRuns.length };
}
