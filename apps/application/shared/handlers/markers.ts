import { environments, markers, testRuns } from '../../server/database/schema';
import { eq, and, asc, desc, isNull, like, lt, ne, notLike, or, sql } from 'drizzle-orm';
import { eligibleRunSql, isEligibleRun, notPrivateRun } from '../run-eligibility';
import { loadRunsSnapshots } from './environment-snapshots';
import { isPassiveCapabilityDeclined } from './capabilities';
import { ENVIRONMENT_MARKER_PREFIX, environmentChangeMarkers } from '../environment-snapshots';

import { DEFAULT_MARKER_CATEGORY, MARKER_CATEGORY_IDS } from '../marker-categories';
import type { DrizzleDB } from './db';
import { syncReleaseMarkerKeep } from './run-keep';
import { resolveRunEnvironment } from './environments';
import { deployedCommitOf } from '@piwitests/core/deployed-commit';

export interface MarkerInput {
  label: string;
  occurredAt: Date;
  category?: string;
  /** The environment's label: a key, an alias or a run's label, resolved as a run's (`resolveRunEnvironment`). */
  environment?: string | null;
  /** A deploy marker's deployed commit: 7 to 40 hexadecimal characters (`deployedCommitOf`). */
  commit?: string | null;
  description?: string | null;
  runId?: number | null;
}

function normalizeCategory(category: string | undefined | null): string {
  return category && MARKER_CATEGORY_IDS.includes(category) ? category : DEFAULT_MARKER_CATEGORY;
}

/** A project's markers, oldest first, each with the name of the environment it names (`environmentName`). */
export async function listProjectMarkers(db: DrizzleDB, projectId: number) {
  const rows = await db
    .select({ marker: markers, environmentName: environments.name })
    .from(markers)
    .leftJoin(environments, eq(environments.id, markers.environmentId))
    .where(eq(markers.projectId, projectId))
    .orderBy(asc(markers.occurredAt));
  return { markers: rows.map((row) => ({ ...row.marker, environmentName: row.environmentName ?? null })) };
}

/** A marker may link only to a run of its own project, never a private run. */
export async function markerRunBelongsToProject(db: DrizzleDB, projectId: number, runId: number): Promise<boolean> {
  const rows = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(eq(testRuns.id, runId), eq(testRuns.projectId, projectId), notPrivateRun(testRuns.origin)));
  return rows.length > 0;
}

/**
 * Store a marker: its environment label resolves as a run's does, discovering an environment nothing takes, and a
 * commit is kept only when it is one (`deployedCommitOf`).
 */
export async function createMarker(db: DrizzleDB, projectId: number, data: MarkerInput) {
  const result = await db
    .insert(markers)
    .values({
      projectId,
      label: data.label,
      occurredAt: data.occurredAt,
      category: normalizeCategory(data.category),
      ...(await resolveRunEnvironment(db, projectId, data.environment ?? null)),
      commit: deployedCommitOf(data.commit),
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
  if (data.environment !== undefined) {
    Object.assign(updates, await resolveRunEnvironment(db, existing[0].projectId, data.environment));
  }
  if (data.commit !== undefined) updates.commit = deployedCommitOf(data.commit);
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

/** What decides a run's environment lineage: the environment its label resolved to, else the label. */
interface RunEnvironmentOf {
  environment: string | null;
  environmentId: number | null;
}

/**
 * Whether two runs are of one environment lineage: the same environment, else, for two runs with none, the same label
 * ignoring case (no label being one lineage too).
 */
function sameEnvironmentLineage(a: RunEnvironmentOf, b: RunEnvironmentOf): boolean {
  if (a.environmentId != null || b.environmentId != null) return a.environmentId === b.environmentId;
  return (a.environment ?? '').toLowerCase() === (b.environment ?? '').toLowerCase();
}

/** The runs of `run`'s environment lineage (`sameEnvironmentLineage`), as SQL over `test_runs`. */
function environmentLineageSql(run: RunEnvironmentOf) {
  if (run.environmentId != null) return eq(testRuns.environmentId, run.environmentId);
  return and(
    isNull(testRuns.environmentId),
    run.environment == null
      ? isNull(testRuns.environment)
      : sql`lower(${testRuns.environment}) = ${run.environment.toLowerCase()}`,
  );
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
    .where(
      and(
        eq(markers.runId, runId),
        eq(markers.source, 'auto'),
        ne(markers.category, 'incident'),
        or(isNull(markers.description), notLike(markers.description, `${ENVIRONMENT_MARKER_PREFIX}%`)),
      ),
    );
  if (alreadyMarked.length > 0) return;

  // Previous runs of this project, most recent first. Filter to the same
  // environment lineage in JS so environment lineages stay independent.
  const candidates = await db
    .select()
    .from(testRuns)
    .where(
      and(eq(testRuns.projectId, run.projectId), lt(testRuns.startTime, run.startTime), notPrivateRun(testRuns.origin)),
    )
    .orderBy(desc(testRuns.startTime))
    .limit(25);
  const prev = candidates.find((c) => sameEnvironmentLineage(c, run));
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
    environmentId: run.environmentId ?? null,
    source: 'auto',
    runId: run.id,
  });
}

/**
 * Auto-create one timeline marker per kind of environment that changed between a finished run and the previous
 * eligible run on the same branch and environment lineage (`sameEnvironmentLineage`): its runner or browser (category `infra`), or a server under
 * test (`config`), labeled with the fields that changed. A kind either run did not record is no change, so a change
 * is marked once, on the run where it appeared. Idempotent per run and kind; gated by `PIWI_AUTO_MARKERS` like
 * `syncAutoMarkersForRun`, and by the project's `markers` capability.
 */
export async function syncEnvironmentMarkersForRun(db: DrizzleDB, runId: number): Promise<void> {
  if (typeof process !== 'undefined' && process.env?.PIWI_AUTO_MARKERS === 'false') return;
  const [run] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
  if (!run || !isEligibleRun(run, 'baseline')) return;
  if (await isPassiveCapabilityDeclined(db, run.projectId, 'markers')) return;

  const conds = [
    eq(testRuns.projectId, run.projectId),
    lt(testRuns.startTime, run.startTime),
    eligibleRunSql('baseline'),
    environmentLineageSql(run),
    run.branch == null ? isNull(testRuns.branch) : eq(testRuns.branch, run.branch),
  ];
  const [prev] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(...conds))
    .orderBy(desc(testRuns.startTime))
    .limit(1);
  if (!prev) return;

  const snapshots = await loadRunsSnapshots(db, [prev.id, run.id]);
  const before = snapshots.get(prev.id) ?? [];
  const after = snapshots.get(run.id) ?? [];
  const marked = await db
    .select({ description: markers.description })
    .from(markers)
    .where(
      and(
        eq(markers.runId, runId),
        eq(markers.source, 'auto'),
        like(markers.description, `${ENVIRONMENT_MARKER_PREFIX}%`),
      ),
    );

  for (const change of environmentChangeMarkers(before, after)) {
    if (marked.some((m) => m.description === change.description)) continue;
    await db.insert(markers).values({
      projectId: run.projectId,
      label: change.label,
      description: change.description,
      occurredAt: run.startTime,
      category: change.category,
      environment: run.environment ?? null,
      environmentId: run.environmentId ?? null,
      source: 'auto',
      runId: run.id,
    });
  }
}
