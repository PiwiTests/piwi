/**
 * Gap classes ranked by how loudly they should be shown. The graph views color
 * a node by its worst open gap and rank neighbors by it, and the feature map
 * colors a feature by the worst gap under it — all with this one order, so a
 * red feature on the map is red for the same reason a red node is red. With them,
 * the reasons a gap closes. Pure,
 * shared by the server, the demo and the app.
 */

/** Severity per class, higher first; an unknown class ranks lowest among gaps. */
const SEVERITY: Record<string, number> = {
  unhandled: 5,
  'false-comfort': 4,
  degraded: 3,
  'blind-spot': 2,
  fragile: 1,
};

/** A class's severity; null (no open gap) is zero. */
export function gapClassSeverity(cls: string | null | undefined): number {
  if (!cls) return 0;
  return SEVERITY[cls] ?? 0.5;
}

/** The most severe class among the given, or null when none. */
export function worstGapClass(classes: Iterable<string | null | undefined>): string | null {
  let worst: string | null = null;
  let worstScore = 0;
  for (const cls of classes) {
    const s = gapClassSeverity(cls);
    if (cls && s > worstScore) {
      worst = cls;
      worstScore = s;
    }
  }
  return worst;
}

/**
 * Why a closed gap closed. `acted-on`: answered while the pull request that
 * raised it was open (a run of it reached the file, a run answered with the
 * status, a test names the intent).
 * `reached`: a test reached its subject. `not-detected`: its detector no longer
 * raises it. `covered-by`: a person named the test that covers it. `merged`: its
 * subject merged into another's. `retired`: its detector is gone. The rest are
 * the change-coverage reads of its file.
 */
export type GapCloseReason =
  | 'acted-on'
  | 'reached'
  | 'not-detected'
  | 'covered-by'
  | 'merged'
  | 'retired'
  | 'out-of-scope'
  | 'deleted'
  | 'not-observable';

/** How the Gaps view names each close reason, after "closed". */
export const GAP_CLOSE_REASON_LABELS: Record<GapCloseReason, string> = {
  'acted-on': 'acted on in its pull request',
  reached: 'a test reached it',
  'not-detected': 'no longer detected',
  'covered-by': 'covered by a test',
  merged: 'merged into another gap',
  retired: 'detector retired',
  'out-of-scope': 'out of the coverage scope',
  deleted: 'file deleted',
  'not-observable': 'not observable',
};
