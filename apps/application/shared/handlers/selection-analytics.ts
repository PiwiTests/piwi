/**
 * Selection health & drift analytics — read-only aggregates that answer the two
 * questions a selection convention can't answer about itself: has a selection
 * silently drifted from what it last ran, and which tests does no selection
 * cover ("unselected", the gap nobody can see today).
 *
 * Drift is measured against the stamp `piwi run` writes onto a run: the most
 * recent run stamped with a selection recorded the hash and count its definition
 * resolved to then; re-resolving now and comparing surfaces a silent shrink or
 * widening. Coverage counts only stored selections — the built-ins
 * (`quarantine-free` especially) trivially cover the suite and would drown the
 * signal.
 */
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { testRuns } from '../../server/database/schema';
import type { DrizzleDB } from './db';
import type { FilterDetails } from '../types';
import { getQuarantinedCaseIds } from './quarantine';
import { listSelections, loadSelectionCatalog, resolveSelectionDefinition } from './selections';
import type { SelectionWarning } from '../selection';

/** Health of one selection: what it resolves to now, and drift from its last run. */
export interface SelectionHealth {
  key: string;
  name: string;
  builtin: boolean;
  /** Tests the definition resolves to against the current catalog. */
  resolvedCount: number;
  /** Quarantined tests inside the current resolution. */
  quarantinedCount: number;
  /** Estimated summed average duration of the resolution, in ms. */
  totalDurationMs: number | null;
  /** Warnings from resolving (quarantine overlap, budget evictions, …). */
  warnings: SelectionWarning[];
  /** The most recent run `piwi run <key>` stamped, or null if none is on record. */
  lastRun: { runId: number; at: number; recordedCount: number } | null;
  /**
   * Whether the definition now resolves to a different set than that run
   * recorded — a silent drift. Null when there is no stamped run to compare to.
   */
  drift: { changed: boolean; countDelta: number } | null;
}

export interface SelectionCoverage {
  /** Tests in the project's catalog. */
  total: number;
  /** Tests matched by at least one stored (non-built-in) selection. */
  selected: number;
  /** Tests matched by no stored selection: what no selection runs. */
  unselected: number;
  /** A capped sample of unselected tests, for display. */
  unselectedSample: Array<{ testCaseId: number; title: string; filePath: string }>;
}

export interface SelectionAnalytics {
  selections: SelectionHealth[];
  coverage: SelectionCoverage;
}

/** How many recent stamped runs to scan when finding each selection's last run. */
const RECENT_RUN_WINDOW = 1000;
/** Cap on the unselected-tests sample returned for display. */
const UNSELECTED_SAMPLE = 50;

/** The most recent selection stamp per key, from a window of recent filtered runs. */
async function loadLastStamps(
  db: DrizzleDB,
  projectId: number,
): Promise<Map<string, { runId: number; at: number; hash: string; count: number }>> {
  const rows = await db
    .select({ id: testRuns.id, startTime: testRuns.startTime, filterDetails: testRuns.filterDetails })
    .from(testRuns)
    .where(and(eq(testRuns.projectId, projectId), isNotNull(testRuns.filterDetails)))
    .orderBy(desc(testRuns.startTime), desc(testRuns.id))
    .limit(RECENT_RUN_WINDOW);

  const latest = new Map<string, { runId: number; at: number; hash: string; count: number }>();
  for (const row of rows) {
    const stamp = (row.filterDetails as FilterDetails | null)?.selection;
    if (!stamp) continue;
    if (latest.has(stamp.key)) continue; // rows are newest-first, so the first per key wins
    const at = row.startTime instanceof Date ? row.startTime.getTime() : Number(row.startTime ?? 0);
    latest.set(stamp.key, { runId: row.id, at, hash: stamp.resolvedHash, count: stamp.resolvedCount });
  }
  return latest;
}

/**
 * Compute health for every selection in a project and the suite-wide coverage.
 * One catalog load is shared across every resolution, so this stays a handful of
 * queries regardless of how many selections a project keeps.
 */
export async function getSelectionAnalytics(db: DrizzleDB, projectId: number): Promise<SelectionAnalytics> {
  const catalog = await loadSelectionCatalog(db, projectId, { withFailRanks: true });
  const quarantined = await getQuarantinedCaseIds(db, projectId);
  const selections = await listSelections(db, projectId);
  const lastStamps = await loadLastStamps(db, projectId);

  const selectedIds = new Set<number>();
  const health: SelectionHealth[] = [];

  for (const selection of selections) {
    const resolved = await resolveSelectionDefinition(db, projectId, selection.definition, {
      key: selection.key,
      format: 'json',
      catalog,
    });
    const ids = resolved.tests.map((t) => t.testCaseId);
    if (!selection.builtin) for (const id of ids) selectedIds.add(id);

    const stamp = lastStamps.get(selection.key) ?? null;
    health.push({
      key: selection.key,
      name: selection.name,
      builtin: selection.builtin ?? false,
      resolvedCount: ids.length,
      quarantinedCount: ids.filter((id) => quarantined.has(id)).length,
      totalDurationMs: resolved.estimate.totalDurationMs,
      warnings: resolved.warnings,
      lastRun: stamp ? { runId: stamp.runId, at: stamp.at, recordedCount: stamp.count } : null,
      drift: stamp ? { changed: stamp.hash !== resolved.resolvedHash, countDelta: ids.length - stamp.count } : null,
    });
  }

  const unselected = catalog
    .filter((row) => !selectedIds.has(row.id))
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.title.localeCompare(b.title) || a.id - b.id);
  return {
    selections: health,
    coverage: {
      total: catalog.length,
      selected: selectedIds.size,
      unselected: unselected.length,
      unselectedSample: unselected
        .slice(0, UNSELECTED_SAMPLE)
        .map((row) => ({ testCaseId: row.id, title: row.title, filePath: row.filePath })),
    },
  };
}
