import { and, eq, isNotNull } from 'drizzle-orm';
import type {
  ConnectionCheckResult,
  CreateIssueResponse,
  ConnectionInput,
  ConnectionSummary,
  ConnectionTestResult,
  ExistingIssueCandidate,
  IssueDraft,
  IssueEntityType,
  TrackerIssueOption,
  TrackerUserOption,
  TestManagementConnectionSummary,
  TrackerSummary,
} from '#shared/integrations/types';
import { foldText } from '#shared/utils/fold-text';
import { connectionBaseUrl, credentialFieldError, nonSecretCredentials } from '#shared/integrations/registry';
import { normalizeJiraSiteUrl } from '#shared/integrations/jira-setup';
import {
  DEMO_TEST_MANAGEMENT_CONNECTION,
  DEMO_TEST_MANAGEMENT_CONNECTION_ID,
} from '#shared/demo/demo-test-management.mjs';
import { demoHttpError } from './http-error';
import {
  missingFieldsMessage,
  missingRequiredFields,
  normalizeFieldValues,
  type TrackerField,
} from '#shared/integrations/fields';
import type { TransitionSample } from '#shared/integrations/transitions';
import { renderMarkdown } from '#shared/integrations/render-markdown';
import { DEFAULT_LOCALE, type IssueLocale } from '#shared/integrations/messages';
import { resolveProjectIntegration, type ResolvedProjectIntegration } from '#shared/integrations/binding';
import { previewAutoCreate, type AutoCreatePreview } from '#shared/handlers/tracker-automation';
import { projectDefaultBranch } from '~~/server/utils/scm/stored-default-branch';
import {
  buildBugReportIssue,
  buildClusterIssue,
  buildExecutionIssue,
  buildRunIssue,
  buildStandaloneExecutionIssue,
} from '~~/server/utils/integrations/documents';
import { normalizeIssueComment, type IssueComment } from '#shared/integrations/run-issue';
import { entityLinks, projects, testRuns, testRunsCases } from '~~/server/database/schema';
import { isEligibleRun } from '#shared/run-eligibility';
import { linkNamedIssues, type DeclaredLinksResult } from '#shared/handlers/declared-issues';
import { DEMO_JIRA_ISSUES } from '#shared/demo/demo-test-meta.mjs';
import type { DrizzleDB } from '#shared/handlers/db';
import type { TrackerIssueBatch, TrackerStatusCategory } from '~~/server/utils/integrations/types';

/**
 * The demo has no server to reach Jira or Zephyr Scale, so it ships one canned connection of each and answers the
 * connection endpoints from constants. Nothing calls out.
 */
const DEMO_TIME = '2024-01-01T00:00:00.000Z';

const DEMO_CONNECTION: ConnectionSummary = {
  id: 1,
  provider: 'jira',
  name: 'DEMO',
  baseUrl: 'https://demo.atlassian.net',
  config: { flavor: 'cloud' },
  status: 'ok',
  lastCheckedAt: DEMO_TIME,
  lastError: null,
  managedBy: 'db',
  hasCredentials: true,
  credentialValues: { email: 'demo@example.com' },
  hasWebhookToken: false,
  createdAt: DEMO_TIME,
  updatedAt: DEMO_TIME,
};

/** The canned Zephyr Scale connection, on the US region as the server would save it. */
const DEMO_ZEPHYR_CONNECTION: ConnectionSummary = {
  id: DEMO_TEST_MANAGEMENT_CONNECTION_ID,
  ...DEMO_TEST_MANAGEMENT_CONNECTION,
  provider: 'zephyr-scale',
  status: 'ok',
  lastCheckedAt: DEMO_TIME,
  lastError: null,
  managedBy: 'db',
  hasCredentials: true,
  credentialValues: {},
  hasWebhookToken: false,
  createdAt: DEMO_TIME,
  updatedAt: DEMO_TIME,
};

/** Whether the canned connection's inbound webhook is on, for as long as the service worker runs. */
let demoWebhookEnabled = false;

