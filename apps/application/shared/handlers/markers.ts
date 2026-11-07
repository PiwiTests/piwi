import { markers, testRuns } from '../../server/database/schema';
import { eq, and, asc, desc, lt, ne } from 'drizzle-orm';
import { notPrivateRun } from '../run-eligibility';

import { DEFAULT_MARKER_CATEGORY, MARKER_CATEGORY_IDS } from '../marker-categories';
import type { DrizzleDB } from './db';
import { syncReleaseMarkerKeep } from './run-keep';

export interface MarkerInput {
  label: string;
  occurredAt: Date;
  category?: string;
  environment?: string | null;
  description?: string | null;
  runId?: number | null;
}

function normalizeCategory(category: string | undefined | null): string {
  return category && MARKER_CATEGORY_IDS.includes(category) ? category : DEFAULT_MARKER_CATEGORY;
}

export async function listProjectMarkers(db: DrizzleDB, projectId: number) {
  const rows = await db.select().from(markers).where(eq(markers.projectId, projectId)).orderBy(asc(markers.occurredAt));
  return { markers: rows };
}

/** A marker may link only to a run of its own project, never a private run. */
export async function markerRunBelongsToProject(db: DrizzleDB, projectId: number, runId: number): Promise<boolean> {
  const rows = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(eq(testRuns.id, runId), eq(testRuns.projectId, projectId), notPrivateRun(testRuns.origin)));
  return rows.length > 0;
}

export async function createMarker(db: DrizzleDB, projectId: number, data: MarkerInput) {
  const result = await db
    .insert(markers)
    .values({
      projectId,
      label: data.label,
      occurredAt: data.occurredAt,
      category: normalizeCategory(data.category),
      environment: data.environment ?? null,
      description: data.description ?? null,
      runId: data.runId ?? null,
      source: 'manual',
    })
    .returning();
  await syncReleaseMarkerKeep(db, result[0]!.runId);
  return { success: true, marker: result[0]! };
}

export async function updateMarker(db: DrizzleDB, id: number, data: Partial<Omit<MarkerInput, 'runId'>>) {
  const existing = await db.select().from(markers).where(eq(markers.id, id));
  if (!existing[0]) throw new Error('Marker not found');

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.label !== undefined) updates.label = data.label;
  if (data.occurredAt !== undefined) updates.occurredAt = data.occurredAt;
  if (data.category !== undefined) updates.category = normalizeCategory(data.category);
  if (data.environment !== undefined) updates.environment = data.environment;
  if (data.description !== undefined) updates.description = data.description;

  await db.update(markers).set(updates).where(eq(markers.id, id));
  await syncReleaseMarkerKeep(db, existing[0].runId);
  const updated = await db.select().from(markers).where(eq(markers.id, id));
  return { success: true, marker: updated[0]! };
}

export async function deleteMarker(db: DrizzleDB, id: number) {
  const existing = await db.select().from(markers).where(eq(markers.id, id));
  if (!existing[0]) throw new Error('Marker not found');
  await db.delete(markers).where(eq(markers.id, id));
  await syncReleaseMarkerKeep(db, existing[0].runId);
  return { success: true };
}

/**
 * Auto-create a timeline marker when a finished run's tooling versions changed
 * from the previous run in the same environment. Conservative (only high-signal
 * changes) and idempotent (skips when an auto marker for this run already
 * exists). Gated by PIWI_AUTO_MARKERS — disabled only when explicitly "false".
 */
export async function syncAutoMarkersForRun(db: DrizzleDB, runId: number): Promise<void> {
  const autoDisabled = typeof process !== 'undefined' && process.env?.PIWI_AUTO_MARKERS === 'false';
  if (autoDisabled) return;

  const runRows = await db.select().from(testRuns).where(eq(testRuns.id, runId));
  const run = runRows[0];
  if (!run) return;

  // Don't duplicate an auto marker for this run. The run's incident marker is
  // a different event and does not count.
  const alreadyMarked = await db
    .select({ id: markers.id })
    .from(markers)
    .where(and(eq(markers.runId, runId), eq(markers.source, 'auto'), ne(markers.category, 'incident')));
  if (alreadyMarked.length > 0) return;

  // Previous runs of this project, most recent first. Filter to the same
  // environment (null-safe) in JS so environment lineages stay independent.
  const candidates = await db
    .select()
    .from(testRuns)
    .where(
      and(eq(testRuns.projectId, run.projectId), lt(testRuns.startTime, run.startTime), notPrivateRun(testRuns.origin)),
    )
    .orderBy(desc(testRuns.startTime))
    .limit(25);
  const prev = candidates.find((c) => (c.environment ?? null) === (run.environment ?? null));
  if (!prev) return;

  const changes: string[] = [];
  if (prev.playwrightVersion && run.playwrightVersion && prev.playwrightVersion !== run.playwrightVersion) {
    changes.push(`Playwright ${prev.playwrightVersion} → ${run.playwrightVersion}`);
  }
  if (prev.reporterVersion && run.reporterVersion && prev.reporterVersion !== run.reporterVersion) {
    changes.push(`Reporter ${prev.reporterVersion} → ${run.reporterVersion}`);
  }
  if (changes.length === 0) return;

  await db.insert(markers).values({
    projectId: run.projectId,
    label: changes.join(', '),
    occurredAt: run.startTime,
    category: 'config',
    environment: run.environment ?? null,
    source: 'auto',
    runId: run.id,
  });
}
