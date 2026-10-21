import type { IssueDocument } from '#shared/integrations/document';
import { adfPlainText, renderAdf } from '#shared/integrations/render-adf';
import { DEFAULT_EXPORT_MAX_INLINE_BYTES } from '#shared/export/limits';
import type {
  CreateIssueInput,
  IssueText,
  IssueTracker,
  TrackerCredentials,
  TrackerIssue,
  TrackerIssueType,
  TrackerProject,
  TrackerSearch,
  TrackerTransition,
  TrackerUser,
  UpdateIssueInput,
} from '../types';
import { statusColorForCategory, toStatusCategory } from '../types';
import { ATLASSIAN_API_GATEWAY } from '#shared/integrations/jira-setup';
import type { TrackerField } from '#shared/integrations/fields';
import type { TrackerIssueOption } from '#shared/integrations/types';
import { jiraFieldToTrackerField, type JiraCreateMetaField } from './fields';
import { isJiraIconPath, isTransientIconStatus, jiraAvatar, jiraIconPath, MAX_ICON_BYTES } from './icons';
import { createHash } from 'node:crypto';

const JIRA_TIMEOUT_MS = 10_000;

/** Jira refuses a summary longer than this, or one with a line break. */
const SUMMARY_MAX_LENGTH = 255;

/** A title as Jira takes a summary: one line, at most {@link SUMMARY_MAX_LENGTH} characters. */
export function jiraSummary(title: string): string {
  const line = title.replace(/\s+/g, ' ').trim();
  return line.length <= SUMMARY_MAX_LENGTH ? line : `${line.slice(0, SUMMARY_MAX_LENGTH - 1).trimEnd()}…`;
}

/** Create metadata is paged; a screen past this many fields is read no further. */
const CREATE_META_PAGE_SIZE = 100;
const CREATE_META_MAX_PAGES = 10;

/** The most issues the issue picker returns. */
const ISSUE_PICKER_LIMIT = 20;

/** The picker's summary marks the matched words with HTML; its text is what is shown. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Project search is paged too, and Jira may serve fewer per page than asked; a
 * site past this many pages is read no further.
 */
const PROJECT_SEARCH_PAGE_SIZE = 100;
const PROJECT_SEARCH_MAX_PAGES = 50;

/**
 * Cloud ids resolved for scoped-token credentials, so only the first request for
 * a given credential pays the detection cost. Keyed by site URL plus a hash of the
 * credential: a classic token never triggers detection, so it is never routed
 * through the gateway, even against a site a scoped token also reaches.
 */
const scopedCloudIds = new Map<string, string>();

/**
 * A Jira Cloud site's tenant (cloud) id, read from the public `_edge/tenant_info`
 * endpoint. Returns null for a self-hosted host or any failure, so the caller
 * stays on the site URL.
 */
async function resolveCloudId(siteBaseUrl: string, timeoutMs: number): Promise<string | null> {
  try {
    const response = await fetch(`${siteBaseUrl}/_edge/tenant_info`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const data = (await response.json()) as { cloudId?: string };
    return typeof data.cloudId === 'string' && data.cloudId.length > 0 ? data.cloudId : null;
  } catch {
    return null;
  }
}

export interface JiraClientConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  /**
   * Set when the connection is known to use a scoped token: REST calls then route
   * through the api.atlassian.com gateway instead of the site URL. Left unset for a
   * classic token, and auto-detected on the first 401 otherwise.
   */
  cloudId?: string | null;
  /** Request timeout in ms; unfurl passes a shorter budget than the default. */
  timeoutMs?: number;
}

interface JiraStatus {
  name?: string;
  statusCategory?: { key?: string };
}

interface JiraUser {
  accountId?: string;
  displayName?: string;
  emailAddress?: string | null;
  avatarUrls?: Record<string, string>;
}

interface JiraIssueResponse {
  id?: string;
  key?: string;
  fields?: {
    summary?: string;
    status?: JiraStatus;
    assignee?: JiraUser | null;
  };
}

/** A Jira REST error that keeps the credential out of its message. */
export class JiraError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Seconds Jira asked us to wait, carried from a 429 `Retry-After`. */
    readonly retryAfterSeconds?: number,
    /** Jira's per-field refusals (`customfield_10042` → "Team is required."), from a 400. */
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = 'JiraError';
  }
}

/** The longest Jira explanation carried into an error message. */
const JIRA_ERROR_DETAIL_MAX = 500;