function demoConnection(): ConnectionSummary {
  return { ...DEMO_CONNECTION, hasWebhookToken: demoWebhookEnabled };
}

export function listDemoConnections(): { connections: ConnectionSummary[]; canStoreSecrets: boolean } {
  return { connections: [demoConnection(), DEMO_ZEPHYR_CONNECTION], canStoreSecrets: true };
}

/** The test management connections the demo's binding form offers: the canned Zephyr Scale connection. */
export function listDemoTestManagementConnections(): TestManagementConnectionSummary[] {
  const { id, provider, name, status } = DEMO_ZEPHYR_CONNECTION;
  return [{ id, provider, name, status }];
}

export function getDemoConnection(id: number): { connection: ConnectionSummary } | null {
  if (id === DEMO_ZEPHYR_CONNECTION.id) return { connection: DEMO_ZEPHYR_CONNECTION };
  return id === DEMO_CONNECTION.id ? { connection: demoConnection() } : null;
}

/**
 * The base URL a connection is saved with, and its region, as the server sets them: the typed address, or the chosen
 * region's host. Refuses a select credential field set to none of its options.
 */
function demoConnectionEndpoint(
  provider: string,
  body: { baseUrl?: string; region?: string; credentials?: Record<string, string> | null },
): { baseUrl: string; region?: string } {
  const endpoint = connectionBaseUrl(provider, body);
  if ('error' in endpoint) throw demoHttpError(400, endpoint.error);
  const fieldError = credentialFieldError(provider, body.credentials);
  if (fieldError) throw demoHttpError(400, fieldError);
  return endpoint;
}

export function createDemoConnection(body: Omit<ConnectionInput, 'baseUrl'> & { baseUrl?: string; region?: string }): {
  connection: ConnectionSummary;
} {
  const endpoint = demoConnectionEndpoint(body.provider, body);
  return {
    connection: {
      ...DEMO_CONNECTION,
      id: 2,
      provider: body.provider,
      name: body.name,
      baseUrl: endpoint.baseUrl,
      config: endpoint.region ? { ...body.config, region: endpoint.region } : (body.config ?? { flavor: 'cloud' }),
      status: 'unverified',
      hasCredentials: !!body.credentials && Object.keys(body.credentials).length > 0,
      credentialValues: nonSecretCredentials(body.provider, body.credentials),
    },
  };
}

export function updateDemoConnection(
  id: number,
  body: Partial<ConnectionInput> & { region?: string },
): { connection: ConnectionSummary } {
  if (id === DEMO_ZEPHYR_CONNECTION.id) {
    // A region provider is moved by its region only, and keeps its region when none is sent.
    const endpoint = body.region !== undefined ? demoConnectionEndpoint('zephyr-scale', body) : null;
    return {
      connection: {
        ...DEMO_ZEPHYR_CONNECTION,
        name: body.name ?? DEMO_ZEPHYR_CONNECTION.name,
        ...(endpoint ? { baseUrl: endpoint.baseUrl, config: { region: endpoint.region } } : {}),
      },
    };
  }
  // Jira is moved by a typed address only.
  const baseUrl =
    body.baseUrl !== undefined
      ? demoConnectionEndpoint(DEMO_CONNECTION.provider, body).baseUrl
      : DEMO_CONNECTION.baseUrl;
  return {
    connection: {
      ...DEMO_CONNECTION,
      id,
      name: body.name ?? DEMO_CONNECTION.name,
      baseUrl,
      // Mirror the server's merge: submitted non-secret fields override the stored ones.
      credentialValues: { ...DEMO_CONNECTION.credentialValues, ...nonSecretCredentials('jira', body.credentials) },
    },
  };
}

export function testDemoConnection(id?: number): ConnectionTestResult {
  if (id === DEMO_ZEPHYR_CONNECTION.id) {
    return { ok: true, account: { id: 'zephyr-scale:us', displayName: 'Zephyr Scale Cloud (United States)' } };
  }
  return { ok: true, account: { id: 'demo-account', displayName: 'Demo User' }, tokenKind: 'classic' };
}

