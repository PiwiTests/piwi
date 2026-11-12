/**
 * The per-project binding — how a project's failures reach a tracker: which
 * connection, which tracker project and issue type, the default labels and
 * assignee, the values for the fields the tracker requires, the include
 * toggles, the write-back policies and the runs they follow, the owner routes
 * that file a team's failures into that team's project, and automatic creation.
 *
 * Pure + dependency-free, mirroring `shared/auto-heal.ts`: the code that reads
 * the binding and talks to the tracker lives in `server/utils/integrations/`.
 * The settings endpoint stores a resolved object; `resolveProjectIntegration`
 * clamps and normalizes an arbitrary (possibly untrusted) payload onto the
 * defaults so every reader sees the same shape. The rules behind automatic
 * creation and the run scope live in `./automation`, the owner routes in
 * `./owner-routes`.
 */
import { toIssueLocale, type IssueLocale } from './messages';
import type { IssueIncludeOptions } from './types';
import { normalizeTitlePrefix } from './title-prefix';
import { normalizeFieldValues, TRANSITION_SKIPPED_FIELDS, type FieldValues } from './fields';
import {
  ANY_RUN_SCOPE,
  DEFAULT_AUTO_CREATE,
  resolveAutoCreate,
  resolveRunScope,
  toNoteInterval,
  type AutoCreatePolicy,
  type NoteInterval,
  type TrackerRunScope,
} from './automation';
import type { OwnerRoute } from './owner-routes';
import { resolveTagKeyPatterns } from './tag-keys';

export { normalizeOwner, pickOwnerRoute, type OwnerRoute } from './owner-routes';
export { type AutoCreatePolicy } from './automation';

/**
 * The write-back policies — each off by default, plus the transitions and their
 * field values, and the runs the run-driven ones follow.
 */
export interface ProjectIntegrationPolicies {
  /**
   * The runs whose verdicts write to the ticket: the fix, regression and
   * still-failing comments, the transitions and the description updates. Every
   * run when it names nothing.
   */
  scope: TrackerRunScope;
  /** Comment on the known issue when the cluster's fix is verified. */
  commentOnFix: boolean;
  /** Transition the issue on fix (to `fixTransitionId`). */
  transitionOnFix: boolean;
  /** The transition id (or status name) used when `transitionOnFix` is on. */
  fixTransitionId: string | null;
  /** Values for the fields the fix transition's screen asks for, such as a resolution. */
  fixTransitionFields: FieldValues;
  /** Comment on the known issue when the cluster regresses. */
  commentOnRegression: boolean;
  /** The transition id (or status name) used to reopen the issue on regression. */
  reopenTransitionId: string | null;
  /** Values for the fields the reopen transition's screen asks for. */
  reopenTransitionFields: FieldValues;
  /** Comment when new occurrences land on an open ticket, at most once per `newOccurrencesEvery`. */
  commentOnNewOccurrences: boolean;
  /** The window of the still-failing note: at most one per day, or per week. */
  newOccurrencesEvery: NoteInterval;
  /** New occurrences since the last note before another note is written. */
  newOccurrencesMin: number;
  /** Comment with the diagnosis when one completes for a tracked cluster (needs the diagnosis toggle). */
  commentOnDiagnosis: boolean;
  /**
   * Rewrite the title and description of an issue Piwi filed when its facts
   * change: new occurrences (once a day at most), a completed diagnosis. Never
   * when the description was edited in the tracker.
   */
  updateDescription: boolean;
  /** Resolve the cluster automatically when its ticket moves to Done. */
  resolveOnClose: boolean;
  /** Reopen the cluster when its ticket is reopened while the cluster is resolved. */
  reopenOnTicketReopen: boolean;
  /** Comment on both issues when a cluster is merged into another. */
  commentOnMerge: boolean;
  /** Days a cluster may sit open on the default branch with no ticket before the needs-ticket queue lists it. */
  needsTicketAfterDays: number;
  /** File an issue for every bug report sent to the project, whoever sends it. */
  fileEveryBugReport: boolean;
}

