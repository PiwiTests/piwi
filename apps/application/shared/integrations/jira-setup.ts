/**
 * Pure helpers behind the Jira connect form: reading a pasted address down to the
 * site URL, the Atlassian pages an administrator opens while creating a token,
 * the scopes a scoped token must carry, plain-language hints for a failed check
 * or a failed search for assignable people, and the token-expiry reminder.
 * Loads unchanged in the app, the server and the demo.
 */

/** Where an Atlassian account creates and revokes its API tokens, classic or scoped. */
export const ATLASSIAN_API_TOKENS_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

/** The Atlassian API gateway a scoped ("granular") API token must call. */
export const ATLASSIAN_API_GATEWAY = 'https://api.atlassian.com/ex/jira';

/** Atlassian caps an API token's lifetime at one year. */
export const ATLASSIAN_TOKEN_MAX_DAYS = 365;

/** A token expiring within this many days is flagged on its connection. */
export const TOKEN_EXPIRY_WARNING_DAYS = 14;

/**
 * A classic token authenticates against the site URL; a scoped token only
 * through the api.atlassian.com gateway.
 */
export type JiraTokenKind = 'classic' | 'scoped';

/** A scope a scoped token must carry, with what it unlocks in Piwi. */
export interface JiraScope {
  scope: string;
  enables: string;
}

export const JIRA_SCOPED_TOKEN_SCOPES: readonly JiraScope[] = [
  { scope: 'read:jira-work', enables: 'unfurl links, sync status, search and fill the pickers' },
  { scope: 'write:jira-work', enables: 'create issues, comment, transition and attach screenshots' },
  { scope: 'read:jira-user', enables: 'check the account and list assignable users' },
];

/** Whether a site runs on Atlassian Cloud or on a host of its own. */
export type JiraSiteKind = 'cloud' | 'self-hosted';

export interface JiraSiteAddress {
  /** The site URL: scheme, host and any context path, without a trailing slash. */
  url: string;
  kind: JiraSiteKind;
}

/** Hosts under which every address is a Jira Cloud site. */
const CLOUD_HOST_SUFFIXES = ['.atlassian.net', '.jira.com'];

/**
 * Path segments that open a page inside a self-hosted Jira. Everything from the
 * first of them onward is dropped, so a context path (`/jira`) survives.
 */
const SELF_HOSTED_PAGE_SEGMENTS = new Set([
  'browse',
  'secure',
  'projects',
  'plugins',
  'rest',
  'issues',
  'servicedesk',
  'login.jsp',
  'dashboards',
]);

export function isJiraCloudHost(host: string): boolean {
  const lower = host.toLowerCase();
  return CLOUD_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix) && lower.length > suffix.length);
}

/**
 * The Jira site an address belongs to, from whatever an administrator pastes: a
 * bare site name (`acme`), a host (`acme.atlassian.net`), or the URL of any Jira
 * page (`https://acme.atlassian.net/jira/software/projects/ABC/boards/1`). A Cloud
 * site is always its HTTPS origin; a self-hosted one keeps its context path.
 * Null when the input is not an http(s) address.
 */
export function normalizeJiraSiteUrl(input: string): JiraSiteAddress | null {
  const raw = input.trim();
  if (!raw) return null;

  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    // A bare word is an Atlassian site name.
    candidate = /^[a-z0-9][a-z0-9-]*$/i.test(candidate) ? `https://${candidate}.atlassian.net` : `https://${candidate}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;

  if (isJiraCloudHost(url.hostname)) {
    return { url: `https://${url.hostname.toLowerCase()}`, kind: 'cloud' };
  }

  const kept: string[] = [];
  for (const segment of url.pathname.split('/').filter(Boolean)) {
    if (SELF_HOSTED_PAGE_SEGMENTS.has(segment.toLowerCase())) break;
    kept.push(segment);
  }
  const path = kept.length ? `/${kept.join('/')}` : '';
  return { url: `${url.protocol}//${url.host}${path}`, kind: 'self-hosted' };
}

/** A readable site label for a Cloud URL (`acme` for `https://acme.atlassian.net`), else the host. */
export function jiraSiteLabel(siteUrl: string): string {
  try {
    const host = new URL(siteUrl).hostname;
    const suffix = CLOUD_HOST_SUFFIXES.find((s) => host.endsWith(s));
    return suffix ? host.slice(0, -suffix.length) : host;
  } catch {
    return siteUrl;
  }
}

/** Jira's own page for registering webhooks (Settings → System → Webhooks). */
export function jiraWebhooksAdminUrl(siteUrl: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/plugins/servlet/webhooks`;
}

/** A Jira project's page, from its key. */
export function jiraProjectUrl(siteUrl: string, projectKey: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(projectKey)}`;
}