/**
 * The pre-save check in the demo: the address is read the way the server reads
 * it, but the demo runs in the browser and never calls out, so the site is
 * reported unreachable. Null when the address is not a URL.
 */
export function checkDemoConnection(body: {
  provider?: string;
  baseUrl?: string;
  region?: string;
}): ConnectionCheckResult | null {
  if (body.provider === 'zephyr-scale') return checkDemoRegionConnection(body);
  const site = normalizeJiraSiteUrl(body.baseUrl ?? '');
  if (!site) return null;
  return {
    baseUrl: site.url,
    site: {
      ok: false,
      reachable: false,
      deploymentType: null,
      title: null,
      reportedUrl: null,
      cloudId: null,
      error: 'The demo runs in your browser and does not contact Jira.',
      hint: null,
    },
  };
}

/** The check of a region provider: answers as if the token signed in, with canned projects. */
function checkDemoRegionConnection(body: { region?: string }): ConnectionCheckResult {
  const endpoint = demoConnectionEndpoint('zephyr-scale', body);
  return {
    baseUrl: endpoint.baseUrl,
    site: {
      ok: true,
      reachable: true,
      deploymentType: null,
      title: null,
      reportedUrl: null,
      cloudId: null,
    },
    auth: { ok: true, account: { id: `zephyr-scale:${endpoint.region}`, displayName: 'Zephyr Scale Cloud' } },
    projects: { ok: true, count: 3, keys: ['DEMO', 'WEB', 'API'] },
  };
}

// ── Create-issue flow (in-browser, never calls out) ──────────────────────────

const DEMO_PROJECT_KEY = 'DEMO';
const DEMO_ISSUE_TYPE = 'Bug';

/** The canned connection as the tracker pickers list it. */
const DEMO_TRACKER: TrackerSummary = {
  id: DEMO_CONNECTION.id,
  provider: 'jira',
  name: DEMO_CONNECTION.name,
  baseUrl: DEMO_CONNECTION.baseUrl,
  titlePrefix: null,
};

export function demoTrackerStatus(): { trackers: TrackerSummary[] } {
  return { trackers: [DEMO_TRACKER] };
}

/** The cluster an entity belongs to (itself for a cluster, its cluster for an execution, none for a bug report). */
async function resolveClusterId(db: DrizzleDB, entityType: IssueEntityType, entityId: number): Promise<number | null> {
  if (entityType === 'failure_cluster') return entityId;
  if (entityType === 'bug_report' || entityType === 'test_run') return null;
  const [row] = await db
    .select({ clusterId: testRunsCases.failureClusterId })
    .from(testRunsCases)
    .where(eq(testRunsCases.id, entityId));
  return row?.clusterId ?? null;
}

/** Jira-shaped links already pinned to the cluster or the bug report, as dedupe candidates. */
async function demoExisting(
  db: DrizzleDB,
  target: { clusterId: number } | { bugReportId: number } | { testRunId: number } | { testRunsCaseId: number },
): Promise<ExistingIssueCandidate[]> {
  const pinnedTo =
    'clusterId' in target
      ? eq(entityLinks.failureClusterId, target.clusterId)
      : 'bugReportId' in target
        ? eq(entityLinks.bugReportId, target.bugReportId)
        : 'testRunId' in target
          ? eq(entityLinks.testRunId, target.testRunId)
          : eq(entityLinks.testRunsCaseId, target.testRunsCaseId);
  const links = await db
    .select()
    .from(entityLinks)
    .where(and(pinnedTo, isNotNull(entityLinks.key)));
  return links
    .filter((l) => l.provider === 'jira')
    .map((l) => ({
      key: l.key ?? '',
      url: l.url,
      title: l.title ?? null,
      statusText: l.statusText ?? null,
      statusColor: l.statusColor ?? null,
      reason: 'linked' as const,
    }));
}

/** The prefix the demo's canned binding puts before every ticket title. */
function demoTitlePrefix(): string | null {
  return getDemoProjectIntegration().titlePrefix;
}

