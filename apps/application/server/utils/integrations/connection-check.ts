/**
 * The check a connection gets before it is saved, one per provider: each signs in with the provider's own client and
 * reports what the connect form shows. Nothing is stored.
 */
import type { IntegrationProviderName } from '#shared/integrations/registry';
import { normalizeJiraSiteUrl } from '#shared/integrations/jira-setup';
import type { ConnectionCheckResult } from '#shared/integrations/types';
import type { DbClient } from '../../database';
import { credentialsForCheck } from './connections';
import { checkJiraCredentials, probeJiraSite } from './jira/check';

/** What the connect form sends to check: the address or region typed, the credentials, the connection being edited. */
export interface ConnectionCheckInput {
  baseUrl?: string;
  region?: string;
  credentials?: Record<string, string> | null;
  connectionId?: number | null;
}

/** A check that refuses the input outright: the route answers 400 with its message. */
export class ConnectionCheckRefusal extends Error {}

/**
 * Jira Cloud: reads the typed address down to the site URL, checks it is a Jira Cloud site through its public
 * `serverInfo`, then, with credentials, signs in.
 */
async function checkJiraConnection(db: DbClient, input: ConnectionCheckInput): Promise<ConnectionCheckResult> {
  const site = normalizeJiraSiteUrl(input.baseUrl ?? '');
  if (!site) throw new ConnectionCheckRefusal('Enter the site address, e.g. https://your-team.atlassian.net');

  const result: ConnectionCheckResult = { baseUrl: site.url, site: await probeJiraSite(site.url) };
  // An unreachable address answers nothing more with credentials; skip the second wait.
  if (!result.site.reachable) return result;

  const credentials = await credentialsForCheck(db, {
    siteUrl: site.url,
    credentials: input.credentials,
    connectionId: input.connectionId,
  });
  if (!credentials) return result;
  return { ...result, ...(await checkJiraCredentials(site.url, credentials)) };
}

/** Every provider's pre-save check. */
export const CONNECTION_CHECKS: Record<
  IntegrationProviderName,
  (db: DbClient, input: ConnectionCheckInput) => Promise<ConnectionCheckResult>
> = {
  jira: checkJiraConnection,
};
