/**
 * Wire shapes the integration UI reads. Secret credentials never appear here — a
 * connection summary carries a `hasCredentials` flag and its non-secret credential
 * values (the account email), and the test result carries the resolved account,
 * not the token that resolved it.
 */
import type { IntegrationProviderName } from './registry';
import type { IssueDocument } from './document';
import type { IssueLocale } from './messages';
import type { JiraTokenKind } from './jira-setup';
import type { FieldValues } from './fields';

export type ConnectionStatus = 'unverified' | 'ok' | 'failed';
export type ConnectionManagedBy = 'db' | 'env';

/** A connection as the settings page sees it — no secret fields. */
export interface ConnectionSummary {
  id: number;
  provider: IntegrationProviderName;
  name: string;
  baseUrl: string;
  /** Provider-specific, non-secret configuration (flavor, site id, …). */
  config: Record<string, unknown> | null;
  status: ConnectionStatus;
  lastCheckedAt: string | null;
  lastError: string | null;
  managedBy: ConnectionManagedBy;
  /** True when the connection has stored credentials, without revealing them. */
  hasCredentials: boolean;
  /**
   * The non-secret credential values (e.g. the account email), so the settings UI
   * can show the account and pre-fill the edit form. Secret fields such as the API
   * token are never included.
   */
  credentialValues: Record<string, string>;
  /** True when an inbound-webhook token is set (the token itself is never returned). */
  hasWebhookToken: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

/** The body the connect form submits (credentials are a plain map by field key). */
export interface ConnectionInput {
  provider: IntegrationProviderName;
  name: string;
  baseUrl: string;
  config?: Record<string, unknown> | null;
  /** Field-key → value; an empty or omitted map on update keeps the stored one. */
  credentials?: Record<string, string> | null;
}

/** The result of testing a connection (`POST connections/:id/test`). */
export interface ConnectionTestResult {
  ok: boolean;
  /** The account the credentials resolved to, when the test succeeded. */
  account?: { id: string; displayName: string };
  /** Whether the token turned out classic or scoped, when the test succeeded. */
  tokenKind?: JiraTokenKind;
  /** Provider error text when the test failed. */
  error?: string;
  /** What to do about the failure, when there is more to say than the error. */
  hint?: string | null;
}

/** One step of a connection check. */
export interface ConnectionCheckStep {
  ok: boolean;
  error?: string;
  hint?: string | null;
}

/**
 * What `POST connections/check` reports before anything is saved: whether the
 * address is a Jira site, then — when credentials were supplied — whether they
 * sign in, which kind of token they are, and how many projects the account sees.
 */
export interface ConnectionCheckResult {
  /** The site URL the check ran against, read from what was typed. */
  baseUrl: string;
  site: ConnectionCheckStep & {
    /** False when nothing answered at the address (DNS, refused connection, timeout). */
    reachable: boolean;
    /** `Cloud`, `Server` or `DataCenter`, as the site reports itself. */
    deploymentType: string | null;
    /** The site's own name for itself. */
    title: string | null;
    /** The address the site reports for itself, when it differs from `baseUrl`. */
    reportedUrl: string | null;
    /** A Cloud site's tenant id — the gateway path a scoped token calls. */
    cloudId: string | null;
  };
  /** Present when credentials were supplied (or kept from the connection being edited). */
  auth?: ConnectionCheckStep & {
    account?: { id: string; displayName: string };
    tokenKind?: JiraTokenKind;
  };
  /** Present once the credentials signed in. */
  projects?: ConnectionCheckStep & {
    count: number;
    /** The first few project keys, to recognize the account's reach at a glance. */
    keys: string[];
  };
}

/** A tracker the UI can file into — what `GET status` returns. */
export interface TrackerSummary {
  id: number;
  provider: IntegrationProviderName;
  name: string;
  /** The tracker's site URL, for linking to a project on it. */
  baseUrl: string;
}

/** A tracker project option for the create modal's picker. */
export interface TrackerProjectOption {
  id: string;
  key: string;
  name: string;
}

/** An issue-type option for the create modal's picker. */
export interface TrackerIssueTypeOption {
  id: string;
  name: string;
}

/** An assignable-user option for the create modal's picker. */
export interface TrackerUserOption {
  id: string;
  displayName: string;
  email?: string | null;
}

/** An issue a field can point at (a parent, an epic), for the create modal's issue picker. */
export interface TrackerIssueOption {
  key: string;
  summary: string;
}

/** An issue that may already track the failure — leads the modal so a person links it. */
export interface ExistingIssueCandidate {
  key: string;
  url: string;
  title: string | null;
  statusText: string | null;
  statusColor: string | null;
  /** Why it was surfaced: pinned link, matching label/fingerprint, or fixed-before. */
  reason: 'linked' | 'label' | 'fingerprint' | 'fixed-before';
}

/** The toggles for what a ticket body carries. */
export interface IssueIncludeOptions {
  includeDiagnosis: boolean;
  includePatch: boolean;
  includeScreenshot: boolean;
  includeShareLink: boolean;
}

/** The prefilled draft `GET issue-draft` returns; the modal edits it and POSTs it back. */
/** What an issue can be filed for: a failure cluster, one failing execution, or a bug report. */
export type IssueEntityType = 'failure_cluster' | 'test_runs_case' | 'bug_report';

export interface IssueDraft {
  entityType: IssueEntityType;
  entityId: number;
  /** The cluster the created link attaches to (the entity's own cluster). */
  clusterId: number | null;
  /** The Piwi project the entity belongs to. */
  projectId: number;
  /** The project binding names a Jira project and an issue type, so the pickers come prefilled. */
  projectBound: boolean;
  /** `PIWI_SITE_URL` is set, so the issue's body links back to Piwi (and can carry a share link). */
  linksBack: boolean;
  title: string;
  connectionId: number | null;
  connections: TrackerSummary[];
  projectKey: string | null;
  issueType: string | null;
  labels: string[];
  assignee: string | null;
  /** The language the ticket is written in — binding, else connection default, else en. */
  locale: IssueLocale;
  /** The project's values for tracker fields — the binding's field defaults. */
  fieldValues: FieldValues;
  include: IssueIncludeOptions;
  /** Markdown preview of the body — what the modal renders through `MarkdownPreview`. */
  markdown: string;
  /** The neutral document the preview renders, for inspection. */
  document: IssueDocument;
  existing: ExistingIssueCandidate[];
}

/** A field a create was refused over: its id, its display name and, from the tracker, why. */
export interface IssueFieldProblem {
  id: string;
  name: string;
  message?: string;
}

/** What `POST issues` returns once the immediate attempt resolves. */
export interface CreateIssueResponse {
  /** The queued action; null when the create was refused before anything was queued. */
  actionId: number | null;
  status: 'done' | 'pending' | 'failed' | 'skipped';
  key?: string;
  url?: string;
  /** The issue was filed earlier for the same cluster (or bug report); nothing new was filed. */
  alreadyFiled?: boolean;
  error?: string;
  /** Required fields the create would leave empty — nothing was sent to the tracker. */
  missingFields?: IssueFieldProblem[];
  /** The tracker's own per-field refusals. */
  fieldErrors?: IssueFieldProblem[];
}
