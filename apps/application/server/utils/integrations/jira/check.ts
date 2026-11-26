import type { ConnectionCheckResult } from '#shared/integrations/types';
import { JIRA_NO_PROJECTS_HINT, jiraFailureHint, type JiraCheckFailure } from '#shared/integrations/jira-setup';
import { JiraClient, JiraError } from './client';
import { connectionFetch, PrivateAddressError } from '../../connection-fetch';

/** The site probe answers from public endpoints, so it gets a shorter budget than REST calls. */
const SITE_PROBE_TIMEOUT_MS = 8_000;

/** How many project keys the check reports back. */
const PROJECT_KEY_SAMPLE = 5;

interface ServerInfo {
  baseUrl?: string;
  deploymentType?: string;
  serverTitle?: string;
}

/**
 * A failed call as a check step sees it: the HTTP status Jira answered with, or
 * null when the request never got an answer (DNS, refused connection, timeout).
 * Undefined for anything else, which gets no hint.
 */
export function jiraCheckFailure(err: unknown): JiraCheckFailure | undefined {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof JiraError) return { status: err.status, message };
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return { status: null, message };
  }
  if (err instanceof TypeError && /fetch failed/i.test(message)) return { status: null, message };
  return undefined;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message;
    return detail ? `${err.message} (${detail})` : err.message;
  }
  return String(err);
}

async function fetchServerInfo(siteUrl: string): Promise<{ status: number; info: ServerInfo | null }> {
  // REST v3 is Cloud-only; a Server or Data Center site answers on v2.
  let status = 0;
  for (const version of ['3', '2']) {
    const response = await connectionFetch(`${siteUrl}/rest/api/${version}/serverInfo`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(SITE_PROBE_TIMEOUT_MS),
    });
    status = response.status;
    if (response.status === 404) continue;
    if (!response.ok) return { status, info: null };
    try {
      return { status, info: (await response.json()) as ServerInfo };
    } catch {
      return { status, info: null };
    }
  }
  return { status, info: null };
}

async function fetchCloudId(siteUrl: string): Promise<string | null> {
  try {
    const response = await connectionFetch(`${siteUrl}/_edge/tenant_info`, {
      signal: AbortSignal.timeout(SITE_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { cloudId?: unknown };
    return typeof data.cloudId === 'string' && data.cloudId ? data.cloudId : null;
  } catch {
    return null;
  }
}

/**
 * Whether an address is a Jira Cloud site, read from its public `serverInfo`
 * and, for Cloud, its tenant id. Needs no credentials.
 */
export async function probeJiraSite(siteUrl: string): Promise<ConnectionCheckResult['site']> {
  const empty = { reachable: true, deploymentType: null, title: null, reportedUrl: null, cloudId: null };
  let probe: Awaited<ReturnType<typeof fetchServerInfo>>;
  try {
    probe = await fetchServerInfo(siteUrl);
  } catch (err) {
    return {
      ...empty,
      reachable: false,
      ok: false,
      error: `Could not reach ${siteUrl}: ${errorText(err)}`,
      hint: err instanceof PrivateAddressError ? null : jiraFailureHint('site', { status: null }),
    };
  }

  const { status, info } = probe;
  if (!info || typeof info.deploymentType !== 'string') {
    return {
      ...empty,
      ok: false,
      error: `No Jira answered at ${siteUrl} (HTTP ${status}).`,
      hint: jiraFailureHint('site', { status }),
    };
  }

  const reported = typeof info.baseUrl === 'string' ? info.baseUrl.replace(/\/+$/, '') : null;
  const site = {
    reachable: true,
    deploymentType: info.deploymentType,
    title: typeof info.serverTitle === 'string' && info.serverTitle ? info.serverTitle : null,
    reportedUrl: reported && reported !== siteUrl ? reported : null,
    cloudId: null as string | null,
  };
  if (info.deploymentType !== 'Cloud') {
    return {
      ...site,
      ok: false,
      error: `This is a Jira ${info.deploymentType} site.`,
      hint: 'Piwi connects to Jira Cloud (REST v3). A Server or Data Center site is not supported.',
    };
  }
  return { ...site, ok: true, cloudId: await fetchCloudId(siteUrl) };
}

/**
 * Sign in with the credentials and list the projects the account sees. A
 * scoped token is told apart from a classic one by whether the client had to
 * switch to the api.atlassian.com gateway.
 */
export async function checkJiraCredentials(
  siteUrl: string,
  credentials: { email: string; apiToken: string },
): Promise<Pick<ConnectionCheckResult, 'auth' | 'projects'>> {
  const client = new JiraClient({ baseUrl: siteUrl, email: credentials.email, apiToken: credentials.apiToken });

  let account: { id: string; displayName: string };
  try {
    account = await client.whoAmI();
  } catch (err) {
    const failure = jiraCheckFailure(err);
    return { auth: { ok: false, error: errorText(err), hint: failure ? jiraFailureHint('auth', failure) : null } };
  }
  const tokenKind = client.detectedConfig()?.cloudId ? 'scoped' : 'classic';
  const auth = { ok: true, account, tokenKind } as const;

  try {
    const projects = await client.listProjects();
    return {
      auth,
      projects: {
        ok: true,
        count: projects.length,
        keys: projects.slice(0, PROJECT_KEY_SAMPLE).map((p) => p.key),
        hint: projects.length === 0 ? JIRA_NO_PROJECTS_HINT : null,
      },
    };
  } catch (err) {
    const failure = jiraCheckFailure(err);
    return {
      auth,
      projects: {
        ok: false,
        count: 0,
        keys: [],
        error: errorText(err),
        hint: failure ? jiraFailureHint('projects', failure) : null,
      },
    };
  }
}