/** The REST base a scoped token calls for a site, from its cloud id. */
export function jiraGatewayUrl(cloudId: string): string {
  return `${ATLASSIAN_API_GATEWAY}/${cloudId}`;
}

/** The step a connection check failed at. */
export type JiraCheckStage = 'site' | 'auth' | 'projects';

/** A failed call as the check saw it: the HTTP status (null when unreachable) and the error text. */
export interface JiraCheckFailure {
  status: number | null;
  message?: string | null;
}

const SCOPE_LIST = JIRA_SCOPED_TOKEN_SCOPES.map((s) => s.scope).join(', ');

/**
 * What to do about a failed check, in one sentence an administrator can act on.
 * Null when there is nothing more useful to say than the error itself.
 */
export function jiraFailureHint(stage: JiraCheckStage, failure: JiraCheckFailure): string | null {
  const { status } = failure;
  const message = (failure.message ?? '').toLowerCase();

  if (status === null) {
    return 'Check the URL, and that this server can reach it through any proxy, firewall or VPN.';
  }
  if (status === 429) return 'Atlassian is rate limiting this account. Wait a minute and check again.';

  if (stage === 'site') {
    if (status === 404) {
      return 'A Jira Cloud site is https://<your-site>.atlassian.net: copy it from the address bar of any Jira page.';
    }
    return 'The address answered, but not like a Jira site. Check the URL.';
  }

  if (status === 401 && message.includes('scope')) {
    return `The token lacks a scope this call needs. A scoped token must carry ${SCOPE_LIST}.`;
  }
  if (status === 401) {
    return 'Atlassian refused the email and token. Use the email of the account that created the token, paste the whole token, and check it has not expired or been revoked.';
  }
  if (status === 403) {
    return stage === 'projects'
      ? 'The account cannot list projects. Grant it Browse Projects on the projects Piwi should file into.'
      : 'The account signed in but may not use Jira on this site. Check it has Jira access.';
  }
  if (status === 404) {
    return stage === 'auth'
      ? 'The site has no Jira Cloud REST API at this address. Piwi connects to Jira Cloud.'
      : null;
  }
  return null;
}

/**
 * What to do about a failed search for assignable people, from Jira's status as
 * the search answered it. Null when Jira's own message says all there is.
 */
export function assigneeSearchHint(providerStatus: number | null | undefined): string | null {
  if (providerStatus === 401) {
    return "Jira refused the connection's email and token. Check them on the connection: the email of the account that created the token, the whole token, and that it has not expired or been revoked.";
  }
  if (providerStatus === 403) {
    return "The connection's account needs Assign Issues on this project or the Browse users and groups global permission. A scoped token also needs read:jira-user.";
  }
  if (providerStatus === 404) return "The connection's account does not see this Jira project. Check the project key.";
  if (providerStatus === 429) return 'Jira is rate limiting this account. Try again in a minute.';
  return null;
}

/**
 * The hint under an empty list of assignable people: Jira Cloud answers an empty
 * list, not an error, when the account may not browse users.
 */
export const ASSIGNEE_EMPTY_HINT =
  "If the project has people, the connection's account needs Assign Issues on it or the Browse users and groups global permission. A scoped token also needs read:jira-user.";

/** The hint shown when the credentials work but the account sees no project. */
export const JIRA_NO_PROJECTS_HINT =
  'The account sees no project. Grant it Browse Projects on the projects Piwi should file into, or check the token carries read:jira-work.';

export interface TokenExpiry {
  state: 'expired' | 'soon' | 'ok';
  /** Whole days until the token stops working; zero or negative once it has. */
  daysLeft: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How close a token is to its expiry date (`YYYY-MM-DD`, the last day Atlassian
 * shows for it). Null when no valid date is recorded.
 */
export function tokenExpiry(expiresOn: unknown, now: Date = new Date()): TokenExpiry | null {
  if (typeof expiresOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) return null;
  const end = Date.parse(`${expiresOn}T00:00:00Z`);
  if (Number.isNaN(end)) return null;
  const daysLeft = Math.ceil((end - now.getTime()) / DAY_MS);
  if (daysLeft <= 0) return { state: 'expired', daysLeft };
  return { state: daysLeft <= TOKEN_EXPIRY_WARNING_DAYS ? 'soon' : 'ok', daysLeft };
}

/** The `YYYY-MM-DD` date a token created today with the longest allowed lifetime expires on. */
export function maxTokenExpiryDate(now: Date = new Date()): string {
  return new Date(now.getTime() + ATLASSIAN_TOKEN_MAX_DAYS * DAY_MS).toISOString().slice(0, 10);
}