/** The draft fields every entity shares: the canned binding, and nothing that links back. */
function demoDraftBase(locale: IssueLocale) {
  const binding = getDemoProjectIntegration();
  return {
    projectBound: true,
    // The static demo has no public address to link back to.
    linksBack: false,
    connectionId: binding.connectionId,
    projectKey: DEMO_PROJECT_KEY,
    issueType: DEMO_ISSUE_TYPE,
    assignee: null,
    locale,
    fieldValues: binding.fieldDefaults,
    include: { includeDiagnosis: true, includePatch: true, includeScreenshot: false, includeShareLink: false },
  };
}

/** The draft for a bug report, as the server builds it: its own document and labels, no cluster. */
async function demoBugReportDraft(
  db: DrizzleDB,
  bugReportId: number,
  locale: IssueLocale,
  filedBy: string | null,
): Promise<IssueDraft | null> {
  const built = await buildBugReportIssue(db, bugReportId, { locale, filedBy, titlePrefix: demoTitlePrefix() });
  if (!built) return null;
  return {
    ...demoDraftBase(locale),
    entityType: 'bug_report',
    entityId: bugReportId,
    clusterId: null,
    projectId: built.projectId,
    title: built.title,
    labels: [...new Set([...getDemoProjectIntegration().labels, ...built.labels])],
    markdown: renderMarkdown(built.document),
    document: built.document,
    existing: await demoExisting(db, { bugReportId }),
  };
}

/** The issue of a run, or of an execution with no failure cluster, as the server builds it. */
function demoRunIssue(
  db: DrizzleDB,
  entityType: IssueEntityType,
  entityId: number,
  rawOpts: { locale?: IssueLocale; comment?: IssueComment | null; filedBy?: string | null },
) {
  const opts = { ...rawOpts, titlePrefix: demoTitlePrefix() };
  return entityType === 'test_run'
    ? buildRunIssue(db, entityId, opts)
    : buildStandaloneExecutionIssue(db, entityId, opts);
}

/** The draft for a run, or for an execution with no failure cluster: the issues linked to it never stop a new one. */
async function demoRunDraft(
  db: DrizzleDB,
  entityType: IssueEntityType,
  entityId: number,
  locale: IssueLocale,
  filedBy: string | null,
): Promise<IssueDraft | null> {
  const built = await demoRunIssue(db, entityType, entityId, { locale, filedBy });
  if (!built) return null;
  return {
    ...demoDraftBase(locale),
    entityType,
    entityId,
    clusterId: null,
    projectId: built.projectId,
    title: built.title,
    labels: [...new Set([...getDemoProjectIntegration().labels, ...built.labels])],
    markdown: renderMarkdown(built.document),
    document: built.document,
    existing: await demoExisting(
      db,
      entityType === 'test_run' ? { testRunId: entityId } : { testRunsCaseId: entityId },
    ),
  };
}

export async function demoIssueDraft(
  db: DrizzleDB,
  entityType: IssueEntityType,
  entityId: number,
  locale: IssueLocale = DEFAULT_LOCALE,
  filedBy: string | null = null,
): Promise<IssueDraft | null> {
  const draft = await demoIssueDraftFor(db, entityType, entityId, locale, filedBy);
  return draft ? { ...draft, filedBy } : null;
}

async function demoIssueDraftFor(
  db: DrizzleDB,
  entityType: IssueEntityType,
  entityId: number,
  locale: IssueLocale,
  filedBy: string | null,
): Promise<IssueDraft | null> {
  if (entityType === 'bug_report') return demoBugReportDraft(db, entityId, locale, filedBy);
  if (entityType === 'test_run') return demoRunDraft(db, entityType, entityId, locale, filedBy);
  const clusterId = await resolveClusterId(db, entityType, entityId);
  if (clusterId == null) {
    return entityType === 'test_runs_case' ? demoRunDraft(db, entityType, entityId, locale, filedBy) : null;
  }
  const buildOpts = { locale, filedBy, titlePrefix: demoTitlePrefix() };
  const built =
    entityType === 'failure_cluster'
      ? await buildClusterIssue(db, entityId, buildOpts)
      : await buildExecutionIssue(db, entityId, buildOpts);
  if (!built) return null;
  return {
    ...demoDraftBase(locale),
    entityType,
    entityId,
    clusterId,
    projectId: built.projectId,
    title: built.title,
    labels: built.labels,
    markdown: renderMarkdown(built.document),
    document: built.document,
    existing: await demoExisting(db, { clusterId }),
  };
}

