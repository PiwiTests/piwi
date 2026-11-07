import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { testRunEnvironmentSnapshots } from '../../server/database/schema';
import type { DrizzleDB } from './db';
import {
  ENVIRONMENT_SNAPSHOTS_MAX,
  environmentDigest,
  environmentScope,
  groupEnvironments,
  sanitizeEnvironmentSnapshot,
  sanitizeEnvironmentSnapshots,
  type RunEnvironments,
} from '#shared/environment-snapshots';
import type { EnvironmentKind, WireEnvironmentSnapshot } from '#shared/types';

/**
 * A run's environment snapshots, one row per run, kind and scope. A delivery replaces the row it names whole, in one
 * statement, so shards writing at the same time never overwrite each other's rows and a retried delivery replaces its
 * own. Shared by the server's ingest paths and the demo's.
 */

/**
 * Store the delivered snapshots of a run: each read field by field (`sanitizeEnvironmentSnapshots`), its digest
 * computed, the row of its kind and scope replaced. A run keeps at most `ENVIRONMENT_SNAPSHOTS_MAX` rows: a new scope
 * past that is dropped. Never throws for a malformed body.
 */
export async function saveEnvironmentSnapshots(db: DrizzleDB, runId: number, delivered: unknown): Promise<void> {
  const snapshots = sanitizeEnvironmentSnapshots(delivered);
  if (snapshots.length === 0) return;
  const existing = await db
    .select({ kind: testRunEnvironmentSnapshots.kind, scope: testRunEnvironmentSnapshots.scope })
    .from(testRunEnvironmentSnapshots)
    .where(eq(testRunEnvironmentSnapshots.runId, runId));
  const known = new Set(existing.map((row) => `${row.kind}\u0000${row.scope}`));
  const now = new Date();
  for (const snapshot of snapshots) {
    const scope = environmentScope(snapshot);
    const key = `${snapshot.kind}\u0000${scope}`;
    if (!known.has(key)) {
      if (known.size >= ENVIRONMENT_SNAPSHOTS_MAX) continue;
      known.add(key);
    }
    const digest = environmentDigest(snapshot);
    await db
      .insert(testRunEnvironmentSnapshots)
      .values({ runId, kind: snapshot.kind, scope, snapshot, digest, capturedAt: now })
      .onConflictDoUpdate({
        target: [
          testRunEnvironmentSnapshots.runId,
          testRunEnvironmentSnapshots.kind,
          testRunEnvironmentSnapshots.scope,
        ],
        set: { snapshot, digest, capturedAt: now },
      });
  }
}

/** Every snapshot of a run, read back field by field. */
export async function loadRunSnapshots(db: DrizzleDB, runId: number): Promise<WireEnvironmentSnapshot[]> {
  const rows = await db
    .select({ snapshot: testRunEnvironmentSnapshots.snapshot })
    .from(testRunEnvironmentSnapshots)
    .where(eq(testRunEnvironmentSnapshots.runId, runId))
    .orderBy(asc(testRunEnvironmentSnapshots.kind), asc(testRunEnvironmentSnapshots.scope))
    .limit(ENVIRONMENT_SNAPSHOTS_MAX);
  return rows.map((row) => sanitizeEnvironmentSnapshot(row.snapshot)).filter((s): s is WireEnvironmentSnapshot => !!s);
}

/** A run's snapshots grouped by kind: runners by shard, browsers by shard and project, servers by origin. */
export async function loadRunEnvironments(db: DrizzleDB, runId: number): Promise<RunEnvironments> {
  return groupEnvironments(await loadRunSnapshots(db, runId));
}

/** The snapshots of several runs, by run id; a run without any is absent. */
export async function loadRunsSnapshots(
  db: DrizzleDB,
  runIds: readonly number[],
  kinds?: readonly EnvironmentKind[],
): Promise<Map<number, WireEnvironmentSnapshot[]>> {
  const out = new Map<number, WireEnvironmentSnapshot[]>();
  const ids = [...new Set(runIds)];
  if (ids.length === 0) return out;
  const conds = [inArray(testRunEnvironmentSnapshots.runId, ids)];
  if (kinds?.length) conds.push(inArray(testRunEnvironmentSnapshots.kind, [...kinds]));
  const rows = await db
    .select({ runId: testRunEnvironmentSnapshots.runId, snapshot: testRunEnvironmentSnapshots.snapshot })
    .from(testRunEnvironmentSnapshots)
    .where(and(...conds))
    .orderBy(desc(testRunEnvironmentSnapshots.runId), asc(testRunEnvironmentSnapshots.scope));
  for (const row of rows) {
    const snapshot = sanitizeEnvironmentSnapshot(row.snapshot);
    if (!snapshot) continue;
    const list = out.get(row.runId) ?? [];
    list.push(snapshot);
    out.set(row.runId, list);
  }
  return out;
}
