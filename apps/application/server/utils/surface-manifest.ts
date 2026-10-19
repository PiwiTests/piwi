/**
 * Declared-surface ingest: turn a manifest (uploaded by the reporter, or fetched
 * from a project's OpenAPI URL by `openapi-surface.ts`) into
 * `route`/`page`/`handler` graph nodes. The pure builder
 * ({@link import('#shared/graph').buildManifestGraph}) does the shaping; this
 * module resolves the run id to stamp and writes the nodes. It makes no network
 * call, so the demo's service worker can import it.
 */

import { desc, eq } from 'drizzle-orm';
import { testRuns } from '../database/schema';
import { ingestManifestGraph } from './graph-ingest';
import type { AppManifest, ManifestSource } from '#shared/types';
import type { DrizzleDB } from '#shared/handlers/db';
import type { DbClient } from '../database';

/** Accepts both the server client and the demo's in-browser SQLite client. */
type DB = DrizzleDB;

/** The most recent run id for a project, used to stamp declared nodes' last-seen. */
export async function latestRunId(db: DB, projectId: number): Promise<number> {
  const rows = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(eq(testRuns.projectId, projectId))
    .orderBy(desc(testRuns.id))
    .limit(1);
  return rows[0]?.id ?? 0;
}

/**
 * Ingest a declared manifest for a project as canonical graph nodes. Failures are
 * swallowed to a boolean so the caller (an upload endpoint or a recompute) is
 * never broken by a graph write.
 */
export async function ingestProjectManifest(
  db: DB,
  projectId: number,
  manifest: AppManifest,
  source: ManifestSource,
  options: { branch?: string | null } = {},
): Promise<boolean> {
  try {
    const runId = await latestRunId(db, projectId);
    await ingestManifestGraph(db as DbClient, projectId, runId, manifest, source, { branch: options.branch ?? null });
    return true;
  } catch {
    return false;
  }
}