/**
 * File a DEMO-<n> issue and write its link into the in-browser DB (on the
 * cluster, or on the bug report) — or, like the server, refuse before filing
 * when the issue type's required fields are still empty. Null when the bug
 * report is gone.
 */
export async function demoCreateIssue(
  db: DrizzleDB,
  entityType: IssueEntityType,
  entityId: number,
  title?: string | null,
  request: {
    issueType?: string;
    fields?: unknown;
    comment?: string | null;
    filedBy?: string | null;
    filedById?: number | null;
    submissionId?: string | null;
  } = {},
): Promise<CreateIssueResponse | null> {
  const values = { ...getDemoProjectIntegration().fieldDefaults, ...normalizeFieldValues(request.fields) };
  const missing = missingRequiredFields(demoCreateFields(request.issueType ?? DEMO_ISSUE_TYPE).fields, values);
  if (missing.length) {
    return {
      actionId: null,
      status: 'failed',
      error: missingFieldsMessage(missing),
      missingFields: missing.map((f) => ({ id: f.id, name: f.name })),
    };
  }

  const commentText = normalizeIssueComment(request.comment);
  const comment = commentText ? { text: commentText, author: request.filedBy ?? null } : null;

  // A run, and an execution with no failure cluster, get one issue per submission.
  const clusterId = await resolveClusterId(db, entityType, entityId);
  if (entityType === 'test_run' || (entityType === 'test_runs_case' && clusterId == null)) {
    const submission = request.submissionId ? `${entityType}:${entityId}:${request.submissionId}` : null;
    const sent = submission ? DEMO_SUBMISSIONS.get(submission) : undefined;
    if (sent) return { ...sent, submissionFiled: true };
    const built = await demoRunIssue(db, entityType, entityId, { comment, filedBy: request.filedBy ?? null });
    if (!built) return null;
    const filed = await insertDemoIssueLink(
      db,
      entityType === 'test_run' ? { testRunId: entityId } : { testRunsCaseId: entityId },
      title?.trim() || built.title,
      request.filedById ?? null,
    );
    if (submission) DEMO_SUBMISSIONS.set(submission, filed);
    return filed;
  }

  // A bug report's issue is linked to the report; a failure's to its cluster,
  // which the cluster and its executions share while the link is there.
  let linkTarget: { failureClusterId: number } | { bugReportId: number };
  let built: { title: string } | null;
  if (entityType === 'bug_report') {
    built = await buildBugReportIssue(db, entityId, {
      filedBy: request.filedBy ?? null,
      titlePrefix: demoTitlePrefix(),
    });
    if (!built) return null;
    linkTarget = { bugReportId: entityId };
  } else {
    linkTarget = { failureClusterId: clusterId ?? entityId };
    const buildOpts = { filedBy: request.filedBy ?? null, titlePrefix: demoTitlePrefix() };
    built =
      entityType === 'failure_cluster'
        ? await buildClusterIssue(db, entityId, buildOpts)
        : await buildExecutionIssue(db, entityId, buildOpts);
  }

  const [filed] = await db
    .select()
    .from(entityLinks)
    .where(
      and(
        'bugReportId' in linkTarget
          ? eq(entityLinks.bugReportId, linkTarget.bugReportId)
          : eq(entityLinks.failureClusterId, linkTarget.failureClusterId),
        eq(entityLinks.origin, 'created'),
      ),
    );
  if (filed?.key) {
    // Like the server, the comment goes to the issue already filed.
    return {
      actionId: filed.id,
      status: 'done',
      key: filed.key,
      url: filed.url,
      alreadyFiled: true,
      ...(comment ? { commentStatus: 'added' as const } : {}),
    };
  }

  return insertDemoIssueLink(db, linkTarget, title?.trim() || built?.title || null, request.filedById ?? null);
}