/** The resolved binding the settings endpoint stores and every reader sees. */
export interface ResolvedProjectIntegration {
  /** The tracker connection this binding targets, or null when unbound. */
  connectionId: number | null;
  /** The tracker project key issues are filed into. */
  projectKey: string | null;
  /** The tracker issue type id. */
  issueType: string | null;
  /**
   * The issue types the declared-issue link step links from a key in a test's tags: type ids or names. Null
   * means the binding's own issue type. A key a test names with `piwi:issue` is linked whatever its type.
   */
  declaredIssueTypes: string[] | null;
  /** Labels added to every issue filed under this binding. */
  labels: string[];
  /** The account id issues are assigned to by default. */
  defaultAssignee: string | null;
  /**
   * Values for tracker fields, keyed by field id — typically the fields the
   * project's create screen requires and Piwi does not fill. A create request's
   * own values override them; a value for a field the screen lacks is not sent.
   */
  fieldDefaults: FieldValues;
  /** The ticket language, or null to inherit the connection's default. */
  locale: IssueLocale | null;
  /** The prefix put before every ticket title, or null to inherit the connection's default. */
  titlePrefix: string | null;
  /** What a ticket body carries. */
  include: IssueIncludeOptions;
  /** The write-back policies. */
  policies: ProjectIntegrationPolicies;
  /** Owner → tracker routes, in priority order. */
  ownerRoutes: OwnerRoute[];
  /** Automatic creation: its rules and guards. */
  autoCreate: AutoCreatePolicy;
}

export const DEFAULT_INCLUDE: IssueIncludeOptions = {
  includeDiagnosis: true,
  includePatch: true,
  includeScreenshot: false,
  includeShareLink: false,
};

export const DEFAULT_POLICIES: ProjectIntegrationPolicies = {
  scope: ANY_RUN_SCOPE,
  commentOnFix: false,
  transitionOnFix: false,
  fixTransitionId: null,
  fixTransitionFields: {},
  commentOnRegression: false,
  reopenTransitionId: null,
  reopenTransitionFields: {},
  commentOnNewOccurrences: false,
  newOccurrencesEvery: 'day',
  newOccurrencesMin: 1,
  commentOnDiagnosis: false,
  updateDescription: false,
  resolveOnClose: false,
  reopenOnTicketReopen: false,
  commentOnMerge: false,
  needsTicketAfterDays: 2,
  fileEveryBugReport: false,
};

export const DEFAULT_PROJECT_INTEGRATION: ResolvedProjectIntegration = {
  connectionId: null,
  projectKey: null,
  issueType: null,
  declaredIssueTypes: null,
  labels: [],
  defaultAssignee: null,
  fieldDefaults: {},
  locale: null,
  titlePrefix: null,
  include: DEFAULT_INCLUDE,
  policies: DEFAULT_POLICIES,
  ownerRoutes: [],
  autoCreate: DEFAULT_AUTO_CREATE,
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Trim, drop empties, cap length and dedupe a label list. */
function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const cleaned = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => v.slice(0, 100));
  return [...new Set(cleaned)].slice(0, 50);
}

/** The issue types of the tag source: trimmed and deduplicated; null when the input is not a list or names none. */
function normalizeIssueTypes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const cleaned = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().slice(0, 100))
    .filter(Boolean);
  return cleaned.length > 0 ? [...new Set(cleaned)].slice(0, 50) : null;
}

function trimOrNull(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function normalizeOwnerRoute(raw: unknown): OwnerRoute | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const owner = trimOrNull(r.owner);
  if (!owner) return null;
  return {
    owner,
    projectKey: trimOrNull(r.projectKey),
    componentId: trimOrNull(r.componentId),
    assigneeAccountId: trimOrNull(r.assigneeAccountId),
    labels: normalizeLabels(r.labels),
  };
}

