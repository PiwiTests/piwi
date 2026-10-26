/**
 * Client-side API router for demo mode.
 *
 * Maps the API requests the demo service worker intercepts (`demo-sw.ts`) to
 * the corresponding in-browser handler functions.  URL matching uses simple
 * RegExp patterns – the same routes the Nuxt server exposes.
 */

import { mergeTestCases } from '#shared/handlers/test-case-merge';
import { and, eq, inArray } from 'drizzle-orm';
import type { ZodType } from 'zod';
import {
  users,
  files,
  appSettings,
  projects,
  testRuns,
  testCases,
  testRunsCases,
  failureClusters,
  failureDiagnoses,
  graphNodes,
  bugReports,
  markers,
  testFunctions,
  entityLinks,
} from '~~/server/database/schema.sqlite';
import {
  ADMIN_ACCESS,
  can,
  isAdministrator,
  passesEarlyCheck,
  passesProjectCheck,
  projectScopeFor,
  routePermissionList,
  type AccessSummary,
  type ProjectPermission,
  type RoutePermission,
} from '#shared/permissions';
import { NOTIFICATION_EVENTS } from '#shared/notification-events';
import { subscriptionFiltersSchema } from '#shared/subscription-filters';
import { MARKER_CATEGORY_IDS } from '#shared/marker-categories';
import { getUserAccess } from '#shared/handlers/role-bindings';
import { createGroup, deleteGroup, setGroupMembers, updateGroup } from '#shared/handlers/groups';
import {
  accessRefusal,
  createUserAccount,
  createUserSchema,
  deleteUserAccount,
  getGroupView,
  getProjectAccessGrid,
  getProjectMembersResponse,
  getProjectMemberViews,
  getUserProjectRoles,
  groupCreateSchema,
  groupMembersSchema,
  groupPatchSchema,
  listGroupItems,
  listUserItems,
  listUserSummaries,
  projectAccessUpdateSchema,
  projectMembersUpdateSchema,
  replaceProjectMembers,
  setProjectAccessCell,
  setUserProjectRoles,
  updateUserAccount,
  updateUserSchema,
  userProjectRolesSchema,
} from '#shared/handlers/project-access';
import { requestedInstanceRole } from '#shared/project-access';
import { getDemoDb } from '../db.client';
import { publishDemoNotificationEvent } from '../run-events';
import { getCodeIndex, getCodeReachForFile } from '~~/server/utils/code-reach';
import {
  getExecutionCoverage,
  getFileCoverage,
  getRunCoverage,
  parseRunCoverage,
  parseRunCoverageQuery,
  parseSourceQuery,
  storeRunCoverage,
  storeRunCoverageGaps,
} from '~~/server/utils/coverage';
import {
  PROJECT_NOT_FOUND,
  listCoverageReports,
  parseCoverageReportsQuery,
  parseCoverageReportUpload,
  storeCoverageReport,
} from '~~/server/utils/coverage-reports';
import { settleCommitCoverage } from '~~/server/utils/coverage-totals';
import {
  exportCommitCoverage,
  getCoverageSummary,
  getCoverageTree,
  recountProjectCoverage,
  invalidateCommitCoverage,
  parseCoverageExportFormat,
  parseCoverageSummaryQuery,
} from '~~/server/utils/coverage-summary';
import { demoClusterSuspectLines, demoExecutionSuspectLines } from './suspect-lines';
import {
  CoverageInsightInputError,
  getCoverageDivergence,
  getCoverageLoss,
  getCoverageReach,
  getPathVariation,
} from '#shared/handlers/coverage-insights';
import { parseCoverageReachQuery, parseLossTestIds } from '#shared/coverage-insights';
import { fixPlanSuspectLines } from '#shared/suspect-lines';
import { getLocatorAlternatives } from '~~/server/utils/locator-alternatives';
import { branchFailuresOrError } from '~~/server/utils/branch-failures';
import { getLocatorHealing, saveLocatorPick } from '~~/server/utils/locator-healing';
import {
  backfillLocatorUsages,
  getExecutionLocators,
  getLocatorIndex,
  getLocatorUsages,
} from '~~/server/utils/locator-usages';
import { parseLocatorBranchQuery, parseLocatorUsageQuery } from '#shared/locator-usages.types';
import { buildFixPlan } from '~~/server/utils/fix-plan';
import { findFixedBefore } from '~~/server/utils/cluster-memory';
import { fixPlanToMarkdown } from '#shared/fix-plan-markdown';
import { contextStalenessHash } from '#shared/diagnosis-staleness';
import { getEnvironmentDiff } from '~~/server/utils/environment-diff';
import { getPageDiff } from '~~/server/utils/page-diff';
import { apiGetDemoDomSnapshot } from './dom-snapshot';
import {
  apiExecutionBugReport,
  apiExecutionReplaySteps,
  apiExportTestRunCase,
  apiExportFailureCluster,
} from './export';
import {
  apiCreateReportSchedule,
  apiCreateReportSnapshot,
  apiDeleteReportSchedule,
  apiExportReportSnapshot,
  apiGetReportSchedule,
  apiGetReportSnapshot,
  apiListReportSchedules,
  apiListReportSnapshots,
  apiPreviewReportSchedule,
  apiReportPreview,
  apiRunReportSchedule,
  apiUpdateReportSchedule,
} from './reports';
import {
  apiCreateDashboard,
  apiDeleteDashboard,
  apiDuplicateDashboard,
  apiGetDashboard,
  apiGetDashboardWidget,
  apiListDashboards,
  apiPreviewWidget,
  apiSaveDashboard,
  apiSetDefaultDashboard,
} from './dashboards';
import { DEMO_CHANNEL } from './demo-channel';
import { apiPerfettoTestRun, apiPerfettoTestRunCase } from './perfetto';
import {
  apiGetDemoTraceStacks,
  apiGetDemoTraceNetwork,
  apiGetDemoTraceNetworkBody,
  apiGetDemoTraceSnapshots,
  apiGetDemoTraceSnapshot,
} from './trace-insights';
import {
  listProjects,
  getProject,
  listKeptRuns,
  getProjectAiStepCoverage,
  getProjectPerformance,
  getProjectTestCases,
  getProjectTestCaseFacets,
  parseTestCasesQuery,
  getProjectSlowTests,
  getProjectTimeoutOpportunities,
  getProjectFailureClusters,
  INVALID_COVERAGE_AREAS,
  INVALID_REPOSITORY_URL,
  INVALID_COVERAGE_SCOPE,
  updateProject,
  createProject,
  getProjectMenu,
  deleteProjectData,
  getProjectFlakyTestsWithVerified,
  getProjectsOverview,
} from '#shared/handlers/projects';
import { parseProjectRunScope } from '#shared/project-run-scope';
import { listTags, createTag, updateTag, deleteTag } from '#shared/handlers/tags';
import {
  listProjectMarkers,
  createMarker,
  updateMarker,
  deleteMarker,
  markerRunBelongsToProject,
} from '#shared/handlers/markers';
import {
  listProjectTestFunctions,
  createTestFunction,
  updateTestFunction,
  deleteTestFunction,
} from '#shared/handlers/test-functions';
import { validateExtractedFunction } from '#shared/test-function-extract-prompt';
import { createTestFunctionSchema, updateTestFunctionSchema } from '#shared/test-function-schemas';
import {
  addQuarantine,
  dismissQuarantineProposal,
  listQuarantine,
  markDismissedProposals,
  releaseQuarantine,
  RELEASE_AFTER_CONSECUTIVE_PASSES,
} from '#shared/handlers/quarantine';
import { isQuarantineProposal, normalizeDismissReason } from '#shared/quarantine-proposals';
import {
  listSelections,
  listResolvedSelections,
  getSelection,
  createSelection,
  updateSelection,
  deleteSelection,
  resolveSelectionDefinition,
  SelectionError,
} from '#shared/handlers/selections';
import { getSelectionSuggestions } from '#shared/handlers/selection-suggestions';
import { getSelectionAnalytics } from '#shared/handlers/selection-analytics';
import {
  computeScenarioGaps,
  listScenarioGaps,
  triageGap,
  issueScenarioDraft,
  listAcceptedUnwritten,
} from '#shared/handlers/scenario-gaps';
import { getFeatureGraph, getFeatureMap, getFileTestMap, MAX_GRAPH_DEPTH } from '~~/server/utils/feature-graph';
import { loadDetectorPrecision } from '#shared/handlers/detector-precision';
import { getMapHealth } from '#shared/handlers/map-health';
import { parseRouteNodeKey } from '#shared/graph';
import { ingestProjectManifest } from '~~/server/utils/surface-manifest';
import type { AppManifest, ManifestSource } from '#shared/types';
import {
  buildProbePlan,
  recordProbeResults,
  DEFAULT_PROBE_BUDGET,
  type ProbeResultInput,
} from '#shared/handlers/probes';
import { computeChangeCoverage } from '#shared/handlers/change-coverage';
import {
  isBuiltinKey,
  parseRankBy,
  parseShard,
  validateSelectionDefinition,
  type SelectionDefinition,
  type SelectionFormat,
} from '#shared/selection';
import {
  getTestCase,
  getTestRunCase,
  getTestCaseHistory,
  getTestRunCaseTraces,
  getTestCaseStabilityTrend,
  STABILITY_TREND_DEFAULT_DAYS,
  getFailureTimeline,
  getExecutionSteps,
  getFailureClues,
  getAttemptDiff,
} from '#shared/handlers/test-cases';
import { parseGranularity } from '#shared/analytics/period';
import { getFlakeProfile } from '#shared/handlers/flake-profile';
import {
  FLAKE_EXPERIMENT_SOURCES,
  FlakePlanUnavailable,
  FlakeResultsRejected,
  getFlakeExperimentPlan,
  getFlakyListSuspects,
  getProjectFlakeLab,
  listFlakeExperiments,
  listFlakeLabInbox,
  recordFlakeResults,
  resolveTestCaseByLocation,
  type FlakeResultsInput,
} from '#shared/handlers/flake-lab';
import { buildExecutionReproduce } from '#shared/handlers/reproduce';
import { parseBisectResultBody } from '@piwitests/core/bisect';
import {
  AGENT_DIAGNOSIS_STATUS,
  agentDiagnosisErrorMessage,
  parseAgentDiagnosis,
  type AgentDiagnosisTarget,
} from '#shared/agent-diagnosis';
import { agentDiagnosisEvent, recordAgentDiagnosis } from '#shared/handlers/agent-diagnosis';
import { parseFixAttempt } from '#shared/fix-attempts';
import { FIX_ATTEMPT_ERRORS, reportFixAttempt } from '#shared/handlers/fix-attempts';
import { getClusterActivity } from '#shared/handlers/cluster-activity';
import { isRunOriginKind } from '@piwitests/core/wire';
import { getVerifiedFixes } from '#shared/handlers/flake-verified';
import { getRunResources, getRunResourceTimeline } from '#shared/handlers/run-resources';
import {
  getFailureCluster,
  getOpenFailureClusters,
  patchClusterStatus,
  patchClusterAssignee,
  patchClusterSnooze,
  quarantineClusterTests,
  bulkTriageClusters,
  patchClusterBaseCommit,
  recordClusterBisect,
  extractClusterCases,
  getClusterDiagnosis,
  getExecutionDiagnosis,
  getClusterOccurrenceTrend,
  CLUSTER_TREND_DEFAULT_DAYS,
} from '#shared/handlers/failure-clusters';
import { parseBulkIds, isSnoozeOption } from '#shared/inbox-queues';
import { getClusterCommits, getClusterCommitDiff, getClusterBranches } from './scm';
import { getDemoSourceAtBlob } from '../demo-scm';
import { getTimeoutThresholds } from '~~/server/utils/timeout-thresholds';
import { getAppSetting } from '~~/server/utils/app-settings';
import { parseTagFilter } from '#shared/utils/tag-filter';
import { WASTED_WAIT_PATTERNS_KEY, resolveStoredWastedPatterns } from '#shared/utils/wasted-waits';
import { TEST_PRIORITIES } from '@piwitests/core/test-meta';
import {
  getClusterContext,
  getClusterContextPrompt,
  getExecutionContext,
  getExecutionContextPrompt,
} from './diagnosis-context';
import { listClusterDiagnosisVersions, apiSubmitDiagnosisFeedback } from './diagnoses';
import {
  listMergeSuggestions,
  approveMergeSuggestion,
  rejectMergeSuggestion,
  getSuggestionProjectId,
} from '#shared/handlers/cluster-merge-suggestions';
import { listLinks, createLink, deleteLink, LINK_ENTITY_TYPES, type LinkEntityType } from '#shared/handlers/links';
import {
  listDemoConnections,
  getDemoConnection,
  createDemoConnection,
  updateDemoConnection,
  testDemoConnection,
  checkDemoConnection,
  demoTrackerStatus,
  demoIssueDraft,
  demoCreateIssue,
  demoIntegrationActions,
  demoSyncTrackerLinks,
  demoConnectionProjects,
  demoConnectionIssueTypes,
  demoCreateFields,
  demoTransitionSample,
  demoAssignable,
  demoIssuePicker,
  getDemoProjectIntegration,
  saveDemoProjectIntegration,
  demoAutoCreatePreview,
  generateDemoWebhookToken,
  disableDemoWebhookToken,
} from './integrations';
import type { ConnectionInput } from '#shared/integrations/types';
import type { ResolvedProjectIntegration } from '#shared/integrations/binding';
import { toIssueLocale } from '#shared/integrations/messages';
import {
  getTestRun,
  getRecentTestRuns,
  patchTestRun,
  parseTestRunPatch,
  getNetworkRequests,
  getFailureGroups,
  getProjectLatestRun,
} from '#shared/handlers/test-runs';
import { computeRunInsights } from '#shared/handlers/run-insights';
import { isAnalyticsWidgetId, runAnalyticsWidget } from '#shared/handlers/analytics';
import { parseAnalyticsScope } from '#shared/analytics/scope';
import { collectRollupExport, rollupCsvHeader, rollupCsvRows } from '#shared/handlers/analytics/rollup-export';
import { WidgetOptionsError, widgetOptionsFromQuery } from '#shared/analytics/registry';
import { getAnalyticsScopeSummary } from '#shared/handlers/analytics/scope-summary';
import { classifyAndPersistFlakyRootCause, withFlakyRootCauses } from '#shared/handlers/flaky-classify';
import { listUserApiKeys, deleteUserApiKeyRecord } from '#shared/handlers/users';
import { searchProjectsTestRunsCases } from '#shared/handlers/search';
import { getSetupStatus } from '#shared/handlers/setup-status';
import {
  getInstanceCapabilities,
  getProjectCapabilities,
  setInstanceDecisions,
  setProjectDecisions,
} from '#shared/handlers/capabilities';
import { getAriaSampling } from '#shared/handlers/aria-sampling';
import {
  apiSetupTestRun,
  apiBeginTestRun,
  apiPostRunEvents,
  apiFinishTestRun,
  apiCancelStaleSimulatorRuns,
  apiHeartbeatTestRun,
} from './reporter';
import { apiCreateUserApiKey } from './users';
import { apiGetDemoFile } from './files';
import {
  apiGetAiStatus,
  apiDiagnoseCluster,
  apiDiagnoseExecution,
  apiStreamDiagnoseCluster,
  apiGetAiSettings,
  apiPutAiSettings,
  apiTestAiSettings,
  apiGetAiLimits,
  apiPutAiLimits,
  apiGetAiUsage,
  apiListAiModels,
} from './ai';
import {
  apiAskAssistant,
  apiAssistantStatus,
  apiCreateAssistantConversation,
  apiDeleteAssistantConversation,
  apiGetAssistantConversation,
  apiListAssistantConversations,
  apiListAssistantQuestions,
  apiRecordAssistantProposal,
  apiStopAssistantAnswer,
  apiTickAssistantChecklist,
} from './assistant';
import {
  apiDismissAssistantNudge,
  apiListAssistantNudgeDismissals,
  apiUndoAssistantNudgeDismissal,
} from './assistant-nudges';
import { apiGetAdminStats, apiGetStorageAnalysis } from './admin';
import { demoHttpError } from './http-error';
import {
  addProjectUrlPattern,
  listProjectUrlPatterns,
  listVisibleUrlPatterns,
  replaceProjectUrlPatterns,
  suggestUrlPatterns,
  urlPatternInputSchema,
  urlPatternListSchema,
  type UrlPatternWriteResult,
} from '#shared/handlers/url-patterns';
import { apiDeleteTestRun } from './test-runs';
import { setRunIncident } from '#shared/handlers/run-health';
import { parseSetRunIncident } from '#shared/run-incident';
import { readRunCoverageGaps } from '#shared/run-coverage-gaps';
import {
  addBugReproduction,
  isReproductionRunAllowed,
  bugReportPatchSchema,
  bugReproductionSchema,
  getBugReport,
  getBugReportMissedBy,
  listBugReports,
  renderBugReportSpec,
  specDirSchema,
  updateBugReport,
} from '#shared/handlers/bug-reports';
import { apiCheckDemoImport, apiDemoImport } from './import';
import {
  apiGetWastedWaits,
  apiPutWastedWaits,
  apiGetTimeoutHygiene,
  apiPutTimeoutHygiene,
  apiGetCiCost,
  apiPutCiCost,
  apiGetPrFeedback,
  apiGetAutoHeal,
  apiPutAutoHeal,
  apiPutPrFeedback,
  apiGetLocale,
  apiPutLocale,
} from './settings';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