/** What each submission of the create dialog filed in the demo, so sending it again files nothing new. */
const DEMO_SUBMISSIONS = new Map<string, CreateIssueResponse>();

/** File a DEMO-<n> issue: its link on the entity, as a created one. */
async function insertDemoIssueLink(
  db: DrizzleDB,
  linkTarget:
    | { failureClusterId: number }
    | { bugReportId: number }
    | { testRunId: number }
    | { testRunsCaseId: number },
  title: string | null,
  createdBy: number | null,
): Promise<CreateIssueResponse> {
  const existing = await db.select().from(entityLinks).where(isNotNull(entityLinks.key));
  const n = 100 + existing.filter((l) => l.provider === 'jira').length + 1;
  const key = `${DEMO_PROJECT_KEY}-${n}`;
  const url = `${DEMO_CONNECTION.baseUrl}/browse/${key}`;

  const [row] = await db
    .insert(entityLinks)
    .values({
      ...linkTarget,
      url,
      provider: 'jira',
      key,
      title: title || key,
      statusText: 'To Do',
      statusColor: 'info',
      connectionId: DEMO_CONNECTION.id,
      externalId: String(10000 + n),
      origin: 'created',
      createdBy,
      unfurledAt: new Date(),
    })
    .returning({ id: entityLinks.id });

  return { actionId: row?.id ?? n, status: 'done', key, url };
}

export function demoIntegrationActions(): { actions: [] } {
  return { actions: [] };
}

export function demoConnectionProjects(): { projects: { id: string; key: string; name: string }[] } {
  return { projects: [{ id: '1', key: DEMO_PROJECT_KEY, name: 'Demo project' }] };
}

export function demoConnectionIssueTypes(): { issueTypes: { id: string; name: string }[] } {
  return {
    issueTypes: [
      { id: '1', name: 'Bug' },
      { id: '2', name: 'Task' },
    ],
  };
}

/**
 * The demo project's create screen: a Bug requires a Severity (a pick-list Jira
 * would list), components are optional, and Jira defaults the priority — enough
 * to show the required-field flow without a Jira.
 */
const DEMO_BUG_FIELDS: TrackerField[] = [
  {
    id: 'project',
    name: 'Project',
    required: true,
    hasDefault: false,
    kind: 'raw',
    options: null,
    typeName: 'project',
  },
  {
    id: 'issuetype',
    name: 'Issue type',
    required: true,
    hasDefault: false,
    kind: 'raw',
    options: null,
    typeName: 'issuetype',
  },
  {
    id: 'summary',
    name: 'Summary',
    required: true,
    hasDefault: false,
    kind: 'string',
    options: null,
    typeName: 'summary',
  },
  {
    id: 'description',
    name: 'Description',
    required: false,
    hasDefault: false,
    kind: 'text',
    options: null,
    typeName: 'description',
  },
  {
    id: 'customfield_10050',
    name: 'Severity',
    required: true,
    hasDefault: false,
    kind: 'option',
    options: [
      { id: '10100', label: 'Critical' },
      { id: '10101', label: 'Major' },
      { id: '10102', label: 'Minor' },
    ],
    typeName: 'select',
  },
  {
    id: 'parent',
    name: 'Parent',
    required: false,
    hasDefault: false,
    kind: 'issue',
    options: null,
    typeName: 'parent',
  },
  {
    id: 'components',
    name: 'Components',
    required: false,
    hasDefault: false,
    kind: 'option-array',
    options: [
      { id: '10200', label: 'Checkout' },
      { id: '10201', label: 'Payments' },
      { id: '10202', label: 'Web' },
    ],
    typeName: 'components',
  },
  {
    id: 'priority',
    name: 'Priority',
    required: false,
    hasDefault: true,
    kind: 'option',
    options: [
      { id: '2', label: 'High' },
      { id: '3', label: 'Medium' },
      { id: '4', label: 'Low' },
    ],
    typeName: 'priority',
  },
];

