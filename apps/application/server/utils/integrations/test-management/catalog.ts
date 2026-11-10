/**
 * Reading the stored test case catalog: a cached copy of the case keys of a provider project, kept in
 * `test_management_cases`. These reads touch the database only, so a screen can ask as often as it needs. The read from
 * the tool is in `catalog-refresh.ts`.
 */
import { and, count, eq, inArray, max } from 'drizzle-orm';
import type { DbClient } from '../../../database';
import { testManagementCases, testManagementCatalogReads } from '../../../database/schema';

export interface CatalogInfo {
  /** How many cases the catalog holds. */
  size: number;
  /** When the catalog was last read from the tool, or null when it never was. */
  fetchedAt: Date | null;
}

export interface CatalogCase {
  key: string;
  name: string;
  status: string | null;
  folder: string | null;
}

/**
 * The size of a project's catalog and when it was last read; `{ size: 0, fetchedAt: null }` while it never was. The time
 * is the one a read recorded, so a project with no cases at all still counts as read. A catalog stored before reads were
 * recorded has none, and the newest of its case rows stands in.
 */
export async function readCatalogInfo(db: DbClient, connectionId: number, projectKey: string): Promise<CatalogInfo> {
  const [cases] = await db
    .select({ size: count(), newest: max(testManagementCases.fetchedAt) })
    .from(testManagementCases)
    .where(and(eq(testManagementCases.connectionId, connectionId), eq(testManagementCases.projectKey, projectKey)));
  const [read] = await db
    .select({ fetchedAt: testManagementCatalogReads.fetchedAt })
    .from(testManagementCatalogReads)
    .where(
      and(
        eq(testManagementCatalogReads.connectionId, connectionId),
        eq(testManagementCatalogReads.projectKey, projectKey),
      ),
    );
  const stamp = read?.fetchedAt ?? cases?.newest ?? null;
  return { size: Number(cases?.size ?? 0), fetchedAt: stamp ? new Date(stamp) : null };
}

/** The catalog's cases among `keys`. Keys the catalog does not hold are left out. */
export async function readCatalogCases(
  db: DbClient,
  connectionId: number,
  projectKey: string,
  keys: readonly string[],
): Promise<CatalogCase[]> {
  if (keys.length === 0) return [];
  const rows = await db
    .select({
      key: testManagementCases.key,
      name: testManagementCases.name,
      status: testManagementCases.statusName,
      folder: testManagementCases.folder,
    })
    .from(testManagementCases)
    .where(
      and(
        eq(testManagementCases.connectionId, connectionId),
        eq(testManagementCases.projectKey, projectKey),
        inArray(testManagementCases.key, [...keys]),
      ),
    );
  return rows;
}

/** Every key of a project's catalog, for the mapping summary. */
export async function readCatalogKeys(db: DbClient, connectionId: number, projectKey: string): Promise<string[]> {
  const rows = await db
    .select({ key: testManagementCases.key })
    .from(testManagementCases)
    .where(and(eq(testManagementCases.connectionId, connectionId), eq(testManagementCases.projectKey, projectKey)));
  return rows.map((row) => row.key);
}