type ProjectScope = 'all' | Set<number>;

/** Per-request context derived from the "act as" demo identity. */
interface DemoCtx {
  /** The acting user's access (mirrors the server's `getUserAccess`). */
  access: AccessSummary;
  /** The projects the acting user reads (mirrors the server's `getProjectScope`). */
  scope: ProjectScope;
  /** The acting user's id, or null when unknown. */
  actingUserId: number | null;
  /** What the route requires, as its server twin's `x-required-permission` declares. */
  permission: RoutePermission[];
}

interface RouteEntry {
  method: HttpMethod;
  pattern: RegExp;
  /**
   * The server route's `x-required-permission`, verbatim (`scripts/check-demo-routes.mjs`
   * compares them). The dispatcher applies the early check and `assertDemoScope` the
   * per-project one, like `requireAuth` and `requireProjectAccess` on the server.
   */
  permission?: RoutePermission | RoutePermission[];
  handler: (matches: RegExpMatchArray, body?: unknown, query?: URLSearchParams, ctx?: DemoCtx) => Promise<unknown>;
}

/**
 * The acting user's access, as the server loads it per request. No acting
 * user means authentication is off, and an unknown one acts as an
 * administrator too, so the demo never locks itself out.
 */
async function resolveDemoAccess(actingUserId: number | null): Promise<AccessSummary> {
  if (!actingUserId) return ADMIN_ACCESS;
  const db = await getDemoDb();
  const [user] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, actingUserId));
  if (!user) return ADMIN_ACCESS;
  return getUserAccess(db, user);
}

/** Whether the acting user holds `permission` (on `projectId` for a project permission). */
function demoCan(ctx: DemoCtx | undefined, permission: Parameters<typeof can>[1], projectId?: number): boolean {
  return !ctx || can(ctx.access, permission, projectId);
}

/** The projects where the acting user holds `permission` (mirrors `getProjectScope(db, user, permission)`). */
function demoScope(ctx: DemoCtx | undefined, permission: ProjectPermission = 'project:read'): ProjectScope {
  return ctx ? projectScopeFor(ctx.access, permission) : 'all';
}

/**
 * Reject the request unless the acting user holds the route's permission on
 * this project, with the server's `requireProjectAccess` answers: 403 "No
 * access to this project" when they cannot read it, else 403 "Insufficient
 * permissions".
 */
function assertDemoScope(ctx: DemoCtx | undefined, projectId: number): void {
  if (!ctx) return;
  if (passesProjectCheck(ctx.access, ctx.permission, projectId)) return;
  throw demoHttpError(
    403,
    can(ctx.access, 'project:read', projectId) ? 'Insufficient permissions' : 'No access to this project',
  );
}

/** The entities `assertDemoEntityScope` resolves to their project. */
type DemoEntity =
  | 'project'
  | 'run'
  | 'case'
  | 'cluster'
  | 'execution'
  | 'bugReport'
  | 'marker'
  | 'testFunction'
  | 'suggestion';

/**
 * Scope-check an entity endpoint the way the server's
 * `requireResolvedProjectAccess` does: resolve the owning project (404 when the
 * entity does not exist), then check the route's permission there. Returns the
 * project id, or null for an administrator, whose request is not resolved.
 */
async function assertDemoEntityScope(ctx: DemoCtx | undefined, entity: DemoEntity, id: number): Promise<number | null> {
  if (!ctx || isAdministrator(ctx.access)) return null;
  const db = await getDemoDb();
  let projectId: number | null = null;
  if (entity === 'project') {
    projectId = id;
  } else if (entity === 'run') {
    const [row] = await db.select({ projectId: testRuns.projectId }).from(testRuns).where(eq(testRuns.id, id));
    projectId = row?.projectId ?? null;
  } else if (entity === 'case') {
    const [row] = await db.select({ projectId: testCases.projectId }).from(testCases).where(eq(testCases.id, id));
    projectId = row?.projectId ?? null;
  } else if (entity === 'cluster') {
    const [row] = await db
      .select({ projectId: failureClusters.projectId })
      .from(failureClusters)
      .where(eq(failureClusters.id, id));
    projectId = row?.projectId ?? null;
  } else if (entity === 'bugReport') {
    const [row] = await db.select({ projectId: bugReports.projectId }).from(bugReports).where(eq(bugReports.id, id));
    projectId = row?.projectId ?? null;
  } else if (entity === 'marker') {
    const [row] = await db.select({ projectId: markers.projectId }).from(markers).where(eq(markers.id, id));
    projectId = row?.projectId ?? null;
  } else if (entity === 'testFunction') {
    const [row] = await db
      .select({ projectId: testFunctions.projectId })
      .from(testFunctions)
      .where(eq(testFunctions.id, id));
    projectId = row?.projectId ?? null;
  } else if (entity === 'suggestion') {
    projectId = await getSuggestionProjectId(db, id);
  } else {
    const [row] = await db
      .select({ projectId: testRuns.projectId })
      .from(testRunsCases)
      .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
      .where(eq(testRunsCases.id, id));
    projectId = row?.projectId ?? null;
  }
  if (projectId === null) throw demoHttpError(404, 'Not found');
  assertDemoScope(ctx, projectId);
  return projectId;
}

/** Record an agent's diagnosis on a cluster or a failure (mirrors both `agent-diagnosis` routes). */
async function recordDemoAgentDiagnosis(target: AgentDiagnosisTarget, body: unknown, ctx: DemoCtx | undefined) {
  const parsed = parseAgentDiagnosis(body);
  if (!parsed.ok) throw demoHttpError(400, parsed.message);
  const result = await recordAgentDiagnosis(await getDemoDb(), target, parsed.value, {
    actor: { channel: parsed.value.channel ?? 'ui', userId: ctx?.actingUserId ?? null },
  });
  if (!result.ok) {
    throw demoHttpError(AGENT_DIAGNOSIS_STATUS[result.error], agentDiagnosisErrorMessage(result.error, target.scope));
  }
  const event = agentDiagnosisEvent(target, result, parsed.value);
  if (event) publishDemoNotificationEvent({ type: 'diagnosis.completed', ...event });
  return { ok: true, diagnosisId: result.diagnosisId, patchValidation: result.patchValidation };
}

/** A user's own API keys, or anyone's for an administrator (mirrors the api-keys routes). */
function assertDemoSelfOrAdmin(ctx: DemoCtx | undefined, userId: number): void {
  if (!demoCan(ctx, 'users:manage') && ctx?.actingUserId !== userId) {
    throw demoHttpError(403, 'Insufficient permissions');
  }
}

/** The entity kind `assertDemoEntityScope` resolves for each entity a link (or an issue) can target. */
const LINK_TARGET_ENTITY: Record<string, DemoEntity> = {
  test_run: 'run',
  test_runs_case: 'execution',
  test_case: 'case',
  failure_cluster: 'cluster',
  bug_report: 'bugReport',
};

/** Check the route's permission on the project of a link's (or an issue's) target entity; 404 when it is missing. */
async function assertDemoLinkTargetScope(
  ctx: DemoCtx | undefined,
  entityType: unknown,
  entityId: number,
): Promise<void> {
  const entity = typeof entityType === 'string' ? LINK_TARGET_ENTITY[entityType] : undefined;
  // An unknown entity type is left to the handler's own validation.
  if (!entity || !Number.isInteger(entityId) || entityId <= 0) return;
  await assertDemoEntityScope(ctx, entity, entityId);
}

/** Check the route's permission on the project of an existing link's target (the server's `resolveLinkProjectId`). */
async function assertDemoLinkScope(ctx: DemoCtx | undefined, linkId: number): Promise<void> {
  if (!ctx || isAdministrator(ctx.access)) return;
  const [link] = await (await getDemoDb()).select().from(entityLinks).where(eq(entityLinks.id, linkId));
  if (!link) throw demoHttpError(404, 'Link not found');
  if (link.testRunId != null) await assertDemoEntityScope(ctx, 'run', link.testRunId);
  else if (link.testRunsCaseId != null) await assertDemoEntityScope(ctx, 'execution', link.testRunsCaseId);
  else if (link.testCaseId != null) await assertDemoEntityScope(ctx, 'case', link.testCaseId);
  else if (link.failureClusterId != null) await assertDemoEntityScope(ctx, 'cluster', link.failureClusterId);
  else if (link.bugReportId != null) await assertDemoEntityScope(ctx, 'bugReport', link.bugReportId);
  else throw demoHttpError(404, 'Link not found');
}

/** Run an access-management handler, answering its refusals with their status, like the server routes. */
async function demoAccessCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const refusal = accessRefusal(err);
    if (refusal) throw demoHttpError(refusal.statusCode, refusal.message);
    throw err;
  }
}

/** Parse a request body with a server route's schema, or answer 400 like the route. */
function demoBody<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw demoHttpError(400, 'Invalid request body');
  return parsed.data;
}

/** The items of a successful URL-pattern write, or the HTTP error the server answers a refused one with. */
function demoUrlPatternItems(result: UrlPatternWriteResult) {
  if (result.ok) return result.items;
  if (result.reason === 'not-found') throw demoHttpError(404, 'Project not found');
  if (result.reason === 'too-many') throw demoHttpError(400, 'A project has at most 100 URL patterns');
  throw demoHttpError(409, `The project already has the pattern ${result.pattern}`);
}