function resolveInclude(raw: unknown): IssueIncludeOptions {
  const r = (raw ?? {}) as Partial<IssueIncludeOptions>;
  return {
    includeDiagnosis: r.includeDiagnosis !== false,
    includePatch: r.includePatch !== false,
    includeScreenshot: r.includeScreenshot === true,
    includeShareLink: r.includeShareLink === true,
  };
}

function resolvePolicies(raw: unknown): ProjectIntegrationPolicies {
  const r = (raw ?? {}) as Partial<Record<keyof ProjectIntegrationPolicies, unknown>>;
  return {
    scope: resolveRunScope(r.scope),
    commentOnFix: r.commentOnFix === true,
    transitionOnFix: r.transitionOnFix === true,
    fixTransitionId: trimOrNull(r.fixTransitionId, 100),
    fixTransitionFields: normalizeFieldValues(r.fixTransitionFields, TRANSITION_SKIPPED_FIELDS),
    commentOnRegression: r.commentOnRegression === true,
    reopenTransitionId: trimOrNull(r.reopenTransitionId, 100),
    reopenTransitionFields: normalizeFieldValues(r.reopenTransitionFields, TRANSITION_SKIPPED_FIELDS),
    commentOnNewOccurrences: r.commentOnNewOccurrences === true,
    newOccurrencesEvery: toNoteInterval(r.newOccurrencesEvery),
    newOccurrencesMin: clampInt(r.newOccurrencesMin, 1, 1000, DEFAULT_POLICIES.newOccurrencesMin),
    commentOnDiagnosis: r.commentOnDiagnosis === true,
    updateDescription: r.updateDescription === true,
    resolveOnClose: r.resolveOnClose === true,
    reopenOnTicketReopen: r.reopenOnTicketReopen === true,
    commentOnMerge: r.commentOnMerge === true,
    needsTicketAfterDays: clampInt(r.needsTicketAfterDays, 0, 365, DEFAULT_POLICIES.needsTicketAfterDays),
    fileEveryBugReport: r.fileEveryBugReport === true,
  };
}

/** Merge a partial (possibly untrusted) payload onto the defaults. */
export function resolveProjectIntegration(
  input?: Partial<ResolvedProjectIntegration> | null,
): ResolvedProjectIntegration {
  const connectionId =
    typeof input?.connectionId === 'number' && Number.isInteger(input.connectionId) && input.connectionId > 0
      ? input.connectionId
      : null;
  const ownerRoutes = Array.isArray(input?.ownerRoutes)
    ? input!.ownerRoutes.map(normalizeOwnerRoute).filter((r): r is OwnerRoute => r != null)
    : [];
  return {
    connectionId,
    projectKey: trimOrNull(input?.projectKey, 100),
    issueType: trimOrNull(input?.issueType, 100),
    declaredIssueTypes: normalizeIssueTypes(input?.declaredIssueTypes),
    labels: normalizeLabels(input?.labels),
    defaultAssignee: trimOrNull(input?.defaultAssignee),
    fieldDefaults: normalizeFieldValues(input?.fieldDefaults),
    locale: toIssueLocale(input?.locale),
    titlePrefix: normalizeTitlePrefix(input?.titlePrefix),
    include: resolveInclude(input?.include),
    policies: resolvePolicies(input?.policies),
    ownerRoutes,
    autoCreate: resolveAutoCreate(input?.autoCreate),
  };
}

/**
 * What the declared-issue link step reads from a test's tags: the project's issue key pattern (`tagKeys`) and the
 * issue types it links, which are the binding's `declaredIssueTypes`, else its issue type. With no pattern or no
 * issue type to link, the tag source links nothing.
 */
export function resolveTagSource(
  tagKeys: unknown,
  binding: Pick<ResolvedProjectIntegration, 'issueType' | 'declaredIssueTypes'>,
): { pattern: string | null; issueTypes: string[] } {
  const pattern = resolveTagKeyPatterns(tagKeys).issue;
  const issueTypes = binding.declaredIssueTypes?.length
    ? binding.declaredIssueTypes
    : binding.issueType
      ? [binding.issueType]
      : [];
  return { pattern, issueTypes };
}