/**
 * Jira's own explanation from an error body: the `errorMessages` list, the
 * per-field `errors` map (`customfield_10042: Team is required.`) and the
 * gateway's `message`, plus that per-field map on its own. The detail is null
 * when the body is empty or not JSON (an HTML error page), so the caller falls
 * back to the bare status line.
 */
async function jiraErrorDetail(
  response: Response,
): Promise<{ detail: string | null; fieldErrors: Record<string, string> | undefined }> {
  let body: { errorMessages?: unknown; errors?: unknown; message?: unknown };
  try {
    body = JSON.parse(await response.text());
  } catch {
    return { detail: null, fieldErrors: undefined };
  }
  if (!body || typeof body !== 'object') return { detail: null, fieldErrors: undefined };
  const parts: string[] = [];
  const fieldErrors: Record<string, string> = {};
  if (Array.isArray(body.errorMessages)) {
    for (const message of body.errorMessages) if (typeof message === 'string' && message) parts.push(message);
  }
  if (body.errors && typeof body.errors === 'object') {
    for (const [field, message] of Object.entries(body.errors)) {
      if (typeof message === 'string' && message) {
        parts.push(`${field}: ${message}`);
        fieldErrors[field] = message;
      }
    }
  }
  if (typeof body.message === 'string' && body.message) parts.push(body.message);
  const errors = Object.keys(fieldErrors).length ? fieldErrors : undefined;
  if (!parts.length) return { detail: null, fieldErrors: errors };
  const detail = parts.join('; ');
  return {
    detail: detail.length > JIRA_ERROR_DETAIL_MAX ? `${detail.slice(0, JIRA_ERROR_DETAIL_MAX)}…` : detail,
    fieldErrors: errors,
  };
}

