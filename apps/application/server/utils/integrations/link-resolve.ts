import { detectProvider, extractKey, type LinkProvider } from '#shared/link-detect';
import type { IntegrationProviderName } from '#shared/integrations/registry';
import type { DbClient } from '../../database';
import { ensureEnvManagedConnections, getConnectionRow, trackerForRow } from './connections';

/** How a URL resolved: its provider, the connection that recognized it, its key. */
export interface ResolvedLink {
  provider: LinkProvider;
  /** The connection that can read/write this record, or null for a pure link. */
  connectionId: number | null;
  /** The issue key parsed from the URL. */
  key: string | null;
}

/**
 * Resolve a link URL against the connection the link's project is bound to
 * (`projectConnectionId`), so a self-hosted `https://jira.company.com/browse/XYZ-99`
 * is recognized as Jira once the project is bound to that host. Any other URL,
 * one on another connection's site included, falls back to the pure,
 * URL-shape-only `detectProvider` and carries no connection.
 */
export async function detectProviderWithConnection(
  db: DbClient,
  url: string,
  projectConnectionId: number | null,
): Promise<ResolvedLink> {
  if (projectConnectionId != null) {
    await ensureEnvManagedConnections(db);
    const row = await getConnectionRow(db, projectConnectionId);
    const match = row ? trackerForRow(row)?.parseIssueUrl(url) : null;
    if (row && match) {
      return {
        provider: row.provider as IntegrationProviderName as LinkProvider,
        connectionId: row.id,
        key: match.key,
      };
    }
  }
  const provider = detectProvider(url);
  return { provider, connectionId: null, key: extractKey(url, provider) };
}
