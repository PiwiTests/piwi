import { and, eq, isNotNull } from 'drizzle-orm';
import type {
  ConnectionCheckResult,
  CreateIssueResponse,
  ConnectionInput,
  ConnectionSummary,
  ConnectionTestResult,
  ExistingIssueCandidate,
  IssueDraft,
  TrackerIssueOption,
  TrackerSummary,
} from '#shared/integrations/types';
import { foldText } from '#shared/utils/fold-text';
import { nonSecretCredentials } from '#shared/integrations/registry';
import { normalizeJiraSiteUrl } from '#shared/integrations/jira-setup';
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
import { buildClusterIssue, buildExecutionIssue } from '~~/server/utils/integrations/documents';
import { entityLinks, testRunsCases } from '~~/server/database/schema';
import type { DrizzleDB } from '#shared/handlers/db';

/**
 * The demo has no server to reach Jira, so it ships one canned Jira connection
 * and answers the connection endpoints from constants. Nothing calls out.
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

/** Whether the canned connection's inbound webhook is on, for as long as the service worker runs. */
let demoWebhookEnabled = false;

function demoConnection(): ConnectionSummary {
  return { ...DEMO_CONNECTION, hasWebhookToken: demoWebhookEnabled };
}

export function listDemoConnections(): { connections: ConnectionSummary[]; canStoreSecrets: boolean } {
  return { connections: [demoConnection()], canStoreSecrets: true };
}

export function getDemoConnection(id: number): { connection: ConnectionSummary } | null {
  return id === DEMO_CONNECTION.id ? { connection: demoConnection() } : null;
}

export function createDemoConnection(body: ConnectionInput): { connection: ConnectionSummary } {
  return {
    connection: {
      ...DEMO_CONNECTION,
      id: 2,
      provider: body.provider,
      name: body.name,
      baseUrl: body.baseUrl,
      config: body.config ?? { flavor: 'cloud' },
      status: 'unverified',
      hasCredentials: !!body.credentials && Object.keys(body.credentials).length > 0,
      credentialValues: nonSecretCredentials(body.provider, body.credentials),
    },
  };
}

export function updateDemoConnection(id: number, body: Partial<ConnectionInput>): { connection: ConnectionSummary } {
  return {
    connection: {
      ...DEMO_CONNECTION,
      id,
      name: body.name ?? DEMO_CONNECTION.name,
      baseUrl: body.baseUrl ?? DEMO_CONNECTION.baseUrl,
      // Mirror the server's merge: submitted non-secret fields override the stored ones.
      credentialValues: { ...DEMO_CONNECTION.credentialValues, ...nonSecretCredentials('jira', body.credentials) },
    },
  };
}

export function testDemoConnection(): ConnectionTestResult {
  return { ok: true, account: { id: 'demo-account', displayName: 'Demo User' }, tokenKind: 'classic' };
}

/**
 * The pre-save check in the demo: the address is read the way the server reads
 * it, but the demo runs in the browser and never calls out, so the site is
 * reported unreachable. Null when the address is not a URL.
 */