/** The `JiraError` for a failed response: its status line plus Jira's explanation. */
async function toJiraError(response: Response, what: string): Promise<JiraError> {
  if (response.status === 429) {
    const header = response.headers.get('retry-after');
    const retryAfter = header != null ? Number(header) : NaN;
    return new JiraError(
      429,
      'Jira rate limited the request (429)',
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }
  const { detail, fieldErrors } = await jiraErrorDetail(response);
  const statusLine = `${what} (${response.status} ${response.statusText})`;
  return new JiraError(response.status, detail ? `${statusLine}: ${detail}` : statusLine, undefined, fieldErrors);
}

/**
 * Jira Cloud client (REST v3, Basic `email:apiToken`). Reads and writes go
 * through the one interface every tracker implements; the base URL is
 * administrator-supplied and therefore trusted.
 */
export class JiraClient implements IssueTracker {
  readonly provider = 'jira' as const;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  /** Set once REST calls are known to need the gateway (a scoped token). */
  private cloudId: string | null;

  constructor(private readonly config: JiraClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? JIRA_TIMEOUT_MS;
    this.cloudId = config.cloudId ?? scopedCloudIds.get(this.credentialKey()) ?? null;
  }

  static fromCredentials(baseUrl: string, credentials: TrackerCredentials, cloudId?: string | null): JiraClient {
    return new JiraClient({
      baseUrl,
      email: credentials.email,
      apiToken: credentials.apiToken,
      cloudId: cloudId ?? null,
    });
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64')}`;
  }

  /** A cache key tying a resolved cloud id to this exact credential and site. */
  private credentialKey(): string {
    const hash = createHash('sha256').update(`${this.config.email}\n${this.config.apiToken}`).digest('hex');
    return `${this.baseUrl}\n${hash}`;
  }

  /** The REST base: the gateway once a scoped token is detected, else the site URL. */
  private apiBase(): string {
    return this.cloudId ? `${ATLASSIAN_API_GATEWAY}/${this.cloudId}` : this.baseUrl;
  }

  /**
   * Fetch a REST path, building the request fresh for each attempt. A scoped
   * ("granular") API token is refused on the site URL with a 401 and works only
   * through the api.atlassian.com gateway, so on that first 401 we resolve the
   * site's cloud id and retry there once; a classic token never takes this path.
   */
  private async apiFetch(path: string, build: () => RequestInit): Promise<Response> {
    let response = await fetch(`${this.apiBase()}${path}`, build());
    if (response.status === 401 && !this.cloudId) {
      const key = this.credentialKey();
      const cloudId = scopedCloudIds.get(key) ?? (await resolveCloudId(this.baseUrl, this.timeoutMs));
      if (cloudId) {
        this.cloudId = cloudId;
        scopedCloudIds.set(key, cloudId);
        response = await fetch(`${this.apiBase()}${path}`, build());
      }
    }
    return response;
  }

  /** Provider config discovered while making calls (a resolved scoped-token cloud id). */
  detectedConfig(): Record<string, unknown> | null {
    return this.cloudId ? { cloudId: this.cloudId } : null;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.apiFetch(path, () => ({
      ...init,
      headers: {
        Authorization: this.authHeader(),
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    }));
    if (!response.ok) throw await toJiraError(response, 'Jira request failed');
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async whoAmI(): Promise<{ id: string; displayName: string }> {
    const me = await this.request<JiraUser>('/rest/api/3/myself');
    return { id: me.accountId ?? '', displayName: me.displayName ?? me.emailAddress ?? '' };
  }

  private toIssue(data: JiraIssueResponse, key: string): TrackerIssue {
    const category = toStatusCategory(data.fields?.status?.statusCategory?.key ?? null);
    const assignee = data.fields?.assignee ?? null;
    return {
      id: data.id ?? null,
      key: data.key ?? key,
      url: this.issueUrl(data.key ?? key),
      title: data.fields?.summary ?? null,
      status: data.fields?.status?.name ?? null,
      statusCategory: category,
      statusColor: statusColorForCategory(category),
      assignee: assignee?.accountId
        ? {
            id: assignee.accountId,
            displayName: assignee.displayName ?? '',
            email: assignee.emailAddress ?? null,
          }
        : null,
    };
  }

  async getIssue(key: string): Promise<TrackerIssue | null> {
    try {
      const data = await this.request<JiraIssueResponse>(
        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,assignee`,
      );
      return this.toIssue(data, key);
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) return null;
      throw err;
    }
  }

  /** Every project the credential can browse, paged through. */
  async listProjects(): Promise<TrackerProject[]> {
    const projects: TrackerProject[] = [];
    let startAt = 0;
    for (let page = 0; page < PROJECT_SEARCH_MAX_PAGES; page++) {
      const data = await this.request<{
        values?: { id?: string; key?: string; name?: string; avatarUrls?: Record<string, string> }[];
        total?: number;
        isLast?: boolean;
      }>(`/rest/api/3/project/search?startAt=${startAt}&maxResults=${PROJECT_SEARCH_PAGE_SIZE}`);
      const items = data.values ?? [];
      for (const p of items) {
        const icon = jiraIconPath(p.avatarUrls?.['24x24'] ?? p.avatarUrls?.['16x16'], this.baseUrl);
        projects.push({ id: p.id ?? '', key: p.key ?? '', name: p.name ?? '', icon });
      }
      startAt += items.length;
      const more =
        data.isLast === false || (data.isLast == null && typeof data.total === 'number' && startAt < data.total);
      if (items.length === 0 || !more) break;
    }
    return projects;
  }

  async listIssueTypes(projectKey: string): Promise<TrackerIssueType[]> {
    const data = await this.request<{ issueTypes?: { id?: string; name?: string; iconUrl?: string }[] }>(
      `/rest/api/3/project/${encodeURIComponent(projectKey)}`,
    );
    return (data.issueTypes ?? []).map((t) => ({
      id: t.id ?? '',
      name: t.name ?? '',
      icon: jiraIconPath(t.iconUrl, this.baseUrl),
    }));
  }

  /**
   * The fields of a project's create screen for an issue type, from Jira's create
   * metadata, paged through. An issue type given by name is looked up by id first,
   * since the metadata is keyed by id.
   */
  async listCreateFields(projectKey: string, issueType: string): Promise<TrackerField[]> {
    const typeId = /^\d+$/.test(issueType)
      ? issueType
      : (await this.listIssueTypes(projectKey)).find((t) => t.name.toLowerCase() === issueType.toLowerCase())?.id;
    if (!typeId) throw new JiraError(404, `Issue type '${issueType}' is not in project ${projectKey}`);
    const base = `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(typeId)}`;
    const fields: TrackerField[] = [];
    let startAt = 0;
    for (let page = 0; page < CREATE_META_MAX_PAGES; page++) {
      const data = await this.request<{
        fields?: JiraCreateMetaField[];
        values?: JiraCreateMetaField[];
        total?: number;
      }>(`${base}?startAt=${startAt}&maxResults=${CREATE_META_PAGE_SIZE}`);
      const items = data.fields ?? data.values ?? [];
      for (const raw of items) {
        const field = jiraFieldToTrackerField(raw);
        if (field) fields.push(field);
      }
      startAt += items.length;
      if (items.length === 0 || typeof data.total !== 'number' || startAt >= data.total) break;
    }
    return fields;
  }

  async searchAssignable(projectKey: string, query: string): Promise<TrackerUser[]> {
    const params = new URLSearchParams({ project: projectKey, query, maxResults: '20' });
    const data = await this.request<JiraUser[]>(`/rest/api/3/user/assignable/search?${params.toString()}`);
    return (data ?? [])
      .filter((u) => u.accountId)
      .map((u) => ({
        id: u.accountId ?? '',
        displayName: u.displayName ?? '',
        email: u.emailAddress ?? null,
        icon: jiraAvatar(u.avatarUrls?.['24x24'] ?? u.avatarUrls?.['16x16'], this.baseUrl),
      }));
  }

  async pickIssues(query: string, projectKey?: string | null): Promise<TrackerIssueOption[]> {
    const params = new URLSearchParams({ query, showSubTasks: 'true', showSubTaskParent: 'true' });
    if (projectKey) params.set('currentJQL', `project = ${JSON.stringify(projectKey)}`);
    const data = await this.request<{
      sections?: { id?: string; issues?: { key?: string; summaryText?: string; summary?: string; img?: string }[] }[];
    }>(`/rest/api/3/issue/picker?${params.toString()}`);
    // The picker answers with the issues the JQL scopes ("cs") and the ones seen lately ("hs"): the project's first.
    const sections = [...(data.sections ?? [])].sort((a, b) => Number(b.id === 'cs') - Number(a.id === 'cs'));
    const out = new Map<string, TrackerIssueOption>();
    for (const section of sections) {
      for (const issue of section.issues ?? []) {
        if (!issue.key || out.has(issue.key)) continue;
        out.set(issue.key, {
          key: issue.key,
          summary: issue.summaryText ?? stripTags(issue.summary ?? ''),
          icon: jiraIconPath(issue.img, this.baseUrl),
        });
      }
    }
    return [...out.values()].slice(0, ISSUE_PICKER_LIMIT);
  }

  async fetchIcon(path: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    if (!isJiraIconPath(path)) return null;
    const response = await this.apiFetch(path, () => ({
      headers: { Authorization: this.authHeader(), Accept: 'image/*' },
      signal: AbortSignal.timeout(this.timeoutMs),
    }));
    if (isTransientIconStatus(response.status)) throw await toJiraError(response, 'Jira icon request failed');
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!response.ok || !mime.startsWith('image/')) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > MAX_ICON_BYTES ? null : { bytes, mime };
  }

  async listTransitions(key: string): Promise<TrackerTransition[]> {
    const data = await this.request<{
      transitions?: {
        id?: string;
        name?: string;
        to?: { name?: string; statusCategory?: { key?: string } };
        fields?: Record<string, Omit<JiraCreateMetaField, 'fieldId'>>;
      }[];
    }>(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions?expand=transitions.fields`);
    return (data.transitions ?? []).map((t) => ({
      id: t.id ?? '',
      name: t.name ?? '',
      toStatus: t.to?.name ?? null,
      toStatusCategory: toStatusCategory(t.to?.statusCategory?.key),
      // A transition screen's fields come keyed by field id.
      fields: Object.entries(t.fields ?? {})
        .map(([fieldId, meta]) => jiraFieldToTrackerField({ ...meta, fieldId }))
        .filter((f): f is TrackerField => f !== null),
    }));
  }

  async transition(key: string, transitionId: string, fields?: Record<string, unknown>): Promise<void> {
    const body: { transition: { id: string }; fields?: Record<string, unknown> } = { transition: { id: transitionId } };
    if (fields && Object.keys(fields).length) body.fields = fields;
    await this.request<void>(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async search(query: TrackerSearch): Promise<TrackerIssue[]> {
    const jql = query.jql ?? buildJql(query);
    const data = await this.request<{ issues?: JiraIssueResponse[] }>('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        maxResults: query.limit ?? 20,
        fields: ['summary', 'status', 'assignee'],
      }),
    });
    return (data.issues ?? []).map((issue) => this.toIssue(issue, issue.key ?? ''));
  }

  async createIssue(input: CreateIssueInput): Promise<TrackerIssue> {
    // Jira-side names (issue type, priority) are localized per site, so address
    // them by id when we have one; a bare numeric string is an id, else a name.
    const issuetype = /^\d+$/.test(input.issueType) ? { id: input.issueType } : { name: input.issueType };
    // Extra field values go first, so Piwi's own fields always win over them.
    const fields: Record<string, unknown> = {
      ...(input.fields ?? {}),
      project: { key: input.projectKey },
      issuetype,
      summary: jiraSummary(input.title),
      description: renderAdf(input.body),
    };
    if (input.labels?.length) fields.labels = input.labels;
    if (input.assigneeId) fields.assignee = { accountId: input.assigneeId };
    // Only ever send a priority by id — never an English name that a French site
    // would not match.
    if (input.priority && /^\d+$/.test(input.priority)) fields.priority = { id: input.priority };
    if (input.componentId) fields.components = [{ id: input.componentId }];

    const data = await this.request<{ id?: string; key?: string }>('/rest/api/3/issue', {
      method: 'POST',
      body: JSON.stringify({ fields }),
    });
    const key = data.key ?? '';
    return {
      id: data.id ?? null,
      key,
      url: this.issueUrl(key),
      title: jiraSummary(input.title),
      status: null,
      statusCategory: null,
      statusColor: null,
      assignee: null,
    };
  }

  async addComment(key: string, body: IssueDocument): Promise<void> {
    await this.request<void>(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body: renderAdf(body) }),
    });
  }

  async updateIssue(key: string, input: UpdateIssueInput): Promise<void> {
    const fields: Record<string, unknown> = {};
    if (input.title != null) fields.summary = jiraSummary(input.title);
    if (input.body) fields.description = renderAdf(input.body);
    if (Object.keys(fields).length === 0) return;
    await this.request<void>(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ fields }),
    });
  }

  async readIssueText(key: string): Promise<IssueText | null> {
    try {
      const data = await this.request<{ fields?: { summary?: string | null; description?: unknown } }>(
        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description`,
      );
      return { title: data.fields?.summary ?? null, description: adfPlainText(data.fields?.description) };
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) return null;
      throw err;
    }
  }

  async attach(key: string, file: { name: string; bytes: Uint8Array; mime: string }): Promise<void> {
    if (file.bytes.byteLength > DEFAULT_EXPORT_MAX_INLINE_BYTES) {
      throw new JiraError(413, `attachment '${file.name}' exceeds the ${DEFAULT_EXPORT_MAX_INLINE_BYTES}-byte cap`);
    }
    // Rebuilt per attempt: the 401 gateway retry in apiFetch resends the body.
    const build = (): RequestInit => {
      const form = new FormData();
      form.append('file', new Blob([file.bytes as unknown as BlobPart], { type: file.mime }), file.name);
      return {
        method: 'POST',
        headers: {
          Authorization: this.authHeader(),
          Accept: 'application/json',
          'X-Atlassian-Token': 'no-check',
        },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      };
    };
    const response = await this.apiFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, build);
    if (!response.ok) throw await toJiraError(response, 'Jira attachment failed');
  }

  issueUrl(key: string): string {
    return `${this.baseUrl}/browse/${key}`;
  }

  parseIssueUrl(url: string): { key: string } | null {
    let parsed: URL;
    let base: URL;
    try {
      parsed = new URL(url);
      base = new URL(this.baseUrl);
    } catch {
      return null;
    }
    if (parsed.host !== base.host) return null;
    // <baseUrl>/browse/KEY-123
    const browse = /\/browse\/([A-Z][A-Z0-9_]+-\d+)(?:$|[?#/])/i.exec(parsed.pathname);
    if (browse?.[1]) return { key: browse[1].toUpperCase() };
    // <baseUrl>/jira/software/c/projects/KEY/…?selectedIssue=KEY-123
    const selected = parsed.searchParams.get('selectedIssue');
    if (selected && /^[A-Z][A-Z0-9_]+-\d+$/i.test(selected)) return { key: selected.toUpperCase() };
    const projectIssue = /\/jira\/software\/c\/projects\/[^/]+\/issues\/([A-Z][A-Z0-9_]+-\d+)/i.exec(parsed.pathname);
    if (projectIssue?.[1]) return { key: projectIssue[1].toUpperCase() };
    return null;
  }
}

/** Translate a neutral search into JQL: label AND text clauses, ordered by update. */
function buildJql(query: TrackerSearch): string {
  const clauses: string[] = [];
  for (const label of query.labels ?? []) {
    clauses.push(`labels = ${JSON.stringify(label)}`);
  }
  if (query.text) {
    clauses.push(`text ~ ${JSON.stringify(query.text)}`);
  }
  const where = clauses.length ? clauses.join(' AND ') : 'order by updated desc';
  return clauses.length ? `${where} order by updated desc` : where;
}