/** The create screen's fields for a demo issue type (by id or name): the Bug asks for a Severity. */
export function demoCreateFields(issueType: string): { fields: TrackerField[] } {
  const isBug = issueType === '1' || issueType.toLowerCase() === DEMO_ISSUE_TYPE.toLowerCase();
  return { fields: isBug ? DEMO_BUG_FIELDS : DEMO_BUG_FIELDS.filter((f) => f.id !== 'customfield_10050') };
}

/**
 * The transitions a demo issue offers: an open one moves to Done through a
 * screen that asks for a Resolution, a done one reopens with no screen.
 */
export function demoTransitionSample(from: 'open' | 'done'): TransitionSample {
  if (from === 'done') {
    return {
      issue: { key: 'DEMO-2', status: 'Done' },
      transitions: [{ id: '11', name: 'Reopen', toStatus: 'To Do', toStatusCategory: 'new', fields: [] }],
    };
  }
  return {
    issue: { key: 'DEMO-1', status: 'To Do' },
    transitions: [
      { id: '21', name: 'Start progress', toStatus: 'In Progress', toStatusCategory: 'indeterminate', fields: [] },
      {
        id: '31',
        name: 'Done',
        toStatus: 'Done',
        toStatusCategory: 'done',
        fields: [
          {
            id: 'resolution',
            name: 'Resolution',
            required: true,
            hasDefault: false,
            kind: 'option',
            options: [
              { id: '10000', label: 'Done' },
              { id: '10001', label: "Won't do" },
              { id: '10002', label: 'Duplicate' },
            ],
            typeName: 'resolution',
          },
        ],
      },
    ],
  };
}

/** The sample people the demo's Jira lets the connection assign: its own account first. */
const DEMO_ASSIGNABLE: TrackerUserOption[] = [
  { id: 'demo-account', displayName: 'Demo User', email: 'demo@example.com' },
  { id: 'demo-alex', displayName: 'Alex Morgan', email: 'alex.morgan@example.com' },
  { id: 'demo-priya', displayName: 'Priya Shah', email: 'priya.shah@example.com' },
  { id: 'demo-sam', displayName: 'Sam Lee', email: 'sam.lee@example.com' },
  { id: 'demo-jordan', displayName: 'Jordan Kim', email: 'jordan.kim@example.com' },
];

/**
 * The demo people matching words of a name or an email, or the one person an
 * account id names, like the server's search for assignable people.
 */
export function demoAssignable(query = '', accountId = ''): { users: TrackerUserOption[] } {
  if (accountId) return { users: DEMO_ASSIGNABLE.filter((u) => u.id === accountId) };
  const q = foldText(query.trim());
  return { users: DEMO_ASSIGNABLE.filter((u) => !q || foldText(`${u.displayName} ${u.email}`).includes(q)) };
}

/** The demo's Jira issues a field can point at: an epic or two to parent a bug under. */
const DEMO_PICKER_ISSUES: TrackerIssueOption[] = [
  { key: 'PIWI-10', summary: 'Checkout reliability' },
  { key: 'PIWI-11', summary: 'Payments hardening' },
  { key: 'PIWI-12', summary: 'Flaky test cleanup' },
];

/** The demo issues matching a key or words of a summary, like the server's issue picker. */
export function demoIssuePicker(query: string): { issues: TrackerIssueOption[] } {
  const q = foldText(query.trim());
  return {
    issues: DEMO_PICKER_ISSUES.filter((i) => !q || foldText(`${i.key} ${i.summary}`).includes(q)),
  };
}

/**
 * The projects a demo connection is bound to: every project for the canned
 * connection, whose binding each of them shows, and null for an id that names
 * no connection.
 */