export function checkDemoConnection(body: { baseUrl?: string }): ConnectionCheckResult | null {
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

// ── Create-issue flow (in-browser, never calls out) ──────────────────────────

const DEMO_PROJECT_KEY = 'DEMO';
const DEMO_ISSUE_TYPE = 'Bug';

/** The canned connection as the tracker pickers list it. */
const DEMO_TRACKER: TrackerSummary = {
  id: DEMO_CONNECTION.id,
  provider: 'jira',
  name: DEMO_CONNECTION.name,
  baseUrl: DEMO_CONNECTION.baseUrl,
};

export function demoTrackerStatus(): { trackers: TrackerSummary[] } {
  return { trackers: [DEMO_TRACKER] };
}

/** The cluster an entity belongs to (itself for a cluster, its cluster for an execution). */
async function resolveClusterId(
  db: DrizzleDB,
  entityType: 'failure_cluster' | 'test_runs_case',
  entityId: number,
): Promise<number | null> {
  if (entityType === 'failure_cluster') return entityId;
  const [row] = await db
    .select({ clusterId: testRunsCases.failureClusterId })
    .from(testRunsCases)
    .where(eq(testRunsCases.id, entityId));
  return row?.clusterId ?? null;
}

/** Jira-shaped links already pinned to the cluster, as dedupe candidates. */
async function demoExisting(db: DrizzleDB, clusterId: number): Promise<ExistingIssueCandidate[]> {
  const links = await db
    .select()
    .from(entityLinks)
    .where(and(eq(entityLinks.failureClusterId, clusterId), isNotNull(entityLinks.key)));
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

export async function demoIssueDraft(
  db: DrizzleDB,
  entityType: 'failure_cluster' | 'test_runs_case',
  entityId: number,
  locale: IssueLocale = DEFAULT_LOCALE,
): Promise<IssueDraft | null> {
  const clusterId = await resolveClusterId(db, entityType, entityId);
  if (clusterId == null) return null;
  const built =
    entityType === 'failure_cluster'
      ? await buildClusterIssue(db, entityId, { locale })
      : await buildExecutionIssue(db, entityId, { locale });
  if (!built) return null;
  return {
    entityType,
    entityId,
    clusterId,
    projectId: built.projectId,
    projectBound: true,
    // The static demo has no public address to link back to.
    linksBack: false,
    title: built.title,
    connectionId: DEMO_CONNECTION.id,
    connections: [DEMO_TRACKER],
    projectKey: DEMO_PROJECT_KEY,
    issueType: DEMO_ISSUE_TYPE,
    labels: built.labels,
    assignee: null,
    locale,
    fieldValues: getDemoProjectIntegration().fieldDefaults,
    include: { includeDiagnosis: true, includePatch: true, includeScreenshot: false, includeShareLink: false },
    markdown: renderMarkdown(built.document),
    document: built.document,
    existing: await demoExisting(db, clusterId),
  };
}

/**
 * File a DEMO-<n> issue and write the known-issue link into the in-browser DB —
 * or, like the server, refuse before filing when the issue type's required
 * fields are still empty.
 */
export async function demoCreateIssue(
  db: DrizzleDB,
  entityType: 'failure_cluster' | 'test_runs_case',
  entityId: number,
  title?: string | null,
  request: { issueType?: string; fields?: unknown } = {},
): Promise<CreateIssueResponse> {
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

  const clusterId = (await resolveClusterId(db, entityType, entityId)) ?? entityId;

  // Like the server, the cluster and its executions share one filing while its link is there.
  const [filed] = await db
    .select()
    .from(entityLinks)
    .where(and(eq(entityLinks.failureClusterId, clusterId), eq(entityLinks.origin, 'created')));
  if (filed?.key) return { actionId: filed.id, status: 'done', key: filed.key, url: filed.url, alreadyFiled: true };

  const built =
    entityType === 'failure_cluster'
      ? await buildClusterIssue(db, entityId, {})
      : await buildExecutionIssue(db, entityId, {});

  const existing = await db.select().from(entityLinks).where(isNotNull(entityLinks.key));
  const n = 100 + existing.filter((l) => l.provider === 'jira').length + 1;
  const key = `${DEMO_PROJECT_KEY}-${n}`;
  const url = `${DEMO_CONNECTION.baseUrl}/browse/${key}`;

  const [row] = await db
    .insert(entityLinks)
    .values({
      failureClusterId: clusterId,
      url,
      provider: 'jira',
      key,
      title: title?.trim() || built?.title || key,
      statusText: 'To Do',
      statusColor: 'info',
      connectionId: DEMO_CONNECTION.id,
      externalId: String(10000 + n),
      origin: 'created',
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

export function demoAssignable(): { users: { id: string; displayName: string }[] } {
  return { users: [{ id: 'demo-account', displayName: 'Demo User' }] };
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

/** The project binding the demo shows — a canned Jira binding on the demo connection. */
export function getDemoProjectIntegration(): ResolvedProjectIntegration {
  return resolveProjectIntegration({
    connectionId: DEMO_CONNECTION.id,
    projectKey: DEMO_PROJECT_KEY,
    issueType: '1',
    labels: ['piwi'],
    locale: 'en',
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
