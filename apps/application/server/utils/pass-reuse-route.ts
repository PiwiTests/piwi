/**
 * What the plan routes share: the capability check, the request's fingerprint
 * and diffs, and the summary every answer carries.
 */
import { isOptInCapabilityOn } from '#shared/handlers/capabilities';
import type { DrizzleDB } from '#shared/handlers/db';
import { apiError } from './api-error';
import { parseImpactChanges } from './selection-impact';
import { MAX_SOURCE_COMMITS, type ReuseFingerprint, type SourceDiff, type StoredRunPlan } from './pass-reuse';

const COMMIT_ID = /^[0-9a-f]{7,64}$/i;
/** Changed files one diff carries at most, as impact takes them. */
const MAX_CHANGED_FILES = 5000;

/** 403 unless an administrator turned pass reuse on and the project did not decline it. */
export async function requirePassReuseOn(db: DrizzleDB, projectId: number): Promise<void> {
  if (!(await isOptInCapabilityOn(db, projectId, 'pass-reuse'))) {
    throw apiError({ statusCode: 403, message: 'Pass reuse is off for this project' });
  }
}

/** The selection key a request plans; 400 without one. */
export function parseSelectionKey(raw: unknown): string {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) throw apiError({ statusCode: 400, message: 'A selection key is required ("full" plans the whole suite)' });
  return key;
}

export function parseFingerprint(raw: unknown): ReuseFingerprint {
  const version = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 64) : null;
  return { playwrightVersion: version };
}

/** A commit id, or null when absent or malformed. */
export function parseCommit(raw: unknown): string | null {
  return typeof raw === 'string' && COMMIT_ID.test(raw.trim()) ? raw.trim().toLowerCase() : null;
}

/** The diffs a client sends, one per source commit it could read; 400 on a malformed one. */
export function parseSourceDiffs(raw: unknown): SourceDiff[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_SOURCE_COMMITS) {
    throw apiError({ statusCode: 400, message: `diffs must be an array of at most ${MAX_SOURCE_COMMITS} entries` });
  }
  return raw.map((entry) => {
    const item = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const commit = parseCommit(item.commit);
    if (!commit) throw apiError({ statusCode: 400, message: 'Each diff needs the commit it was computed from' });
    const changedFiles = Array.isArray(item.changedFiles)
      ? item.changedFiles.filter((f): f is string => typeof f === 'string')
      : [];
    if (changedFiles.length > MAX_CHANGED_FILES) {
      throw apiError({ statusCode: 400, message: `A diff carries at most ${MAX_CHANGED_FILES} changed files` });
    }
    return { commit, changedFiles, changes: parseImpactChanges(item.changes) };
  });
}

/** The counts and reasons every plan answer carries. */
export function planSummary(plan: StoredRunPlan) {
  return {
    selection: plan.selection,
    counts: { candidates: plan.run.length + plan.reused.length, run: plan.run.length, reused: plan.reused.length },
    reasons: plan.reasons,
  };
}
