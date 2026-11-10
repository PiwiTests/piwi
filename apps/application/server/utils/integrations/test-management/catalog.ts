/**
 * Reading the stored test case catalog: a cached copy of the case keys of a provider project, kept in
 * `test_management_cases`. These reads touch the database only, so a screen can ask as often as it needs.
 */
import { and, count, eq, inArray, max } from 'drizzle-orm';
import type { DbClient } from '../../../database';
import { testManagementCases } from '../../../database/schema';

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

/** The size of a project's catalog and when it was last read; `{ size: 0, fetchedAt: null }` while it never was. */
export async function readCatalogInfo(db: DbClient, connectionId: number, projectKey: string): Promise<CatalogInfo> {
  const [row] = await db
    .select({ size: count(), fetchedAt: max(testManagementCases.fetchedAt) })
    .from(testManagementCases)
    .where(and(eq(testManagementCases.connectionId, connectionId), eq(testManagementCases.projectKey, projectKey)));
  const fetchedAt = row?.fetchedAt ? new Date(row.fetchedAt) : null;
  return { size: Number(row?.size ?? 0), fetchedAt };
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
