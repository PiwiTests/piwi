import { eq } from 'drizzle-orm';
import { integrationConnections } from '../../server/database/schema';
import { readTestManagementBinding } from '../../server/utils/integrations/test-management/binding';
import { readCatalogCases, readCatalogInfo } from '../../server/utils/integrations/test-management/catalog';
import type { DrizzleDB } from './db';

/** One case of the stored catalog, as the hover card shows it. `url` is where the tool shows the case, when it has one. */
export interface CatalogCaseView {
  name: string;
  status: string | null;
  url: string | null;
}

export interface CatalogCasesLookup {
  bound: boolean;
  projectKey: string | null;
  /** When the catalog was last read; null while it never was (and then no key is reported as unknown). */
  fetchedAt: string | null;
  /** Each requested key with its case, or null when the catalog holds no such case. */
  cases: Record<string, CatalogCaseView | null>;
}

/**
 * Looks `keys` up in the project's stored catalog. Reads the database only. `caseUrl` says where a provider shows a
 * case (Zephyr documents no address, so it is null); the server passes the provider's own, the demo passes null.
 */
export async function lookupCatalogCases(
  db: DrizzleDB,
  projectId: number,
  keys: readonly string[],
  caseUrl: (provider: string | undefined) => string | null,
): Promise<CatalogCasesLookup> {
  const binding = await readTestManagementBinding(db as never, projectId);
  if (binding.connectionId === null || binding.providerProjectKey === null) {
    return { bound: false, projectKey: null, fetchedAt: null, cases: {} };
  }

  const [connection] = await db
    .select({ provider: integrationConnections.provider })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, binding.connectionId));
  const info = await readCatalogInfo(db as never, binding.connectionId, binding.providerProjectKey);
  const found = new Map(
    (await readCatalogCases(db as never, binding.connectionId, binding.providerProjectKey, keys)).map((c) => [
      c.key,
      c,
    ]),
  );
  const url = caseUrl(connection?.provider);
  return {
    bound: true,
    projectKey: binding.providerProjectKey,
    fetchedAt: info.fetchedAt ? info.fetchedAt.toISOString() : null,
    cases: Object.fromEntries(
      keys.map((key) => {
        const hit = found.get(key);
        return [key, hit ? { name: hit.name, status: hit.status, url } : null];
      }),
    ),
  };
}
