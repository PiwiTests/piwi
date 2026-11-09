import { and, eq } from 'drizzle-orm';
import { markers, testRuns } from '../../server/database/schema';
import type { KeepSource } from '../types';
import { normalizeKeepReason } from '../run-keep';
import { isPrivateRunOrigin } from '../run-eligibility';
import type { DrizzleDB } from './db';

/** The keep columns of a run nothing protects. */
const NOT_KEPT = { keptAt: null, keptBy: null, keepSource: null, keepReason: null } as const;

/**
 * Keep a run the reporter asked to keep (`keep: true` in a start, setup,
 * submit, upload or finish body). Any shard may ask; the first ask wins and
 * the rest are no-ops, as is a body without the flag.
 */
export async function applyReporterKeep(db: DrizzleDB, runId: number, keep: unknown): Promise<void> {
  if (keep === true) await keepRun(db, runId, { source: 'reporter' });
}

/** Whether the run is kept forever. A missing run is not kept. */
export async function isRunKept(db: DrizzleDB, runId: number): Promise<boolean> {
  const [run] = await db.select({ keptAt: testRuns.keptAt }).from(testRuns).where(eq(testRuns.id, runId));
  return !!run?.keptAt;
}

/** The refusal a delete of a kept run answers with (HTTP 409). */
export function keptRunDeleteMessage(runId: number): string {
  return `Run #${runId} is kept forever. Release it before deleting it.`;
}

/**
 * Keep a run forever: retention never deletes it. Keeping a run that is
 * already kept only replaces its reason, and only when one is given — the
 * original time, author and source stay. A private run is never kept.
 */
export async function keepRun(
  db: DrizzleDB,
  runId: number,
  input: { source: KeepSource; userId?: number | null; reason?: string | null },
): Promise<void> {
  const [run] = await db
    .select({ keptAt: testRuns.keptAt, origin: testRuns.origin })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  if (!run) throw new Error('Test run not found');
  if (isPrivateRunOrigin(run.origin)) return;

  if (run.keptAt) {
    if (input.reason !== undefined) {
      await db
        .update(testRuns)
        .set({ keepReason: normalizeKeepReason(input.reason), updatedAt: new Date() })
        .where(eq(testRuns.id, runId));
    }
    return;
  }

  await db
    .update(testRuns)
    .set({
      keptAt: new Date(),
      keptBy: input.userId || null,
      keepSource: input.source,
      keepReason: normalizeKeepReason(input.reason),
      updatedAt: new Date(),
    })
    .where(eq(testRuns.id, runId));
}

/** Release a kept run: it becomes subject to retention again. */
export async function releaseRun(db: DrizzleDB, runId: number): Promise<void> {
  await db
    .update(testRuns)
    .set({ ...NOT_KEPT, updatedAt: new Date() })
    .where(eq(testRuns.id, runId));
}

/**
 * Align a run's keep with its release markers: a run linked to a `release`
 * marker is kept, with the marker's label as the reason. When the last such
 * marker goes (deleted, or recategorized), a keep the marker created is
 * released; a keep a person or the reporter made is never touched.
 */
export async function syncReleaseMarkerKeep(db: DrizzleDB, runId: number | null | undefined): Promise<void> {
  if (!runId) return;
  const [run] = await db
    .select({ keptAt: testRuns.keptAt, keepSource: testRuns.keepSource })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  if (!run) return;

  const [release] = await db
    .select({ label: markers.label })
    .from(markers)
    .where(and(eq(markers.runId, runId), eq(markers.category, 'release')))
    .limit(1);

  if (release && !run.keptAt) {
    await keepRun(db, runId, { source: 'marker', reason: release.label });
  } else if (!release && run.keptAt && run.keepSource === 'marker') {
    await releaseRun(db, runId);
  }
}