const routes: RouteEntry[] = [
  // Analytics — the scope summary, then one generic entry; widgets dispatch through the shared handler map
  {
    method: 'GET',
    pattern: /^\/api\/dashboards\/scope$/,
    handler: async (_m, _, q, ctx) =>
      getAnalyticsScopeSummary(await getDemoDb(), parseAnalyticsScope(q), ctx?.scope ?? 'all'),
  },
  {
    method: 'GET',
    pattern: /^\/api\/rollups$/,
    handler: async (_m, _, q, ctx) => {
      const format = (q?.get('format') ?? 'json').toLowerCase();
      if (format !== 'json' && format !== 'csv')
        throw demoHttpError(400, `Unsupported format '${format}'. Use json or csv.`);
      const items = await collectRollupExport(await getDemoDb(), parseAnalyticsScope(q), ctx?.scope ?? 'all');
      if (format === 'json') return { items };
      return new Response(`\uFEFF${rollupCsvHeader()}${rollupCsvRows(items)}`, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="piwi-rollups-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    },
  },
  // Dashboards — saved dashboards, one widget of a dashboard and the editor's preview
  {
    method: 'GET',
    pattern: /^\/api\/dashboards$/,
    handler: async (_m, _b, _q, ctx) => apiListDashboards(ctx?.actingUserId ?? null),
  },
  {
    method: 'POST',
    pattern: /^\/api\/dashboards$/,
    handler: async (_m, body, _q, ctx) => apiCreateDashboard(body, ctx?.actingUserId ?? null, ctx?.scope ?? 'all'),
  },
  {
    method: 'GET',
    pattern: /^\/api\/dashboards\/([\w-]+)$/,
    handler: async (m, _b, q, ctx) => apiGetDashboard(m[1]!, q, ctx?.actingUserId ?? null, ctx?.scope ?? 'all'),
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/dashboards\/([\w-]+)$/,
    handler: async (m, body, _q, ctx) => apiSaveDashboard(m[1]!, body, ctx?.actingUserId ?? null, ctx?.scope ?? 'all'),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/dashboards\/([\w-]+)$/,
    handler: async (m, _b, _q, ctx) => apiDeleteDashboard(m[1]!, ctx?.actingUserId ?? null),
  },
  {
    method: 'POST',
    pattern: /^\/api\/dashboards\/([\w-]+)\/duplicate$/,
    handler: async (m, body, _q, ctx) =>
      apiDuplicateDashboard(m[1]!, body, ctx?.actingUserId ?? null, ctx?.scope ?? 'all'),
  },
  {
    method: 'GET',
    pattern: /^\/api\/dashboards\/([\w-]+)\/widgets\/([\w-]+)$/,
    handler: async (m, _b, q, ctx) =>
      apiGetDashboardWidget(m[1]!, m[2]!, q, ctx?.actingUserId ?? null, ctx?.scope ?? 'all'),
  },
  {
    method: 'POST',
    pattern: /^\/api\/widgets\/preview$/,
    handler: async (_m, body, _q, ctx) => apiPreviewWidget(body, ctx?.scope ?? 'all'),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/settings\/default-dashboard$/,
    permission: 'settings:manage',
    handler: async (_m, body) => apiSetDefaultDashboard(body),
  },
  {
    method: 'GET',
    pattern: /^\/api\/widgets\/([\w-]+)$/,
    handler: async (m, _, q, ctx) => {
      const widget = m[1]!;
      if (!isAnalyticsWidgetId(widget)) throw demoHttpError(400, 'Unknown analytics widget');
      try {
        const options = widgetOptionsFromQuery(q?.get('options'));
        return await runAnalyticsWidget(
          await getDemoDb(),
          widget,
          parseAnalyticsScope(q),
          ctx?.scope ?? 'all',
          options,
        );
      } catch (error) {
        if (error instanceof WidgetOptionsError) throw demoHttpError(400, error.message);
        throw error;
      }
    },
  },
  // Quality reports — the preview and downloads, from the shared bundle and renderers
  {
    method: 'GET',
    pattern: /^\/api\/reports\/preview$/,
    handler: async (_m, _, q, ctx) => apiReportPreview(q, ctx?.scope ?? 'all', ctx?.actingUserId ?? null),
  },
  // Projects
  {
    method: 'GET',
    pattern: /^\/api\/projects\/overview$/,
    handler: async (_, __, ___, ctx) => ({ items: await getProjectsOverview(await getDemoDb(), ctx?.scope) }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects$/,
    handler: async (_, __, ___, ctx) => {
      const rows = await listProjects(await getDemoDb(), ctx?.scope);
      // The server routes strip the token before responding (the shared handler
      // rows carry it); do the same so a demo visitor's stored token never comes
      // back over the wire.
      const items = rows.map((p) => {
        const { scmToken: _scm, ...rest } = p as { scmToken?: string | null } & typeof p;
        return rest;
      });
      return { items };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects$/,
    permission: 'project:create',
    handler: async (_, body) => {
      const b = body as { name: string; label?: string; description?: string };
      try {
        return await createProject(await getDemoDb(), b.name, b.label, b.description);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Failed to create project';
        throw demoHttpError(message === 'A project with this name already exists' ? 409 : 400, message);
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/menu$/,
    handler: async (_, __, ___, ctx) => ({ items: await getProjectMenu(await getDemoDb(), ctx?.scope) }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)$/,
    handler: async (m, _, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const rawLimit = Number(q?.get('limit'));
      const runLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
      const project = await getProject(await getDemoDb(), +m[1]!, { runLimit });
      if (!project) return project;
      const { scmToken: _scm, ...rest } = project as { scmToken?: string | null } & typeof project;
      return rest;
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/projects\/(\d+)$/,
    permission: 'project:manage',
    handler: async (m, body, _, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      // A browser demo has no server secret to encrypt with (the server uses
      // encryptSecret with PIWI_SECRET_KEY), so the token is stored as-is —
      // but every GET strips it, so it never leaves the browser's own DB.
      try {
        const update = body as Parameters<typeof updateProject>[2];
        const project = await updateProject(await getDemoDb(), +m[1]!, update);
        if (update?.coverageScope !== undefined || update?.coverageAreas !== undefined) {
          await recountProjectCoverage(await getDemoDb(), +m[1]!);
        }
        return project;
      } catch (e) {
        if (
          e instanceof Error &&
          (e.message === INVALID_COVERAGE_SCOPE ||
            e.message === INVALID_COVERAGE_AREAS ||
            e.message === INVALID_REPOSITORY_URL)
        )
          throw demoHttpError(400, e.message);
        throw e;
      }
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/projects\/(\d+)$/,
    permission: 'project:delete',
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const db = await getDemoDb();
      const existing = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, +m[1]!));
      if (!existing[0]) throw demoHttpError(404, 'Project not found');
      await deleteProjectData(db, +m[1]!);
      return { success: true };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/deletion$/,
    permission: 'project:delete',
    // The in-browser DB reports no deletion progress; the delete modal shows its indeterminate state.
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      return { progress: null };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/performance$/,
    handler: async (m, _, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const rawRuns = q ? parseInt(q.get('runs') ?? '', 10) : NaN;
      const runs = Math.min(Number.isNaN(rawRuns) ? 50 : rawRuns, 200);
      const from = q?.get('from') || undefined;
      const to = q?.get('to') || undefined;
      const fullRunsOnly = q?.get('fullRunsOnly') !== 'false';
      return {
        items: await getProjectPerformance(
          await getDemoDb(),
          +m[1]!,
          runs,
          from,
          to,
          fullRunsOnly,
          parseProjectRunScope(q),
        ),
      };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/test-cases$/,
    handler: async (m, _, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      return getProjectTestCases(await getDemoDb(), +m[1]!, parseTestCasesQuery(q));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/test-cases\/facets$/,
    handler: async (m, _, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const maxAgeDays = Math.max(0, Math.floor(Number(q?.get('maxAgeDays')) || 0));
      return getProjectTestCaseFacets(await getDemoDb(), +m[1]!, { maxAgeDays, scope: parseProjectRunScope(q) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/slow-tests$/,
    handler: async (m, _, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const rawRuns = q ? parseInt(q.get('runs') ?? '', 10) : NaN;
      const runs = Math.min(Number.isNaN(rawRuns) ? 10 : rawRuns, 100);
      return { items: await getProjectSlowTests(await getDemoDb(), +m[1]!, runs, parseProjectRunScope(q)) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/timeout-opportunities$/,
    handler: async (m, _, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const db = await getDemoDb();
      const rawRuns = q ? parseInt(q.get('runs') ?? '', 10) : NaN;
      const runs = Math.min(Number.isNaN(rawRuns) ? 20 : rawRuns, 100);
      // Custom thresholds from the timeout-hygiene setting apply here, like the
      // server route reads them (the demo persists the same app setting).
      const thresholds = await getTimeoutThresholds(db);
      return {
        items: await getProjectTimeoutOpportunities(db, +m[1]!, runs, thresholds, parseProjectRunScope(q)),
      };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/failure-clusters$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      return {
        items: await getProjectFailureClusters(
          await getDemoDb(),
          +m[1]!,
          q?.get('status') ?? undefined,
          parseProjectRunScope(q),
        ),
      };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/cluster-merge-suggestions$/,
    handler: async (m, _, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      return { items: await listMergeSuggestions(await getDemoDb(), +m[1]!, (q && q.get('status')) || 'pending') };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/cluster-merge-suggestions\/(\d+)\/approve$/,
    permission: 'triage:write',
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'suggestion', +m[1]!);
      const result = await approveMergeSuggestion(await getDemoDb(), +m[1]!);
      if (!result) throw demoHttpError(409, 'Suggestion is not pending');
      return { success: true, ...result };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/cluster-merge-suggestions\/(\d+)\/reject$/,
    permission: 'triage:write',
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'suggestion', +m[1]!);
      const ok = await rejectMergeSuggestion(await getDemoDb(), +m[1]!);
      if (!ok) throw demoHttpError(409, 'Suggestion is not pending');
      return { success: true };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/flake-suspects$/,
    handler: async (m, _, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const ids = (q?.get('testCaseIds') ?? '')
        .split(',')
        .map((v) => Number(v.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
      return { items: await getFlakyListSuspects(await getDemoDb(), +m[1]!, ids) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/flaky-tests$/,
    handler: async (m, _, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const rawRuns = q ? parseInt(q.get('runs') ?? '', 10) : NaN;
      const runs = Math.min(200, Math.max(1, Number.isNaN(rawRuns) ? 50 : rawRuns));
      const environment = q?.get('environment')?.trim() || undefined;
      const branch = q?.get('branch')?.trim() || undefined;
      const tags = parseTagFilter(q?.get('tags'));
      const owner = q?.get('owner')?.trim() || undefined;
      const priorityRaw = (q?.get('priority') ?? '').trim().toLowerCase();
      const priority = (TEST_PRIORITIES as readonly string[]).includes(priorityRaw)
        ? (priorityRaw as (typeof TEST_PRIORITIES)[number])
        : undefined;
      const db = await getDemoDb();
      const { items, verifiedFixed } = await getProjectFlakyTestsWithVerified(
        db,
        +m[1]!,
        runs,
        environment,
        { tags, owner, priority },
        branch,
        parseProjectRunScope(q),
      );
      if (['false', '0'].includes(q?.get('enrich') ?? '')) return { items, verifiedFixed };
      // CODEOWNERS resolution needs an SCM client the browser cannot reach —
      // ownership stays annotation-only here (seeded cases carry `piwi:` owners).
      return { items: await withFlakyRootCauses(db, +m[1]!, items), verifiedFixed };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/latest-run$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const origin = q?.get('origin');
      if (origin != null && (!isRunOriginKind(origin) || q?.get('ref') == null)) {
        throw demoHttpError(400, 'origin needs a known run origin and a ref');
      }
      return getProjectLatestRun(
        await getDemoDb(),
        +m[1]!,
        isRunOriginKind(origin) ? { kind: origin, ref: q!.get('ref')! } : null,
      );
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/aria-sampling$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      return getAriaSampling(await getDemoDb(), +m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/ai-steps$/,
    handler: async (m, _, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const days = Math.min(90, Math.max(1, parseInt(q?.get('days') || '30')));
      return getProjectAiStepCoverage(await getDemoDb(), +m[1]!, days);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/(\d+)\/flaky-classify$/,
    permission: 'triage:write',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const b = body as { testCaseId?: number };
      if (!b?.testCaseId) throw demoHttpError(400, 'testCaseId is required');
      return classifyAndPersistFlakyRootCause(await getDemoDb(), +m[1]!, b.testCaseId);
    },
  },

  // Importing past runs — parsed and stored entirely in the browser
  {
    method: 'POST',
    pattern: /^\/api\/test-runs\/import\/check$/,
    permission: 'storage:manage',
    handler: (_, body) => apiCheckDemoImport(body as Parameters<typeof apiCheckDemoImport>[0]),
  },
  {
    method: 'POST',
    pattern: /^\/api\/test-runs\/import$/,
    permission: 'storage:manage',
    handler: (_, body) => apiDemoImport(body as FormData),
  },

  // Reporter streaming protocol (used by the demo run simulator)
  {
    method: 'POST',
    pattern: /^\/api\/test-runs\/setup$/,
    permission: 'run:submit',
    handler: (_, body, _q, ctx) =>
      apiSetupTestRun(body as Parameters<typeof apiSetupTestRun>[0], demoScope(ctx, 'run:submit')),
  },
  {
    method: 'POST',
    pattern: /^\/api\/test-runs\/(\d+)\/begin$/,
    handler: (m, body) => apiBeginTestRun(+m[1]!, body as Parameters<typeof apiBeginTestRun>[1]),
  },
  {
    method: 'POST',
    pattern: /^\/api\/test-runs\/(\d+)\/events$/,
    handler: (m, body) => apiPostRunEvents(+m[1]!, body as Parameters<typeof apiPostRunEvents>[1]),
  },
  {
    method: 'POST',
    pattern: /^\/api\/test-runs\/(\d+)\/finish$/,
    handler: (m, body) => apiFinishTestRun(+m[1]!, body as Parameters<typeof apiFinishTestRun>[1]),
  },
  {
    method: 'POST',
    pattern: /^\/api\/demo\/cancel-stale-runs$/,
    handler: (_, body) => apiCancelStaleSimulatorRuns(body as Parameters<typeof apiCancelStaleSimulatorRuns>[0]),
  },
  {
    method: 'POST',
    pattern: /^\/api\/test-runs\/(\d+)\/heartbeat$/,
    handler: (m, body) => apiHeartbeatTestRun(+m[1]!, body as Parameters<typeof apiHeartbeatTestRun>[1]),
  },

  // Test runs
  {
    method: 'GET',
    pattern: /^\/api\/test-runs\/recent$/,
    handler: async (_, __, ___, ctx) => ({ items: await getRecentTestRuns(await getDemoDb(), ctx?.scope) }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-runs\/(\d+)$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'run', +m[1]!);
      const db = await getDemoDb();
      // Resolve the stored wasted-wait patterns like the server route does: a
      // custom pattern list recomputes per-case wasted time, the default leaves
      // the stored values alone.
      const stored = await getAppSetting<{ value: string[] }>(db, WASTED_WAIT_PATTERNS_KEY);
      const resolved = resolveStoredWastedPatterns(stored);
      return getTestRun(db, +m[1]!, resolved.isDefault ? null : resolved.patterns);
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/test-runs\/(\d+)$/,
    handler: async (m, body, _q, ctx) => {
      const projectId = await assertDemoEntityScope(ctx, 'run', +m[1]!);
      const patch = parseTestRunPatch(body);
      if (typeof patch === 'string') throw demoHttpError(400, patch);
      const db = await getDemoDb();
      if (patch.keep === false && projectId !== null && !demoCan(ctx, 'run:delete', projectId)) {
        throw demoHttpError(403, 'Releasing a kept run takes the Project admin role on this project');
      }
      try {
        return await patchTestRun(db, +m[1]!, patch, { userId: ctx?.actingUserId ?? null });
      } catch (err) {
        if (err instanceof Error && err.message === 'Test run not found') throw demoHttpError(404, err.message);
        throw err;
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-runs\/(\d+)\/coverage$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'run', +m[1]!);
      const parsed = parseRunCoverageQuery(q?.get('file'), q?.get('limit'));
      if ('error' in parsed) throw demoHttpError(400, parsed.error);
      const coverage = await getRunCoverage(await getDemoDb(), +m[1]!, parsed);
      if (!coverage) throw demoHttpError(404, 'Test run not found');
      return coverage;
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/test-runs\/(\d+)\/coverage$/,
    permission: 'run:submit',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'run', +m[1]!);
      const db = await getDemoDb();
      const [run] = await db
        .select({ projectId: testRuns.projectId, commit: testRuns.commit })
        .from(testRuns)
        .where(eq(testRuns.id, +m[1]!));
      if (!run) throw demoHttpError(404, 'Test run not found');
      const files = parseRunCoverage(body);
      if (typeof files === 'string') throw demoHttpError(400, files);
      const stored = await storeRunCoverage(db, +m[1]!, run.projectId, files);
      await storeRunCoverageGaps(db, +m[1]!, readRunCoverageGaps((body as { incomplete?: unknown }).incomplete));
      if (run.commit) {
        invalidateCommitCoverage(run.projectId, run.commit);
        await settleCommitCoverage(getDemoDb, run.projectId, run.commit);
      }
      return { files: stored };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/coverage-reports$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const parsed = parseCoverageReportsQuery(q?.get('commit') ?? undefined, q?.get('limit') ?? undefined);
      if ('error' in parsed) throw demoHttpError(400, parsed.error);
      return { items: await listCoverageReports(await getDemoDb(), +m[1]!, parsed) };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/(\d+)\/coverage-reports$/,
    permission: 'run:submit',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const upload = parseCoverageReportUpload(body);
      if (typeof upload === 'string') throw demoHttpError(400, upload);
      const stored = await storeCoverageReport(await getDemoDb(), +m[1]!, upload).catch((error: unknown) => {
        if (error instanceof Error && error.message === PROJECT_NOT_FOUND) throw demoHttpError(404, PROJECT_NOT_FOUND);
        throw error;
      });
      invalidateCommitCoverage(+m[1]!, upload.commit);
      const superseded = await settleCommitCoverage(getDemoDb, +m[1]!, upload.commit);
      return superseded ? { ...stored, superseded } : stored;
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/coverage-summary$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const parsed = parseCoverageSummaryQuery(
        q?.get('commit'),
        q?.get('branch'),
        q?.get('folder'),
        q?.get('file'),
        q?.get('area'),
      );
      if ('error' in parsed) throw demoHttpError(400, parsed.error);
      const summary = await getCoverageSummary(await getDemoDb(), +m[1]!, parsed);
      if (!summary) throw demoHttpError(404, 'No coverage for this commit');
      return summary;
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/coverage-tree$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const parsed = parseCoverageSummaryQuery(
        q?.get('commit'),
        q?.get('branch'),
        q?.get('folder'),
        undefined,
        q?.get('area'),
      );
      if ('error' in parsed) throw demoHttpError(400, parsed.error);
      const tree = await getCoverageTree(await getDemoDb(), +m[1]!, parsed);
      if (!tree) throw demoHttpError(404, 'No coverage for this commit');
      if ('gone' in tree) throw demoHttpError(410, tree.message);
      return tree;
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/coverage-export$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const parsed = parseCoverageSummaryQuery(q?.get('commit'), q?.get('branch'), undefined);
      if ('error' in parsed) throw demoHttpError(400, parsed.error);
      const format = parseCoverageExportFormat(q?.get('format') ?? undefined);
      if (typeof format !== 'string') throw demoHttpError(400, format.error);
      const exported = await exportCommitCoverage(await getDemoDb(), +m[1]!, parsed, format);
      if (!exported) throw demoHttpError(404, 'No coverage for this commit');
      if ('gone' in exported) throw demoHttpError(410, exported.message);
      return new Response(exported.body, {
        status: 200,
        headers: {
          'Content-Type': exported.contentType,
          'Content-Disposition': `attachment; filename="${exported.filename}"`,
        },
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/test-runs\/(\d+)\/incident$/,
    permission: ['run:submit', 'run:control'],
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'run', +m[1]!);
      const input = parseSetRunIncident(body);
      if (typeof input === 'string') throw demoHttpError(400, input);
      const db = await getDemoDb();
      const by = ctx?.actingUserId
        ? ((await db.select({ name: users.name }).from(users).where(eq(users.id, ctx.actingUserId)))[0]?.name ?? null)
        : null;
      try {
        return await setRunIncident(db, +m[1]!, { ...input, by });
      } catch (err) {
        if (err instanceof Error && err.message === 'Test run not found') throw demoHttpError(404, err.message);
        throw err;
      }
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/test-runs\/(\d+)$/,
    permission: 'run:delete',
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'run', +m[1]!);
      return apiDeleteTestRun(+m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-runs\/(\d+)\/network-requests$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'run', +m[1]!);
      return { items: await getNetworkRequests(await getDemoDb(), +m[1]!) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-runs\/(\d+)\/perfetto$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'run', +m[1]!);
      return apiPerfettoTestRun(+m[1]!);
    },
  },

  // Failure groups
  {
    method: 'GET',
    pattern: /^\/api\/test-runs\/(\d+)\/failure-groups$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'run', +m[1]!);
      return { items: await getFailureGroups(await getDemoDb(), +m[1]!) };
    },
  },

  // Run insights
  {
    method: 'GET',
    pattern: /^\/api\/test-runs\/(\d+)\/insights$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'run', +m[1]!);
      const baselineRaw = q?.get('baseline');
      const baselineId = baselineRaw ? Number(baselineRaw) : null;
      const baseBranch = q?.get('baseBranch')?.trim() || null;
      return computeRunInsights(await getDemoDb(), +m[1]!, {
        baselineId: baselineId != null && Number.isFinite(baselineId) ? baselineId : null,
        baseBranch,
        failedFallback: true,
      });
    },
  },

  // Run resources
  {
    method: 'GET',
    pattern: /^\/api\/test-runs\/(\d+)\/resources$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'run', +m[1]!);
      const resources = await getRunResources(await getDemoDb(), +m[1]!);
      if (!resources) throw demoHttpError(404, 'Run not found');
      return resources;
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-runs\/(\d+)\/resource-timeline$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'run', +m[1]!);
      const timeline = await getRunResourceTimeline(await getDemoDb(), +m[1]!);
      if (!timeline) throw demoHttpError(404, 'Run not found');
      return timeline;
    },
  },

  // Failure clusters
  {
    method: 'GET',
    pattern: /^\/api\/failure-clusters$/,
    handler: async (_m, _b, q, ctx) => {
      const limit = Math.min(200, Math.max(1, Number(q?.get('limit')) || 50));
      return { items: await getOpenFailureClusters(await getDemoDb(), ctx?.scope, limit) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/failure-clusters\/(\d+)$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      return getFailureCluster(await getDemoDb(), +m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/failure-clusters\/(\d+)\/occurrence-trend$/,
    handler: async (m, _, q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      const days = parseInt(q?.get('days') || String(CLUSTER_TREND_DEFAULT_DAYS));
      return getClusterOccurrenceTrend(await getDemoDb(), +m[1]!, { days });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/failure-clusters\/(\d+)\/export$/,
    handler: async (m, _, q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      return apiExportFailureCluster(+m[1]!, q as URLSearchParams | undefined);
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/failure-clusters\/(\d+)\/status$/,
    permission: 'triage:write',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      const b = body as { status?: string; triageNote?: string | null };
      return patchClusterStatus(await getDemoDb(), +m[1]!, b.status ?? '', b.triageNote);
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/failure-clusters\/(\d+)\/assignee$/,
    permission: 'triage:write',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      const b = body as { assignee?: string | null };
      return patchClusterAssignee(await getDemoDb(), +m[1]!, b.assignee ?? null);
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/failure-clusters\/(\d+)\/snooze$/,
    permission: 'triage:write',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      const b = body as { snooze?: string | null };
      const snooze = b.snooze ?? null;
      if (snooze !== null && !isSnoozeOption(snooze)) throw demoHttpError(400, 'Invalid snooze option');
      return patchClusterSnooze(await getDemoDb(), +m[1]!, snooze);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/failure-clusters\/(\d+)\/quarantine$/,
    permission: 'quarantine:write',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      const b = (body ?? {}) as { reason?: string };
      return quarantineClusterTests(await getDemoDb(), +m[1]!, { reason: b.reason });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/failure-clusters\/bulk$/,
    permission: 'triage:write',
    handler: async (_m, body, _q, ctx) => {
      const b = (body ?? {}) as {
        ids?: unknown;
        action?: string;
        status?: string;
        assignee?: string | null;
        snooze?: string | null;
      };
      const ids = parseBulkIds(b.ids);
      if (!ids) throw demoHttpError(400, 'ids must be a non-empty array of positive integers (max 200)');
      const db = await getDemoDb();
      // Narrow to the clusters the acting user may triage, as the server does.
      const scope = demoScope(ctx, 'triage:write');
      const rows = await db
        .select({ id: failureClusters.id, projectId: failureClusters.projectId })
        .from(failureClusters)
        .where(inArray(failureClusters.id, ids));
      const allowed = rows.filter((r) => scope === 'all' || scope.has(r.projectId)).map((r) => r.id);
      let result;
      if (b.action === 'status') {
        result = await bulkTriageClusters(db, allowed, { action: 'status', status: b.status ?? '' });
      } else if (b.action === 'assign') {
        result = await bulkTriageClusters(db, allowed, { action: 'assign', assignee: b.assignee ?? null });
      } else if (b.action === 'snooze') {
        const snooze = b.snooze ?? null;
        if (snooze !== null && !isSnoozeOption(snooze)) throw demoHttpError(400, 'Invalid snooze option');
        result = await bulkTriageClusters(db, allowed, { action: 'snooze', snooze });
      } else {
        throw demoHttpError(400, 'action must be one of: status, assign, snooze');
      }
      if (!result) throw demoHttpError(400, 'Invalid bulk triage request');
      return { requested: ids.length, updated: result.updated };
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/failure-clusters\/(\d+)\/base-commit$/,
    permission: 'triage:write',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      const b = body as { commit?: string | null };
      return patchClusterBaseCommit(await getDemoDb(), +m[1]!, b.commit);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/failure-clusters\/(\d+)\/bisect$/,
    permission: 'run:control',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      const parsed = parseBisectResultBody(body);
      if (!parsed.ok) throw demoHttpError(400, parsed.message);
      const bisectedCommit = await recordClusterBisect(await getDemoDb(), +m[1]!, parsed.value);
      if (!bisectedCommit) throw demoHttpError(404, 'Failure cluster not found');
      return { ok: true, bisectedCommit };
    },
  },
  // The demo bundles no skill files; the desktop app is the one that installs them.
  {
    method: 'GET',
    pattern: /^\/api\/agent-skills$/,
    handler: async () => ({ version: '', items: [] }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/failure-clusters\/(\d+)\/agent-diagnosis$/,
    permission: 'ai:run',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      return recordDemoAgentDiagnosis({ scope: 'cluster', clusterId: +m[1]! }, body, ctx);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/test-run-cases\/(\d+)\/agent-diagnosis$/,
    permission: 'ai:run',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return recordDemoAgentDiagnosis({ scope: 'execution', executionId: +m[1]! }, body, ctx);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/failure-clusters\/(\d+)\/fix-attempts$/,
    permission: 'run:control',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      const parsed = parseFixAttempt(body);
      if (!parsed.ok) throw demoHttpError(400, parsed.message);
      const result = await reportFixAttempt(await getDemoDb(), +m[1]!, parsed.value, {
        channel: parsed.value.channel ?? 'ui',
        userId: ctx?.actingUserId ?? null,
      });
      if (!result.ok)
        throw demoHttpError(FIX_ATTEMPT_ERRORS[result.error].status, FIX_ATTEMPT_ERRORS[result.error].message);
      return { ok: true, recorded: result.recorded, attempt: result.attempt };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/failure-clusters\/(\d+)\/activity$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      return { items: await getClusterActivity(await getDemoDb(), +m[1]!) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/failure-clusters\/(\d+)\/branches$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      return { items: (await getClusterBranches(await getDemoDb(), +m[1]!)).branches };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/failure-clusters\/(\d+)\/commits$/,
    handler: async (m, _, q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      const { commits, ...rest } = await getClusterCommits(await getDemoDb(), +m[1]!, q as URLSearchParams | undefined);
      return { items: commits, ...rest };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/failure-clusters\/(\d+)\/commit-diff$/,
    handler: async (m, _, q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      return getClusterCommitDiff(await getDemoDb(), +m[1]!, q as URLSearchParams | undefined);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/failure-clusters\/(\d+)\/context$/,
    handler: async (m, _, q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      const query = q as URLSearchParams | undefined;
      const db = await getDemoDb();
      const format = query?.get('format');
      if (format === 'prompt') return getClusterContextPrompt(db, +m[1]!, query);
      const clusterCtx = await getClusterContext(db, +m[1]!, query);
      const contextSha = await contextStalenessHash(clusterCtx.sections);
      // Default format mirrors the server: a plain context/coverage/scmChanges
      // envelope; `?format=json` returns the full structured shape.
      if (format === 'json') return { ...clusterCtx, contextSha };
      return { context: clusterCtx.text, contextSha, coverage: clusterCtx.coverage, scmChanges: clusterCtx.scmChanges };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/failure-clusters\/(\d+)\/diagnosis$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      return getClusterDiagnosis(await getDemoDb(), +m[1]!);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/failure-clusters\/(\d+)\/diagnose$/,
    permission: 'ai:run',
    handler: async (m, body, q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      return apiDiagnoseCluster(+m[1]!, body as Record<string, unknown> | undefined, q as URLSearchParams | undefined);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/failure-clusters\/(\d+)\/diagnose\/stream$/,
    permission: 'ai:run',
    handler: async (m, body, query, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      return apiStreamDiagnoseCluster(
        +m[1]!,
        body as Record<string, unknown> | undefined,
        query as URLSearchParams | undefined,
      );
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/failure-clusters\/(\d+)\/extract-cases$/,
    permission: 'triage:write',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      const b = body as { testCaseIds: number[]; triageNote?: string };
      return extractClusterCases(await getDemoDb(), +m[1]!, b.testCaseIds, b.triageNote);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/failure-clusters\/(\d+)\/diagnoses$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      const full = (q as URLSearchParams | undefined)?.get('full') === '1';
      return { items: await listClusterDiagnosisVersions(await getDemoDb(), +m[1]!, { full }) };
    },
  },
  {
    method: 'GET',
    // CI re-run availability — always off in the browser demo (no server, token
    // or CI to dispatch to), so the button renders disabled with a clear reason.
    pattern: /^\/api\/failure-clusters\/(\d+)\/rerun$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      return {
        available: false,
        reason: 'CI re-run is not available in the demo.',
        provider: null,
        enabled: false,
        hasToken: false,
        lastDispatch: null,
      };
    },
  },
  {
    method: 'POST',
    // No-op dispatch: the demo has no CI to trigger.
    pattern: /^\/api\/failure-clusters\/(\d+)\/rerun$/,
    permission: 'run:control',
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      return { ok: false, demo: true, message: 'CI re-run is not available in the demo.' };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/test-cases\/(\d+)\/merge$/,
    permission: 'project:manage',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'case', +m[1]!);
      const sourceId = Number((body as { sourceId?: unknown } | null)?.sourceId);
      if (!Number.isInteger(sourceId) || sourceId <= 0) throw demoHttpError(400, 'sourceId must be a test case id');
      const outcome = await mergeTestCases(await getDemoDb(), +m[1]!, sourceId);
      if (!outcome.ok) {
        throw demoHttpError(
          { 'not-found': 404, 'same-case': 400, 'other-project': 400, 'ran-together': 409 }[outcome.error],
          outcome.message,
        );
      }
      return outcome;
    },
  },
  {
    method: 'POST',
    // No-op dispatch: the demo has no CI to run the lab in.
    pattern: /^\/api\/test-cases\/(\d+)\/flake-lab-ci$/,
    permission: 'run:control',
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'case', +m[1]!);
      return { ok: false, demo: true, message: 'Flake Lab in CI is not available in the demo.' };
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/failure-diagnoses\/(\d+)\/feedback$/,
    handler: async (m, body, _q, ctx) => {
      if (ctx && ctx.scope !== 'all') {
        const db = await getDemoDb();
        const [diag] = await db
          .select({ clusterId: failureDiagnoses.clusterId, testRunsCaseId: failureDiagnoses.testRunsCaseId })
          .from(failureDiagnoses)
          .where(eq(failureDiagnoses.id, +m[1]!));
        if (!diag) throw demoHttpError(404, 'Not found');
        if (diag.clusterId != null) await assertDemoEntityScope(ctx, 'cluster', diag.clusterId);
        else if (diag.testRunsCaseId != null) await assertDemoEntityScope(ctx, 'execution', diag.testRunsCaseId);
      }
      return apiSubmitDiagnosisFeedback(await getDemoDb(), +m[1]!, body as Record<string, unknown> | undefined);
    },
  },

  // AI status and settings
  { method: 'GET', pattern: /^\/api\/ai\/status$/, handler: () => apiGetAiStatus() },
  { method: 'GET', pattern: /^\/api\/settings\/ai$/, permission: 'settings:manage', handler: () => apiGetAiSettings() },
  {
    method: 'PUT',
    pattern: /^\/api\/settings\/ai$/,
    permission: 'settings:manage',
    handler: (_, body) => apiPutAiSettings(body),
  },
  {
    method: 'POST',
    pattern: /^\/api\/settings\/ai\/test$/,
    permission: 'settings:manage',
    handler: () => apiTestAiSettings(),
  },
  {
    method: 'GET',
    pattern: /^\/api\/settings\/ai\/usage$/,
    permission: 'settings:manage',
    handler: (_, __, q) => apiGetAiUsage(q?.get('days') ?? null),
  },
  // Assistant — the status and the acting user's own conversations
  {
    method: 'GET',
    pattern: /^\/api\/assistant\/status$/,
    handler: () => apiAssistantStatus(),
  },
  {
    method: 'GET',
    pattern: /^\/api\/assistant\/questions$/,
    handler: async (_m, _b, _q, ctx) => apiListAssistantQuestions(ctx?.actingUserId ?? null),
  },
  {
    method: 'GET',
    pattern: /^\/api\/assistant\/conversations$/,
    handler: async (_m, _b, _q, ctx) => apiListAssistantConversations(ctx?.actingUserId ?? null),
  },
  {
    method: 'POST',
    pattern: /^\/api\/assistant\/conversations$/,
    handler: async (_m, body, _q, ctx) => apiCreateAssistantConversation(body, ctx?.actingUserId ?? null),
  },
  {
    method: 'GET',
    pattern: /^\/api\/assistant\/conversations\/(\d+)$/,
    handler: async (m, _b, _q, ctx) => apiGetAssistantConversation(+m[1]!, ctx?.actingUserId ?? null),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/assistant\/conversations\/(\d+)$/,
    handler: async (m, _b, _q, ctx) => apiDeleteAssistantConversation(+m[1]!, ctx?.actingUserId ?? null),
  },
  {
    method: 'POST',
    pattern: /^\/api\/assistant\/conversations\/(\d+)\/messages$/,
    handler: async (m, body, _q, ctx) =>
      apiAskAssistant(+m[1]!, body, {
        ownerId: ctx?.actingUserId ?? null,
        access: ctx?.access ?? ADMIN_ACCESS,
        scope: ctx?.scope ?? 'all',
        get: async <T>(path: string, query?: Record<string, string | number>) =>
          (await handleDemoRequest(
            path,
            'GET',
            undefined,
            query ? new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString() : undefined,
            ctx?.actingUserId ?? null,
          )) as T,
      }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/assistant\/conversations\/(\d+)\/stop$/,
    handler: async (m, _b, _q, ctx) => apiStopAssistantAnswer(+m[1]!, ctx?.actingUserId ?? null),
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/assistant\/conversations\/(\d+)\/messages\/(\d+)\/checklist$/,
    handler: async (m, body, _q, ctx) => apiTickAssistantChecklist(+m[1]!, +m[2]!, body, ctx?.actingUserId ?? null),
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/assistant\/conversations\/(\d+)\/messages\/(\d+)\/proposal$/,
    handler: async (m, body, _q, ctx) => apiRecordAssistantProposal(+m[1]!, +m[2]!, body, ctx?.actingUserId ?? null),
  },
  {
    method: 'GET',
    pattern: /^\/api\/assistant\/nudge-dismissals$/,
    handler: async (_m, _b, _q, ctx) => apiListAssistantNudgeDismissals(ctx?.actingUserId ?? null),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/assistant\/nudge-dismissals\/([^/]+)$/,
    handler: async (m, _b, _q, ctx) => apiDismissAssistantNudge(m[1]!, ctx?.actingUserId ?? null),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/assistant\/nudge-dismissals\/([^/]+)$/,
    handler: async (m, _b, _q, ctx) => apiUndoAssistantNudgeDismissal(m[1]!, ctx?.actingUserId ?? null),
  },
  // An answer's MCP endpoint takes the token of an answer the Claude Code CLI writes; the demo writes none.
  {
    method: 'POST',
    pattern: /^\/api\/assistant\/conversations\/(\d+)\/mcp$/,
    handler: () => {
      throw demoHttpError(401, 'This endpoint takes the token of a running answer');
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/settings\/ai\/limits$/,
    permission: 'settings:manage',
    handler: () => apiGetAiLimits(),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/settings\/ai\/limits$/,
    permission: 'settings:manage',
    handler: (_, body) => apiPutAiLimits(body),
  },
  {
    method: 'POST',
    pattern: /^\/api\/settings\/ai\/models$/,
    permission: 'settings:manage',
    handler: (_, body) => apiListAiModels(body),
  },

  // Date & time localization
  { method: 'GET', pattern: /^\/api\/settings\/locale$/, handler: () => apiGetLocale() },
  {
    method: 'PUT',
    pattern: /^\/api\/settings\/locale$/,
    permission: 'settings:manage',
    handler: (_, body) => apiPutLocale(body as Parameters<typeof apiPutLocale>[0]),
  },

  // Test-run streaming (no-op in demo mode; only terminal-status runs exist)
  { method: 'GET', pattern: /^\/api\/test-runs\/(\d+)\/stream$/, handler: () => Promise.resolve({ ok: true }) },

  // Notification SSE (handled via BroadcastChannel in demo mode)
  { method: 'GET', pattern: /^\/api\/notifications\/stream$/, handler: () => Promise.resolve({ ok: true }) },

  // Test cases (stable)
  {
    method: 'GET',
    pattern: /^\/api\/test-cases\/(\d+)$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'case', +m[1]!);
      return getTestCase(await getDemoDb(), +m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-cases\/(\d+)\/history$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'case', +m[1]!);
      return { items: await getTestCaseHistory(await getDemoDb(), +m[1]!) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-cases\/(\d+)\/flake-plan$/,
    permission: ['run:submit', 'run:control'],
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'case', +m[1]!);
      const kind = q?.get('kind') === 'verify' ? 'verify' : 'reproduce';
      const runs = q?.get('runs') ? Number(q.get('runs')) : null;
      try {
        return await getFlakeExperimentPlan(await getDemoDb(), +m[1]!, {
          kind,
          runs: Number.isInteger(runs) && runs! >= 1 && runs! <= 100 ? runs : null,
          record: q?.get('record') !== 'false',
          commit: q?.get('commit') || null,
          source: FLAKE_EXPERIMENT_SOURCES.find((s) => s === q?.get('source')),
          machine: q?.get('machine') || null,
        });
      } catch (error) {
        if (error instanceof FlakePlanUnavailable) throw demoHttpError(error.statusCode, error.message);
        throw error;
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-cases\/(\d+)\/flake-experiments$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'case', +m[1]!);
      const limit = Number(q?.get('limit')) || undefined;
      const db = await getDemoDb();
      return {
        items: await listFlakeExperiments(db, +m[1]!, { limit }),
        verifiedFix: (await getVerifiedFixes(db, [+m[1]!])).get(+m[1]!) ?? null,
      };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/(\d+)\/flake-lab\/results$/,
    permission: 'run:submit',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      try {
        return await recordFlakeResults(await getDemoDb(), +m[1]!, (body ?? {}) as FlakeResultsInput);
      } catch (error) {
        if (error instanceof FlakeResultsRejected) throw demoHttpError(error.statusCode, error.message);
        throw error;
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/flake-lab$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const int = (name: string) => {
        const value = parseInt(q?.get(name) ?? '', 10);
        return Number.isNaN(value) ? undefined : value;
      };
      return getProjectFlakeLab(await getDemoDb(), +m[1]!, {
        runs: int('runs'),
        environment: q?.get('environment')?.trim() || null,
        branch: q?.get('branch')?.trim() || null,
        scope: parseProjectRunScope(q),
        limit: int('limit'),
        suspects: q?.get('suspects') === 'true' || q?.get('suspects') === '1',
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/flake-lab\/test$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const match = /^(.+):(\d+)$/.exec((q?.get('location') ?? '').trim());
      if (!match) throw demoHttpError(400, 'location must be a spec path and a line, file:line');
      const found = await resolveTestCaseByLocation(await getDemoDb(), +m[1]!, match[1]!, Number(match[2]));
      if (!found) throw demoHttpError(404, `No test case at ${q?.get('location')}`);
      return found;
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-cases\/(\d+)\/flake-profile$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'case', +m[1]!);
      const profile = await getFlakeProfile(await getDemoDb(), +m[1]!);
      if (!profile) throw demoHttpError(404, 'Test case not found');
      return profile;
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-cases\/(\d+)\/stability-trend$/,
    handler: async (m, _, q, ctx) => {
      await assertDemoEntityScope(ctx, 'case', +m[1]!);
      const days = parseInt(q?.get('days') || String(STABILITY_TREND_DEFAULT_DAYS));
      const granularity = parseGranularity(q?.get('by')) ?? 'auto';
      return getTestCaseStabilityTrend(await getDemoDb(), +m[1]!, { days, granularity });
    },
  },

  // Test run cases (executions)
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return getTestRunCase(await getDemoDb(), +m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/traces$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return { items: await getTestRunCaseTraces(await getDemoDb(), +m[1]!) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/export$/,
    handler: async (m, _, q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return apiExportTestRunCase(+m[1]!, q as URLSearchParams | undefined);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/piwibug$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return apiExecutionBugReport(+m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/replay-steps$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return apiExecutionReplaySteps(+m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/perfetto$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return apiPerfettoTestRunCase(+m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/diagnosis-context$/,
    handler: async (m, _, q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      const query = q as URLSearchParams | undefined;
      const db = await getDemoDb();
      const format = query?.get('format');
      if (format === 'prompt') return getExecutionContextPrompt(db, +m[1]!, query);
      const executionCtx = await getExecutionContext(db, +m[1]!, query);
      if (format === 'json') return executionCtx;
      return { context: executionCtx.text, coverage: executionCtx.coverage, scmChanges: executionCtx.scmChanges };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/diagnosis$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return getExecutionDiagnosis(await getDemoDb(), +m[1]!);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/test-run-cases\/(\d+)\/diagnose$/,
    permission: 'ai:run',
    handler: async (m, body, q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return apiDiagnoseExecution(+m[1]!, body as Record<string, unknown> | undefined, q);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/locator-healing$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return getLocatorHealing(await getDemoDb(), +m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/locators$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      const result = await getExecutionLocators(await getDemoDb(), +m[1]!);
      if (!result) throw demoHttpError(404, 'Test run case not found');
      return result;
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/coverage$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      const coverage = await getExecutionCoverage(await getDemoDb(), +m[1]!);
      if (!coverage) throw demoHttpError(404, 'Test run case not found');
      return coverage;
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/suspect-lines$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      const answer = await demoExecutionSuspectLines(await getDemoDb(), +m[1]!);
      if (!answer) throw demoHttpError(404, 'Test run case not found');
      return answer;
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/coverage-divergence$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      const answer = await getCoverageDivergence(await getDemoDb(), +m[1]!);
      if (!answer) throw demoHttpError(404, 'Test run case not found');
      return answer;
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-cases\/(\d+)\/path-variation$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'case', +m[1]!);
      const answer = await getPathVariation(await getDemoDb(), +m[1]!);
      if (!answer) throw demoHttpError(404, 'Test case not found');
      return answer;
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-cases\/(\d+)\/coverage-reach$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'case', +m[1]!);
      const query = parseCoverageReachQuery({
        file: q?.get('file'),
        lines: q?.get('lines'),
        executionId: q?.get('executionId'),
      });
      if ('error' in query) throw demoHttpError(400, query.error);
      try {
        const answer = await getCoverageReach(await getDemoDb(), +m[1]!, query);
        if (!answer) throw demoHttpError(404, 'Test case not found');
        return answer;
      } catch (error) {
        if (error instanceof CoverageInsightInputError) throw demoHttpError(400, error.message);
        throw error;
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/coverage-loss$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const tests = parseLossTestIds(q?.get('tests'));
      if (!tests) throw demoHttpError(400, 'tests must list 1 to 50 test case ids, such as 12,15,40');
      const answer = await getCoverageLoss(await getDemoDb(), +m[1]!, tests);
      if (!answer) throw demoHttpError(404, 'None of these tests is in the project');
      return answer;
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/test-run-cases\/(\d+)\/locator-pick$/,
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return saveLocatorPick(await getDemoDb(), +m[1]!, body as Parameters<typeof saveLocatorPick>[2]);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/environment-diff$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return getEnvironmentDiff(await getDemoDb(), +m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/page-diff$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return getPageDiff(await getDemoDb(), +m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/timeline$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return getFailureTimeline(await getDemoDb(), +m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/steps$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return getExecutionSteps(await getDemoDb(), +m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/clues$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return getFailureClues(await getDemoDb(), +m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/reproduce$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return buildExecutionReproduce(await getDemoDb(), +m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/attempt-diff$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return getAttemptDiff(await getDemoDb(), +m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/dom-snapshot$/,
    handler: async (m, _body, query, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return apiGetDemoDomSnapshot(+m[1]!, query);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/trace-stacks$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return apiGetDemoTraceStacks(+m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/trace-network$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return apiGetDemoTraceNetwork(+m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/trace-network-body$/,
    handler: async (m, _body, query, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return apiGetDemoTraceNetworkBody(+m[1]!, query);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/trace-snapshots$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return apiGetDemoTraceSnapshots(+m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/trace-snapshot$/,
    handler: async (m, _body, query, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      return apiGetDemoTraceSnapshot(+m[1]!, query);
    },
  },
  // The demo cannot pixel-diff in the browser — it serves the overlay the
  // seed generated with the real diff code, straight from the files row.
  {
    method: 'GET',
    pattern: /^\/api\/test-run-cases\/(\d+)\/visual-diff$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'execution', +m[1]!);
      const db = await getDemoDb();
      const rows = await db
        .select({ path: files.path, metadata: files.metadata })
        .from(files)
        .where(and(eq(files.testRunsCaseId, +m[1]!), eq(files.type, 'visual-diff')))
        .limit(1);
      const row = rows[0];
      if (!row?.metadata) return { status: 'no-baseline' };
      return { status: 'ok', diff: { path: row.path, ...(row.metadata as Record<string, unknown>) } };
    },
  },

  // Tags
  {
    method: 'GET',
    pattern: /^\/api\/tags$/,
    handler: async () => ({ items: (await listTags(await getDemoDb())).tags }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/tags$/,
    permission: 'tags:manage',
    handler: async (_, body) => {
      const b = body as { text?: string; color?: string };
      const text = typeof b.text === 'string' ? b.text : '';
      if (text.length < 1 || text.length > 50) {
        throw demoHttpError(400, 'Tag text must be between 1 and 50 characters');
      }
      const color = typeof b.color === 'string' && b.color.trim() ? b.color : undefined;
      if (!color) throw demoHttpError(400, 'Color is required');
      try {
        return await createTag(await getDemoDb(), text, color);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Failed to create tag';
        throw demoHttpError(message === 'A tag with this text already exists' ? 409 : 400, message);
      }
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/tags\/(\d+)$/,
    permission: 'tags:manage',
    handler: async (m, body) => updateTag(await getDemoDb(), +m[1]!, body as Parameters<typeof updateTag>[2]),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/tags\/(\d+)$/,
    permission: 'tags:manage',
    handler: async (m) => deleteTag(await getDemoDb(), +m[1]!),
  },

  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/kept-runs$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const limit = Number(q?.get('limit')) || undefined;
      return listKeptRuns(await getDemoDb(), +m[1]!, { limit });
    },
  },

  // Markers (project timeline)
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/markers$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      return { items: (await listProjectMarkers(await getDemoDb(), +m[1]!)).markers };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/(\d+)\/markers$/,
    permission: 'marker:write',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const b = body as {
        label?: string;
        occurredAt?: string;
        category?: string;
        environment?: string | null;
        description?: string | null;
        runId?: number | string | null;
      };
      const label = typeof b.label === 'string' ? b.label : '';
      if (label.length < 1 || label.length > 120)
        throw demoHttpError(400, 'Label must be between 1 and 120 characters');
      const occurredAt = new Date(b.occurredAt ?? '');
      if (Number.isNaN(occurredAt.getTime())) throw demoHttpError(400, 'occurredAt must be a valid date');
      if (b.category && !MARKER_CATEGORY_IDS.includes(b.category)) throw demoHttpError(400, 'Unknown marker category');
      if (b.environment != null && b.environment.length > 120)
        throw demoHttpError(400, 'environment must be at most 120 characters');
      if (b.description != null && b.description.length > 2000) {
        throw demoHttpError(400, 'description must be at most 2000 characters');
      }
      const runId = b.runId == null || b.runId === '' ? null : Number(b.runId);
      if (runId !== null && (!Number.isInteger(runId) || runId <= 0)) {
        throw demoHttpError(400, 'runId must be a positive integer');
      }
      const db = await getDemoDb();
      if (runId && !(await markerRunBelongsToProject(db, +m[1]!, runId))) {
        throw demoHttpError(400, 'runId must be a run of this project');
      }
      return createMarker(db, +m[1]!, {
        label,
        occurredAt,
        category: b.category,
        environment: b.environment ?? null,
        description: b.description ?? null,
        runId,
      });
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/markers\/(\d+)$/,
    permission: 'marker:write',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'marker', +m[1]!);
      const b = body as { occurredAt?: string } & Record<string, unknown>;
      if (b.label !== undefined && (typeof b.label !== 'string' || b.label.length < 1 || b.label.length > 120)) {
        throw demoHttpError(400, 'Label must be between 1 and 120 characters');
      }
      if (b.category !== undefined && !MARKER_CATEGORY_IDS.includes(b.category as string)) {
        throw demoHttpError(400, 'Unknown marker category');
      }
      const patch = { ...b, ...(b.occurredAt ? { occurredAt: new Date(b.occurredAt) } : {}) };
      return updateMarker(await getDemoDb(), +m[1]!, patch as Parameters<typeof updateMarker>[2]);
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/markers\/(\d+)$/,
    permission: 'marker:write',
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'marker', +m[1]!);
      return deleteMarker(await getDemoDb(), +m[1]!);
    },
  },

  // Locator index: which tests use a locator
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/locator-usages$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const parsed = parseLocatorUsageQuery(q?.get('match'), q?.get('value'));
      if ('error' in parsed) throw demoHttpError(400, parsed.error);
      const branch = parseLocatorBranchQuery(q?.get('branch'));
      if ('error' in branch) throw demoHttpError(400, branch.error);
      return getLocatorUsages(await getDemoDb(), +m[1]!, parsed.match, parsed.value, { branch: branch.branch });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/locator-index$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const branch = parseLocatorBranchQuery(q?.get('branch'));
      if ('error' in branch) throw demoHttpError(400, branch.error);
      const index = await getLocatorIndex(await getDemoDb(), +m[1]!, { branch: branch.branch });
      if (!index) throw demoHttpError(404, 'Project not found');
      return index;
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/code-reach$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const file = q?.get('file')?.trim() ?? '';
      if (!file || file.length > 500) throw demoHttpError(400, 'file is required (at most 500 characters)');
      const branch = parseLocatorBranchQuery(q?.get('branch'));
      if ('error' in branch) throw demoHttpError(400, branch.error);
      return getCodeReachForFile(await getDemoDb(), +m[1]!, file, branch.branch);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/locator-alternatives$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const file = q?.get('file')?.trim() ?? '';
      if (!file || file.length > 500) throw demoHttpError(400, 'file is required (at most 500 characters)');
      return { items: await getLocatorAlternatives(await getDemoDb(), +m[1]!, file) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/branch-failures$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      return branchFailuresOrError(await getDemoDb(), +m[1]!, Object.fromEntries(q ?? []), demoHttpError);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/coverage$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const file = q?.get('file')?.trim() ?? '';
      if (!file || file.length > 500) throw demoHttpError(400, 'file is required (at most 500 characters)');
      const branch = parseLocatorBranchQuery(q?.get('branch'));
      if ('error' in branch) throw demoHttpError(400, branch.error);
      return getFileCoverage(await getDemoDb(), +m[1]!, file, branch.branch);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/source$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const parsed = parseSourceQuery(q?.get('path'), q?.get('blob'));
      if ('error' in parsed) throw demoHttpError(400, parsed.error);
      const source = await getDemoSourceAtBlob(+m[1]!, parsed.path, parsed.blob);
      if (!source) throw demoHttpError(404, 'Source not available');
      return source;
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/code-index$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const branch = parseLocatorBranchQuery(q?.get('branch'));
      if ('error' in branch) throw demoHttpError(400, branch.error);
      return getCodeIndex(await getDemoDb(), +m[1]!, branch.branch);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/(\d+)\/locator-usages\/rebuild$/,
    permission: 'test-assets:write',
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      return backfillLocatorUsages(await getDemoDb(), +m[1]!, { reset: true });
    },
  },

  // Test function catalog (recorder codegen matching)
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/test-functions$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      return { items: (await listProjectTestFunctions(await getDemoDb(), +m[1]!)).testFunctions };
    },
  },
  // Validated with the same schemas the real endpoints use, not cast straight
  // through: demo mode is meant to behave like the API, and accepting an entry
  // the live instance would reject is a divergence the user only discovers
  // after switching.
  {
    method: 'POST',
    pattern: /^\/api\/projects\/(\d+)\/test-functions$/,
    permission: 'test-assets:write',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      return createTestFunction(await getDemoDb(), +m[1]!, createTestFunctionSchema.parse(body));
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/test-functions\/(\d+)$/,
    permission: 'test-assets:write',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'testFunction', +m[1]!);
      return updateTestFunction(await getDemoDb(), +m[1]!, updateTestFunctionSchema.parse(body));
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/test-functions\/(\d+)$/,
    permission: 'test-assets:write',
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'testFunction', +m[1]!);
      return deleteTestFunction(await getDemoDb(), +m[1]!);
    },
  },
  // No AI call involved (pure parse + schema validation), unlike
  // `test-functions/extract` — that one's excluded from demo mode in
  // check-demo-routes.mjs, this one isn't.
  {
    method: 'POST',
    pattern: /^\/api\/projects\/(\d+)\/test-functions\/validate-proposal$/,
    permission: 'ai:run',
    handler: async (m, body, _q, ctx) => {
      assertDemoScope(ctx, +m[1]!);
      return { proposal: validateExtractedFunction((body as { responseText?: string })?.responseText ?? '') };
    },
  },

  // Fix plan. Ownership stays annotation-only here — CODEOWNERS resolution
  // needs an SCM client the browser has no way to reach.
  {
    method: 'GET',
    pattern: /^\/api\/failure-clusters\/(\d+)\/fix-plan$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      const db = await getDemoDb();
      const built = await buildFixPlan(db, +m[1]!);
      const plan = built && { ...built, suspectLines: fixPlanSuspectLines(await demoClusterSuspectLines(db, +m[1]!)) };
      const format = (q as URLSearchParams | undefined)?.get('format');
      if (format === 'markdown' && plan) return fixPlanToMarkdown(plan);
      return plan;
    },
  },

  // Suspect lines of a cluster: the database's answer, since the demo reads no source control.
  {
    method: 'GET',
    pattern: /^\/api\/failure-clusters\/(\d+)\/suspect-lines$/,
    handler: async (m, _b, _q, ctx) => {
      const projectId = await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      const db = await getDemoDb();
      if (projectId === null) {
        const [cluster] = await db
          .select({ id: failureClusters.id })
          .from(failureClusters)
          .where(eq(failureClusters.id, +m[1]!));
        if (!cluster) throw demoHttpError(404, 'Failure cluster not found');
      }
      return demoClusterSuspectLines(db, +m[1]!);
    },
  },

  // Fixed before — resolved clusters this one resembles, read straight from the
  // in-browser DB by the same scorer the server uses.
  {
    method: 'GET',
    pattern: /^\/api\/failure-clusters\/(\d+)\/fixed-before$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'cluster', +m[1]!);
      const db = await getDemoDb();
      const [cluster] = await db.select().from(failureClusters).where(eq(failureClusters.id, +m[1]!));
      return { items: cluster ? await findFixedBefore(db, cluster) : [] };
    },
  },

  // Quarantine. The demo has no CI to gate, so candidates are omitted — the
  // proposal query is derived from flaky analysis and would only add work the
  // browser cannot act on.
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/quarantine$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const db = await getDemoDb();
      const { entries, debt } = await listQuarantine(db, +m[1]!);
      return {
        entries: (await markDismissedProposals(db, +m[1]!, entries, [])).entries,
        debt,
        candidates: [],
        releaseAfterConsecutivePasses: RELEASE_AFTER_CONSECUTIVE_PASSES,
      };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/(\d+)\/quarantine$/,
    permission: 'quarantine:write',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const b = body as { testCaseId?: number; reason?: string | null; source?: string };
      const testCaseId = Number(b.testCaseId);
      if (!Number.isFinite(testCaseId) || testCaseId <= 0) throw demoHttpError(400, 'testCaseId is required');
      const result = await addQuarantine(await getDemoDb(), +m[1]!, testCaseId, {
        reason: typeof b.reason === 'string' ? b.reason.slice(0, 500) : null,
        source: b.source,
        createdBy: ctx?.actingUserId ?? undefined,
      });
      return { success: true, ...result };
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/projects\/(\d+)\/quarantine\/(\d+)$/,
    permission: 'quarantine:write',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const reason =
        body && typeof (body as { reason?: unknown }).reason === 'string'
          ? String((body as { reason: string }).reason).slice(0, 500)
          : null;
      const result = await releaseQuarantine(await getDemoDb(), +m[1]!, +m[2]!, reason);
      if (!result.released) throw demoHttpError(404, 'No active quarantine for this test');
      return { success: true, ...result };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/(\d+)\/quarantine\/(\d+)\/dismiss$/,
    permission: 'quarantine:write',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const b = (body ?? {}) as { proposal?: unknown; reason?: unknown };
      if (!isQuarantineProposal(b.proposal)) throw demoHttpError(400, 'proposal must be quarantine or release');
      const proposal = b.proposal;
      const reason = normalizeDismissReason(b.reason);
      let dismissed: boolean;
      try {
        dismissed = await dismissQuarantineProposal(
          await getDemoDb(),
          +m[1]!,
          +m[2]!,
          proposal,
          { channel: 'ui', userId: ctx?.actingUserId ?? null },
          reason,
        );
      } catch (e) {
        if (e instanceof Error && e.message === 'Test case not found in this project')
          throw demoHttpError(404, e.message);
        throw e;
      }
      if (!dismissed) throw demoHttpError(404, `No ${proposal} proposal for this test`);
      return { success: true, proposal, dismissed };
    },
  },

  // Test selections. Resolution is pure SQL over the catalog, so the whole
  // feature runs in the browser exactly as it does on a server.
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/selections$/,
    handler: async (m, _b, query, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const resolve = query?.get('resolve');
      const db = await getDemoDb();
      return {
        items:
          resolve === 'true' || resolve === '1'
            ? await listResolvedSelections(db, +m[1]!)
            : await listSelections(db, +m[1]!),
      };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/(\d+)\/selections$/,
    permission: 'test-assets:write',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const b = body as { key?: unknown; name?: unknown; description?: unknown; definition?: unknown };
      try {
        return await createSelection(await getDemoDb(), +m[1]!, {
          key: String(b.key ?? ''),
          name: String(b.name ?? ''),
          description: typeof b.description === 'string' ? b.description : null,
          definition: (b.definition ?? {}) as SelectionDefinition,
          createdBy: ctx?.actingUserId ?? undefined,
        });
      } catch (e) {
        if (e instanceof SelectionError) throw demoHttpError(e.statusCode, e.message);
        throw e;
      }
    },
  },
  {
    // Registered before the `[key]` item route so the literal path wins the GET.
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/selections\/suggestions$/,
    handler: async (m, _b, query, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const budgetMs = Number(query?.get('budgetMs'));
      return getSelectionSuggestions(await getDemoDb(), +m[1]!, {
        budgetMs: Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : undefined,
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/selections\/overview$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      return getSelectionAnalytics(await getDemoDb(), +m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/selections\/([^/]+)$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const selection = await getSelection(await getDemoDb(), +m[1]!, decodeURIComponent(m[2]!));
      if (!selection) throw demoHttpError(404, `No selection "${decodeURIComponent(m[2]!)}" in this project`);
      return selection;
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/gaps\/change-coverage$/,
    handler: async (m, _b, query, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      // An absent `run` means "no run under inspection", not run 0 — parse it to
      // null so the join reports history reach instead of marking every file
      // uncovered against a run that never existed.
      const runRaw = query?.get('run');
      const runNum = runRaw != null && runRaw !== '' ? Number(runRaw) : null;
      const runId = runNum != null && Number.isFinite(runNum) ? runNum : null;
      // The demo has no SCM provider; show a small representative diff so the
      // uncovered-changes join renders against the seeded reach.
      return computeChangeCoverage(await getDemoDb(), +m[1]!, {
        changedFiles: [
          { filePath: 'src/api/orders.post.ts', additions: 41, deletions: 3 },
          { filePath: 'src/components/OrderRow.vue', additions: 8, deletions: 2 },
          { filePath: 'src/utils/rounding.ts', additions: 5, deletions: 1 },
        ],
        runId,
        baseBranch: 'main',
        tickets: ['PROJ-418'],
        scmAvailable: true,
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/(\d+)\/gaps\/recompute$/,
    permission: 'triage:write',
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const gaps = await computeScenarioGaps(await getDemoDb(), +m[1]!);
      return { success: true, runsProcessed: 0, gapsUpserted: gaps.upserted, gapsClosed: gaps.closed };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/surface\/manifest$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const db = await getDemoDb();
      const nodes = await db
        .select({ kind: graphNodes.kind, key: graphNodes.key, origin: graphNodes.origin, attrs: graphNodes.attrs })
        .from(graphNodes)
        .where(and(eq(graphNodes.projectId, +m[1]!), inArray(graphNodes.origin, ['manifest', 'openapi'])));
      const routes = nodes
        .filter((n) => n.kind === 'route')
        .map((n) => {
          const { method, pattern } = parseRouteNodeKey(n.key);
          return {
            method,
            pattern,
            origin: n.origin,
            responses: (n.attrs as { responses?: number[] } | null)?.responses ?? [],
          };
        });
      const pages = nodes
        .filter((n) => n.kind === 'page')
        .map((n) => ({ pattern: n.key, origin: n.origin, name: (n.attrs as { name?: string } | null)?.name ?? null }));
      return { openApiUrl: null, routes, pages };
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/projects\/(\d+)\/surface\/manifest$/,
    permission: 'run:submit',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const payload = (body ?? {}) as { source?: ManifestSource; manifest?: AppManifest };
      const source: ManifestSource = payload.source ?? 'committed';
      const manifest: AppManifest = payload.manifest ?? {};
      const ingested = await ingestProjectManifest(await getDemoDb(), +m[1]!, manifest, source);
      return {
        success: ingested,
        routes: manifest.routes?.length ?? 0,
        pages: manifest.pages?.length ?? 0,
      };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/probes\/plan$/,
    permission: ['run:submit', 'run:control'],
    handler: async (m, _b, query, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const rawBudget = query?.get('budget');
      const budget = rawBudget != null && Number.isFinite(Number(rawBudget)) ? Number(rawBudget) : DEFAULT_PROBE_BUDGET;
      return buildProbePlan(await getDemoDb(), +m[1]!, { budget });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/(\d+)\/probes\/results$/,
    permission: 'run:submit',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const payload = (body ?? {}) as { runId?: number | null; results?: ProbeResultInput[] };
      const results = Array.isArray(payload.results) ? payload.results : [];
      const runId = typeof payload.runId === 'number' ? payload.runId : null;
      const { recorded } = await recordProbeResults(await getDemoDb(), +m[1]!, runId, results);
      return { success: true, recorded };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/gaps\/inbox$/,
    handler: async () => ({ items: await listAcceptedUnwritten(await getDemoDb(), 'all') }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/flake-lab\/inbox$/,
    handler: async (_m, _b, _q, ctx) => ({
      items: await listFlakeLabInbox(await getDemoDb(), !ctx || ctx.scope === 'all' ? 'all' : [...ctx.scope]),
    }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/gaps\/precision$/,
    handler: async () => {
      const db = await getDemoDb();
      const rows = await db.select({ id: projects.id, name: projects.name }).from(projects);
      const items = [];
      for (const p of rows) {
        const detectors = await loadDetectorPrecision(db, p.id);
        if (detectors.length > 0) items.push({ projectId: p.id, projectName: p.name, detectors });
      }
      return { items };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/gaps\/health$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      return { items: await getMapHealth(await getDemoDb(), +m[1]!) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/gaps\/precision$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      return { items: await loadDetectorPrecision(await getDemoDb(), +m[1]!) };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/(\d+)\/gaps\/(\d+)\/triage$/,
    permission: 'triage:write',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const result = await triageGap(await getDemoDb(), +m[1]!, +m[2]!, (body ?? {}) as any);
      if ('error' in result) {
        if (result.error === 'gap-not-found') throw demoHttpError(404, 'Gap not found');
        throw demoHttpError(400, 'Covering test not found in this project');
      }
      return { success: true, status: result.status };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/(\d+)\/gaps\/(\d+)\/draft$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const draft = await issueScenarioDraft(await getDemoDb(), +m[1]!, +m[2]!, { channel: 'ui' });
      if (!draft) throw demoHttpError(404, 'Gap not found');
      return draft;
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/graph$/,
    handler: async (m, _b, query, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const nodeParam = (query?.get('node') ?? '').trim();
      const sep = nodeParam.indexOf(':');
      if (sep <= 0) throw demoHttpError(400, 'node must be "kind:key"');
      const rawDepth = Number(query?.get('depth'));
      const depth = Number.isFinite(rawDepth) ? Math.min(MAX_GRAPH_DEPTH, Math.max(1, rawDepth)) : 2;
      return getFeatureGraph(
        await getDemoDb(),
        +m[1]!,
        { kind: nodeParam.slice(0, sep), key: nodeParam.slice(sep + 1) },
        depth,
      );
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/feature-map$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      return getFeatureMap(await getDemoDb(), +m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/gaps\/file$/,
    handler: async (m, _b, query, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const path = query?.get('path')?.trim();
      if (!path) throw demoHttpError(400, 'path is required: a repository-relative file path');
      return getFileTestMap(await getDemoDb(), +m[1]!, path);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/gaps$/,
    handler: async (m, _b, query, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const num = (v: string | null | undefined) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      return {
        items: await listScenarioGaps(await getDemoDb(), +m[1]!, {
          kind: query?.get('kind') ?? undefined,
          class: query?.get('class') ?? undefined,
          detector: query?.get('detector') ?? undefined,
          status: query?.get('status') ?? undefined,
          prNumber: num(query?.get('pr')),
          limit: num(query?.get('limit')),
        }),
      };
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/projects\/(\d+)\/selections\/([^/]+)$/,
    permission: 'test-assets:write',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const b = body as { name?: unknown; description?: unknown; definition?: unknown };
      try {
        return await updateSelection(await getDemoDb(), +m[1]!, decodeURIComponent(m[2]!), {
          name: typeof b.name === 'string' ? b.name : undefined,
          description: b.description === undefined ? undefined : b.description === null ? null : String(b.description),
          definition: b.definition === undefined ? undefined : (b.definition as SelectionDefinition),
        });
      } catch (e) {
        if (e instanceof SelectionError) throw demoHttpError(e.statusCode, e.message);
        throw e;
      }
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/projects\/(\d+)\/selections\/([^/]+)$/,
    permission: 'test-assets:write',
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const key = decodeURIComponent(m[2]!);
      if (isBuiltinKey(key)) throw demoHttpError(409, `"${key}" is a built-in selection and cannot be deleted`);
      const result = await deleteSelection(await getDemoDb(), +m[1]!, key);
      if (!result.deleted) throw demoHttpError(404, `No selection "${key}" in this project`);
      return { success: true };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/(\d+)\/selections\/preview$/,
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const b = body as { definition?: unknown; format?: unknown };
      const check = validateSelectionDefinition(b.definition);
      if (!check.valid) throw demoHttpError(400, `Invalid definition: ${check.errors.join('; ')}`);
      const format = (['args', 'grep', 'files', 'json'] as SelectionFormat[]).includes(b.format as SelectionFormat)
        ? (b.format as SelectionFormat)
        : 'args';
      return resolveSelectionDefinition(await getDemoDb(), +m[1]!, b.definition as SelectionDefinition, { format });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/selections\/([^/]+)\/resolve$/,
    handler: async (m, _b, query, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const key = decodeURIComponent(m[2]!);
      const selection = await getSelection(await getDemoDb(), +m[1]!, key);
      if (!selection) throw demoHttpError(404, `No selection "${key}" in this project`);
      const formatParam = query?.get('format');
      const format = (['args', 'grep', 'files', 'json'] as SelectionFormat[]).includes(formatParam as SelectionFormat)
        ? (formatParam as SelectionFormat)
        : 'args';
      const budgetMs = Number(query?.get('budgetMs'));
      let definition: SelectionDefinition = selection.definition;
      if (Number.isFinite(budgetMs) && budgetMs > 0) {
        definition = { ...definition, budget: { ...definition.budget, maxTotalDurationMs: budgetMs } };
      }
      return resolveSelectionDefinition(await getDemoDb(), +m[1]!, definition, {
        key: selection.key,
        version: selection.version,
        format,
        shard: parseShard(query?.get('shard')) ?? undefined,
        order: parseRankBy(query?.get('order')) ?? undefined,
      });
    },
  },

  // Users
  {
    method: 'GET',
    pattern: /^\/api\/users$/,
    permission: ['users:manage', 'project:members'],
    handler: async (_m, _b, _q, ctx) => {
      const db = await getDemoDb();
      // The early check let in an administrator or someone holding project:members on a project.
      const items = demoCan(ctx, 'users:manage') ? await listUserItems(db) : await listUserSummaries(db);
      return { items, authEnabled: true };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/users$/,
    permission: 'users:manage',
    handler: async (_m, body, _q, ctx) => {
      const { username, password, role, name, email, groupIds } = demoBody(createUserSchema, body);
      // Mirrors the server route: scrypt hashing is Node-only, so the demo
      // stores the password as-is, but it is never returned (the response is a
      // projection) and no login flow exists in demo mode.
      const user = await demoAccessCall(async () =>
        createUserAccount(
          await getDemoDb(),
          { username, password: password ?? '', role: requestedInstanceRole(role), name, email, groupIds },
          ctx?.actingUserId ?? null,
        ),
      );
      return { success: true, user };
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/users\/(\d+)$/,
    permission: 'users:manage',
    handler: async (m, _b, _q, ctx) =>
      demoAccessCall(async () =>
        deleteUserAccount(await getDemoDb(), +m[1]!, ctx?.actingUserId ?? null, { guard: Boolean(ctx?.actingUserId) }),
      ),
  },
  {
    method: 'GET',
    pattern: /^\/api\/users\/(\d+)\/api-keys$/,
    handler: async (m, _b, _q, ctx) => {
      assertDemoSelfOrAdmin(ctx, +m[1]!);
      return { items: (await listUserApiKeys(await getDemoDb(), +m[1]!)).apiKeys };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/users\/(\d+)\/api-keys$/,
    handler: (m, body, _q, ctx) => {
      assertDemoSelfOrAdmin(ctx, +m[1]!);
      return apiCreateUserApiKey(+m[1]!, body as Parameters<typeof apiCreateUserApiKey>[1]);
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/users\/(\d+)\/api-keys\/(\d+)$/,
    handler: async (m, _b, _q, ctx) => {
      assertDemoSelfOrAdmin(ctx, +m[1]!);
      try {
        return await deleteUserApiKeyRecord(await getDemoDb(), +m[1]!, +m[2]!);
      } catch (err) {
        if (err instanceof Error && err.message === 'API key not found') throw demoHttpError(404, err.message);
        throw err;
      }
    },
  },

  // A user's own project roles
  {
    method: 'GET',
    pattern: /^\/api\/users\/(\d+)\/projects$/,
    permission: 'users:manage',
    handler: async (m) => {
      const roles = await getUserProjectRoles(await getDemoDb(), +m[1]!);
      if (!roles) throw demoHttpError(404, 'User not found');
      return roles;
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/users\/(\d+)\/projects$/,
    permission: 'users:manage',
    handler: async (m, body, _q, ctx) => {
      const roles = demoBody(userProjectRolesSchema, body);
      const result = await demoAccessCall(async () =>
        setUserProjectRoles(await getDemoDb(), +m[1]!, roles, ctx?.actingUserId ?? null),
      );
      return { success: true, ...result };
    },
  },

  // Groups
  {
    method: 'GET',
    pattern: /^\/api\/groups$/,
    permission: ['groups:manage', 'project:members'],
    handler: async () => ({ groups: await listGroupItems(await getDemoDb()) }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/groups$/,
    permission: 'groups:manage',
    handler: async (_m, body, _q, ctx) => {
      const input = demoBody(groupCreateSchema, body);
      const db = await getDemoDb();
      const group = await demoAccessCall(async () => {
        const created = await createGroup(db, { ...input, createdBy: ctx?.actingUserId ?? null });
        return getGroupView(db, created.id);
      });
      return { success: true, group };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/groups\/(\d+)$/,
    permission: 'groups:manage',
    handler: async (m) => demoAccessCall(async () => getGroupView(await getDemoDb(), +m[1]!)),
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/groups\/(\d+)$/,
    permission: 'groups:manage',
    handler: async (m, body) => {
      const patch = demoBody(groupPatchSchema, body);
      const db = await getDemoDb();
      const group = await demoAccessCall(async () => {
        await updateGroup(db, +m[1]!, patch);
        return getGroupView(db, +m[1]!);
      });
      return { success: true, group };
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/groups\/(\d+)$/,
    permission: 'groups:manage',
    handler: async (m) => {
      await demoAccessCall(async () => deleteGroup(await getDemoDb(), +m[1]!));
      return { success: true };
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/groups\/(\d+)\/members$/,
    permission: 'groups:manage',
    handler: async (m, body, _q, ctx) => {
      const { userIds } = demoBody(groupMembersSchema, body);
      const db = await getDemoDb();
      const group = await demoAccessCall(async () => {
        await setGroupMembers(db, +m[1]!, userIds, ctx?.actingUserId ?? null);
        return getGroupView(db, +m[1]!);
      });
      return { success: true, group };
    },
  },

  // A project's members
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/members$/,
    permission: 'project:members',
    handler: async (m, _b, _q, ctx) => {
      assertDemoScope(ctx, +m[1]!);
      return demoAccessCall(async () =>
        getProjectMembersResponse(await getDemoDb(), +m[1]!, ctx?.access ?? ADMIN_ACCESS),
      );
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/projects\/(\d+)\/members$/,
    permission: 'project:members',
    handler: async (m, body, _q, ctx) => {
      assertDemoScope(ctx, +m[1]!);
      const { entries } = demoBody(projectMembersUpdateSchema, body);
      const db = await getDemoDb();
      await demoAccessCall(() =>
        replaceProjectMembers(db, +m[1]!, entries, {
          userId: ctx?.actingUserId ?? null,
          access: ctx?.access ?? ADMIN_ACCESS,
        }),
      );
      return { success: true, members: await getProjectMemberViews(db, +m[1]!) };
    },
  },

  // The permission grid (every user and group × every project)
  {
    method: 'GET',
    pattern: /^\/api\/project-access$/,
    permission: 'users:manage',
    handler: async () => ({ ...(await getProjectAccessGrid(await getDemoDb())), authEnabled: true }),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/project-access$/,
    permission: 'users:manage',
    handler: async (_m, body, _q, ctx) => {
      const update = demoBody(projectAccessUpdateSchema, body);
      const bindings = await demoAccessCall(async () =>
        setProjectAccessCell(await getDemoDb(), update, ctx?.actingUserId ?? null),
      );
      return { bindings };
    },
  },

  // Entity links
  {
    method: 'GET',
    pattern: /^\/api\/links$/,
    handler: async (_, __, q) => {
      const entityType = q?.get('entityType') ?? '';
      const entityId = parseInt(q?.get('entityId') ?? '0', 10);
      if (!(LINK_ENTITY_TYPES as readonly string[]).includes(entityType) || !entityId) {
        throw demoHttpError(400, 'Invalid entityType or entityId');
      }
      return { items: (await listLinks(await getDemoDb(), entityType as LinkEntityType, entityId)).links };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/links$/,
    permission: 'link:write',
    handler: async (_, body, _q, ctx) => {
      const b = (body ?? {}) as { entityType?: unknown; entityId?: unknown };
      await assertDemoLinkTargetScope(ctx, b.entityType, Number(b.entityId));
      return createLink(await getDemoDb(), body as Parameters<typeof createLink>[1]);
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/links\/(\d+)$/,
    permission: 'link:write',
    handler: async (m, _b, _q, ctx) => {
      await assertDemoLinkScope(ctx, +m[1]!);
      return deleteLink(await getDemoDb(), +m[1]!);
    },
  },

  // Integrations — one canned Jira connection, answered from constants
  {
    method: 'GET',
    pattern: /^\/api\/integrations\/connections$/,
    permission: 'connections:manage',
    handler: async () => listDemoConnections(),
  },
  {
    method: 'POST',
    pattern: /^\/api\/integrations\/connections$/,
    permission: 'connections:manage',
    handler: async (_, body) => createDemoConnection(body as ConnectionInput),
  },
  {
    method: 'GET',
    pattern: /^\/api\/integrations\/connections\/(\d+)$/,
    permission: 'connections:manage',
    handler: async (m) => {
      const found = getDemoConnection(+m[1]!);
      if (!found) throw demoHttpError(404, 'Connection not found');
      return found;
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/integrations\/connections\/(\d+)$/,
    permission: 'connections:manage',
    handler: async (m, body) => updateDemoConnection(+m[1]!, body as Partial<ConnectionInput>),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/integrations\/connections\/(\d+)$/,
    permission: 'connections:manage',
    handler: async () => ({ success: true }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/integrations\/connections\/(\d+)\/test$/,
    permission: 'connections:manage',
    handler: async () => testDemoConnection(),
  },
  {
    method: 'POST',
    pattern: /^\/api\/integrations\/connections\/check$/,
    permission: 'connections:manage',
    handler: async (_, body) => {
      const result = checkDemoConnection(body as { baseUrl?: string });
      if (!result) throw demoHttpError(400, 'Enter the site address, e.g. https://your-team.atlassian.net');
      return result;
    },
  },
  { method: 'GET', pattern: /^\/api\/integrations\/status$/, handler: async () => demoTrackerStatus() },
  {
    method: 'GET',
    pattern: /^\/api\/integrations\/issue-draft$/,
    permission: 'issue:create',
    handler: async (_, __, q, ctx) => {
      const entityType = (q?.get('entityType') ?? '') as 'failure_cluster' | 'test_runs_case';
      const entityId = Number(q?.get('entityId') ?? 0);
      await assertDemoLinkTargetScope(ctx, entityType, entityId);
      const draft = await demoIssueDraft(
        await getDemoDb(),
        entityType,
        entityId,
        toIssueLocale(q?.get('locale')) ?? undefined,
      );
      if (!draft) throw demoHttpError(404, 'No tracker connected or entity unavailable');
      return draft;
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/integrations\/issues$/,
    permission: 'issue:create',
    handler: async (_, body, _q, ctx) => {
      const b = body as {
        entityType: 'failure_cluster' | 'test_runs_case';
        entityId: number;
        title?: string;
        issueType?: string;
        fields?: unknown;
      };
      await assertDemoLinkTargetScope(ctx, b.entityType, b.entityId);
      return demoCreateIssue(await getDemoDb(), b.entityType, b.entityId, b.title, {
        issueType: b.issueType,
        fields: b.fields,
      });
    },
  },
  { method: 'GET', pattern: /^\/api\/integrations\/actions$/, handler: async () => demoIntegrationActions() },
  {
    method: 'POST',
    pattern: /^\/api\/integrations\/sync$/,
    permission: 'connections:manage',
    handler: async () => demoSyncTrackerLinks(),
  },
  {
    method: 'GET',
    pattern: /^\/api\/integrations\/connections\/(\d+)\/projects$/,
    permission: 'issue:create',
    handler: async () => demoConnectionProjects(),
  },
  {
    method: 'GET',
    pattern: /^\/api\/integrations\/connections\/(\d+)\/projects\/([^/]+)\/issue-types$/,
    permission: 'issue:create',
    handler: async () => demoConnectionIssueTypes(),
  },
  {
    method: 'GET',
    pattern: /^\/api\/integrations\/connections\/(\d+)\/projects\/([^/]+)\/issue-types\/([^/]+)\/fields$/,
    permission: 'issue:create',
    handler: async (m) => demoCreateFields(decodeURIComponent(m[3]!)),
  },
  {
    method: 'GET',
    pattern: /^\/api\/integrations\/connections\/(\d+)\/projects\/([^/]+)\/transitions$/,
    permission: ['connections:manage', 'project:manage'],
    handler: async (_m, _body, query) => demoTransitionSample(query?.get('from') === 'done' ? 'done' : 'open'),
  },
  {
    method: 'GET',
    pattern: /^\/api\/integrations\/connections\/(\d+)\/assignable$/,
    permission: 'issue:create',
    handler: async () => demoAssignable(),
  },
  {
    method: 'GET',
    pattern: /^\/api\/integrations\/connections\/(\d+)\/issue-picker$/,
    permission: 'issue:create',
    handler: async (_m, _body, query) => demoIssuePicker(query?.get('q') ?? ''),
  },
  {
    method: 'POST',
    pattern: /^\/api\/integrations\/connections\/(\d+)\/webhook-token$/,
    permission: 'connections:manage',
    handler: async () => generateDemoWebhookToken(),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/integrations\/connections\/(\d+)\/webhook-token$/,
    permission: 'connections:manage',
    handler: async () => disableDemoWebhookToken(),
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/integrations$/,
    permission: 'project:manage',
    handler: async (m, _b, _q, ctx) => {
      assertDemoScope(ctx, +m[1]!);
      return getDemoProjectIntegration();
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/projects\/(\d+)\/integrations$/,
    permission: 'project:manage',
    handler: async (m, body, _q, ctx) => {
      assertDemoScope(ctx, +m[1]!);
      return saveDemoProjectIntegration((body ?? {}) as Partial<ResolvedProjectIntegration>);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/(\d+)\/integrations\/auto-create-preview$/,
    permission: 'project:manage',
    handler: async (m, body, _q, ctx) => {
      assertDemoScope(ctx, +m[1]!);
      return demoAutoCreatePreview(
        await getDemoDb(),
        +m[1]!,
        (body ?? null) as Partial<ResolvedProjectIntegration> | null,
      );
    },
  },

  // Search
  {
    method: 'GET',
    pattern: /^\/api\/search$/,
    handler: async (_, __, q, ctx) => searchProjectsTestRunsCases(await getDemoDb(), q?.get('q') || '', ctx?.scope),
  },

  // Setup status — the same evidence probes as the server, run against the
  // in-browser demo DB, so the Setup page's checklist reflects the seeded data.
  {
    method: 'GET',
    pattern: /^\/api\/setup-status$/,
    permission: 'settings:manage',
    handler: async () => getSetupStatus(await getDemoDb()),
  },

  // Capability states and decisions — the same resolver as the server, over the
  // in-browser DB, so declines persist like everything else in the demo.
  {
    method: 'GET',
    pattern: /^\/api\/capabilities$/,
    handler: async () => getInstanceCapabilities(await getDemoDb()),
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/capabilities$/,
    permission: 'settings:manage',
    handler: async (_, body) => {
      const db = await getDemoDb();
      await setInstanceDecisions(db, (body as { decisions?: Record<string, unknown> })?.decisions ?? {});
      return getInstanceCapabilities(db);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/capabilities$/,
    handler: async (m, _, __, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      return getProjectCapabilities(await getDemoDb(), +m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/bug-reports$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const status = q?.get('status') ?? null;
      return { items: await listBugReports(await getDemoDb(), +m[1]!, { status }) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/bug-reports\/intake$/,
    // The demo has no tracker connection: a send files nowhere, and it keeps no step screenshots.
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      return { tracker: null, projectKey: null, locale: null, canCreate: false, fileEvery: false, stepShots: 0 };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/bug-reports\/(\d+)$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'bugReport', +m[1]!);
      const report = await getBugReport(await getDemoDb(), +m[1]!);
      if (!report) throw demoHttpError(404, 'Bug report not found');
      return report;
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/bug-reports\/(\d+)$/,
    permission: 'bug-report:write',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'bugReport', +m[1]!);
      const parsed = bugReportPatchSchema.safeParse(body);
      if (!parsed.success) throw demoHttpError(400, 'Invalid request body');
      const report = await updateBugReport(await getDemoDb(), +m[1]!, parsed.data);
      if (!report) throw demoHttpError(404, 'Bug report not found');
      return report;
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/bug-reports\/(\d+)\/reproductions$/,
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'bugReport', +m[1]!);
      const parsed = bugReproductionSchema.safeParse(body);
      if (!parsed.success) throw demoHttpError(400, 'Invalid request body');
      const db = await getDemoDb();
      if (!(await isReproductionRunAllowed(db, +m[1]!, parsed.data.runId)))
        throw demoHttpError(400, 'runId is not a run of this bug report’s project');
      return addBugReproduction(db, +m[1]!, parsed.data, null);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/bug-reports\/(\d+)\/missed-by$/,
    // The demo has no CODEOWNERS to read: no owner.
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'bugReport', +m[1]!);
      const missed = await getBugReportMissedBy(await getDemoDb(), +m[1]!);
      if (!missed) throw demoHttpError(404, 'Bug report not found');
      return { ...missed, owner: null };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/bug-reports\/(\d+)\/spec$/,
    handler: async (m, _b, q, ctx) => {
      await assertDemoEntityScope(ctx, 'bugReport', +m[1]!);
      const specDir = specDirSchema.safeParse(q?.get('specDir') ?? undefined);
      if (!specDir.success) throw demoHttpError(400, 'Invalid spec folder');
      const mode = q?.get('mode') === 'run' ? 'run' : 'commit';
      const spec = await renderBugReportSpec(await getDemoDb(), +m[1]!, mode, specDir.data);
      if (!spec) throw demoHttpError(404, 'Bug report not found');
      return {
        mode: spec.mode,
        code: spec.code,
        fileName: spec.fileName,
        path: spec.path,
        warnings: spec.warnings,
        matchedSpans: spec.matchedSpans,
      };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/url-patterns$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      return { items: await listProjectUrlPatterns(await getDemoDb(), +m[1]!) };
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/projects\/(\d+)\/url-patterns$/,
    permission: 'project:manage',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const parsed = urlPatternListSchema.safeParse(body);
      if (!parsed.success) throw demoHttpError(400, 'Invalid request body');
      return {
        items: demoUrlPatternItems(await replaceProjectUrlPatterns(await getDemoDb(), +m[1]!, parsed.data.items)),
      };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/(\d+)\/url-patterns$/,
    permission: 'project:manage',
    handler: async (m, body, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const parsed = urlPatternInputSchema.safeParse(body);
      if (!parsed.success) throw demoHttpError(400, 'Invalid request body');
      return { items: demoUrlPatternItems(await addProjectUrlPattern(await getDemoDb(), +m[1]!, parsed.data)) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/(\d+)\/url-patterns\/suggestions$/,
    handler: async (m, _b, _q, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      return suggestUrlPatterns(await getDemoDb(), +m[1]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/extension\/url-patterns$/,
    handler: async (_m, _b, _q, ctx) => {
      const db = await getDemoDb();
      const scope = ctx?.scope ?? 'all';
      const [items, menu] = await Promise.all([listVisibleUrlPatterns(db, scope), getProjectMenu(db, scope)]);
      return {
        user: null,
        items,
        projects: menu.map((p) => ({
          id: p.id,
          label: p.label || p.name,
          canEdit: demoCan(ctx, 'project:manage', p.id),
        })),
      };
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/projects\/(\d+)\/capabilities$/,
    permission: 'project:manage',
    handler: async (m, body, __, ctx) => {
      await assertDemoEntityScope(ctx, 'project', +m[1]!);
      const db = await getDemoDb();
      await setProjectDecisions(db, +m[1]!, (body as { decisions?: Record<string, unknown> })?.decisions ?? {});
      return getProjectCapabilities(db, +m[1]!);
    },
  },

  // Version — demo runs entirely client-side (sql.js in the browser, no Node
  // server), so `node`/`dbBackend` describe that rather than a real backend.
  // `appVersion`/`buildSha`/`buildTime` are already available via
  // `config.public` in the demo build; this mirrors the server shape for
  // parity with any caller that hits the endpoint directly.
  {
    method: 'GET',
    pattern: /^\/api\/version$/,
    handler: () =>
      Promise.resolve({
        appVersion: null,
        buildSha: null,
        buildTime: null,
        node: 'N/A (browser demo)',
        dbBackend: 'sql.js (in-browser)',
      }),
  },

  // Health — demo runs entirely client-side, so "the database" is always the
  // in-browser sql.js instance; touch it the same way the server's liveness
  // probe does (a lightweight query) so this stays a real check, not a stub.
  {
    method: 'GET',
    pattern: /^\/api\/health$/,
    handler: async () => {
      try {
        const db = await getDemoDb();
        await db.select({ key: appSettings.key }).from(appSettings).limit(1);
      } catch {
        return { status: 'error', database: 'unreachable' };
      }
      return { status: 'ok', database: 'ok' };
    },
  },

  // Admin
  { method: 'GET', pattern: /^\/api\/admin\/stats$/, permission: 'storage:manage', handler: () => apiGetAdminStats() },
  {
    method: 'GET',
    pattern: /^\/api\/admin\/storage$/,
    permission: 'storage:manage',
    handler: () => apiGetStorageAnalysis(),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/admin\/cleanup$/,
    permission: 'storage:manage',
    // Mirror the server response keys (deletedRuns/spaceReclaim) — the storage
    // page reads deletedRuns for its toast; there is nothing to reclaim in a
    // browser demo.
    handler: () =>
      Promise.resolve({ success: true, deletedRuns: 0, keptRunsSkipped: 0, newestRunsSkipped: 0, spaceReclaim: null }),
  },
];

// Auth – demo mode manages state via the useAuth composable; endpoints here
// provide stubs for the non-demo code paths in case auth is enabled alongside demo.
routes.push(
  {
    method: 'GET',
    pattern: /^\/api\/auth\/me$/,
    // Mirrors the server's `authUserView`: the access is read from the in-browser database,
    // so a change made in Settings → Permissions shows here at once.
    handler: async (_, __, ___, ctx) => {
      if (!ctx?.actingUserId) return { authenticated: false, user: null };
      const db = await getDemoDb();
      const [user] = await db.select().from(users).where(eq(users.id, ctx.actingUserId));
      if (!user) return { authenticated: false, user: null };
      return {
        authenticated: true,
        user: {
          id: user.id,
          username: user.username,
          role: ctx.access.instanceRole,
          name: user.name,
          avatarUrl: user.avatarUrl,
          email: user.email,
          emailVerified: user.emailVerified,
          oauthProvider: user.oauthProvider,
          hasPassword: Boolean(user.password),
          access: ctx.access,
        },
      };
    },
  },
  // The demo always ships with seeded users, so first-admin setup never applies.
  {
    method: 'GET',
    pattern: /^\/api\/auth\/setup$/,
    handler: () => Promise.resolve({ needsSetup: false, setupTokenRequired: false }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/auth\/login$/,
    handler: () => Promise.resolve({ success: false, message: 'Login not available in demo mode' }),
  },
  { method: 'POST', pattern: /^\/api\/auth\/logout$/, handler: () => Promise.resolve({ success: true }) },
  // Account management stubs — not functional in demo, return graceful no-ops
  { method: 'POST', pattern: /^\/api\/auth\/forgot-password$/, handler: () => Promise.resolve({ success: true }) },
  { method: 'POST', pattern: /^\/api\/auth\/reset-password$/, handler: () => Promise.resolve({ success: true }) },
  { method: 'POST', pattern: /^\/api\/auth\/change-password$/, handler: () => Promise.resolve({ success: true }) },
  { method: 'POST', pattern: /^\/api\/auth\/send-verify-email$/, handler: () => Promise.resolve({ success: true }) },
  { method: 'GET', pattern: /^\/api\/auth\/verify-email$/, handler: () => Promise.resolve({ success: true }) },
  {
    method: 'POST',
    pattern: /^\/api\/users\/(\d+)\/invite$/,
    permission: 'users:manage',
    handler: () => Promise.resolve({ success: true }),
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/users\/(\d+)$/,
    handler: async (m, body, _q, ctx) => {
      const patch = demoBody(updateUserSchema, body);
      const { user } = await demoAccessCall(async () =>
        updateUserAccount(
          await getDemoDb(),
          +m[1]!,
          patch,
          { userId: ctx?.actingUserId ?? null, access: ctx?.access ?? ADMIN_ACCESS },
          { guardLastAdministrator: Boolean(ctx?.actingUserId) },
        ),
      );
      // The demo has no sessions to revoke: the next request reads the new role.
      return { success: true, user };
    },
  },
);

// SMTP / email — demo has no email capability; return read-only "not configured" status
routes.push(
  {
    method: 'GET',
    pattern: /^\/api\/settings\/smtp$/,
    handler: () =>
      Promise.resolve({
        host: null,
        port: 587,
        user: null,
        from: null,
        fromName: null,
        hasPassword: false,
        secure: false,
        configured: false,
        envManaged: true,
      }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/settings\/smtp\/test$/,
    permission: 'settings:manage',
    handler: () => Promise.resolve({ success: false, error: 'Email not available in demo mode' }),
  },
  {
    method: 'GET',
    pattern: /^\/api\/settings\/wasted-waits$/,
    permission: 'settings:manage',
    handler: () => apiGetWastedWaits(),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/settings\/wasted-waits$/,
    permission: 'settings:manage',
    handler: (_, body) => apiPutWastedWaits(body as Parameters<typeof apiPutWastedWaits>[0]),
  },
  {
    method: 'GET',
    pattern: /^\/api\/settings\/timeout-hygiene$/,
    permission: 'settings:manage',
    handler: () => apiGetTimeoutHygiene(),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/settings\/timeout-hygiene$/,
    permission: 'settings:manage',
    handler: (_, body) => apiPutTimeoutHygiene(body as Parameters<typeof apiPutTimeoutHygiene>[0]),
  },
  {
    method: 'GET',
    pattern: /^\/api\/settings\/ci-cost$/,
    permission: 'settings:manage',
    handler: () => apiGetCiCost(),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/settings\/ci-cost$/,
    permission: 'settings:manage',
    handler: (_, body) => apiPutCiCost(body as Parameters<typeof apiPutCiCost>[0]),
  },
  {
    method: 'GET',
    pattern: /^\/api\/settings\/pr-feedback$/,
    permission: 'settings:manage',
    handler: () => apiGetPrFeedback(),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/settings\/pr-feedback$/,
    permission: 'settings:manage',
    handler: (_, body) => apiPutPrFeedback(body as Parameters<typeof apiPutPrFeedback>[0]),
  },
  {
    method: 'GET',
    pattern: /^\/api\/settings\/auto-heal$/,
    permission: 'settings:manage',
    handler: () => apiGetAutoHeal(),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/settings\/auto-heal$/,
    permission: 'settings:manage',
    handler: (_, body) => apiPutAutoHeal(body as Parameters<typeof apiPutAutoHeal>[0]),
  },
);

// ── Demo notification channels & subscriptions (stateful in-memory) ───────────

interface DemoSubscription {
  id: number;
  userId: number | null;
  channelId: number;
  projectId: number | null;
  events: string[];
  filters: Record<string, unknown> | null;
  mode: string;
  digestAt: string | null;
  mutedUntil: string | null;
  active: boolean;
  channel: { id: number; name: string; type: string };
  createdAt: string;
  updatedAt: string;
}

let _nextSubId = 1;
const _demoSubs: DemoSubscription[] = [];

routes.push(
  // Channels
  {
    method: 'GET',
    pattern: /^\/api\/channels$/,
    handler: () => Promise.resolve({ items: [DEMO_CHANNEL], canStoreSecrets: true }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/channels$/,
    handler: () => Promise.resolve({ success: true, channel: DEMO_CHANNEL }),
  },
  { method: 'DELETE', pattern: /^\/api\/channels\/(\d+)$/, handler: () => Promise.resolve({ success: true }) },
  {
    method: 'POST',
    pattern: /^\/api\/channels\/(\d+)\/test$/,
    handler: () => Promise.resolve({ success: false, error: 'Not available in demo mode' }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/channels\/test$/,
    handler: () => Promise.resolve({ success: false, error: 'Not available in demo mode' }),
  },

  // Subscriptions — stateful within the SW's lifetime
  {
    method: 'GET',
    pattern: /^\/api\/subscriptions$/,
    handler: (_, __, q) => {
      const projectIdParam = q?.get('projectId');
      const filtered =
        projectIdParam != null ? _demoSubs.filter((s) => s.projectId === parseInt(projectIdParam)) : _demoSubs;
      return Promise.resolve({ items: filtered });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/subscriptions$/,
    handler: (_, body) => {
      const b = body as {
        channelId?: number;
        projectId?: number | null;
        events?: string[];
        mode?: string;
        filters?: Record<string, unknown> | null;
        digestAt?: string | null;
      };
      const events = b.events ?? [];
      if (events.length === 0 || events.some((e) => !(NOTIFICATION_EVENTS as readonly string[]).includes(e))) {
        throw demoHttpError(400, 'events must contain at least one valid event');
      }
      const filters = subscriptionFiltersSchema.optional().safeParse(b.filters);
      if (!filters.success) throw demoHttpError(400, 'Invalid request body');
      const mode = b.mode === 'digest' ? 'digest' : 'realtime';
      const digestAt = typeof b.digestAt === 'string' && /^\d{1,2}:\d{2}$/.test(b.digestAt) ? b.digestAt : null;
      const sub: DemoSubscription = {
        id: _nextSubId++,
        userId: null,
        channelId: b.channelId ?? 1,
        projectId: b.projectId ?? null,
        events,
        filters: filters.data ?? null,
        mode,
        digestAt,
        mutedUntil: null,
        active: true,
        channel: { id: DEMO_CHANNEL.id, name: DEMO_CHANNEL.name, type: DEMO_CHANNEL.type },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      _demoSubs.push(sub);
      return Promise.resolve({ success: true, subscription: sub });
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/subscriptions\/(\d+)$/,
    handler: (m, body) => {
      const sub = _demoSubs.find((s) => s.id === parseInt(m[1]!));
      if (!sub) throw demoHttpError(404, 'Subscription not found');
      const b = body as Partial<DemoSubscription>;
      if (b.events) {
        if (b.events.length === 0 || b.events.some((e) => !(NOTIFICATION_EVENTS as readonly string[]).includes(e))) {
          throw demoHttpError(400, 'events must contain at least one valid event');
        }
        sub.events = b.events;
      }
      if (b.mode !== undefined) sub.mode = b.mode === 'digest' ? 'digest' : 'realtime';
      if (b.filters !== undefined) {
        const filters = subscriptionFiltersSchema.nullable().safeParse(b.filters);
        if (!filters.success) throw demoHttpError(400, 'Invalid request body');
        sub.filters = filters.data;
      }
      if (b.digestAt !== undefined) sub.digestAt = b.digestAt;
      if (b.mutedUntil !== undefined) sub.mutedUntil = b.mutedUntil;
      if (b.active !== undefined) sub.active = b.active;
      sub.updatedAt = new Date().toISOString();
      return Promise.resolve({ success: true, subscription: sub });
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/subscriptions\/(\d+)$/,
    handler: (m) => {
      const idx = _demoSubs.findIndex((s) => s.id === parseInt(m[1]!));
      if (idx >= 0) _demoSubs.splice(idx, 1);
      return Promise.resolve({ success: true });
    },
  },
);

// Report schedules and snapshots — stored in the in-browser database; the demo
// has no scheduler, so a schedule never fires by itself.
const demoReportChannels = () => [
  {
    id: DEMO_CHANNEL.id,
    name: DEMO_CHANNEL.name,
    type: DEMO_CHANNEL.type,
    userId: DEMO_CHANNEL.userId,
    address: DEMO_CHANNEL.config.address,
  },
];

routes.push(
  {
    method: 'GET',
    pattern: /^\/api\/reports\/schedules$/,
    permission: 'report:write',
    handler: (_m, _b, _q, ctx) => apiListReportSchedules(demoReportChannels(), demoScope(ctx, 'report:write')),
  },
  {
    method: 'POST',
    pattern: /^\/api\/reports\/schedules$/,
    permission: 'report:write',
    handler: (_m, body, _q, ctx) => apiCreateReportSchedule(body, demoReportChannels(), demoScope(ctx, 'report:write')),
  },
  {
    method: 'POST',
    pattern: /^\/api\/reports\/schedules\/preview$/,
    permission: 'report:write',
    handler: (_m, body, _q, ctx) => apiPreviewReportSchedule(body, demoScope(ctx, 'report:write')),
  },
  {
    method: 'GET',
    pattern: /^\/api\/reports\/schedules\/(\d+)$/,
    permission: 'report:write',
    handler: (m) => apiGetReportSchedule(+m[1]!, demoReportChannels()),
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/reports\/schedules\/(\d+)$/,
    permission: 'report:write',
    handler: (m, body, _q, ctx) =>
      apiUpdateReportSchedule(+m[1]!, body, demoReportChannels(), demoScope(ctx, 'report:write')),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/reports\/schedules\/(\d+)$/,
    permission: 'report:write',
    handler: (m) => apiDeleteReportSchedule(+m[1]!),
  },
  {
    method: 'POST',
    pattern: /^\/api\/reports\/schedules\/(\d+)\/run$/,
    permission: 'report:write',
    handler: (m) => apiRunReportSchedule(+m[1]!),
  },
  {
    method: 'GET',
    pattern: /^\/api\/reports\/snapshots$/,
    handler: (_m, _b, q, ctx) => apiListReportSnapshots(q, ctx?.scope ?? 'all'),
  },
  {
    method: 'POST',
    pattern: /^\/api\/reports\/snapshots$/,
    permission: 'report:write',
    handler: (_m, body, _q, ctx) =>
      apiCreateReportSnapshot(body, demoScope(ctx, 'report:write'), ctx?.actingUserId ?? null),
  },
  {
    method: 'GET',
    pattern: /^\/api\/reports\/snapshots\/(\d+)$/,
    handler: (m, _b, _q, ctx) => apiGetReportSnapshot(+m[1]!, ctx?.scope ?? 'all'),
  },
  {
    method: 'GET',
    pattern: /^\/api\/reports\/snapshots\/(\d+)\/export$/,
    handler: (m, _b, q, ctx) => apiExportReportSnapshot(+m[1]!, q, ctx?.scope ?? 'all'),
  },
);

// Global SSE stream – no-op in demo mode (useRunStream skips it)
routes.push({ method: 'GET', pattern: /^\/api\/stream$/, handler: () => Promise.resolve({ ok: true }) });

// Files – serves the demo's committed binary assets (screenshots, traces,
// videos under public/demo/) plus a graceful "not available" fallback for
// report links that don't exist in demo mode. The pattern must consume the
// whole path: the handler receives the regex match, and `m[0]` is only the
// matched substring.
routes.push({ method: 'GET', pattern: /^\/api\/files\/.+/, handler: (m) => apiGetDemoFile(m[0]) });

// OAuth – demo mode does not support OAuth; redirect to login
const DEMO_LOGIN_REDIRECT = Promise.resolve({ url: '/login', status: 302 });
routes.push(
  { method: 'GET', pattern: /^\/api\/auth\/oauth\/[^/]+\/login$/, handler: () => DEMO_LOGIN_REDIRECT },
  { method: 'GET', pattern: /^\/api\/auth\/oauth\/[^/]+\/callback$/, handler: () => DEMO_LOGIN_REDIRECT },
  {
    method: 'POST',
    pattern: /^\/api\/auth\/oauth\/[^/]+\/unlink$/,
    handler: () => Promise.resolve({ success: true }),
  },
);

/**
 * Attempt to handle a request with the in-browser demo router.
 *
 * Returns `undefined` when no route matches (caller should fall through to
 * the real network).
 */
export async function handleDemoRequest(
  path: string,
  method: HttpMethod = 'GET',
  body?: unknown,
  queryString?: string,
  actingUserId: number | null = null,
): Promise<unknown> {
  const query = queryString ? new URLSearchParams(queryString) : undefined;

  for (const route of routes) {
    if (route.method !== method) continue;
    const m = path.match(route.pattern);
    if (m) {
      const access = await resolveDemoAccess(actingUserId);
      const permission = routePermissionList(route.permission);
      if (!passesEarlyCheck(access, permission)) throw demoHttpError(403, 'Insufficient permissions');
      const ctx: DemoCtx = { access, scope: projectScopeFor(access, 'project:read'), actingUserId, permission };
      return route.handler(m, body, query, ctx);
    }
  }

  // No route matched
  return undefined;
}
