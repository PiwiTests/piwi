/**
 * Detector precision from triage verdicts — the learning loop. Every triage is a
 * labeled example: accepted and covered-by count for the detector, a gap dismissed
 * as wrong or as covered elsewhere (no test was missing) counts against, and a
 * dismissal with no reason or as not worth testing counts for nothing. A
 * detector below the threshold on a project with enough
 * verdicts mutes itself there: its rows drop out of the pull-request comment
 * first, and the Gaps view says so. Beside the verdicts, the outcome no one
 * triages: how many of the gaps a detector raised on a pull request that pull
 * request acted on (a test it added answered the gap before it merged).
 *
 * The scoring core is pure so the demo and the tests run it; the loader reads the
 * gaps and the manual reaches edges a covered-by wrote.
 */

import { and, eq, notInArray } from 'drizzle-orm';
import { scenarioGaps } from '../../server/database/schema';
import type { DrizzleDB } from './db';

/**
 * Detectors the recompute does not run. Their rows stay in the ledger with the
 * verdicts people gave, but they have no precision to report: nothing they would
 * raise is left to mute. `api-only-route` claimed a route was reached only by
 * request fixtures, which no observed route can be, since network capture records
 * only the page's own requests.
 */
export const RETIRED_DETECTORS = ['api-only-route'];

/** A detector mutes itself below this precision, once it has enough verdicts. */
export const MUTE_PRECISION_THRESHOLD = 0.6;
export const MUTE_MIN_VERDICTS = 20;

/** One triage verdict for a detector: it was right (`for`) or wrong (`against`). */
export interface DetectorVerdict {
  detector: string;
  verdict: 'for' | 'against';
}

/** One gap a detector raised on a pull request, and whether that pull request acted on it. */
export interface DetectorOutcome {
  detector: string;
  actedOn: boolean;
}

/** A detector's precision on a project, and whether it has muted itself. */
export interface DetectorPrecision {
  detector: string;
  for: number;
  against: number;
  verdicts: number;
  /** for / (for + against), or null when there are no verdicts. */
  precision: number | null;
  muted: boolean;
  /** The gaps it raised on a pull request. */
  pullRequestGaps: number;
  /** Of those, the ones closed as acted on: answered while the pull request was open. */
  actedOn: number;
}

/** True when a detector's precision is low enough, with enough verdicts, to mute. */
export function isDetectorMuted(precision: number | null, verdicts: number): boolean {
  return precision != null && verdicts >= MUTE_MIN_VERDICTS && precision < MUTE_PRECISION_THRESHOLD;
}

/**
 * Fold triage verdicts into per-detector precision, with the pull-request
 * outcomes beside it. Pure: the loader turns gap rows into the lists this scores.
 */
export function computeDetectorPrecision(
  verdicts: DetectorVerdict[],
  outcomes: DetectorOutcome[] = [],
): DetectorPrecision[] {
  const byDetector = new Map<string, { for: number; against: number; pullRequestGaps: number; actedOn: number }>();
  const entryOf = (detector: string) => {
    const entry = byDetector.get(detector) ?? { for: 0, against: 0, pullRequestGaps: 0, actedOn: 0 };
    byDetector.set(detector, entry);
    return entry;
  };
  for (const v of verdicts) {
    const entry = entryOf(v.detector);
    if (v.verdict === 'for') entry.for++;
    else entry.against++;
  }
  for (const o of outcomes) {
    const entry = entryOf(o.detector);
    entry.pullRequestGaps++;
    if (o.actedOn) entry.actedOn++;
  }
  return [...byDetector.entries()]
    .map(([detector, { for: forCount, against, pullRequestGaps, actedOn }]) => {
      const total = forCount + against;
      const precision = total > 0 ? forCount / total : null;
      return {
        detector,
        for: forCount,
        against,
        verdicts: total,
        precision,
        muted: isDetectorMuted(precision, total),
        pullRequestGaps,
        actedOn,
      };
    })
    .sort((a, b) => (a.precision ?? 1) - (b.precision ?? 1));
}

/**
 * Load a project's per-detector precision from its triage verdicts. A verdict is
 * the action a human took, recorded durably on the gap, not a reading of its
 * current status: a gap that was **accepted** or marked **covered-by** counts
 * *for* its detector even after it later closes, and a gap **dismissed as wrong**
 * or as **covered elsewhere** counts *against*. A covered-by credits only the
 * gap it was given on (its own `covered_at`), never every detector that happens
 * to share the subject node. Every gap raised on a pull request is an outcome,
 * acted on when it closed as `acted-on`.
 */
export async function loadDetectorPrecision(db: DrizzleDB, projectId: number): Promise<DetectorPrecision[]> {
  const rows = await db
    .select({
      detector: scenarioGaps.detector,
      kind: scenarioGaps.kind,
      status: scenarioGaps.status,
      dismissReason: scenarioGaps.dismissReason,
      acceptedAt: scenarioGaps.acceptedAt,
      coveredAt: scenarioGaps.coveredAt,
      prNumber: scenarioGaps.prNumber,
      closeReason: scenarioGaps.closeReason,
    })
    .from(scenarioGaps)
    .where(and(eq(scenarioGaps.projectId, projectId), notInArray(scenarioGaps.detector, RETIRED_DETECTORS)));

  const verdicts: DetectorVerdict[] = [];
  const outcomes: DetectorOutcome[] = [];
  for (const r of rows) {
    if (r.prNumber != null) outcomes.push({ detector: r.detector, actedOn: r.closeReason === 'acted-on' });
    const noTestMissing = r.dismissReason === 'covered-elsewhere' && r.kind !== 'finding';
    if (r.status === 'dismissed' && (r.dismissReason === 'wrong' || noTestMissing)) {
      verdicts.push({ detector: r.detector, verdict: 'against' });
    } else if (r.status === 'accepted' || r.acceptedAt != null || r.coveredAt != null) {
      verdicts.push({ detector: r.detector, verdict: 'for' });
    }
  }
  return computeDetectorPrecision(verdicts, outcomes);
}

/** The set of detectors muted on a project — read by the PR comment and the tab. */
export async function loadMutedDetectors(db: DrizzleDB, projectId: number): Promise<Set<string>> {
  const precision = await loadDetectorPrecision(db, projectId);
  return new Set(precision.filter((p) => p.muted).map((p) => p.detector));
}