export async function demoConnectionBoundProjects(db: DrizzleDB, connectionId: number): Promise<number[] | null> {
  if (connectionId !== DEMO_CONNECTION.id) return null;
  return (await db.select({ id: projects.id }).from(projects)).map((p) => p.id);
}

/** The demo's Jira as the link step reads it: the keys of {@link DEMO_JIRA_ISSUES}, in the DEMO project. */
const DEMO_ISSUE_LOOKUP = {
  parseIssueUrl(url: string) {
    const match = /^https:\/\/demo\.atlassian\.net\/browse\/([A-Z][A-Z0-9_]+-\d+)\/?$/.exec(url);
    return match ? { key: match[1]! } : null;
  },
  async getIssues(keys: string[]): Promise<TrackerIssueBatch> {
    const asked = new Set(keys);
    return {
      issues: DEMO_JIRA_ISSUES.filter((issue) => asked.has(issue.key)).map((issue) => ({
        ...issue,
        statusCategory: issue.statusCategory as TrackerStatusCategory,
        assignee: null,
        url: `${DEMO_CONNECTION.baseUrl}/browse/${issue.key}`,
        projectKey: DEMO_PROJECT_KEY,
        issueType: DEMO_ISSUE_TYPE,
      })),
    };
  },
};

/**
 * The link step at a demo run's finish, as the server runs it: a run the `tracker` use admits links the issues its
 * failing tests name, looked up in the demo's Jira through the canned binding, which admits every run.
 */
export async function linkDemoDeclaredIssues(db: DrizzleDB, runId: number): Promise<DeclaredLinksResult | null> {
  const [run] = await db
    .select({ metadata: testRuns.metadata, isFullRun: testRuns.isFullRun, status: testRuns.status })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  if (!run || !isEligibleRun(run, 'tracker')) return null;
  return linkNamedIssues(db, runId, {
    projectKey: DEMO_PROJECT_KEY,
    // No connection row backs the canned connection, as for the seeded links.
    connectionId: null,
    tracker: DEMO_ISSUE_LOOKUP,
    deadline: AbortSignal.timeout(10_000),
  });
}

/** The project binding the demo shows — a canned Jira binding on the demo connection. */
export function getDemoProjectIntegration(): ResolvedProjectIntegration {
  return resolveProjectIntegration({
    connectionId: DEMO_CONNECTION.id,
    projectKey: DEMO_PROJECT_KEY,
    issueType: '1',
    labels: ['piwi'],
    locale: 'en',
    titlePrefix: '[Piwi]',
  });
}

/**
 * The automatic-creation preview over the seeded clusters, with the binding the
 * form sends (else the canned one): the same facts and rules as the server, the
 * default branch from the stored runs, and no CODEOWNERS or tracker to ask.
 */
export async function demoAutoCreatePreview(
  db: DrizzleDB,
  projectId: number,
  body: Partial<ResolvedProjectIntegration> | null,
): Promise<AutoCreatePreview> {
  const binding = body && Object.keys(body).length > 0 ? resolveProjectIntegration(body) : getDemoProjectIntegration();
  return previewAutoCreate(db, projectId, binding, { defaultBranch: await projectDefaultBranch(db, projectId) });
}

/** Echo the normalized binding back — the demo has nothing to persist to. */
export function saveDemoProjectIntegration(body: Partial<ResolvedProjectIntegration>): ResolvedProjectIntegration {
  return resolveProjectIntegration(body);
}

/** A fake webhook token so the Settings UI can render the once-shown value. */
export function generateDemoWebhookToken(): { token: string; url: string } {
  demoWebhookEnabled = true;
  const token = 'demo-webhook-token';
  return { token, url: `/api/integrations/jira/webhook/${token}` };
}

export function disableDemoWebhookToken(): { success: true } {
  demoWebhookEnabled = false;
  return { success: true };
}

/** The demo has no tracker to poll, so a sync sweep refreshes nothing. */
export function demoSyncTrackerLinks(): { refreshed: number; failed: number; skipped: number } {
  return { refreshed: 0, failed: 0, skipped: 0 };
}
