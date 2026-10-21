import { eq, and, desc, or, lt, gt, inArray } from 'drizzle-orm';
import {
  listProjects,
  getProjectFlakyTests,
  getProjectSlowTests,
  getProjectPerformance,
  getProjectTestCases,
  getProjectSpecHealth,
} from '#shared/handlers/projects';
import { parseLockFilter, parseTagFilter } from '#shared/utils/tag-filter';
import { FAILED_STATUS_KEYS } from '#shared/utils/test-counts';
import { buildFixPlan } from '../fix-plan';
import { codeownersOwnerResolver, enrichFixPlanOwnership } from '../scm/ownership';
import { withFixPlanSuspectLines } from '../suspect-lines';
import { getNetworkRequests, getFailureGroups } from '#shared/handlers/test-runs';
import {
  getTestCase,
  getTestRunCase,
  getTestRunCaseTraces,
  getTestCaseStabilityTrend,
  getFailureClues,
  type FailureCluesResult,
} from '#shared/handlers/test-cases';
import { getFlakeProfile } from '#shared/handlers/flake-profile';
import { getRunResources } from '#shared/handlers/run-resources';
import { isPassiveCapabilityDeclined } from '#shared/handlers/capabilities';
import { latestOccurrences, listResourceFindings, runFindingsNovelty } from '#shared/handlers/resource-findings';
import { resourceFingerprint } from '#shared/resource-fingerprint.mjs';
import {
  FlakePlanUnavailable,
  flakeCommand,
  getFlakeExperimentPlan,
  latestSuspectResults,
  listFlakeExperiments,
} from '#shared/handlers/flake-lab';
import { parseBisectResultBody } from '@piwitests/core/bisect';
import { agentDiagnosisErrorMessage, parseAgentDiagnosis, type AgentDiagnosisTarget } from '#shared/agent-diagnosis';
import { resolveAgentDiagnosisTarget } from '#shared/handlers/agent-diagnosis';
import { storedPatchValidation } from '#shared/patch';
import { parseFixAttempt } from '#shared/fix-attempts';
import type { LatestExecution } from '#shared/latest-execution';
import { FIX_ATTEMPT_ERRORS, reportFixAttempt } from '#shared/handlers/fix-attempts';
import { clusterTrailerLine } from '#shared/commit-trailers';
import { parseSetRunIncident } from '#shared/run-incident';
import { recordAgentDiagnosisOn } from '../agent-diagnosis';
import { diagnoseExecution, loadExecutionForDiagnosis } from '../execution-diagnosis';
import { decideRunIncident } from '../run-incident-decision';
import { describeFlakeArm, estimateFlakeSessionMs } from '@piwitests/core/flake-plan';
import {
  getFailureCluster,
  getClusterDiagnosis,
  getExecutionDiagnosis,
  extractClusterCases,
  patchClusterStatus,
  patchClusterBaseCommit,
  recordClusterBisect,
  getOpenFailureClusters,
  bulkTriageClusters,
  quarantineClusterTests,
  releaseClusterTests,
} from '#shared/handlers/failure-clusters';
import { BULK_TRIAGE_MAX, clusterInQueue, isInboxQueue, isSnoozeOption, parseBulkIds } from '#shared/inbox-queues';
import {
  getSuggestionProjectId,
  pendingSuggestionsForCluster,
  rejectMergeSuggestion,
} from '#shared/handlers/cluster-merge-suggestions';
import { approveSuggestedMerge } from '../merge-suggestion-approve';
import { rerunClusterInCi } from '../ci-rerun';
import { createEnrichedLink } from '../integrations/link-create';
import { computeRunInsights } from '#shared/handlers/run-insights';
import { searchProjectsTestRunsCases } from '#shared/handlers/search';
import { foldedContains } from '#shared/utils/fold-text-sql';
import { listTags } from '#shared/handlers/tags';
import { createLinkSchema, deleteLinksTo, listLinks, type LinkEntityType } from '#shared/handlers/links';
import { resolveLinkEntityProjectId } from '../project-access';
import { buildIssueDraft, type DraftEntityType } from '../integrations/draft';
import { createIssue } from '../integrations/create';
import { getClusterKnownIssue } from '../integrations/known-issue';
import { toIssueLocale } from '#shared/integrations/messages';
import {
  coerceFieldValue,
  fieldValueHint,
  joinFieldNames,
  normalizeFieldValues,
  type TrackerField,
} from '#shared/integrations/fields';
import { getCreateFields } from '../integrations/fields';
import { getAdminStats } from '#shared/handlers/admin';
import { createTestFunction } from '#shared/handlers/test-functions';
import { createTestFunctionSchema } from '#shared/test-function-schemas';
import { listSelections, getSelection, resolveSelectionDefinition } from '#shared/handlers/selections';
import { getSelectionSuggestions } from '#shared/handlers/selection-suggestions';
import { getSelectionAnalytics } from '#shared/handlers/selection-analytics';
import {
  validateSelectionDefinition,
  type ResolvedSelection,
  type SelectionDefinition,
  type SelectionFormat,
} from '#shared/selection';
import { projects, testRuns, testRunsCases, testCases, failureClusters, failureDiagnoses } from '../../database/schema';
import { buildDiagnosisContext, buildClusterDiagnosisContext } from '../ai-context';
import { stripAnsi } from '#shared/error-fingerprint';
import { caseHeadline, type FailureVerdict } from '#shared/failure-verdict';
import { MCP_TOOL_DEFS, DESKTOP_MCP_TOOL_DEFS } from '#shared/mcp-tools';
import { collectReportBundle } from '#shared/reports/collect';
import { assertDashboardScope } from '#shared/reports/request';
import { REPORT_LANGUAGES, isReportLanguage } from '#shared/reports/languages';
import { isBuiltinDashboardKey } from '#shared/analytics/dashboards';
import { getMetric, isMetricId, type MetricId } from '#shared/analytics/metrics';
import { resolveInstanceStates } from '#shared/handlers/setup-status';
import { WIDGET_METRIC_IDS } from '#shared/analytics/registry';
import { analyticsScopeToQuery, parseAnalyticsScope } from '#shared/analytics/scope';
import { applyWidgetScope } from '#shared/analytics/dashboards';
import {
  DashboardError,
  dashboardScopeWith,
  dashboardActorFor,
  getDashboard,
  listDashboards,
  loadDashboardDefinition,
  type DashboardActor,
} from '#shared/handlers/dashboards';
import { isAuthEnabled } from '../auth';
import { runAnalyticsWidget } from '#shared/handlers/analytics';
import { compareMetricPeriods, PeriodSpecError } from '#shared/handlers/analytics/compare-periods';
import type {
  McpToolDef,
  McpToolName,
  DesktopMcpToolName,
  McpFlakyTestItem,
  McpAffectedTestCase,
  PaginatedResponse,
} from '#shared/mcp-tools';
import type { RunMetadata, BrowserConfig } from '../run-json-types';
import { getStorage } from '../../storage';
import { getLocatorHealingBatch, getLocatorHealing } from '../locator-healing';
import { predictDiffBreaks, toRunLocatorBreak } from '#shared/handlers/locator-breaks';
import { getLocatorIndex } from '../locator-usages';

/** The largest diff `predict_locator_breaks` reads, in characters. */
const MAX_PREDICT_DIFF_CHARS = 2_000_000;
/** Breaks `predict_locator_breaks` returns, likely first. */
const MAX_PREDICTED_BREAKS = 50;
import { getPageDiff } from '../page-diff';
import { describePageDiff, formatPageDiffSummary } from '#shared/page-diff';
import { inlineCasePayloads } from '../case-payloads';
import { selectCaseScreenshots } from '../case-screenshots';
import { failurePageScreenshot } from '#shared/file-classify';
import { createScmProvider } from '../scm';
import { readProjectRepositoryUrl } from '../scm/project-repository';
import { readChangeCoverage } from '../scm/change-coverage';
import { isValidGitRef } from '../scm/refs';
import { listScenarioGaps, issueScenarioDraft, gapTriageSchema, triageGap } from '#shared/handlers/scenario-gaps';
import { addQuarantine, dismissQuarantineProposal, releaseQuarantine } from '#shared/handlers/quarantine';
import { isQuarantineProposal, normalizeDismissReason } from '#shared/quarantine-proposals';
import { getFeatureGraph } from '../feature-graph';
import { resolveAiConfig } from '../ai-provider';
import { runClusterDiagnosis, isDiagnosisRunning } from '../ai-diagnosis';
import {
  getBugReport,
  getBugReportMissedBy,
  listBugReports,
  renderBugReportSpec,
  renderStepsWith,
  bugReportPatchSchema,
  updateBugReport,
} from '#shared/handlers/bug-reports';
import { describeExpectation, describeStepInWords, expectedSteps, type BugReport } from '@piwitests/core/bug-report';
import { parseSteps } from '@piwitests/core/steps';
import {
  scopeAllows,
  resolveRunProjectId,
  resolveClusterProjectId,
  resolveCaseProjectId,
  resolveTestRunCaseProjectId,
  resolveDiagnosisProjectId,
  resolveBugReportProjectId,
} from '../project-access';
import type { ProjectScope } from '../project-access';
import type { HandbackActor } from '#shared/handback-outcomes';
import type { FailureCluster, FailureDiagnosis, User } from '../../database/schema';
import {
  PROJECT_ROLE_LABELS,
  PROJECT_ROLES,
  can,
  holdsAnywhere,
  isProjectPermission,
  rolesGranting,
  type AccessSummary,
  type Permission,
  type ProjectPermission,
} from '#shared/permissions';
import type { DbClient } from '../../database';
import { stat, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath, relative as relativePath, basename } from 'node:path';
import { importArchive } from '../import-archive';
import { sanitizeFilename } from '../sanitize-filename';
import { resolveMaxUploadBytes } from '../upload-limits';
import { formatBytes } from '#shared/utils/format-bytes';
import { dropNulls } from './json';
import { describePiwi, getReleaseNotes } from './about-piwi';
import { COVERAGE_TOOL_HANDLERS, clusterTestsUniqueCoverage, uniqueCoverageSummary } from './coverage-tools';

// ── Token-optimization helpers ───────────────────────────────────────────────

function trunc(s: string | null | undefined, max = 300): string | null {
  if (!s) return null;
  const clean = stripAnsi(s);
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

function iso(d: Date | string | number | null | undefined): string | null {
  if (!d) return null;
  return new Date(d as string).toISOString();
}

function scmFromMeta(metadata: unknown): { branch?: string; commit?: string } {
  const m = metadata as RunMetadata | null;
  const branch = m?.scm?.branch ?? undefined;
  const commit = m?.scm?.commit?.slice(0, 8) ?? undefined;
  return dropNulls({ branch, commit }) as { branch?: string; commit?: string };
}

function compactBrowser(browser: unknown): string | null {
  const b = browser as BrowserConfig | null;
  if (!b) return null;
  return [b.projectName, b.browserName].filter(Boolean).join('/') || null;
}

/** Project the deterministic clues into the compact shape MCP tools return. */
function compactClues(result: FailureCluesResult) {
  if (result.clues.length === 0) return null;
  return result.clues.map((clue) => ({
    rule: clue.rule,
    strength: clue.strength,
    title: clue.title,
    detail: clue.detail,
    citations: clue.citations.map((c) => c.section),
  }));
}

/**
 * Wrap a list of items into a paginated response. Fetched one extra row beyond
 * pageSize to detect `hasMore`; the extra row is the cursor for the next page.
 * When the caller asks for page N+1 of an unchanged list, the cursor lands at
 * the exact boundary — no skip, no duplicate, no gap.
 */
function paginatedItems<T>(items: T[], pageSize: number, getCursor: (item: T) => string | null): PaginatedResponse<T> {
  const hasMore = items.length > pageSize;
  if (hasMore) items = items.slice(0, pageSize);
  return {
    items,
    nextCursor: hasMore && items.length > 0 ? getCursor(items[items.length - 1]!) : null,
  };
}

function clampPageSize(raw: unknown): number {
  return Math.min(50, Math.max(1, Number(raw) || 10));
}

function numericParam(raw: unknown, name: string): number {
  const n = Number(raw);
  if (isNaN(n)) throw new Error(`Invalid ${name}: must be a number`);
  return n;
}

/** Parse a numeric cursor, throwing a clean error (not a SQL failure) on garbage. */
function numericCursor(raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (isNaN(n)) throw new Error('Invalid cursor');
  return n;
}

// ── Authorization ────────────────────────────────────────────────────────────
//
// The dispatcher loads the caller's access and project scope once per request
// and passes them in. Every project- or entity-scoped tool checks the scope, so
// a key reads only the projects its owner holds a role on, and every write tool
// checks, on the project it acts on, the permission its REST twin declares
// (mirrors the REST project-access layer).

export interface McpContext {
  user: User | null;
  /** The caller's instance role and project roles; every permission with authentication off (`ADMIN_ACCESS`). */
  access: AccessSummary;
  /** The projects the caller reads (`project:read`). */
  scope: ProjectScope;
  /** The API key the request was made with; null for a session or with authentication off. */
  apiKeyId?: number | null;
}

/** The caller of a write tool, as the reporter of a hand-back outcome. */
function mcpActor(ctx: McpContext): HandbackActor {
  return { channel: 'mcp', userId: ctx.user?.id ?? null, apiKeyId: ctx.apiKeyId ?? null };
}

/** Throw if the caller's scope does not include this project. */
function assertProject(ctx: McpContext, projectId: number): void {
  if (!scopeAllows(ctx.scope, projectId)) {
    throw new Error(`No access to project ${projectId}`);
  }
}

/**
 * Resolve an entity's owning project, returning 'not-found' when it doesn't
 * exist (handlers map that to null) and throwing when it's out of scope, or
 * when the caller lacks `permission` there (a write tool's permission).
 * Returns what `resolve` found: the project id, or the entity loaded with its
 * `projectId` when the handler needs more of it.
 */
async function checkEntityScope<T extends number | { projectId: number }>(
  db: DbClient,
  ctx: McpContext,
  id: number,
  resolve: (db: DbClient, id: number) => Promise<T | null>,
  permission?: ProjectPermission,
): Promise<T | 'not-found'> {
  const found = await resolve(db, id);
  if (found == null) return 'not-found';
  const projectId = typeof found === 'number' ? found : found.projectId;
  assertProject(ctx, projectId);
  if (permission) assertPermission(ctx, permission, projectId);
  return found;
}

/** A failure cluster's row; null when it does not exist. */
async function loadCluster(db: DbClient, id: number): Promise<FailureCluster | null> {
  const [cluster] = await db.select().from(failureClusters).where(eq(failureClusters.id, id));
  return cluster ?? null;
}

/** The refusal naming the missing permissions and who holds them, so the agent can tell its user what to ask for. */
function permissionRefusal(permissions: readonly Permission[], projectId?: number): string {
  const where = projectId === undefined ? '' : ` on project ${projectId}`;
  const granting = new Set(permissions.filter(isProjectPermission).flatMap(rolesGranting));
  let holders = 'administrators only';
  if (granting.size > 0) {
    const labels = PROJECT_ROLES.filter((role) => granting.has(role)).map((role) => PROJECT_ROLE_LABELS[role]);
    const last = labels.pop();
    holders = labels.length ? `held by the ${labels.join(', ')} and ${last} roles` : `held by the ${last} role`;
  }
  return `This action requires the ${permissions.join(' or ')} permission${where} (${holders})`;
}

/**
 * Throw unless the caller holds `permission` (or one of the list) on
 * `projectId`, as `can` decides: a write tool checks the permission its REST
 * twin declares on the project it acts on, and an instance permission (no
 * project) needs an administrator. Reading a project is not enough to write to it.
 */
export function assertPermission(
  ctx: McpContext,
  permission: Permission | readonly Permission[],
  projectId?: number,
): void {
  const permissions = typeof permission === 'string' ? [permission] : permission;
  if (!permissions.some((p) => can(ctx.access, p, projectId))) {
    throw new Error(permissionRefusal(permissions, projectId));
  }
}

/** The refusal of a diagnosis run on an instance with no AI provider, naming the way that still works. */
const AI_NOT_CONFIGURED =
  'AI diagnosis is not configured on this instance; write the diagnosis and call record_diagnosis';

/** The cluster or the failure a diagnosis tool names: exactly one of `clusterId` and `executionId`. */
function diagnosisTarget(params: Record<string, unknown>): AgentDiagnosisTarget {
  const named = (params.clusterId != null ? 1 : 0) + (params.executionId != null ? 1 : 0);
  if (named !== 1) throw new Error('Pass clusterId or executionId (one of them)');
  return params.clusterId != null
    ? { scope: 'cluster', clusterId: numericParam(params.clusterId, 'clusterId') }
    : { scope: 'execution', executionId: numericParam(params.executionId, 'executionId') };
}

/** A stored diagnosis, cluster or execution scope, in the shape the diagnosis tools return. */
function diagnosisToMcp(diag: FailureDiagnosis) {
  const det = diag.details as Record<string, unknown> | null;
  return {
    diagnosisId: diag.id,
    status: diag.status,
    provider: diag.provider || null,
    model: diag.model || null,
    category: diag.category || null,
    confidence: diag.confidence || null,
    confidenceScore: (det?.confidenceScore as number) ?? null,
    severity: (det?.severity as string) || null,
    affectedArea: (det?.affectedArea as string) || null,
    summary: diag.summary || null,
    rootCause: diag.rootCause || null,
    evidence: (det?.evidence as string[]) || null,
    hypotheses: (det?.hypotheses as unknown[]) || null,
    suggestedFix: det?.suggestedFix || null,
    patchValidation: storedPatchValidation(det),
    investigationSteps: (det?.investigationSteps as string[]) || null,
    preventionTips: (det?.preventionTips as string[]) || null,
    error: trunc(diag.error, 400),
    inputTokens: diag.inputTokens || null,
    outputTokens: diag.outputTokens || null,
    durationMs: diag.durationMs || null,
    updatedAt: iso(diag.updatedAt),
  };
}

// ── Tool definition type ─────────────────────────────────────────────────────

export type McpToolHandler = (db: DbClient, params: Record<string, unknown>, ctx: McpContext) => Promise<unknown>;

export interface McpTool extends McpToolDef {
  handler: McpToolHandler;
}

// ── Tool content wrapper ─────────────────────────────────────────────────────

export function toContent(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 0) }] };
}

/** Compact a resolution into the agent-facing shape (bounded test sample). */
function selectionToMcp(r: ResolvedSelection): unknown {
  const SAMPLE = 100;
  return dropNulls({
    key: r.key,
    version: r.version,
    matched: r.estimate.count,
    estimatedDurationMs: r.estimate.totalDurationMs,
    command: r.materialization.command || null,
    warnings: r.warnings.length ? r.warnings.map((w) => w.message) : null,
    tests: r.tests
      .slice(0, SAMPLE)
      .map((t) => dropNulls({ testCaseId: t.testCaseId, title: t.title, filePath: t.filePath, line: t.line })),
    truncated: r.tests.length > SAMPLE ? r.tests.length - SAMPLE : null,
  });
}

function selectionFormatParam(raw: unknown): SelectionFormat {
  const formats: SelectionFormat[] = ['args', 'grep', 'files', 'json'];
  return formats.includes(raw as SelectionFormat) ? (raw as SelectionFormat) : 'args';
}

/**
 * A create refused over empty required fields, worded for an agent: each field's
 * id, its name and what it takes, so the next call can pass them in `fields`.
 */
function missingFieldsForAgent(missing: { id: string; name: string }[], screen: Map<string, TrackerField>): string {
  const names = joinFieldNames(missing.map((f) => f.name));
  const each = missing.map((f) => {
    const field = screen.get(f.id);
    return `${f.id} (${f.name})${field ? ` takes ${fieldValueHint(field)}` : ''}`;
  });
  return `Jira requires ${names} for this issue type. Pass ${missing.length === 1 ? 'it' : 'them'} in \`fields\`, keyed by field id: ${each.join('; ')}. Or set a default in the project's issue tracker settings.`;
}

// ── Tool handlers ────────────────────────────────────────────────────────────
//
// Keyed by tool name. The catalog (name/description/inputSchema) lives in
// `shared/mcp-tools.ts` so both this server and `app/pages/mcp.vue` render the
// same list; here we attach the DB-backed behavior. The record is keyed by
// `McpToolName` (derived from MCP_TOOL_DEFS), so TypeScript rejects a handler
// whose name isn't a declared tool, and a declared tool with no handler.
const HANDLERS: Record<McpToolName, McpToolHandler> = {
  // ── list_projects ──────────────────────────────────────────────────────────
  async list_projects(db, _params, ctx) {
    const projects = await listProjects(db, ctx.scope);
    const items = projects.map((p: any) =>
      dropNulls({
        id: p.id,
        name: p.name,
        label: p.label || null,
        totalRuns: p.totalRuns,
        totalTestCases: p.totalTestCases,
        tags: p.tags?.length ? p.tags.map((t: any) => t.name) : null,
        latestRun: p.latestRun
          ? dropNulls({
              id: p.latestRun.id,
              status: p.latestRun.status,
              startedAt: iso(p.latestRun.startTime),
              passed: p.latestRun.passedTests,
              failed: p.latestRun.failedTests,
              flaky: p.latestRun.flakyTests || null,
              ...scmFromMeta(p.latestRun.metadata),
            })
          : null,
      }),
    );
    return { items };
  },

  // ── get_project ────────────────────────────────────────────────────────────
  async get_project(db, params, ctx) {
    const id = numericParam(params.projectId, 'projectId');
    assertProject(ctx, id);
    const pageSize = clampPageSize(params.pageSize);
    const cursor = params.cursor as string | undefined;

    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    if (!project) return null;

    const conditions = [eq(testRuns.projectId, id)];
    if (cursor) conditions.push(lt(testRuns.startTime, new Date(cursor)));

    const runRows = await db
      .select({
        id: testRuns.id,
        status: testRuns.status,
        startTime: testRuns.startTime,
        duration: testRuns.duration,
        totalTests: testRuns.totalTests,
        passedTests: testRuns.passedTests,
        failedTests: testRuns.failedTests,
        skippedTests: testRuns.skippedTests,
        didNotRunTests: testRuns.didNotRunTests,
        flakyTests: testRuns.flakyTests,
        environment: testRuns.environment,
        label: testRuns.label,
        metadata: testRuns.metadata,
      })
      .from(testRuns)
      .where(and(...conditions))
      .orderBy(desc(testRuns.startTime))
      .limit(pageSize + 1);

    const runs = paginatedItems(runRows, pageSize, (r) => iso(r.startTime)).items;
    const nextCursor = runRows.length > pageSize && runs.length > 0 ? iso(runRows[pageSize - 1]?.startTime) : null;

    return dropNulls({
      id: project.id,
      name: project.name,
      label: project.label || null,
      description: project.description || null,
      runs: runs.map((r) =>
        dropNulls({
          id: r.id,
          status: r.status,
          startedAt: iso(r.startTime),
          duration: r.duration,
          total: r.totalTests,
          passed: r.passedTests,
          failed: r.failedTests,
          flaky: r.flakyTests || null,
          skipped: r.skippedTests || null,
          didNotRun: r.didNotRunTests || null,
          env: r.environment || null,
          label: r.label || null,
          ...scmFromMeta(r.metadata),
        }),
      ),
      nextCursor,
    });
  },

  // ── list_runs ──────────────────────────────────────────────────────────────
  async list_runs(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const pageSize = clampPageSize(params.pageSize);
    const cursor = params.cursor as string | undefined;
    const statusFilter = params.status as string | undefined;
    const branchFilter = params.branch as string | undefined;

    const conditions = [eq(testRuns.projectId, projectId)];
    if (statusFilter) conditions.push(eq(testRuns.status, statusFilter));
    // Branch is a scalar column indexed on (project_id, branch, start_time), so
    // the filter is a plain equality served by the database — no over-fetch.
    if (branchFilter) conditions.push(eq(testRuns.branch, branchFilter));
    if (cursor) conditions.push(lt(testRuns.startTime, new Date(cursor)));

    const signRows = await db
      .select({
        id: testRuns.id,
        status: testRuns.status,
        startTime: testRuns.startTime,
        duration: testRuns.duration,
        totalTests: testRuns.totalTests,
        passedTests: testRuns.passedTests,
        failedTests: testRuns.failedTests,
        skippedTests: testRuns.skippedTests,
        didNotRunTests: testRuns.didNotRunTests,
        flakyTests: testRuns.flakyTests,
        environment: testRuns.environment,
        label: testRuns.label,
        metadata: testRuns.metadata,
      })
      .from(testRuns)
      .where(and(...conditions))
      .orderBy(desc(testRuns.startTime))
      .limit(pageSize + 1);

    const mapped = signRows.map((r) =>
      dropNulls({
        id: r.id,
        status: r.status,
        startedAt: iso(r.startTime),
        duration: r.duration,
        total: r.totalTests,
        passed: r.passedTests,
        failed: r.failedTests,
        flaky: r.flakyTests || null,
        skipped: r.skippedTests || null,
        didNotRun: r.didNotRunTests || null,
        env: r.environment || null,
        label: r.label || null,
        ...scmFromMeta(r.metadata),
      }),
    );

    return paginatedItems(mapped, pageSize, (r): string | null => r.startedAt!);
  },

  // ── get_run ────────────────────────────────────────────────────────────────
  async get_run(db, params, ctx) {
    const runId = numericParam(params.runId, 'runId');
    const statusFilter = (params.statusFilter as string) || 'failed';
    const pageSize = clampPageSize(params.pageSize);
    const cursor = numericCursor(params.cursor);

    // Slim run-summary select — counts come from denormalized columns, so we
    // never load every case just to summarize the run.
    const [run] = await db
      .select({
        id: testRuns.id,
        projectId: testRuns.projectId,
        projectName: projects.name,
        status: testRuns.status,
        startTime: testRuns.startTime,
        duration: testRuns.duration,
        totalTests: testRuns.totalTests,
        passedTests: testRuns.passedTests,
        failedTests: testRuns.failedTests,
        flakyTests: testRuns.flakyTests,
        skippedTests: testRuns.skippedTests,
        didNotRunTests: testRuns.didNotRunTests,
        environment: testRuns.environment,
        label: testRuns.label,
        metadata: testRuns.metadata,
        playwrightVersion: testRuns.playwrightVersion,
        reporterVersion: testRuns.reporterVersion,
      })
      .from(testRuns)
      .innerJoin(projects, eq(testRuns.projectId, projects.id))
      .where(eq(testRuns.id, runId));
    if (!run) return null;
    assertProject(ctx, run.projectId);

    // Filter by status in SQL and paginate, so passed cases (and their step
    // JSON) are never loaded just to be discarded.
    const caseConditions = [eq(testRunsCases.testRunId, runId)];
    if (statusFilter === 'flaky') {
      caseConditions.push(and(eq(testRunsCases.status, 'passed'), gt(testRunsCases.retries, 0))!);
    } else if (statusFilter !== 'all') {
      caseConditions.push(inArray(testRunsCases.status, [...FAILED_STATUS_KEYS]));
    }
    if (cursor) caseConditions.push(lt(testRunsCases.id, cursor));

    const caseRows = await db
      .select({
        executionId: testRunsCases.id,
        testCaseId: testRunsCases.testCaseId,
        title: testCases.title,
        externalId: testCases.externalId,
        filePath: testCases.filePath,
        status: testRunsCases.status,
        duration: testRunsCases.duration,
        retries: testRunsCases.retries,
        error: testRunsCases.error,
        clusterId: testRunsCases.failureClusterId,
        browser: testRunsCases.browser,
        workerIndex: testRunsCases.workerIndex,
        line: testRunsCases.line,
      })
      .from(testRunsCases)
      .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
      .where(and(...caseConditions))
      .orderBy(desc(testRunsCases.id))
      .limit(pageSize + 1);

    const mappedCases = caseRows.map((c) =>
      dropNulls({
        executionId: c.executionId,
        testCaseId: c.testCaseId,
        title: c.title,
        externalId: c.externalId,
        filePath: c.filePath,
        status: c.status,
        duration: c.duration,
        retries: c.retries || null,
        error: trunc(c.error, 400),
        clusterId: c.clusterId || null,
        browser: compactBrowser(c.browser),
        worker: c.workerIndex ?? null,
        line: c.line || null,
      }),
    );
    const paged = paginatedItems(mappedCases, pageSize, (c: any) => String(c.executionId));

    const meta = run.metadata as RunMetadata | null;
    return dropNulls({
      id: run.id,
      projectId: run.projectId,
      projectName: run.projectName || null,
      status: run.status,
      startedAt: iso(run.startTime),
      duration: run.duration,
      total: run.totalTests,
      passed: run.passedTests,
      failed: run.failedTests,
      flaky: run.flakyTests || null,
      skipped: run.skippedTests || null,
      didNotRun: run.didNotRunTests || null,
      env: run.environment || null,
      label: run.label || null,
      branch: meta?.scm?.branch || null,
      commit: meta?.scm?.commit?.slice(0, 8) || null,
      playwrightVersion: run.playwrightVersion || null,
      reporterVersion: run.reporterVersion || null,
      cases: paged.items,
      nextCursor: paged.nextCursor,
      filter: statusFilter,
    });
  },

  // ── list_failed_cases ──────────────────────────────────────────────────────
  async list_failed_cases(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const pageSize = clampPageSize(params.pageSize);
    const cursor = numericCursor(params.cursor);
    const runId = params.runId ? numericParam(params.runId, 'runId') : undefined;

    const conditions = [eq(testRuns.projectId, projectId), inArray(testRunsCases.status, [...FAILED_STATUS_KEYS])];
    if (runId) conditions.push(eq(testRunsCases.testRunId, runId));
    if (cursor) conditions.push(lt(testRunsCases.id, cursor));

    const rows = await db
      .select({
        caseId: testRunsCases.id,
        testCaseId: testRunsCases.testCaseId,
        title: testCases.title,
        externalId: testCases.externalId,
        filePath: testCases.filePath,
        status: testRunsCases.status,
        duration: testRunsCases.duration,
        retries: testRunsCases.retries,
        error: testRunsCases.error,
        clusterId: testRunsCases.failureClusterId,
        runId: testRunsCases.testRunId,
        runStatus: testRuns.status,
        runStart: testRuns.startTime,
        rawBrowser: testRunsCases.browser,
        locks: testRunsCases.locks,
      })
      .from(testRunsCases)
      .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
      .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
      .where(and(...conditions))
      .orderBy(desc(testRunsCases.id))
      .limit(pageSize + 1);

    const mapped = rows.map((r) =>
      dropNulls({
        executionId: r.caseId,
        testCaseId: r.testCaseId,
        title: r.title,
        externalId: r.externalId,
        filePath: r.filePath,
        status: r.status,
        duration: r.duration,
        retries: r.retries || null,
        headline: caseHeadline(r)?.headline ?? null,
        error: trunc(r.error, 400),
        clusterId: r.clusterId || null,
        runId: r.runId,
        runStatus: r.runStatus,
        startedAt: iso(r.runStart),
        browser: compactBrowser(r.rawBrowser),
        locks: Array.isArray(r.locks) && r.locks.length ? (r.locks as string[]) : null,
      }),
    );

    return paginatedItems(mapped, pageSize, (r: any) => String(r.executionId));
  },

  // ── list_flaky_tests ───────────────────────────────────────────────────────
  async list_flaky_tests(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const pageSize = clampPageSize(params.pageSize);
    const cursor = numericCursor(params.cursor);
    const runsLimit = Math.min(200, Number(params.runs) || 50);

    const result = await getProjectFlakyTests(db, projectId, runsLimit);
    const items: any[] = (result as any)?.items ?? result ?? [];

    // Cursor is the flakiness `score` (descending). getProjectFlakyTests already
    // returns the list sorted by impact; re-sort by score for stable cursoring.
    const sorted = cursor != null ? items.filter((t: any) => t.score < cursor) : items.slice();
    sorted.sort((a: any, b: any) => b.score - a.score || a.testCaseId - b.testCaseId);

    const mapped = sorted.slice(0, pageSize + 1).map(
      (t: any): Partial<McpFlakyTestItem> =>
        dropNulls({
          testCaseId: t.testCaseId,
          title: t.title,
          externalId: t.externalId,
          filePath: t.filePath,
          flakyScore: t.score,
          failureRate: t.failureRate ?? null,
          runCount: t.totalRuns,
          failCount: t.failedRuns || null,
          retryPassCount: t.retryPassRuns || null,
          alternationCount: t.alternations || null,
          rootCause: t.rootCause || null,
          tags: t.tags?.length ? t.tags : null,
          owner: t.owner || null,
          priority: t.priority || null,
          impact: t.impact || null,
          wastedCiMinutes: t.wastedCiMinutes || null,
          avgFailedDurationMs: t.avgFailedDurationMs || null,
        }),
    );

    return paginatedItems(mapped, pageSize, (r: any) => String(r.flakyScore));
  },

  // ── get_test_case ──────────────────────────────────────────────────────────
  async get_test_case(db, params, ctx) {
    const id = numericParam(params.testCaseId, 'testCaseId');
    const pageSize = clampPageSize(params.pageSize);
    const cursor = numericCursor(params.cursor);

    const tc = (await getTestCase(db, id)) as any;
    if (!tc) return null;
    if (tc.project?.id != null) assertProject(ctx, tc.project.id);

    // Fetch executions with cursor pagination
    const execConditions = [eq(testRunsCases.testCaseId, id)];
    if (cursor) execConditions.push(lt(testRunsCases.id, cursor));

    const execRows = tc.recentExecutions
      ? await db
          .select({
            id: testRunsCases.id,
            runId: testRunsCases.testRunId,
            status: testRunsCases.status,
            duration: testRunsCases.duration,
            retries: testRunsCases.retries,
            error: testRunsCases.error,
            startedAt: testRunsCases.startedAt,
          })
          .from(testRunsCases)
          .where(and(...execConditions))
          .orderBy(desc(testRunsCases.id))
          .limit(pageSize + 1)
      : [];

    const execMapped = execRows.map((e) =>
      dropNulls({
        id: e.id,
        runId: e.runId,
        status: e.status,
        duration: e.duration,
        retries: e.retries || null,
        error: trunc(e.error, 400),
        startedAt: iso(e.startedAt),
      }),
    );

    return dropNulls({
      id: tc.id,
      title: tc.title,
      externalId: tc.externalId,
      filePath: tc.filePath,
      tags: tc.tags?.length ? tc.tags : null,
      locks: tc.locks?.length ? tc.locks : null,
      project: tc.project ? { id: tc.project.id, name: tc.project.name } : null,
      stats: dropNulls({
        totalRuns: tc.totalRuns,
        passed: tc.passedRuns,
        failed: tc.failedRuns,
        flaky: tc.flakyRuns || null,
        recentFlaky: tc.recentFlakyRuns || null,
        avgDuration: tc.avgDuration ? Math.round(tc.avgDuration) : null,
      }),
      clusters: tc.clusters?.length
        ? tc.clusters.map((c: any) =>
            dropNulls({ id: c.id, type: c.errorType, status: c.status, occurrences: c.occurrences }),
          )
        : null,
      recentExecutions: paginatedItems(execMapped, pageSize, (e: any) => String(e.id)),
    });
  },

  // ── list_clusters ──────────────────────────────────────────────────────────
  async list_clusters(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const pageSize = clampPageSize(params.pageSize);
    const cursor = numericCursor(params.cursor);
    const statusFilter = params.status as string | undefined;

    const conditions = [eq(failureClusters.projectId, projectId)];
    if (statusFilter) conditions.push(eq(failureClusters.status, statusFilter));

    // Cursor is the cluster `id` (descending). Auto-increment ensures
    // deterministic ordering — no tiebreaker needed.
    if (cursor) conditions.push(lt(failureClusters.id, cursor));

    const clusterRows = await db
      .select()
      .from(failureClusters)
      .where(and(...conditions))
      .orderBy(desc(failureClusters.id))
      .limit(pageSize + 1);

    const mapped = clusterRows.map((c: any) =>
      dropNulls({
        id: c.id,
        signature: c.signature,
        errorType: c.errorType || null,
        selector: c.selector || null,
        status: c.status,
        occurrences: c.occurrences,
        affectedTests: c.affectedTests,
        firstSeenRunId: c.firstSeenRunId,
        lastSeenRunId: c.lastSeenRunId,
        lastSeenStatus: c.lastSeenRunStatus || null,
        diagnosis: null,
        sampleError: trunc(c.sampleError, 400),
      }),
    );

    return paginatedItems(mapped, pageSize, (r: any) => String(r.id));
  },

  // ── get_cluster ────────────────────────────────────────────────────────────
  async get_cluster(db, params, ctx) {
    const id = numericParam(params.clusterId, 'clusterId');
    const cluster = await getFailureCluster(db, id);
    if (!cluster) return null;
    if (cluster.project?.id != null) assertProject(ctx, cluster.project.id);

    const knownIssue = await getClusterKnownIssue(db, id);
    const mergeSuggestions = await pendingSuggestionsForCluster(db, id);

    // Fetch locator healing for up to 5 affected cases in one batch (2 DB
    // round-trips) so AI coding agents get fix suggestions without visiting
    // the dashboard.
    const topCases = (cluster.affectedTestCases ?? []).slice(0, 5);
    const trcIds = topCases.map((t: any) => t.recentTestRunsCaseId).filter((id: any) => id != null);
    const healingMap = trcIds.length > 0 ? await getLocatorHealingBatch(db, trcIds) : new Map();

    const healingResults = topCases
      .map((t: any) => {
        const caseId = t.recentTestRunsCaseId;
        if (!caseId) return null;
        const h = healingMap.get(caseId);
        if (!h || h.source === 'none') return null;
        return {
          testCaseId: t.testCaseId,
          title: t.title,
          executionId: caseId,
          source: h.source,
          failingLocator: h.failingLocator,
          recommendation: h.recommendation
            ? dropNulls({
                recommended: h.recommendation.recommended
                  ? dropNulls({
                      locator: h.recommendation.recommended.locator,
                      method: h.recommendation.recommended.method,
                      score: h.recommendation.recommended.score,
                    })
                  : null,
                durable: h.recommendation.durable
                  ? dropNulls({
                      locator: h.recommendation.durable.locator,
                      method: h.recommendation.durable.method,
                      score: h.recommendation.durable.score,
                    })
                  : null,
                preservesConvention: h.recommendation.preservesConvention || null,
                hasDurableAlternative: h.recommendation.hasDurableAlternative || null,
                suggestAddTestId: h.recommendation.suggestAddTestId || null,
              })
            : null,
          alternativesCount: (h.fromPriorSuccess?.length ?? 0) + (h.fromElementMatch?.length ?? 0),
          ...(h.priorNameMayBeStale ? { priorNameMayBeStale: true } : {}),
          ...(h.healedInRunId ? { healedInRunId: h.healedInRunId } : {}),
        };
      })
      .filter((e: any) => e != null);

    return dropNulls({
      id: cluster.id,
      signature: cluster.signature,
      errorType: cluster.errorType || null,
      selector: cluster.selector || null,
      status: cluster.status,
      triageNote: cluster.triageNote || null,
      occurrences: cluster.occurrences,
      affectedTests: cluster.affectedTests,
      firstSeenRunId: cluster.firstSeenRunId,
      lastSeenRunId: cluster.lastSeenRunId,
      lastSeenAt: iso(cluster.lastSeenAt),
      lastSeenStatus: cluster.lastSeenRunStatus || null,
      project: cluster.project ? { id: cluster.project.id, name: cluster.project.name } : null,
      sampleError: trunc(cluster.sampleError, 400),
      mergeSuggestions: mergeSuggestions.map((s) => ({ suggestionId: s.id, otherClusterId: s.otherClusterId })),
      diagnosis: cluster.diagnosis
        ? dropNulls({
            status: cluster.diagnosis.status,
            category: cluster.diagnosis.category,
            confidence: cluster.diagnosis.confidence,
            summary: cluster.diagnosis.summary,
          })
        : null,
      affectedTestCases: cluster.affectedTestCases?.slice(0, 20).map(
        (t: any): Partial<McpAffectedTestCase> =>
          dropNulls({
            testCaseId: t.testCaseId,
            title: t.title,
            filePath: t.filePath,
            runCount: t.runCount,
            executionId: t.recentTestRunsCaseId,
          }),
      ),
      locatorHealing: healingResults.length > 0 ? healingResults : null,
      issue: knownIssue ? dropNulls({ key: knownIssue.key, url: knownIssue.url, status: knownIssue.status }) : null,
    });
  },

  // ── get_fix_plan ───────────────────────────────────────────────────────────
  async get_fix_plan(db, params, ctx) {
    const clusterId = numericParam(params.clusterId, 'clusterId');
    const [cluster] = await db
      .select({ projectId: failureClusters.projectId })
      .from(failureClusters)
      .where(eq(failureClusters.id, clusterId));
    if (!cluster) return null;
    assertProject(ctx, cluster.projectId);

    const plan = await buildFixPlan(db, clusterId);
    if (!plan) return null;
    const enriched = await withFixPlanSuspectLines(db, clusterId, enrichFixPlanOwnership(db, cluster.projectId, plan));

    // Additive: the story, the situation and the computed next step,
    // read on the cluster's latest occurrence through the shared handlers.
    const clusterDetail = await getFailureCluster(db, clusterId).catch(() => null);
    const latestId = clusterDetail?.latestTestRunsCaseId ?? null;
    const [cluesResult, detail] = await Promise.all([
      latestId ? getFailureClues(db, latestId).catch(() => null) : Promise.resolve(null),
      latestId
        ? getTestRunCase(db, latestId, null, {
            resolveOwner: codeownersOwnerResolver(db, cluster.projectId),
          }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const story = cluesResult?.story ?? null;
    const situation = (detail as { situation?: { text?: string } | null } | null)?.situation ?? null;

    return {
      ...(enriched as unknown as Record<string, unknown>),
      story: story
        ? dropNulls({ id: story.id, sentence: story.sentence, strength: story.strength, clueIds: story.clueIds })
        : null,
      situation: situation?.text || null,
      nextStep: clusterDetail?.nextStep ?? null,
    };
  },

  // ── get_cluster_diagnosis ──────────────────────────────────────────────────
  async get_cluster_diagnosis(db, params, ctx) {
    const id = numericParam(params.clusterId, 'clusterId');
    if ((await checkEntityScope(db, ctx, id, resolveClusterProjectId)) === 'not-found') {
      return null;
    }
    const result = await getClusterDiagnosis(db, id);
    if (!result.diagnosis) return null;
    return dropNulls({ ...diagnosisToMcp(result.diagnosis), manualBaseCommit: result.manualBaseCommit || null });
  },

  // ── get_execution_diagnosis ───────────────────────────────────────────────
  async get_execution_diagnosis(db, params, ctx) {
    const id = numericParam(params.executionId, 'executionId');
    if ((await checkEntityScope(db, ctx, id, resolveTestRunCaseProjectId)) === 'not-found') return null;
    const { diagnosis } = await getExecutionDiagnosis(db, id);
    return diagnosis ? dropNulls({ executionId: id, ...diagnosisToMcp(diagnosis) }) : null;
  },

  // ── get_test_case_context ─────────────────────────────────────────────────
  async get_test_case_context(db, params, ctx) {
    const id = numericParam(params.executionId, 'executionId');
    if ((await checkEntityScope(db, ctx, id, resolveTestRunCaseProjectId)) === 'not-found') return null;

    const [trc] = await db
      .select({ id: testRunsCases.id, failureClusterId: testRunsCases.failureClusterId })
      .from(testRunsCases)
      .where(eq(testRunsCases.id, id))
      .limit(1);
    if (!trc) return null;

    const built = await buildDiagnosisContext(db, {
      kind: 'execution',
      executionId: id,
      clusterId: trc.failureClusterId ?? undefined,
    });

    const base = dropNulls({
      executionId: id,
      text: built.text,
      sections: built.sections.map((s) => ({
        id: s.id,
        title: s.title,
        chars: s.chars,
        truncated: s.truncated,
        items: s.items ?? null,
      })),
      tokenEstimate: built.tokenEstimate,
      cluster: built.cluster ?? null,
    });

    // When the execution has no cluster, the diagnosis context has nothing to
    // assemble. Fall back to the raw stored evidence so the tool still returns
    // something actionable instead of an empty coverage stub.
    if (built.sections.length === 0) {
      const [row] = await db.select().from(testRunsCases).where(eq(testRunsCases.id, id)).limit(1);
      if (row) {
        const evidence = await inlineCasePayloads(db, row);
        return {
          ...base,
          rawExecution: dropNulls({
            status: row.status,
            error: trunc(row.error, 1500),
            steps: row.steps,
            consoleLogs: row.consoleLogs,
            webVitals: row.webVitals,
            ariaSnapshot: trunc(evidence.ariaSnapshot, 4000),
          }),
        };
      }
    }

    return base;
  },

  // ── get_case_screenshots ───────────────────────────────────────────────────
  async get_case_screenshots(db, params, ctx) {
    const id = numericParam(params.executionId, 'executionId');
    if ((await checkEntityScope(db, ctx, id, resolveTestRunCaseProjectId)) === 'not-found') return null;
    const withContent = params.content === true || params.content === 'true';

    const allRows = await selectCaseScreenshots(db, id);
    if (allRows.length === 0) return { items: [] };
    const atFailure = failurePageScreenshot(allRows, (r) => r.subtype);
    const screenshotRows = withContent ? allRows.slice(0, 3) : allRows;

    const storage = getStorage();
    const results: Array<{ name: string; mediaType: string; dataLength: number; atFailure?: true; data?: string }> = [];

    for (const f of screenshotRows) {
      try {
        const buf = await storage.readFile(f.path);
        const ext = f.path.toLowerCase().split('.').pop() || 'png';
        const mediaType =
          ext === 'jpg' || ext === 'jpeg'
            ? 'image/jpeg'
            : ext === 'gif'
              ? 'image/gif'
              : ext === 'webp'
                ? 'image/webp'
                : 'image/png';

        const entry: any = {
          name: f.path.split('/').pop() || 'screenshot',
          mediaType,
          dataLength: buf.length,
          ...(f === atFailure ? { atFailure: true } : {}),
        };

        if (withContent) {
          const maxBytes = 100 * 1024; // ~100 KB cap per image
          const slice = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
          entry.data = Buffer.from(slice).toString('base64');
          if (buf.length > maxBytes) entry.truncated = true;
        }

        results.push(entry);
      } catch {
        // skip inaccessible files
      }
    }
    return { items: results };
  },

  // ── get_cluster_context ────────────────────────────────────────────────────
  async get_cluster_context(db, params, ctx) {
    const id = numericParam(params.clusterId, 'clusterId');
    const [clusterRow] = await db.select().from(failureClusters).where(eq(failureClusters.id, id));
    if (!clusterRow) return null;
    assertProject(ctx, clusterRow.projectId);

    const baseCommit = params.baseCommit as string | undefined;
    const selectedCommitShas = params.selectedCommitShas as string[] | undefined;

    const { text, coverage, images } = await buildClusterDiagnosisContext(db, clusterRow, {
      baseCommit,
      selectedCommitShas,
    });

    let context = text;

    // Promote screenshots: if images are included, add a note at the end
    if (images?.length) {
      context +=
        '\n\n## Screenshots\nDecisive for "what rendered" at time of failure. ' +
        'Call get_case_screenshots with the executionId to view each:\n' +
        images.map((img) => `- ${img.name} (${img.mediaType}, ~${(img.data.length / 1024).toFixed(0)} KB)`).join('\n');
    }

    return dropNulls({
      clusterId: id,
      context,
      coverage: coverage?.scm
        ? dropNulls({
            hasLastGreen: coverage.scm.hasLastGreen,
            hasCommitRange: coverage.scm.hasCommitRange,
            provider: coverage.scm.provider || null,
            commitsCount: coverage.scm.commitsCount || null,
            filesCount: coverage.scm.filesCount || null,
            patchedFilesCount: coverage.scm.patchedFilesCount || null,
            patchesOmitted: coverage.scm.patchesOmitted || null,
            baseCommitUsed: coverage.scm.baseCommitUsed || null,
            range: coverage.scm.range ? `${coverage.scm.range.from}..${coverage.scm.range.to}` : null,
            compareUrl: coverage.scm.compareUrl || null,
            scmError: coverage.scm.error || null,
            alreadyGreen: coverage.alreadyGreen || null,
          })
        : null,
    });
  },

  // ── search_test_cases ───────────────────────────────────────────────────────
  async search_test_cases(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const q = String(params.q ?? '').trim();
    if (!q) return { items: [], nextCursor: null };
    const pageSize = clampPageSize(params.pageSize);
    const cursor = numericCursor(params.cursor);
    const conditions = [eq(testCases.projectId, projectId)];
    conditions.push(
      or(foldedContains(testCases.title, q), foldedContains(testCases.filePath, q), eq(testCases.externalId, q))!,
    );
    if (cursor) conditions.push(lt(testCases.id, cursor));

    const rows = await db
      .select({
        id: testCases.id,
        title: testCases.title,
        externalId: testCases.externalId,
        filePath: testCases.filePath,
        tags: testCases.tags,
        locks: testCases.locks,
      })
      .from(testCases)
      .where(and(...conditions))
      .orderBy(desc(testCases.id))
      .limit(pageSize + 1);

    const mapped = rows.map((r) =>
      dropNulls({
        id: r.id,
        title: r.title,
        externalId: r.externalId,
        filePath: r.filePath,
        tags: Array.isArray(r.tags) && r.tags.length ? (r.tags as string[]) : null,
        locks: Array.isArray(r.locks) && r.locks.length ? (r.locks as string[]) : null,
      }),
    );

    return paginatedItems(mapped, pageSize, (r) => String(r.id!));
  },

  // ── get_test_run_case ──────────────────────────────────────────────────────
  async get_test_run_case(db, params, ctx) {
    const id = numericParam(params.executionId, 'executionId');
    const [row] = await db.select().from(testRunsCases).where(eq(testRunsCases.id, id));
    if (!row) return null;
    if ((await checkEntityScope(db, ctx, id, resolveTestRunCaseProjectId)) === 'not-found') return null;

    const [tc] = await db
      .select({ title: testCases.title, filePath: testCases.filePath })
      .from(testCases)
      .where(eq(testCases.id, row.testCaseId));

    // `include` lets an agent pull only the blobs it needs. Default: everything.
    // The big JSON/text columns (steps, stepEvents, console, aria, source) are
    // gated so a caller after just the error+summary pays only for that.
    const rawInclude = params.include;
    const include: Set<string> | null = Array.isArray(rawInclude)
      ? new Set(rawInclude.map(String))
      : typeof rawInclude === 'string' && rawInclude
        ? new Set([rawInclude])
        : null;
    const want = (k: string) => include === null || include.has(k);

    const evidence = want('aria') || want('source') ? await inlineCasePayloads(db, row) : row;

    // Deterministic clues ride alongside the error unless the caller opts out.
    const clues = want('clues') ? await getFailureClues(db, id).catch(() => null) : null;

    return dropNulls({
      executionId: row.id,
      testCaseId: row.testCaseId,
      title: tc?.title || null,
      filePath: tc?.filePath || null,
      status: row.status,
      duration: row.duration,
      retries: row.retries || null,
      headline: caseHeadline(row)?.headline ?? null,
      error: row.error, // full, untruncated
      clues: clues ? compactClues(clues) : null,
      clusterId: row.failureClusterId || null,
      line: row.line || null,
      column: row.column || null,
      workerIndex: row.workerIndex ?? null,
      browser: compactBrowser(row.browser),
      steps: want('steps') ? row.steps : null,
      stepEvents: want('steps') ? row.stepEvents : null,
      slowestStep: row.slowestStep || null,
      slowestStepDuration: row.slowestStepDuration || null,
      consoleLogs: want('console') ? row.consoleLogs : null,
      webVitals: want('webVitals') ? row.webVitals : null,
      ariaSnapshot: want('aria') ? trunc(evidence.ariaSnapshot, 8000) : null,
      testSource: want('source') ? evidence.testSource || null : null,
      testAnnotations: row.testAnnotations,
      locks: Array.isArray(row.locks) && row.locks.length ? (row.locks as string[]) : null,
      startedAt: iso(row.startedAt),
      isNewRegression: row.isNewRegression || null,
      isNewFlaky: row.isNewFlaky || null,
    });
  },

  // ── list_recent_activity ──────────────────────────────────────────────────
  async list_recent_activity(db, params, ctx) {
    const pageSize = clampPageSize(params.pageSize);
    const cursor = params.cursor as string | undefined;

    // Restrict the cross-project feed to the caller's assigned projects.
    if (ctx.scope !== 'all' && ctx.scope.size === 0) return { items: [], nextCursor: null };
    const conditions = cursor ? [lt(testRuns.startTime, new Date(cursor))] : [];
    if (ctx.scope !== 'all') conditions.push(inArray(testRuns.projectId, [...ctx.scope]));

    const rows = await db
      .select({
        id: testRuns.id,
        projectId: testRuns.projectId,
        projectName: projects.name,
        status: testRuns.status,
        startTime: testRuns.startTime,
        duration: testRuns.duration,
        totalTests: testRuns.totalTests,
        passedTests: testRuns.passedTests,
        failedTests: testRuns.failedTests,
        flakyTests: testRuns.flakyTests,
        label: testRuns.label,
      })
      .from(testRuns)
      .innerJoin(projects, eq(testRuns.projectId, projects.id))
      .where(and(...conditions))
      .orderBy(desc(testRuns.startTime))
      .limit(pageSize + 1);

    const mapped = rows.map((r) =>
      dropNulls({
        id: r.id,
        projectId: r.projectId,
        projectName: r.projectName,
        status: r.status,
        startedAt: iso(r.startTime),
        duration: r.duration,
        total: r.totalTests,
        passed: r.passedTests,
        failed: r.failedTests,
        flaky: r.flakyTests || null,
        label: r.label || null,
      }),
    );

    return paginatedItems(mapped, pageSize, (r) => r.startedAt!);
  },

  // ── get_repo_commits ───────────────────────────────────────────────────────
  async get_repo_commits(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const limit = Math.min(100, Number(params.limit) || 20);
    const branch = params.branch as string | undefined;

    const repoUrl = await readProjectRepositoryUrl(db, projectId);
    if (!repoUrl)
      return { commits: [], error: 'No repository is set for this project (set it in its source control settings)' };

    const provider = await createScmProvider(repoUrl, db, projectId);
    if (!provider) return { commits: [], error: 'SCM provider not configured or unsupported' };

    try {
      const commits = await provider.listCommits(limit, branch);
      return {
        commits: commits.map((c) =>
          dropNulls({ sha: c.sha, shortSha: c.shortSha, message: c.message, author: c.author, date: c.date }),
        ),
      };
    } catch (err) {
      return { commits: [], error: err instanceof Error ? err.message : String(err) };
    }
  },

  // ── get_repo_diff ──────────────────────────────────────────────────────────
  async get_repo_diff(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const sha = (params.sha as string)?.trim();
    if (!sha) return { error: 'sha is required' };

    const repoUrl = await readProjectRepositoryUrl(db, projectId);
    if (!repoUrl) return { error: 'No repository is set for this project (set it in its source control settings)' };

    const provider = await createScmProvider(repoUrl, db, projectId);
    if (!provider) return { error: 'SCM provider not configured or unsupported' };

    try {
      const changes = await provider.fetchCommitDiff(sha);
      if (!changes) return { error: 'Diff unavailable for this commit' };
      return dropNulls({
        commit: sha,
        files: changes.files.map((f) =>
          dropNulls({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch || null,
          }),
        ),
        patchesOmitted: changes.patchesOmitted || null,
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },

  // ── get_run_insights ───────────────────────────────────────────────────────
  async get_run_insights(db, params, ctx) {
    const runId = numericParam(params.runId, 'runId');
    if ((await checkEntityScope(db, ctx, runId, resolveRunProjectId)) === 'not-found') return null;

    const baseBranch = typeof params.baseBranch === 'string' ? params.baseBranch.trim() || null : null;
    const r = await computeRunInsights(db, runId, { baseBranch, failedFallback: true });
    const cap = <T>(a: T[]) => a.slice(0, 15);
    return dropNulls({
      runId,
      hasBaseline: r.hasBaseline,
      baseline: r.baseline
        ? {
            runId: r.baseline.id,
            branch: r.baseline.branch,
            environment: r.baseline.environment,
            note: r.baselineNote,
          }
        : null,
      baseBranches: r.baseBranches,
      totalTests: r.totalTests,
      passedTests: r.passedTests,
      failedTests: r.failedTests,
      passRate: r.passRate,
      baselinePassRate: r.hasBaseline ? r.baselinePassRate : null,
      passRateDelta: r.hasBaseline ? r.passRateDelta : null,
      avgDurationDelta: r.avgDurationDelta,
      newRegressions: cap(r.newRegressions),
      recurrences: cap(r.recurrences),
      recovered: cap(r.recovered),
      newFlaky: cap(r.newFlaky),
      slowestTests: cap(r.slowestTests),
      mostImproved: cap(r.mostImproved),
      mostRegressed: cap(r.mostRegressed),
      workerImbalance: r.workerImbalance,
      workerImbalanceWarning: r.workerImbalanceWarning || null,
      flakyOnRetry: cap(r.flakyOnRetry),
      clusterNew: cap(r.clusterNew),
    });
  },

  // ── get_spec_health ────────────────────────────────────────────────────────
  async get_spec_health(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const days = params.days != null ? numericParam(params.days, 'days') : 30;
    return getProjectSpecHealth(db, projectId, days);
  },

  // ── get_slow_tests ─────────────────────────────────────────────────────────
  async get_slow_tests(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const runs = Math.min(100, Number(params.runs) || 50);
    const result = (await getProjectSlowTests(db, projectId, runs)) as any[];
    return { items: result.slice(0, 25).map((t: any) => dropNulls(t)) };
  },

  // ── get_performance_trend ──────────────────────────────────────────────────
  async get_performance_trend(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const limit = Math.min(100, Number(params.limit) || 30);
    return getProjectPerformance(db, projectId, limit);
  },

  // ── get_test_stability_trend ───────────────────────────────────────────────
  async get_test_stability_trend(db, params, ctx) {
    const testCaseId = numericParam(params.testCaseId, 'testCaseId');
    if ((await checkEntityScope(db, ctx, testCaseId, resolveCaseProjectId)) === 'not-found') return null;
    const days = params.days != null ? numericParam(params.days, 'days') : undefined;
    return getTestCaseStabilityTrend(db, testCaseId, { days });
  },

  // ── get_flake_profile ──────────────────────────────────────────────────────
  async get_flake_profile(db, params, ctx) {
    const testCaseId = numericParam(params.testCaseId, 'testCaseId');
    if ((await checkEntityScope(db, ctx, testCaseId, resolveCaseProjectId)) === 'not-found') return null;
    const [profile, experiments] = await Promise.all([
      getFlakeProfile(db, testCaseId),
      listFlakeExperiments(db, testCaseId, { limit: 10 }),
    ]);
    if (!profile) return null;
    const results = latestSuspectResults(experiments);
    return {
      testCaseId: profile.testCaseId,
      window: { days: profile.windowDays, maxAttempts: profile.maxAttempts, from: profile.from, to: profile.to },
      attempts: profile.attempts,
      failures: profile.failures,
      passes: profile.passes,
      suspects: profile.suspects.map((s) => {
        const lab = results.get(s.id);
        return dropNulls({
          id: s.id,
          kind: s.kind,
          label: s.label,
          sentence: s.sentence,
          counts: s.counts,
          lift: Math.round(s.lift * 10) / 10,
          condition: s.condition,
          conditionLabel: s.conditionLabel,
          route: s.route,
          thresholdMs: s.thresholdMs,
          thresholdCount: s.thresholdCount,
          testCaseId: s.testCaseId,
          title: s.title,
          project: s.project,
          sharedRoutes: s.sharedRoutes,
          approximate: s.approximate,
          executionIds: s.executionIds.slice(0, 10),
          lab: lab
            ? {
                experimentId: lab.experimentId,
                verdict: lab.verdict,
                matchingFailures: lab.matchingFailures,
                runs: lab.runs,
                control: { matchingFailures: lab.controlMatchingFailures, runs: lab.controlRuns },
                pValue: lab.pValue,
                finishedAt: lab.finishedAt,
              }
            : null,
        });
      }),
      context: profile.context.map((c) => ({ ...c, lift: Math.round(c.lift * 10) / 10 })),
      experiments: experiments.map((e) =>
        dropNulls({
          id: e.id,
          kind: e.kind,
          verdict: e.verdict,
          commit: e.commit,
          failureCommit: e.failureCommit,
          source: e.source,
          playwrightProject: e.playwrightProject,
          finishedAt: e.finishedAt,
          verifies: e.verifies,
          arms: e.arms.map((a) =>
            dropNulls({
              id: a.key,
              label: a.label,
              suspectId: a.suspectId,
              conditions: a.conditions,
              runs: a.runs,
              matchingFailures: a.matchingFailures,
              otherFailures: a.otherFailures,
              discardedRounds: a.discardedRounds || null,
              stoppedEarly: a.stoppedEarly || null,
              pValue: a.pValue,
              verdict: a.verdict,
              reproducing: a.id === e.reproducingArmId || null,
            }),
          ),
        }),
      ),
    };
  },

  // ── plan_flake_experiment ──────────────────────────────────────────────────
  async plan_flake_experiment(db, params, ctx) {
    const testCaseId = numericParam(params.testCaseId, 'testCaseId');
    if ((await checkEntityScope(db, ctx, testCaseId, resolveCaseProjectId)) === 'not-found') return null;
    let plan;
    try {
      plan = await getFlakeExperimentPlan(db, testCaseId, { record: false });
    } catch (error) {
      if (error instanceof FlakePlanUnavailable) return null;
      throw error;
    }
    const arms = [plan.control, ...plan.arms];
    const estimate = estimateFlakeSessionMs(arms, plan.medianDurationMs);
    return dropNulls({
      testCaseId,
      test: plan.displayTitle,
      filePath: plan.test.file,
      playwrightProject: plan.test.project,
      commands: {
        reproduce: flakeCommand(testCaseId),
        oneSuspect: plan.arms.length ? `${flakeCommand(testCaseId)} --suspect 1` : null,
        verify: flakeCommand(testCaseId, 'verify'),
      },
      exitCodes: {
        0: 'reproduced (verify: the fix held)',
        1: 'not reproduced (verify: still fails or too few runs)',
        2: 'error',
      },
      failureCommit: plan.failureCommit,
      errorSignatures: plan.errorSignatures,
      arms: arms.map((a) => ({
        id: a.id,
        label: a.id === 'control' ? describeFlakeArm([]) : a.label,
        suspectId: a.suspectId,
        conditions: a.conditions,
        runs: a.runs,
        stopAt: a.stopAt,
      })),
      combined: plan.combined ? { label: plan.combined.label, conditions: plan.combined.conditions } : null,
      skippedSuspects: plan.suspects.filter((s) => s.skipped).map((s) => ({ id: s.id, reason: s.skipped })),
      estimateMinutes: estimate != null ? Math.ceil(estimate / 60_000) : null,
      plan,
    });
  },

  // ── get_network_requests ───────────────────────────────────────────────────
  async get_network_requests(db, params, ctx) {
    const runId = numericParam(params.runId, 'runId');
    if ((await checkEntityScope(db, ctx, runId, resolveRunProjectId)) === 'not-found') return null;
    const summaries = (await getNetworkRequests(db, runId)) as any[] | null;
    if (!summaries) return null;
    return { endpoints: summaries.slice(0, 30).map((e: any) => dropNulls(e)) };
  },

  // ── list_resource_findings ─────────────────────────────────────────────────
  async list_resource_findings(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    if (await isPassiveCapabilityDeclined(db, projectId, 'resources')) return { findings: [] };
    const status = params.status === 'fixed' || params.status === 'all' ? params.status : 'open';
    const verdict = typeof params.verdict === 'string' ? params.verdict : undefined;
    const findings = await listResourceFindings(db, projectId, { status, verdict, limit: Number(params.limit) || 50 });
    const last = await latestOccurrences(
      db,
      findings.map((f) => f.id),
    );
    return {
      findings: findings.map((f) => {
        const occurrence = last.get(f.id);
        return dropNulls({
          ...f,
          fingerprint: undefined,
          last: occurrence
            ? dropNulls({
                runId: occurrence.runId,
                branch: occurrence.branch,
                objects: occurrence.count,
                tests: occurrence.tests,
                heldMs: occurrence.heldMs,
                afterTestCpuMs: occurrence.afterTestCpuMs,
                pages: occurrence.pages,
              })
            : null,
        });
      }),
    };
  },

  // ── get_resource_profile ───────────────────────────────────────────────────
  async get_resource_profile(db, params, ctx) {
    const runId = numericParam(params.runId, 'runId');
    if ((await checkEntityScope(db, ctx, runId, resolveRunProjectId)) === 'not-found') return null;
    const resources = await getRunResources(db, runId);
    if (!resources) return null;
    const novelty = resources.report ? await runFindingsNovelty(db, runId) : null;
    const isNew = new Map((novelty?.findings ?? []).map((f) => [f.fingerprint, f.isNew]));
    return {
      baseBranch: novelty?.baseBranch ?? null,
      shards: (resources.report?.parts ?? []).map((part) =>
        dropNulls({
          shardIndex: part.shardIndex,
          counts: part.counts,
          findings: part.findings.map((finding) => ({
            ...finding,
            isNew: isNew.get(resourceFingerprint(finding)) ?? null,
          })),
          machine: part.profile
            ? {
                platform: part.profile.platform,
                wallMs: part.profile.wallMs,
                ...part.profile.machine,
                cpu: { ...part.profile.cpu, series: undefined },
                memory: part.profile.memory,
                disk: part.profile.disk,
                notMeasured: part.profile.notMeasured,
              }
            : null,
          openPagesByWorker: part.workers.map((w) => ({
            worker: w.worker,
            max: Math.max(0, ...w.openPages),
            last: w.openPages[w.openPages.length - 1] ?? 0,
          })),
          artifactBytes: part.artifactBytes,
          workerHealth: part.workerHealth,
        }),
      ),
      measuredExecutions: resources.measuredExecutions,
      costliest: resources.costliest.slice(0, 10).map((e) => dropNulls(e)),
    };
  },

  // ── get_failure_groups ─────────────────────────────────────────────────────
  async get_failure_groups(db, params, ctx) {
    const runId = numericParam(params.runId, 'runId');
    if ((await checkEntityScope(db, ctx, runId, resolveRunProjectId)) === 'not-found') return null;
    const groups = (await getFailureGroups(db, runId)) as any[];
    return {
      groups: groups.slice(0, 30).map((g: any) =>
        dropNulls({
          clusterId: g.clusterId,
          signature: g.signature,
          title: g.title || null,
          status: g.status,
          count: g.count ?? (g.cases?.length || null),
          workerCorrelated: g.workerCorrelated || null,
          cases: Array.isArray(g.cases)
            ? g.cases.slice(0, 10).map((c: any) =>
                dropNulls({
                  executionId: c.executionId ?? c.id,
                  testCaseId: c.testCaseId,
                  title: c.title,
                  filePath: c.filePath,
                }),
              )
            : null,
        }),
      ),
    };
  },

  // ── get_locator_healing ────────────────────────────────────────────────────
  async get_locator_healing(db, params, ctx) {
    const id = numericParam(params.executionId, 'executionId');
    if ((await checkEntityScope(db, ctx, id, resolveTestRunCaseProjectId)) === 'not-found') return null;
    const h = await getLocatorHealing(db, id);
    if (!h) return null;
    // Healing does not apply (the locator resolved, a navigation failed, no
    // locator in the error): say why, so an agent does not rewrite the selector.
    if (h.applicable === false) return dropNulls({ executionId: id, applicable: false, reason: h.reason });
    if (h.source === 'none') return null;
    const rankedList = (arr: any[] | null | undefined) =>
      arr && arr.length
        ? arr.slice(0, 8).map((a: any) => dropNulls({ locator: a.locator, method: a.method, score: a.score }))
        : null;
    return dropNulls({
      executionId: id,
      source: h.source,
      capturedAt: h.capturedAt,
      failingLocator: h.failingLocator,
      // The exact edit site: file:line:col + the failing source line, so an
      // agent can apply the recommended fix without re-deriving either.
      location: h.location ?? null,
      sourceLine: h.sourceLine ? dropNulls({ line: h.sourceLine.line, text: h.sourceLine.text }) : null,
      // The recommended fix as a ready-to-apply edit: the rewritten line plus a
      // git-applyable unified diff, so an agent can patch the file directly.
      edit: h.edit
        ? dropNulls({
            filePath: h.edit.filePath,
            line: h.edit.line,
            oldLine: h.edit.oldLine,
            newLine: h.edit.newLine,
            unifiedDiff: h.edit.unifiedDiff,
          })
        : null,
      healedInRunId: h.healedInRunId ?? null,
      recommendation: h.recommendation
        ? dropNulls({
            recommended: h.recommendation.recommended
              ? dropNulls({
                  locator: h.recommendation.recommended.locator,
                  method: h.recommendation.recommended.method,
                  score: h.recommendation.recommended.score,
                })
              : null,
            durable: h.recommendation.durable
              ? dropNulls({
                  locator: h.recommendation.durable.locator,
                  method: h.recommendation.durable.method,
                  score: h.recommendation.durable.score,
                })
              : null,
            preservesConvention: h.recommendation.preservesConvention || null,
            hasDurableAlternative: h.recommendation.hasDurableAlternative || null,
            suggestAddTestId: h.recommendation.suggestAddTestId || null,
          })
        : null,
      fromDiffRename: rankedList(h.fromDiffRename),
      diffRename: h.diffRename ?? null,
      fromPriorSuccess: rankedList(h.fromPriorSuccess),
      fromElementMatch: rankedList(h.fromElementMatch),
      fromAriaSnapshot: rankedList(h.fromAriaSnapshot),
      priorNameMayBeStale: h.priorNameMayBeStale || null,
    });
  },

  // ── predict_locator_breaks ─────────────────────────────────────────────────
  async predict_locator_breaks(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const diff = typeof params.diff === 'string' ? params.diff : '';
    if (!diff.trim()) throw new Error('diff is required: the output of `git diff` for the change');
    if (diff.length > MAX_PREDICT_DIFF_CHARS) throw new Error(`diff is over ${MAX_PREDICT_DIFF_CHARS} characters`);
    const branch = typeof params.branch === 'string' && params.branch.trim() ? params.branch.trim() : null;
    const index = await getLocatorIndex(db, projectId, { branch });
    if (!index) return null;
    const breaks = predictDiffBreaks(diff, index);
    const items = breaks.slice(0, MAX_PREDICTED_BREAKS).map((b) => {
      const stored = toRunLocatorBreak(b);
      return dropNulls({
        locator: b.locator,
        confidence: b.confidence,
        rewrite: b.rewrite ?? null,
        change: dropNulls({
          filePath: b.anchor.file,
          line: b.anchor.line,
          kind: b.anchor.kind,
          attribute: b.anchor.attribute ?? null,
          key: b.anchor.key ?? null,
          before: b.anchor.before,
          after: b.anchor.after ?? null,
        }),
        tests: b.tests.slice(0, 20).map((t) => ({ testCaseId: t.id, title: t.title, filePath: t.file })),
        callSites: stored.callSites,
        // Replace each `before` string literal with `after` at the call sites, keeping the quotes.
        edits: stored.replacements.map(([before, after]) => ({ before, after })),
      });
    });
    return {
      branch: index.branch ?? index.defaultBranch,
      locators: index.locators.length,
      truncated: breaks.length > MAX_PREDICTED_BREAKS || index.truncated || null,
      items,
      nextCursor: null,
    };
  },

  // ── search ─────────────────────────────────────────────────────────────────
  async search(db, params, ctx) {
    const q = String(params.q ?? '').trim();
    if (q.length < 2) return { projects: [], runs: [], cases: [], clusters: [] };
    const res = await searchProjectsTestRunsCases(db, q, ctx.scope);
    return {
      projects: res.projects.map((p: any) => dropNulls({ id: p.id, name: p.name, label: p.label || null })),
      runs: res.runs.map((r: any) =>
        dropNulls({
          id: r.id,
          label: r.label || null,
          status: r.status,
          projectId: r.projectId,
          projectName: r.projectName,
          startedAt: iso(r.startTime),
        }),
      ),
      cases: res.cases.map((c: any) =>
        dropNulls({ testCaseId: c.id, title: c.title, filePath: c.filePath, projectId: c.projectId }),
      ),
      clusters: res.clusters.map((c) =>
        dropNulls({
          id: c.id,
          name: c.name,
          status: c.status,
          projectId: c.projectId,
          issueKey: c.issueKey,
        }),
      ),
    };
  },

  // ── list_case_traces ───────────────────────────────────────────────────────
  async list_case_traces(db, params, ctx) {
    const id = numericParam(params.executionId, 'executionId');
    if ((await checkEntityScope(db, ctx, id, resolveTestRunCaseProjectId)) === 'not-found') return null;
    const traces = (await getTestRunCaseTraces(db, id)) as any[];
    return {
      traces: traces.map((t: any) =>
        dropNulls({ id: t.id, filePath: t.filePath, downloadPath: `/api/files/${t.filePath}` }),
      ),
    };
  },

  // ── list_links ─────────────────────────────────────────────────────────────
  async list_links(db, params, ctx) {
    const entityType = String(params.entityType ?? '');
    const entityId = numericParam(params.entityId, 'entityId');
    const resolver =
      entityType === 'test_run'
        ? resolveRunProjectId
        : entityType === 'test_runs_case'
          ? resolveTestRunCaseProjectId
          : entityType === 'test_case'
            ? resolveCaseProjectId
            : entityType === 'failure_cluster'
              ? resolveClusterProjectId
              : null;
    if (!resolver) {
      throw new Error('entityType must be test_run, test_runs_case, test_case, or failure_cluster');
    }
    if ((await checkEntityScope(db, ctx, entityId, resolver)) === 'not-found') return null;
    const { links } = await listLinks(db, entityType as LinkEntityType, entityId);
    return {
      links: links.map((l: any) =>
        dropNulls({
          id: l.id,
          url: l.url,
          provider: l.provider,
          key: l.key || null,
          title: l.title || null,
          statusText: l.statusText || null,
        }),
      ),
    };
  },

  async create_issue(db, params, ctx) {
    const entityType = String(params.entityType ?? '') as DraftEntityType;
    if (entityType !== 'failure_cluster' && entityType !== 'test_runs_case' && entityType !== 'bug_report') {
      throw new Error('entityType must be failure_cluster, test_runs_case or bug_report');
    }
    const entityId = numericParam(params.entityId, 'entityId');
    const projectId = await resolveLinkEntityProjectId(db, entityType, entityId);
    if (projectId == null) return null;
    assertProject(ctx, projectId);
    assertPermission(ctx, 'issue:create', projectId);

    const include = {
      includeDiagnosis: params.includeDiagnosis === undefined ? undefined : Boolean(params.includeDiagnosis),
      includePatch: params.includePatch === undefined ? undefined : Boolean(params.includePatch),
    };
    const siteUrl = process.env.PIWI_SITE_URL ?? null;
    const locale = toIssueLocale(params.locale);

    const draft = await buildIssueDraft(db, entityType, entityId, { include, locale, siteUrl });
    if (!draft) throw new Error('No Jira connection is configured');

    // Already tracked: hand back the existing issue rather than filing a second.
    if (draft.existing.length) {
      const first = draft.existing[0]!;
      return dropNulls({ key: first.key, url: first.url, existing: draft.existing });
    }

    if (!draft.connectionId || !draft.projectKey || !draft.issueType) {
      throw new Error('Configure a Jira project binding (project key and issue type) before filing issues');
    }

    // Field values arrive keyed by field id, loosely typed (a listed value by its
    // name, a person by account id); the create screen shapes them for Jira.
    const screen = await getCreateFields(db, draft.connectionId, draft.projectKey, draft.issueType).catch(() => null);
    const byId = new Map((screen ?? []).map((f) => [f.id, f]));
    const given =
      params.fields && typeof params.fields === 'object' && !Array.isArray(params.fields)
        ? (params.fields as Record<string, unknown>)
        : {};
    const fields = normalizeFieldValues(
      Object.fromEntries(
        Object.entries(given).map(([id, value]) => {
          const field = byId.get(id);
          return [id, { value: field ? coerceFieldValue(field, value) : value }];
        }),
      ),
    );

    const outcome = await createIssue(db, {
      entityType,
      entityId,
      connectionId: draft.connectionId,
      title: typeof params.title === 'string' ? params.title : draft.title,
      projectKey: draft.projectKey,
      issueType: draft.issueType,
      labels: draft.labels,
      assignee: draft.assignee,
      locale: draft.locale,
      include,
      fields,
      // The auth-disabled administrator is user 0, which no row references.
      requestedBy: ctx.user?.id || null,
      siteUrl,
    });
    if (!outcome) return null;
    if (outcome.missingFields?.length) throw new Error(missingFieldsForAgent(outcome.missingFields, byId));
    if (outcome.fieldErrors?.length) {
      throw new Error(`${outcome.error} Pass values Jira accepts in \`fields\`, keyed by field id.`);
    }
    if (outcome.status === 'pending') {
      throw new Error(
        `Filing the issue is queued: the tracker did not answer${outcome.error ? ` (${outcome.error})` : ''}. Piwi retries it and links the issue to the cluster once it is created.`,
      );
    }
    if (outcome.status !== 'done') throw new Error(outcome.error || 'Filing the issue did not complete');
    return dropNulls({
      key: outcome.key,
      url: outcome.url,
      existing: draft.existing.length ? draft.existing : undefined,
    });
  },

  // ── list_tags ──────────────────────────────────────────────────────────────
  async list_tags(db) {
    const { tags } = await listTags(db);
    return { tags: tags.map((t: any) => dropNulls({ id: t.id, text: t.text, color: t.color })) };
  },

  // ── get_project_test_catalog ───────────────────────────────────────────────
  async get_project_test_catalog(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const pageSize = clampPageSize(params.pageSize);
    const offset = Math.max(0, Number(params.offset) || 0);
    const query = typeof params.query === 'string' && params.query.trim() ? params.query.trim() : undefined;
    const page = await getProjectTestCases(db, projectId, {
      limit: pageSize,
      offset,
      q: query,
      tags: parseTagFilter(typeof params.tags === 'string' ? params.tags : undefined),
      locks: parseLockFilter(typeof params.locks === 'string' ? params.locks : undefined),
      owner: typeof params.owner === 'string' && params.owner.trim() ? params.owner.trim() : undefined,
      priority: typeof params.priority === 'string' ? params.priority.trim().toLowerCase() : undefined,
    });
    return {
      total: page.total,
      offset,
      items: page.items.map((t: any) =>
        dropNulls({
          testCaseId: t.id,
          title: t.title,
          externalId: t.externalId,
          filePath: t.filePath,
          totalRuns: t.totalRuns,
          passed: t.passedRuns || null,
          failed: t.failedRuns || null,
          flaky: t.flakyRuns || null,
          lastStatus: t.lastStatus || null,
          tags: t.tags?.length ? t.tags : null,
          locks: t.locks?.length ? t.locks : null,
          owner: t.owner || null,
          priority: t.priority || null,
          avgDuration: t.avgDuration != null ? Math.round(t.avgDuration) : null,
        }),
      ),
      nextOffset: offset + pageSize < page.total ? offset + pageSize : null,
    };
  },

  // ── list_selections ─────────────────────────────────────────────────────────
  async list_selections(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const selections = await listSelections(db, projectId);
    return {
      items: selections.map((s) =>
        dropNulls({
          key: s.key,
          name: s.name,
          description: s.description,
          version: s.version,
          builtin: s.builtin || null,
        }),
      ),
    };
  },

  // ── resolve_selection ───────────────────────────────────────────────────────
  async resolve_selection(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const key = typeof params.key === 'string' ? params.key.trim() : '';
    if (!key) throw new Error('key is required');
    const selection = await getSelection(db, projectId, key);
    if (!selection) throw new Error(`No selection "${key}" in this project`);

    let definition: SelectionDefinition = selection.definition;
    const budgetMs = Number(params.budgetMs);
    if (Number.isFinite(budgetMs) && budgetMs > 0) {
      definition = { ...definition, budget: { ...definition.budget, maxTotalDurationMs: budgetMs } };
    }
    const resolved = await resolveSelectionDefinition(db, projectId, definition, {
      key: selection.key,
      version: selection.version,
      format: selectionFormatParam(params.format),
    });
    return selectionToMcp(resolved);
  },

  // ── preview_selection ───────────────────────────────────────────────────────
  async preview_selection(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const check = validateSelectionDefinition(params.definition);
    if (!check.valid) throw new Error(`Invalid definition: ${check.errors.join('; ')}`);
    const resolved = await resolveSelectionDefinition(db, projectId, params.definition as SelectionDefinition, {
      format: selectionFormatParam(params.format),
    });
    return selectionToMcp(resolved);
  },

  // ── suggest_selections ──────────────────────────────────────────────────────
  async suggest_selections(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const budgetMs = Number(params.budgetMs);
    const suggestions = await getSelectionSuggestions(db, projectId, {
      budgetMs: Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : undefined,
    });
    return {
      tags: suggestions.tags.map((t) =>
        dropNulls({
          testCaseId: t.testCaseId,
          title: t.title,
          kind: t.kind,
          tag: t.tag,
          confidence: Number(t.confidence.toFixed(2)),
          evidence: t.evidence,
        }),
      ),
      smoke: suggestions.smoke
        ? dropNulls({
            budgetMs: suggestions.smoke.budgetMs,
            totalRoutes: suggestions.smoke.totalRoutes,
            coveredRoutes: suggestions.smoke.coveredRoutes,
            testCaseIds: suggestions.smoke.testCaseIds,
            splitLocks: suggestions.smoke.splitLocks.length ? suggestions.smoke.splitLocks : null,
            picks: suggestions.smoke.picks.map((p) =>
              dropNulls({
                testCaseId: p.testCaseId,
                title: p.title,
                newRoutes: p.newRoutes,
                cumulativeRoutes: p.cumulativeRoutes,
                cumulativeDurationMs: p.cumulativeDurationMs,
              }),
            ),
          })
        : null,
    };
  },

  // ── analyze_selections ──────────────────────────────────────────────────────
  async analyze_selections(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const analytics = await getSelectionAnalytics(db, projectId);
    return {
      selections: analytics.selections.map((s) =>
        dropNulls({
          key: s.key,
          name: s.name,
          builtin: s.builtin || null,
          resolvedCount: s.resolvedCount,
          quarantinedCount: s.quarantinedCount || null,
          totalDurationMs: s.totalDurationMs,
          warnings: s.warnings.length ? s.warnings.map((w) => w.message) : null,
          lastRun: s.lastRun ? { runId: s.lastRun.runId, recordedCount: s.lastRun.recordedCount } : null,
          drift: s.drift ? dropNulls({ changed: s.drift.changed, countDelta: s.drift.countDelta || null }) : null,
        }),
      ),
      coverage: {
        total: analytics.coverage.total,
        selected: analytics.coverage.selected,
        unselected: analytics.coverage.unselected,
        unselectedSample: analytics.coverage.unselectedSample,
      },
    };
  },

  // ── list_open_clusters ─────────────────────────────────────────────────────
  async list_open_clusters(db, params, ctx) {
    if (ctx.scope !== 'all' && ctx.scope.size === 0) return { items: [], nextCursor: null };
    const pageSize = clampPageSize(params.pageSize);
    const cursor = numericCursor(params.cursor);

    // Queue filter: reuse the inbox source (open, non-snoozed, enriched) and the
    // same pure predicates the dashboard queues use, then page in memory by id on
    // the same axis as the emitted cursor.
    const queue = params.queue as string | undefined;
    if (queue && isInboxQueue(queue) && queue !== 'all') {
      const user = { name: ctx.user?.name ?? null, email: ctx.user?.email ?? null };
      const enriched = await getOpenFailureClusters(db, ctx.scope, 200);
      const mappedQueue = enriched
        .filter((c) => clusterInQueue(c, queue, { user, lastVisitMs: null }))
        .filter((c) => (cursor ? c.id < cursor : true))
        .sort((a, b) => b.occurrences - a.occurrences || b.id - a.id)
        .map((c) =>
          dropNulls({
            id: c.id,
            projectId: c.projectId,
            signature: c.signature,
            title: c.title || null,
            errorType: c.errorType || null,
            status: c.status,
            occurrences: c.occurrences,
            lastSeenRunId: c.lastSeenRunId,
            sampleError: trunc(c.sampleError, 300),
          }),
        );
      return paginatedItems(mappedQueue, pageSize, (c: any) => String(c.id));
    }

    const statusFilter = (params.status as string) || 'open';

    const conditions = [eq(failureClusters.status, statusFilter)];
    if (ctx.scope !== 'all') conditions.push(inArray(failureClusters.projectId, [...ctx.scope]));
    if (cursor) conditions.push(lt(failureClusters.id, cursor));

    const rows = await db
      .select({
        id: failureClusters.id,
        projectId: failureClusters.projectId,
        signature: failureClusters.signature,
        title: failureClusters.title,
        errorType: failureClusters.errorType,
        status: failureClusters.status,
        occurrences: failureClusters.occurrences,
        lastSeenRunId: failureClusters.lastSeenRunId,
        sampleError: failureClusters.sampleError,
      })
      .from(failureClusters)
      .where(and(...conditions))
      .orderBy(desc(failureClusters.occurrences), desc(failureClusters.id))
      .limit(pageSize + 1);

    const mapped = rows.map((c) =>
      dropNulls({
        id: c.id,
        projectId: c.projectId,
        signature: c.signature,
        title: c.title || null,
        errorType: c.errorType || null,
        status: c.status,
        occurrences: c.occurrences,
        lastSeenRunId: c.lastSeenRunId,
        sampleError: trunc(c.sampleError, 300),
      }),
    );
    // The cursor is the last id while the order is (occurrences DESC, id DESC),
    // so a later page skips clusters newer than the cursor and can repeat older
    // ones already shown.
    return paginatedItems(mapped, pageSize, (c: any) => String(c.id));
  },

  // ── get_instance_stats ─────────────────────────────────────────────────────
  async get_instance_stats(db, _params, ctx) {
    assertPermission(ctx, 'storage:manage');
    return getAdminStats(db);
  },

  // ── explain_failure ────────────────────────────────────────────────────────
  async explain_failure(db, params, ctx) {
    const id = numericParam(params.executionId, 'executionId');
    const projectId = await resolveTestRunCaseProjectId(db, id);
    if (projectId == null) return null;
    assertProject(ctx, projectId);

    const [row] = await db.select().from(testRunsCases).where(eq(testRunsCases.id, id));
    if (!row) return null;
    const evidence = await inlineCasePayloads(db, row);
    const [tc] = await db
      .select({ title: testCases.title, filePath: testCases.filePath })
      .from(testCases)
      .where(eq(testCases.id, row.testCaseId));

    const [healing, screenshotRows, diagContext, cluesResult, pageDiff, detail] = await Promise.all([
      getLocatorHealing(db, id).catch(() => null),
      selectCaseScreenshots(db, id),
      row.failureClusterId
        ? buildDiagnosisContext(db, {
            kind: 'execution',
            executionId: id,
            clusterId: row.failureClusterId,
            skipScm: true,
          }).catch(() => null)
        : Promise.resolve(null),
      getFailureClues(db, id).catch(() => null),
      getPageDiff(db, id).catch(() => null),
      getTestRunCase(db, id, null, { resolveOwner: codeownersOwnerResolver(db, projectId) }).catch(() => null),
    ]);

    const rec = healing && healing.source !== 'none' ? healing.recommendation?.recommended : null;
    const story = cluesResult?.story ?? null;
    const nextStep = (detail as { nextStep?: unknown } | null)?.nextStep ?? null;
    const situation = (detail as { situation?: { text?: string } | null } | null)?.situation ?? null;
    const latest = (detail as { latest?: LatestExecution | null } | null)?.latest ?? null;
    // A retry pass has no error of its own: its verdict reads the failed attempt's,
    // and names that attempt's execution.
    const verdict = (detail as { verdict?: FailureVerdict | null } | null)?.verdict ?? null;
    const failedAttempt = verdict?.attempt ?? null;
    const didNotRun = (detail as { didNotRun?: { text?: string } | null } | null)?.didNotRun ?? null;

    return dropNulls({
      executionId: id,
      testCaseId: row.testCaseId,
      title: tc?.title || null,
      filePath: tc?.filePath || null,
      status: row.status,
      headline: caseHeadline(row)?.headline ?? verdict?.headline ?? null,
      failedAttempt: failedAttempt ? { executionId: failedAttempt.executionId, retry: failedAttempt.retry } : null,
      error: trunc(row.error, 1500),
      story: story
        ? dropNulls({ id: story.id, sentence: story.sentence, strength: story.strength, clueIds: story.clueIds })
        : null,
      situation: situation?.text || null,
      didNotRun: didNotRun?.text || null,
      latest: latest
        ? dropNulls({
            isLatest: latest.isLatest,
            executionId: latest.newest?.executionId ?? null,
            runId: latest.newest?.runId ?? null,
            status: latest.newest?.status ?? null,
          })
        : null,
      nextStep: nextStep ?? null,
      clues: cluesResult ? compactClues(cluesResult) : null,
      clusterId: row.failureClusterId || null,
      slowestStep: row.slowestStep || null,
      steps: row.steps,
      consoleLogs: row.consoleLogs,
      ariaSnapshot: trunc(evidence.ariaSnapshot, 3000),
      locatorFix: rec ? dropNulls({ locator: rec.locator, method: rec.method, score: rec.score }) : null,
      pageDiff:
        pageDiff?.status === 'ok' && pageDiff.summary
          ? dropNulls({
              summary: describePageDiff(pageDiff.summary),
              changes: formatPageDiffSummary(pageDiff.summary),
              baselineRunId: pageDiff.baseline?.runId ?? null,
              locatorChange:
                pageDiff.hunks?.find((h) => h.matchesLocator)?.type === 'renamed'
                  ? `the failing locator's ${pageDiff.hunks.find((h) => h.matchesLocator)!.role} was renamed`
                  : pageDiff.hunks?.some((h) => h.matchesLocator && h.type === 'removed')
                    ? `the failing locator's node was removed from the page`
                    : null,
            })
          : null,
      screenshotCount: screenshotRows.length || null,
      diagnosisContext: diagContext?.text || null,
      isNewRegression: row.isNewRegression || null,
      isNewFlaky: row.isNewFlaky || null,
    });
  },

  // ── set_cluster_status ─────────────────────────────────────────────────────
  async set_cluster_status(db, params, ctx) {
    const id = numericParam(params.clusterId, 'clusterId');
    if ((await checkEntityScope(db, ctx, id, resolveClusterProjectId, 'triage:write')) === 'not-found') return null;
    const status = String(params.status ?? '');
    if (!['open', 'resolved', 'ignored'].includes(status)) {
      throw new Error('status must be one of: open, resolved, ignored');
    }
    const note = typeof params.triageNote === 'string' ? params.triageNote : undefined;
    const result = await patchClusterStatus(db, id, status, note);
    if (!result) return null;
    return dropNulls({ id, status, triageNote: result.cluster?.triageNote ?? null, ok: true });
  },

  // ── set_cluster_base_commit ────────────────────────────────────────────────
  async set_cluster_base_commit(db, params, ctx) {
    const id = numericParam(params.clusterId, 'clusterId');
    if ((await checkEntityScope(db, ctx, id, resolveClusterProjectId, 'triage:write')) === 'not-found') return null;
    const commit = typeof params.commit === 'string' ? params.commit.trim() : null;
    const result = await patchClusterBaseCommit(db, id, commit);
    if (!result) return null;
    return dropNulls({ id, manualBaseCommit: commit, ok: true });
  },

  // ── submit_diagnosis_feedback ──────────────────────────────────────────────
  async submit_diagnosis_feedback(db, params, ctx) {
    const id = numericParam(params.diagnosisId, 'diagnosisId');
    const feedback = params.feedback == null ? null : String(params.feedback);
    if (feedback !== null && feedback !== 'up' && feedback !== 'down') {
      throw new Error('feedback must be "up", "down", or null');
    }
    const [existing] = await db
      .select({ id: failureDiagnoses.id })
      .from(failureDiagnoses)
      .where(eq(failureDiagnoses.id, id))
      .limit(1);
    if (!existing) return null;
    // Resolve via the diagnosis itself — cluster-scoped rows resolve through their
    // cluster, execution-scoped rows (null cluster) through their run.
    if ((await checkEntityScope(db, ctx, existing.id, resolveDiagnosisProjectId, 'project:read')) === 'not-found') {
      return null;
    }
    const note = typeof params.feedbackNote === 'string' ? params.feedbackNote.trim() || null : null;
    await db
      .update(failureDiagnoses)
      .set({ feedback, feedbackNote: note, updatedAt: new Date() })
      .where(eq(failureDiagnoses.id, id));
    return { id, feedback, ok: true };
  },

  // ── run_cluster_diagnosis ──────────────────────────────────────────────────
  async run_cluster_diagnosis(db, params, ctx) {
    const id = numericParam(params.clusterId, 'clusterId');
    const cluster = await checkEntityScope(db, ctx, id, loadCluster, 'ai:run');
    if (cluster === 'not-found') return null;
    if (isDiagnosisRunning(id)) throw new Error('Diagnosis is already running for this cluster');

    // Return the stored completed diagnosis unless a re-run is asked for.
    if (params.force !== true && params.force !== 'true') {
      const [existing] = await db
        .select()
        .from(failureDiagnoses)
        .where(and(eq(failureDiagnoses.clusterId, id), eq(failureDiagnoses.scope, 'cluster')))
        .limit(1);
      if (existing?.status === 'completed') return dropNulls({ clusterId: id, ...diagnosisToMcp(existing) });
    }

    const config = await resolveAiConfig(db);
    if (!config) throw new Error(AI_NOT_CONFIGURED);
    const baseCommit = typeof params.baseCommit === 'string' ? params.baseCommit : undefined;
    const diag = await runClusterDiagnosis(db, cluster, config, { baseCommit });
    return dropNulls({ clusterId: id, ...diagnosisToMcp(diag) });
  },

  // ── run_execution_diagnosis ────────────────────────────────────────────────
  async run_execution_diagnosis(db, params, ctx) {
    const id = numericParam(params.executionId, 'executionId');
    const execution = await checkEntityScope(db, ctx, id, loadExecutionForDiagnosis, 'ai:run');
    if (execution === 'not-found') return null;
    const outcome = await diagnoseExecution(db, execution, {
      force: params.force === true || params.force === 'true',
      additionalContext:
        typeof params.additionalContext === 'string' && params.additionalContext.trim()
          ? params.additionalContext
          : undefined,
      baseCommit: typeof params.baseCommit === 'string' && params.baseCommit.trim() ? params.baseCommit : undefined,
    });
    if (!outcome.ok) {
      if (outcome.error === 'not-failed') throw new Error(`Execution ${id} did not fail: there is nothing to diagnose`);
      if (outcome.error === 'not-configured') throw new Error(AI_NOT_CONFIGURED);
      throw new Error('A diagnosis is already running for this failure');
    }
    return dropNulls({ executionId: id, ...diagnosisToMcp(outcome.diagnosis) });
  },

  // ── triage_cluster ─────────────────────────────────────────────────────────
  async triage_cluster(db, params, ctx) {
    const ids = parseBulkIds(params.clusterIds);
    if (!ids) {
      throw new Error(`clusterIds must be a non-empty array of positive integers (max ${BULK_TRIAGE_MAX})`);
    }
    const action = String(params.action ?? '');
    let apply: (allowed: number[]) => Promise<{ updated: number; tests?: number; changed?: number }>;
    if (action === 'status') {
      const status = String(params.status ?? '');
      if (!['open', 'resolved', 'ignored'].includes(status)) {
        throw new Error('status must be one of: open, resolved, ignored');
      }
      const note = typeof params.note === 'string' && params.note.trim() ? params.note : null;
      apply = async (allowed) => {
        if (!note) return { updated: (await bulkTriageClusters(db, allowed, { action: 'status', status }))!.updated };
        let updated = 0;
        for (const id of allowed) if (await patchClusterStatus(db, id, status, note)) updated += 1;
        return { updated };
      };
    } else if (action === 'assign') {
      if (params.assignee != null && typeof params.assignee !== 'string') {
        throw new Error('assignee must be a string (empty to unassign)');
      }
      const assignee = (params.assignee as string | undefined) ?? null;
      apply = async (allowed) => (await bulkTriageClusters(db, allowed, { action: 'assign', assignee }))!;
    } else if (action === 'snooze') {
      const snooze = params.snooze ?? null;
      if (snooze !== null && !isSnoozeOption(snooze)) {
        throw new Error('snooze must be one of: 1-day, 1-week, until-recurs (omit to unsnooze)');
      }
      apply = async (allowed) => (await bulkTriageClusters(db, allowed, { action: 'snooze', snooze }))!;
    } else if (action === 'quarantine' || action === 'release') {
      const reason =
        typeof params.reason === 'string' && params.reason.trim() ? params.reason.slice(0, 500) : undefined;
      apply = async (allowed) => {
        let updated = 0;
        let tests = 0;
        let changed = 0;
        for (const id of allowed) {
          const result =
            action === 'quarantine'
              ? await quarantineClusterTests(db, id, { createdBy: ctx.user?.id || null, reason })
              : await releaseClusterTests(db, id, { reason, actor: mcpActor(ctx) });
          if (!result) continue;
          updated += 1;
          tests += result.tests;
          changed += 'quarantined' in result ? result.quarantined : result.released;
        }
        return { updated, tests, changed };
      };
    } else {
      throw new Error('action must be one of: status, assign, snooze, quarantine, release');
    }

    // Like the bulk REST route: refused when the caller holds the action's
    // permission on no project, else applied only to the clusters of the
    // projects where they hold it.
    const permission: ProjectPermission =
      action === 'quarantine' || action === 'release' ? 'quarantine:write' : 'triage:write';
    if (!holdsAnywhere(ctx.access, permission)) throw new Error(permissionRefusal([permission]));
    const rows = await db
      .select({ id: failureClusters.id, projectId: failureClusters.projectId })
      .from(failureClusters)
      .where(inArray(failureClusters.id, ids));
    const allowed = new Set(
      rows
        .filter((r) => scopeAllows(ctx.scope, r.projectId) && can(ctx.access, permission, r.projectId))
        .map((r) => r.id),
    );
    const result = await apply([...allowed]);
    const uniqueCoverage =
      action === 'quarantine' || action === 'release'
        ? await clusterTestsUniqueCoverage(
            db,
            rows.filter((r) => allowed.has(r.id)),
          )
        : [];
    return dropNulls({
      action,
      requested: ids.length,
      updated: result.updated,
      tests: result.tests ?? null,
      quarantined: action === 'quarantine' ? result.changed : null,
      released: action === 'release' ? result.changed : null,
      skippedIds: ids.filter((id) => !allowed.has(id)),
      uniqueCoverage,
    });
  },

  // ── triage_gap ─────────────────────────────────────────────────────────────
  async triage_gap(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    const gapId = numericParam(params.gapId, 'gapId');
    const validation = gapTriageSchema.safeParse(params);
    if (!validation.success) {
      throw new Error(validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    assertProject(ctx, projectId);
    assertPermission(ctx, 'triage:write', projectId);
    // The auth-disabled administrator is user 0, which no row references.
    const result = await triageGap(db, projectId, gapId, { ...validation.data, triagedByUserId: ctx.user?.id || null });
    if ('error' in result) {
      if (result.error === 'gap-not-found') return null;
      throw new Error('Covering test not found in this project');
    }
    return { id: gapId, projectId, status: result.status };
  },

  // ── decide_merge_suggestion ────────────────────────────────────────────────
  async decide_merge_suggestion(db, params, ctx) {
    const decision = String(params.decision ?? '');
    if (decision !== 'approve' && decision !== 'reject') throw new Error('decision must be approve or reject');
    let suggestionId: number;
    if (params.suggestionId != null) {
      suggestionId = numericParam(params.suggestionId, 'suggestionId');
    } else if (params.clusterId != null) {
      const clusterId = numericParam(params.clusterId, 'clusterId');
      if ((await checkEntityScope(db, ctx, clusterId, resolveClusterProjectId, 'triage:write')) === 'not-found') {
        return null;
      }
      const pending = await pendingSuggestionsForCluster(db, clusterId);
      if (pending.length === 0) throw new Error(`Cluster ${clusterId} has no pending merge suggestion`);
      if (pending.length > 1) {
        const listed = pending.map((p) => `${p.id} (with cluster ${p.otherClusterId})`).join(', ');
        throw new Error(
          `Cluster ${clusterId} has ${pending.length} pending merge suggestions: ${listed}; pass suggestionId`,
        );
      }
      suggestionId = pending[0]!.id;
    } else {
      throw new Error('Pass clusterId or suggestionId');
    }
    if ((await checkEntityScope(db, ctx, suggestionId, getSuggestionProjectId, 'triage:write')) === 'not-found') {
      return null;
    }

    if (decision === 'approve') {
      const merged = await approveSuggestedMerge(db, suggestionId, mcpActor(ctx));
      if (!merged) throw new Error('Suggestion is not pending');
      return { suggestionId, decision, survivorId: merged.survivorId };
    }
    if (!(await rejectMergeSuggestion(db, suggestionId, mcpActor(ctx)))) throw new Error('Suggestion is not pending');
    return { suggestionId, decision, ok: true };
  },

  // ── move_tests_to_new_cluster ──────────────────────────────────────────────
  async move_tests_to_new_cluster(db, params, ctx) {
    const id = numericParam(params.clusterId, 'clusterId');
    const testCaseIds = parseBulkIds(params.testCaseIds);
    if (!testCaseIds) {
      throw new Error(`testCaseIds must be a non-empty array of positive integers (max ${BULK_TRIAGE_MAX})`);
    }
    if (params.triageNote != null && typeof params.triageNote !== 'string') {
      throw new Error('triageNote must be a string');
    }
    if ((await checkEntityScope(db, ctx, id, resolveClusterProjectId, 'triage:write')) === 'not-found') return null;
    const note = typeof params.triageNote === 'string' && params.triageNote.trim() ? params.triageNote : undefined;
    const result = await extractClusterCases(db, id, testCaseIds, note);
    if (!result) return null;
    return dropNulls({
      sourceClusterId: id,
      clusterId: result.clusterId,
      movedTests: result.extractedCount,
      remainingOccurrences: result.remainingOccurrences,
    });
  },

  // ── dismiss_quarantine_proposal ────────────────────────────────────────────
  async dismiss_quarantine_proposal(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    const testCaseId = numericParam(params.testCaseId, 'testCaseId');
    const proposal = params.proposal;
    if (!isQuarantineProposal(proposal)) throw new Error('proposal must be quarantine or release');
    if (params.reason != null && typeof params.reason !== 'string') throw new Error('reason must be a string');
    assertProject(ctx, projectId);
    assertPermission(ctx, 'quarantine:write', projectId);
    const reason = normalizeDismissReason(params.reason);
    let dismissed: boolean;
    try {
      dismissed = await dismissQuarantineProposal(db, projectId, testCaseId, proposal, mcpActor(ctx), reason);
    } catch (e) {
      if (e instanceof Error && e.message === 'Test case not found in this project') return null;
      throw e;
    }
    if (!dismissed) throw new Error(`Test ${testCaseId} has no ${proposal} proposal to dismiss`);
    return dropNulls({ projectId, testCaseId, proposal, dismissed, reason });
  },

  // ── set_test_quarantine ────────────────────────────────────────────────────
  async set_test_quarantine(db, params, ctx) {
    const testCaseId = numericParam(params.testCaseId, 'testCaseId');
    if (typeof params.quarantined !== 'boolean') throw new Error('quarantined must be true or false');
    if (params.reason != null && typeof params.reason !== 'string') throw new Error('reason must be a string');
    const projectId = await checkEntityScope(db, ctx, testCaseId, resolveCaseProjectId, 'quarantine:write');
    if (projectId === 'not-found') return null;
    const reason = typeof params.reason === 'string' && params.reason.trim() ? params.reason.slice(0, 500) : null;
    if (params.quarantined) {
      const { created } = await addQuarantine(db, projectId, testCaseId, { reason, createdBy: ctx.user?.id || null });
      // A test already in quarantine keeps the reason it was quarantined with.
      return dropNulls({
        testCaseId,
        quarantined: true,
        changed: created,
        reason: created ? reason : null,
        uniqueCoverage: await uniqueCoverageSummary(db, projectId, [testCaseId]),
      });
    }
    const { released } = await releaseQuarantine(db, projectId, testCaseId, reason, mcpActor(ctx));
    if (!released) throw new Error(`Test ${testCaseId} is not in quarantine`);
    return dropNulls({
      testCaseId,
      quarantined: false,
      changed: true,
      reason,
      uniqueCoverage: await uniqueCoverageSummary(db, projectId, [testCaseId]),
    });
  },

  // ── set_bug_report_status ──────────────────────────────────────────────────
  async set_bug_report_status(db, params, ctx) {
    const id = numericParam(params.id, 'id');
    const validation = bugReportPatchSchema.safeParse({ status: params.status });
    if (!validation.success || !validation.data.status) {
      throw new Error('status must be one of: open, dismissed, closed');
    }
    if ((await checkEntityScope(db, ctx, id, resolveBugReportProjectId, 'bug-report:write')) === 'not-found') {
      return null;
    }
    const report = await updateBugReport(db, id, { status: validation.data.status });
    if (!report) return null;
    return { id, status: report.status };
  },

  // ── rerun_cluster_in_ci ────────────────────────────────────────────────────
  async rerun_cluster_in_ci(db, params, ctx) {
    const id = numericParam(params.clusterId, 'clusterId');
    if ((await checkEntityScope(db, ctx, id, resolveClusterProjectId, 'run:control')) === 'not-found') return null;
    const outcome = await rerunClusterInCi(db, id, {
      id: ctx.user?.id || null,
      name: ctx.user?.name || ctx.user?.username || null,
    });
    if (!outcome.ok) {
      if (outcome.error === 'not-found') return null;
      throw new Error(outcome.message);
    }
    const { provider, url, args, at } = outcome.dispatch;
    return dropNulls({ clusterId: id, provider, url, args, dispatchedAt: iso(at) });
  },

  // ── set_cluster_bisect ─────────────────────────────────────────────────────
  async set_cluster_bisect(db, params, ctx) {
    const id = numericParam(params.clusterId, 'clusterId');
    if ((await checkEntityScope(db, ctx, id, resolveClusterProjectId, 'run:control')) === 'not-found') return null;
    const parsed = parseBisectResultBody(params);
    if (!parsed.ok) throw new Error(parsed.message);
    const commit = await recordClusterBisect(db, id, parsed.value);
    if (!commit) return null;
    return dropNulls({
      clusterId: id,
      sha: commit.sha,
      subject: commit.subject,
      author: commit.author,
      date: commit.date,
    });
  },

  // ── record_diagnosis ───────────────────────────────────────────────────────
  async record_diagnosis(db, params, ctx) {
    const target = diagnosisTarget(params);
    const parsed = parseAgentDiagnosis({ model: params.model, diagnosis: params.diagnosis });
    if (!parsed.ok) throw new Error(parsed.message);
    const id = target.scope === 'cluster' ? target.clusterId : target.executionId;
    const resolved = await checkEntityScope(db, ctx, id, (db) => resolveAgentDiagnosisTarget(db, target), 'ai:run');
    if (resolved === 'not-found') return null;
    const result = await recordAgentDiagnosisOn(db, target, parsed.value, mcpActor(ctx), resolved);
    if (!result.ok) {
      if (result.error === 'not-found') return null;
      throw new Error(agentDiagnosisErrorMessage(result.error, target.scope));
    }
    return dropNulls({
      clusterId: target.scope === 'cluster' ? target.clusterId : null,
      executionId: target.scope === 'execution' ? target.executionId : null,
      diagnosisId: result.diagnosisId,
      category: parsed.value.diagnosis.category,
      confidence: parsed.value.diagnosis.confidence,
      patchValidation: result.patchValidation,
      replacedPrevious: result.replacedVersion || null,
    });
  },

  // ── report_fix_attempt ─────────────────────────────────────────────────────
  async report_fix_attempt(db, params, ctx) {
    const id = numericParam(params.clusterId, 'clusterId');
    const { clusterId: _clusterId, channel: _channel, ...body } = params;
    const parsed = parseFixAttempt(body);
    if (!parsed.ok) throw new Error(parsed.message);
    if ((await checkEntityScope(db, ctx, id, resolveClusterProjectId, 'run:control')) === 'not-found') return null;
    const result = await reportFixAttempt(db, id, parsed.value, mcpActor(ctx));
    if (!result.ok) {
      if (result.error === 'not-found') return null;
      throw new Error(FIX_ATTEMPT_ERRORS[result.error].message);
    }
    return dropNulls({
      clusterId: id,
      key: result.attempt.key,
      outcome: result.attempt.outcome,
      recorded: result.recorded,
      commitTrailer: clusterTrailerLine(id),
    });
  },

  // ── set_run_incident ───────────────────────────────────────────────────────
  async set_run_incident(db, params, ctx) {
    const id = numericParam(params.runId, 'runId');
    const input = parseSetRunIncident({ incident: params.incident, reason: params.reason });
    if (typeof input === 'string') throw new Error(input);
    const projectId = await checkEntityScope(db, ctx, id, resolveRunProjectId);
    if (projectId === 'not-found') return null;
    assertPermission(ctx, ['run:submit', 'run:control'], projectId);
    const by = ctx.user?.id ? ctx.user.name || ctx.user.username : null;
    const state = await decideRunIncident(db, id, input, by);
    return dropNulls({
      runId: id,
      incident: state.incident ? { rule: state.incident.rule, reason: state.incident.reason } : null,
      decision: state.review?.decision ?? null,
    });
  },

  // ── link_issue ─────────────────────────────────────────────────────────────
  async link_issue(db, params, ctx) {
    const validation = createLinkSchema.safeParse({
      entityType: params.entityType,
      entityId: params.entityId,
      url: params.url,
      title: params.title,
    });
    if (!validation.success) {
      throw new Error(validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    const { entityType, entityId } = validation.data;
    const projectId = await resolveLinkEntityProjectId(db, entityType, entityId);
    if (projectId == null) return null;
    assertProject(ctx, projectId);
    assertPermission(ctx, 'link:write', projectId);
    const link = await createEnrichedLink(db, validation.data, ctx.scope);
    if (!link) throw new Error('Failed to create link');
    return dropNulls({
      id: link.id,
      entityType,
      entityId,
      url: link.url,
      provider: link.provider,
      key: link.key || null,
      title: link.title || null,
      statusText: link.statusText || null,
    });
  },

  // ── unlink_issue ───────────────────────────────────────────────────────────
  async unlink_issue(db, params, ctx) {
    const validation = createLinkSchema.omit({ title: true }).safeParse({
      entityType: params.entityType,
      entityId: params.entityId,
      url: typeof params.url === 'string' ? params.url.trim() : params.url,
    });
    if (!validation.success) {
      throw new Error(validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    const { entityType, entityId, url } = validation.data;
    const projectId = await resolveLinkEntityProjectId(db, entityType, entityId);
    if (projectId == null) return null;
    assertProject(ctx, projectId);
    assertPermission(ctx, 'link:write', projectId);
    const removed = await deleteLinksTo(db, entityType, entityId, url);
    if (removed === 0) throw new Error(`${entityType} ${entityId} has no link to ${url}`);
    return { entityType, entityId, url, removed };
  },

  // ── create_test_function ───────────────────────────────────────────────────
  async create_test_function(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    assertPermission(ctx, 'test-assets:write', projectId);

    const validation = createTestFunctionSchema.safeParse(params);
    if (!validation.success) {
      throw new Error(validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }

    try {
      const { testFunction } = await createTestFunction(db, projectId, {
        ...validation.data,
        source: validation.data.source ?? 'ai-extracted',
      });
      return dropNulls({
        id: testFunction.id,
        projectId,
        name: testFunction.name,
        kind: testFunction.kind,
        module: testFunction.module,
        source: testFunction.source,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create test function';
      throw new Error(
        message.toLowerCase().includes('unique') ? 'A function with this name already exists in this module' : message,
      );
    }
  },

  // ── describe_piwi ──────────────────────────────────────────────────────────
  async describe_piwi(db, params, ctx) {
    return describePiwi(db, params, ctx);
  },

  // ── get_release_notes ──────────────────────────────────────────────────────
  async get_release_notes(_db, params) {
    return getReleaseNotes(params);
  },

  async get_change_coverage(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const runId = params.run != null ? numericParam(params.run, 'run') : null;
    const base = typeof params.base === 'string' ? params.base : null;
    const head = typeof params.head === 'string' ? params.head : null;
    // Refs reach SCM API URLs with the project's token — reject traversal.
    if ((base != null && !isValidGitRef(base)) || (head != null && !isValidGitRef(head))) {
      throw new Error('Invalid base or head ref');
    }

    const coverage = await readChangeCoverage(db, projectId, { runId, baseSha: base, headSha: head });
    return dropNulls({
      runId: coverage.runId,
      baseSha: coverage.baseSha,
      headSha: coverage.headSha,
      baseBranch: coverage.baseBranch,
      windowRuns: coverage.windowRuns,
      scmAvailable: coverage.scmAvailable,
      totalFiles: coverage.reachedFiles + coverage.uncoveredFiles,
      reachedFiles: coverage.reachedFiles,
      uncoveredFiles: coverage.uncoveredFiles,
      notCounted: coverage.notCounted,
      patchCoverage: coverage.patchCoverage,
      tickets: coverage.tickets.map((t) =>
        dropNulls({
          ticket: t.ticket,
          files: t.files.map((f) =>
            dropNulls({
              filePath: f.filePath,
              additions: f.additions,
              deletions: f.deletions,
              reach: f.reach,
              reachedInRun: f.reachedInRun,
              reachedCountHistory: f.reachedCountHistory,
              reachingTestCount: f.reachingTestCount,
              suites: f.suites.length > 0 ? f.suites : null,
              lines: f.lines,
            }),
          ),
        }),
      ),
    });
  },

  // ── get_coverage, compare_coverage, get_coverage_loss, get_coverage_summary (coverage-tools.ts) ──
  async get_coverage(db, params, ctx) {
    return COVERAGE_TOOL_HANDLERS.get_coverage(db, params, ctx);
  },

  async compare_coverage(db, params, ctx) {
    return COVERAGE_TOOL_HANDLERS.compare_coverage(db, params, ctx);
  },

  async get_coverage_summary(db, params, ctx) {
    return COVERAGE_TOOL_HANDLERS.get_coverage_summary(db, params, ctx);
  },

  async get_coverage_loss(db, params, ctx) {
    return COVERAGE_TOOL_HANDLERS.get_coverage_loss(db, params, ctx);
  },

  async list_scenario_gaps(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const gapClass = typeof params.class === 'string' ? params.class : undefined;
    const feature = typeof params.feature === 'string' ? params.feature : undefined;
    const minScore = params.minScore != null ? numericParam(params.minScore, 'minScore') : undefined;
    const pr = params.pr != null ? numericParam(params.pr, 'pr') : undefined;
    const limit = params.limit != null ? clampPageSize(params.limit) : 20;

    let gaps = await listScenarioGaps(db, projectId, {
      class: gapClass,
      minScore,
      prNumber: pr,
      limit: feature ? 200 : limit,
    });

    // Feature filter: the gaps the list files under the feature (a hub's gaps
    // belong to no one feature).
    if (feature) gaps = gaps.filter((g) => g.feature === feature).slice(0, limit);

    return {
      items: gaps.map((g) =>
        dropNulls({
          id: g.id,
          detector: g.detector,
          class: g.class,
          title: g.title,
          evidence: g.evidence,
          score: g.score,
          status: g.status,
          ticket: g.ticket,
          prNumber: g.prNumber,
          testCaseId: g.testCaseId,
        }),
      ),
    };
  },

  async draft_scenario(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const gapId = numericParam(params.gapId, 'gapId');
    const draft = await issueScenarioDraft(db, projectId, gapId, mcpActor(ctx));
    if (!draft) return { error: `No gap #${gapId} in project ${projectId}` };
    return {
      title: draft.gapTitle,
      class: draft.gapClass,
      annotations: draft.annotations,
      path: draft.path,
      catalogMethods: draft.catalogMethods.map((m) => `${m.module}#${m.name}`),
      draft: draft.text,
    };
  },

  async get_feature_graph(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const nodeParam = typeof params.node === 'string' ? params.node.trim() : '';
    const sep = nodeParam.indexOf(':');
    if (sep <= 0) return { error: 'node must be "kind:key", e.g. route:POST /api/orders' };
    const depth = params.depth != null ? numericParam(params.depth, 'depth') : 2;
    const graph = await getFeatureGraph(
      db,
      projectId,
      { kind: nodeParam.slice(0, sep), key: nodeParam.slice(sep + 1) },
      depth,
    );
    return {
      seed: `${graph.seed.kind}:${graph.seed.key}`,
      depth: graph.depth,
      nodes: graph.nodes.map((n) => ({
        node: `${n.kind}:${n.key}`,
        class: n.class,
        depth: n.depth,
        tests: n.tests.map((t) => t.title),
      })),
      edges: graph.edges.map((e) => ({
        from: `${e.fromKind}:${e.fromKey}`,
        to: `${e.toKind}:${e.toKey}`,
        kind: e.kind,
      })),
    };
  },

  // ── get_quality_report ─────────────────────────────────────────────────────
  async get_quality_report(db, params, ctx) {
    const dashboard = params.dashboard ?? 'executive';
    if (!isBuiltinDashboardKey(dashboard)) {
      throw new Error('dashboard must be executive, engineering, team, gaps-digest or overview');
    }
    const lang = params.lang ?? undefined;
    if (lang !== undefined && !isReportLanguage(lang))
      throw new Error(`lang must be one of ${REPORT_LANGUAGES.join(', ')}`);
    const scope = toolScope(params, ctx);
    assertDashboardScope(dashboard, scope);
    return collectReportBundle(db, {
      dashboard,
      scope,
      access: ctx.scope,
      language: lang,
      baseUrl: process.env.PIWI_SITE_URL ?? null,
    });
  },

  // ── list_dashboards ────────────────────────────────────────────────────────
  async list_dashboards(db, _params, ctx) {
    const list = await listDashboards(db, mcpDashboardActor(ctx));
    return {
      items: list.items.map((d) =>
        dropNulls({
          id: d.id,
          name: d.name,
          description: d.description,
          kind: d.kind,
          visibility: d.visibility,
          owner: d.ownerName,
          widgets: d.widgetCount,
          updatedAt: d.updatedAt,
        }),
      ),
      instanceDefault: list.instanceDefault ?? 'overview',
    };
  },

  // ── get_dashboard ──────────────────────────────────────────────────────────
  async get_dashboard(db, params, ctx) {
    const query = toolScopeQuery(params, ctx);
    const actor = mcpDashboardActor(ctx);
    const id = String(params.id ?? '');
    try {
      const { definition } = await loadDashboardDefinition(db, id, actor);
      const scope = dashboardScopeWith(definition, query);
      const view = await getDashboard(db, id, actor, ctx.scope, { scope });
      const bands = [];
      for (const band of view.bands) {
        const widgets = [];
        for (const widget of band.widgets) {
          if (!widget.available) {
            widgets.push({ key: widget.key, title: widget.title, available: false, reason: widget.reason });
            continue;
          }
          const data = await runAnalyticsWidget(
            db,
            widget.type,
            applyWidgetScope(scope, widget.scope),
            ctx.scope,
            widget.options,
          );
          widgets.push({ key: widget.key, type: widget.type, title: widget.title, data });
        }
        bands.push({ title: band.title, description: band.description ?? null, widgets });
      }
      return dropNulls({
        id: view.id,
        name: view.name,
        description: view.description,
        kind: view.kind,
        visibility: view.visibility,
        scope: analyticsScopeToQuery(scope),
        hiddenProjects: view.hiddenProjects,
        bands,
      });
    } catch (error) {
      if (error instanceof DashboardError) throw new Error(error.message);
      throw error;
    }
  },

  // ── get_metric_trend ───────────────────────────────────────────────────────
  async get_metric_trend(db, params, ctx) {
    const metric = params.metric;
    if (!isMetricId(metric) || !WIDGET_METRIC_IDS.includes(metric)) {
      throw new Error(`Unknown metric '${String(metric)}'. Use one of: ${WIDGET_METRIC_IDS.join(', ')}`);
    }
    await assertMetricsOffered(db, [metric]);
    const trend = await runAnalyticsWidget(db, 'metric', toolScope(params, ctx), ctx.scope, {
      metric,
      display: 'line',
    });
    return { definition: getMetric(metric).definition, ...(trend as object) };
  },

  // ── compare_periods ────────────────────────────────────────────────────────
  async compare_periods(db, params, ctx) {
    const raw: unknown[] = Array.isArray(params.metrics) ? params.metrics : [];
    const metrics = raw.filter((m): m is MetricId => isMetricId(m) && WIDGET_METRIC_IDS.includes(m));
    if (metrics.length !== raw.length) throw new Error('metrics must be metric ids from the catalog');
    await assertMetricsOffered(db, metrics);
    try {
      return await compareMetricPeriods(
        db,
        toolScope(params, ctx),
        ctx.scope,
        String(params.a ?? ''),
        String(params.b ?? ''),
        metrics.length > 0 ? metrics : undefined,
      );
    } catch (error) {
      if (error instanceof PeriodSpecError) throw new Error(error.message);
      throw error;
    }
  },

  // ── Bug reports ────────────────────────────────────────────────────────────
  async list_bug_reports(db, params, ctx) {
    const projectId = numericParam(params.projectId, 'projectId');
    assertProject(ctx, projectId);
    const pageSize = clampPageSize(params.pageSize);
    const cursor = numericCursor(params.cursor);
    const page = await listBugReports(db, projectId, {
      status: typeof params.status === 'string' ? params.status : null,
      beforeId: cursor,
      limit: pageSize + 1,
    });
    return paginatedItems(
      page.map((r) => dropNulls({ ...r, reproductions: r.reproductions || null })),
      pageSize,
      (r) => String(r.id),
    );
  },

  async get_bug_report(db, params, ctx) {
    const id = numericParam(params.id, 'id');
    if ((await checkEntityScope(db, ctx, id, resolveBugReportProjectId)) === 'not-found') return null;
    const report = await getBugReport(db, id);
    if (!report) return null;
    const bug: BugReport = { v: 1, steps: report.steps, evidence: report.evidence, context: report.context };
    return dropNulls({
      id: report.id,
      projectId: report.projectId,
      title: report.title,
      status: report.status,
      pageKey: report.pageKey,
      path: report.path,
      origin: report.origin,
      reportedBy: report.reportedBy,
      createdAt: report.createdAt,
      language: report.language,
      stepsInWords: report.steps.steps.map((step, i) => `${i + 1}. ${describeStepInWords(step)}`),
      expected: expectedSteps(bug).map(({ index, step }) => ({
        step: index + 1,
        expected: describeExpectation(step),
        actual: step.assertion?.actual ?? null,
        note: step.assertion?.note ?? null,
      })),
      steps: report.steps,
      evidence: {
        console: report.evidence.console.map((c) => ({ level: c.level, message: trunc(c.message, 400), page: c.page })),
        failedRequests: report.evidence.requests.map((r) => ({ method: r.method, url: r.url, status: r.status })),
        screenshots: report.evidence.screenshots.length,
        outline: report.evidence.outline,
      },
      test: report.test
        ? { testCaseId: report.test.id, title: report.test.title, filePath: report.test.filePath }
        : null,
      missedBy: await getBugReportMissedBy(db, id)
        .then((m) =>
          m
            ? {
                summary: m.summary,
                page: m.page,
                testsOnPage: m.visiting.slice(0, 20),
                reaching: m.targets.flatMap((t) => t.reaching).slice(0, 20),
              }
            : null,
        )
        .catch(() => null),
      reproductions: report.reproductionList.map((r) =>
        dropNulls({
          source: r.source,
          verdict: r.verdict,
          divergedAt: r.divergedAt,
          origin: r.origin,
          createdAt: r.createdAt,
        }),
      ),
    });
  },

  async render_steps(db, params, ctx) {
    if (params.bugReportId != null) {
      const id = numericParam(params.bugReportId, 'bugReportId');
      if ((await checkEntityScope(db, ctx, id, resolveBugReportProjectId)) === 'not-found') return null;
      const spec = await renderBugReportSpec(db, id, params.mode === 'run' ? 'run' : 'commit');
      if (!spec) return null;
      return {
        code: spec.code,
        path: spec.path,
        warnings: spec.warnings.map((w) => `step ${w.step + 1}: ${w.message}`),
      };
    }
    const parsed = parseSteps(params.steps);
    if (!parsed.ok) throw new Error(`Not a steps document: ${parsed.errors.slice(0, 3).join('; ')}`);
    const raw = (params.options ?? {}) as Record<string, unknown>;
    const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
      allowed.includes(v as T) ? (v as T) : undefined;
    const result = renderStepsWith(parsed.steps, {
      title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : undefined,
      testImport: typeof raw.testImport === 'string' ? raw.testImport.slice(0, 200) : undefined,
      urls: pick(raw.urls, ['absolute', 'relative'] as const),
      locators: pick(raw.locators, ['first', 'stable'] as const),
      urlChecks: raw.urlChecks === true,
      values: pick(raw.values, ['literal', 'env'] as const),
      expectFail: raw.expectFail === true,
      tags: Array.isArray(raw.tags)
        ? raw.tags.filter((t): t is string => typeof t === 'string').slice(0, 10)
        : undefined,
    });
    return { code: result.code, warnings: result.warnings.map((w) => `step ${w.step + 1}: ${w.message}`) };
  },
};

/** The analytics scope of a report or metric tool call, from the tool's scope properties. */
/** Refuse a metric whose capability this instance declined, naming the capability. */
async function assertMetricsOffered(db: DbClient, metrics: MetricId[]): Promise<void> {
  const needed = metrics.map((id) => getMetric(id).capability).filter((c) => c !== undefined);
  if (needed.length === 0) return;
  const states = await resolveInstanceStates(db);
  for (const id of metrics) {
    const capability = getMetric(id).capability;
    if (capability && states[capability] === 'declined') {
      throw new Error(`Metric '${id}' needs the ${capability} capability, which this instance declined`);
    }
  }
}

function toolScope(params: Record<string, unknown>, ctx: McpContext) {
  return parseAnalyticsScope(toolScopeQuery(params, ctx));
}

/**
 * The analytics query keys a tool call's scope parameters stand for; empty when it passed none. A project
 * out of the caller's scope is refused, as every project-scoped tool does, rather than dropped from the answer.
 */
function toolScopeQuery(params: Record<string, unknown>, ctx: McpContext): Record<string, string> {
  if (Array.isArray(params.projectIds)) for (const id of params.projectIds) assertProject(ctx, Number(id));
  const list = (value: unknown) => (Array.isArray(value) && value.length > 0 ? value.map(String).join(',') : undefined);
  const query: Record<string, string> = {};
  const projects = list(params.projectIds);
  if (projects) query.projects = projects;
  if (params.period) query.period = String(params.period);
  if (params.compare) query.compare = String(params.compare);
  if (params.by) query.by = String(params.by);
  const environments = list(params.environments);
  if (environments) query.environments = environments;
  const branches = list(params.branches);
  if (branches) query.branches = branches;
  if (params.allBranches === true) query.allBranches = 'true';
  if (params.selection) query.sel = String(params.selection);
  const tags = list(params.tags);
  if (tags) query.tags = tags;
  const owners = list(params.owners);
  if (owners) query.owner = owners;
  return query;
}

/** Who a tool call acts as for dashboards; with authentication off every dashboard is shared. */
function mcpDashboardActor(ctx: McpContext): DashboardActor {
  if (!isAuthEnabled()) return dashboardActorFor(null, null);
  return dashboardActorFor(ctx.user?.id ?? null, ctx.access);
}

// Merge the shared catalog with the server-only handlers. Coherence between the
// two is enforced at compile time by `Record<McpToolName, …>` above — no runtime
// guard needed: if this compiles, every tool has exactly one handler.
export const MCP_TOOLS: McpTool[] = MCP_TOOL_DEFS.map((def) => ({
  ...def,
  handler: HANDLERS[def.name],
}));

// ── Desktop-only tools ────────────────────────────────────────────────────────
//
// Served only by the desktop app's bundled server — the one launched with
// PIWI_DESKTOP_TOKEN. They read and write files on the machine the server runs
// on, which is exactly why a hosted instance can never offer them. The route
// appends `DESKTOP_MCP_TOOLS` to the catalog only in desktop mode; each handler
// also calls `assertDesktop()` so a server build can never run one even if the
// route wiring regressed. Paths are supplied by the caller: the desktop guard
// already limits `/mcp` to the local access token, whose holder owns this
// machine — the same trust the local-import route (`desktop/import-local`)
// relies on.

const MAX_SOURCE_BYTES = 256 * 1024;

/** Refuse a desktop-only tool unless this is the guarded desktop build. */
function assertDesktop(): void {
  if (!process.env.PIWI_DESKTOP_TOKEN) {
    throw new Error('This tool is only available in the Piwi desktop app');
  }
}

/** The recommended locator edit, as `getLocatorHealing` returns it. */
interface LocatorSourceEdit {
  line: number;
  oldLine: string;
  newLine: string;
}

/**
 * Plan a single-line locator rewrite against the on-disk file. Pure and
 * unit-tested: it never touches the filesystem. The guard compares the target
 * line to what Piwi recorded (ignoring trailing whitespace) and refuses on any
 * mismatch, so a file edited since the run is left untouched rather than
 * clobbered.
 */
export function planLocatorSourceEdit(
  fileText: string,
  edit: LocatorSourceEdit,
): { ok: true; newText: string } | { ok: false; reason: string; foundLine: string | null } {
  const lines = fileText.split('\n');
  const index = edit.line - 1;
  if (index < 0 || index >= lines.length) {
    return {
      ok: false,
      reason: `the file has ${lines.length} lines but the fix targets line ${edit.line}`,
      foundLine: null,
    };
  }
  const current = lines[index]!;
  const trimEnd = (s: string) => s.replace(/\s+$/, '');
  if (trimEnd(current) !== trimEnd(edit.oldLine)) {
    return {
      ok: false,
      reason:
        'the on-disk line no longer matches what Piwi recorded — the file changed since the run; apply the diff by hand',
      foundLine: current,
    };
  }
  lines[index] = edit.newLine;
  return { ok: true, newText: lines.join('\n') };
}

const DESKTOP_HANDLERS: Record<DesktopMcpToolName, McpToolHandler> = {
  // ── import_local_report ──────────────────────────────────────────────────────
  async import_local_report(_db, params, ctx) {
    assertDesktop();
    assertPermission(ctx, 'storage:manage');
    const path = String(params.path ?? '');
    const projectName = String(params.projectName ?? '').trim();
    if (!path || !isAbsolute(path) || !path.toLowerCase().endsWith('.zip')) {
      throw new Error('path must be an absolute path to a .zip archive');
    }
    if (!projectName) throw new Error('projectName is required');
    const environment =
      typeof params.environment === 'string' && params.environment.trim() ? params.environment.trim() : null;
    const label = typeof params.label === 'string' && params.label.trim() ? params.label.trim() : null;

    let info;
    try {
      info = await stat(path);
    } catch {
      throw new Error(`file not found: ${path}`);
    }
    if (!info.isFile()) throw new Error('not a file');
    const maxBytes = resolveMaxUploadBytes();
    if (info.size > maxBytes) throw new Error(`archive too large (max ${formatBytes(maxBytes)})`);

    const data = await readFile(path);
    return importArchive({
      user: ctx.user,
      projectName,
      archive: { filename: sanitizeFilename(basename(path)), data },
      environment,
      label,
      importGroup: null,
    });
  },

  // ── read_local_source ────────────────────────────────────────────────────────
  async read_local_source(_db, params) {
    assertDesktop();
    const path = String(params.path ?? '');
    if (!path || !isAbsolute(path)) throw new Error('path must be an absolute path');

    let info;
    try {
      info = await stat(path);
    } catch {
      throw new Error(`file not found: ${path}`);
    }
    if (!info.isFile()) throw new Error('not a file');
    if (info.size > MAX_SOURCE_BYTES && params.line == null) {
      throw new Error(`file is ${formatBytes(info.size)} — pass a line to read a window instead of the whole file`);
    }

    const text = await readFile(path, 'utf8');
    const lines = text.split('\n');
    if (params.line == null) {
      return { path, totalLines: lines.length, startLine: 1, endLine: lines.length, text };
    }
    const line = numericParam(params.line, 'line');
    const rawContext = Number(params.contextLines ?? 40);
    const contextLines = Math.min(500, Math.max(0, Number.isFinite(rawContext) ? Math.floor(rawContext) : 40));
    const startLine = Math.max(1, line - contextLines);
    const endLine = Math.min(lines.length, line + contextLines);
    return {
      path,
      totalLines: lines.length,
      line,
      startLine,
      endLine,
      text: lines.slice(startLine - 1, endLine).join('\n'),
    };
  },

  // ── apply_locator_fix ────────────────────────────────────────────────────────
  async apply_locator_fix(db, params, ctx) {
    assertDesktop();
    const executionId = numericParam(params.executionId, 'executionId');
    const repoRoot = String(params.repoRoot ?? '');
    const apply = params.apply === true;
    if (!repoRoot || !isAbsolute(repoRoot)) throw new Error('repoRoot must be an absolute path');
    if ((await checkEntityScope(db, ctx, executionId, resolveTestRunCaseProjectId)) === 'not-found') return null;

    const healing = await getLocatorHealing(db, executionId);
    if (!healing)
      return dropNulls({ executionId, applied: false, reason: 'no locator-healing data for this execution' });
    if (healing.applicable === false) {
      return dropNulls({
        executionId,
        applied: false,
        reason: healing.reason ?? 'locator healing does not apply here',
      });
    }
    if (!healing.edit || !healing.edit.filePath) {
      return dropNulls({
        executionId,
        applied: false,
        reason: 'no ready-to-apply edit — call get_locator_healing to inspect the alternatives',
      });
    }
    const edit = { ...healing.edit, filePath: healing.edit.filePath };

    // Keep the write inside the checkout the caller named — a healing filePath is
    // repo-relative, so a resolved target that climbs out of repoRoot is a
    // mismatched root, not a file to write.
    const target = resolvePath(repoRoot, edit.filePath);
    const rel = relativePath(repoRoot, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`the fix targets ${edit.filePath}, which is outside repoRoot`);
    }

    let fileText: string;
    try {
      fileText = await readFile(target, 'utf8');
    } catch {
      return dropNulls({
        executionId,
        applied: false,
        filePath: edit.filePath,
        reason: `file not found under repoRoot: ${edit.filePath}`,
        unifiedDiff: edit.unifiedDiff,
      });
    }

    const plan = planLocatorSourceEdit(fileText, edit);
    if (!plan.ok) {
      return dropNulls({
        executionId,
        applied: false,
        filePath: edit.filePath,
        line: edit.line,
        reason: plan.reason,
        foundLine: plan.foundLine,
        oldLine: edit.oldLine,
        newLine: edit.newLine,
        unifiedDiff: edit.unifiedDiff,
      });
    }

    if (!apply) {
      return dropNulls({
        executionId,
        applied: false,
        preview: true,
        filePath: edit.filePath,
        line: edit.line,
        oldLine: edit.oldLine,
        newLine: edit.newLine,
        unifiedDiff: edit.unifiedDiff,
        note: 'preview only — call again with apply=true to write this change',
      });
    }

    await writeFile(target, plan.newText, 'utf8');
    return dropNulls({
      executionId,
      applied: true,
      filePath: edit.filePath,
      line: edit.line,
      oldLine: edit.oldLine,
      newLine: edit.newLine,
    });
  },
};

/** Desktop-only tools, merged into the catalog by the route in desktop mode. */
export const DESKTOP_MCP_TOOLS: McpTool[] = DESKTOP_MCP_TOOL_DEFS.map((def) => ({
  ...def,
  handler: DESKTOP_HANDLERS[def.name],
}));
