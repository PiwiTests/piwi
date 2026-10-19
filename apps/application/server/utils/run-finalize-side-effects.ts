import { applyBugReportLifecycle } from '#shared/handlers/bug-reports';
import { followBugReportTickets } from './integrations/bug-reports';
import { runTrackerAutomation } from './integrations/automation';
import type { DbClient } from '../database';
import { computeRegressionSignals } from './compute-regression-signals';
import { autoDiagnoseRun } from './ai-diagnosis';
import { emitIncidentNotification, emitRunNotifications } from './notifications/run-notifications';
import { analyzeFinishedRunInBackground, postRunPrFeedbackInBackground } from './scm/pr-feedback';
import { maybeEnqueueHealActionInBackground } from './heal/policy';
import { syncAutoMarkersForRun } from '#shared/handlers/markers';
import { classifyRunFlakyTests } from '#shared/handlers/flaky-classify';
import { INCIDENT_RUN_METADATA_KEY, isEligibleRun, isIncidentRun } from '#shared/run-eligibility';
import { recordRunHealth } from '#shared/handlers/run-health';
import { upsertDailyRollup } from '#shared/handlers/analytics/rollups';
import { recordRunResourceFindings } from '#shared/handlers/resource-findings';
import { runEventBus } from './run-events';
import { matchCiRerunRun } from './ci-rerun';
import { inferRunOutcomes } from './outcome-inference';
import { pinProjectRepository } from './scm/project-repository';

/** A run's metadata without its incident flag, for the rules that read the run apart from the flag. */
function withoutIncidentFlag(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  const rest: Record<string, unknown> = { ...(metadata as Record<string, unknown>) };
  delete rest[INCIDENT_RUN_METADATA_KEY];
  return rest;
}

/**
 * The finalize side effects for a finished run: the environment-incident
 * check, the daily rollup of its cell, regression signals, the CI re-run
 * dispatch it answers, auto markers, flaky root causes, the history of its
 * resource findings, its analysis (the scenario gaps, change coverage, fix
 * verification and the hand-back outcomes it shows) and its outbound effects
 * (AI diagnosis, the issues automatic creation files once fix verification
 * is done, notifications, the pull-request comment and commit status, auto-heal).
 *
 * Every ingest path (finish, upload, submit) routes its finalization through
 * this one helper so the run eligibility rule is honored everywhere: none of
 * these fire for a run whose origin the `run-health` use leaves out (a probe
 * run or a flake-lab run replays a test with an injected fault or condition,
 * so it never counts as a real run), exactly as imports are silent. The
 * incident check runs first and is awaited: a run it flags as an environment
 * incident gets its rollup, its CI re-run match, its auto markers and its
 * resource findings, and in place of regression signals, the analysis, AI
 * diagnosis, the run and cluster notifications, pull-request feedback and
 * auto-heal it sends one `environment.incident` event. Flaky root causes skip
 * runs the `flakiness` use leaves out, and fix verification, auto-heal and the
 * bug-report lifecycle apply their own uses.
 *
 * Every other run gets its analysis, each step under its own use, and its
 * outcomes once its change coverage is stored. Only the outbound effects
 * follow the `notifications` use, which reads the run's origin from its
 * metadata as the incident check read it, its final `status` and `isFullRun`:
 * never for a run from an editor, and for a run from a developer's machine or
 * the desktop app only when it ran the whole suite. A run the use leaves out
 * sends no incident event either: the use reads a flagged run as if it carried
 * no flag.
 *
 * The returned promise settles once the run's rollup cell is recomputed, so a
 * caller that awaits it answers only when the analytics already count the run
 * and the gate already reads its incident flag; everything else runs in the
 * background. The cell is recomputed a second time once the regression signals
 * it counts are written. Each write is followed by a `rollup-updated` event:
 * the widget cache and the live dashboards wait for it, since `run-finished`
 * and `run-submitted` go out before the rollup counts the run.
 */
export async function runFinalizeSideEffects(
  db: DbClient,
  id: number,
  run: { projectId: number; metadata?: unknown; isFullRun?: number | boolean | null; status?: string | null },
): Promise<void> {
  if (!isEligibleRun(run, 'run-health')) return;
  await pinProjectRepository(db, run.projectId, run.metadata).catch((e) =>
    console.error('[scm] pinning the project repository failed', e),
  );
  const health = await recordRunHealth(db, id).catch((e) => {
    console.error('[run-health] recordRunHealth failed', e);
    return null;
  });
  const current = { ...run, metadata: health?.metadata ?? run.metadata };
  const incident = isIncidentRun(current.metadata);

  const recompute = () =>
    upsertDailyRollup(db, id).then(() =>
      runEventBus.publishGlobal({ type: 'rollup-updated', runId: id, projectId: run.projectId }),
    );
  const rollup = recompute().catch((e) => console.error('[analytics] upsertDailyRollup failed', e));
  if (!incident) {
    computeRegressionSignals(db, id)
      .catch((e) => console.error('[regression-signals] computeRegressionSignals failed', e))
      .then(() => rollup)
      .then(recompute)
      .catch((e) => console.error('[analytics] upsertDailyRollup failed', e));
  }
  matchCiRerunRun(db, id).catch((e) => console.error('[ci-rerun] matchCiRerunRun failed', e));
  syncAutoMarkersForRun(db, id).catch((e) => console.error('[markers] syncAutoMarkersForRun failed', e));
  if (isEligibleRun(current, 'flakiness')) {
    classifyRunFlakyTests(db, run.projectId, id).catch((e) =>
      console.error('[flaky-classify] classifyRunFlakyTests failed', e),
    );
  }
  recordRunResourceFindings(db, id).catch((e) =>
    console.error('[resource-findings] recordRunResourceFindings failed', e),
  );
  applyBugReportLifecycle(db, id)
    .then((moved) => followBugReportTickets(db, id, moved))
    .catch((e) => console.error('[bug-reports] applyBugReportLifecycle failed', e));
  if (incident) {
    // The incident event takes the place of the verdicts of a run that sends them.
    if (
      health?.flagged &&
      isEligibleRun({ ...current, metadata: withoutIncidentFlag(current.metadata) }, 'notifications')
    ) {
      emitIncidentNotification(db, id).catch((e) =>
        console.error('[notifications] emitIncidentNotification failed', e),
      );
    }
    return rollup;
  }
  const analysis = analyzeFinishedRunInBackground(db, id);
  void analysis.coverage.then(() =>
    inferRunOutcomes(db, id).catch((e) => console.error('[outcomes] inferRunOutcomes failed', e)),
  );
  if (!isEligibleRun(current, 'notifications')) return rollup;
  autoDiagnoseRun(db, run.projectId, id).catch((e) => console.error('[ai-diagnosis] autoDiagnoseRun failed', e));
  // The issues the project's rules file go out first, so the run's notifications name them. They
  // wait for fix verification: a regression's reopen transition is then queued, and a rule does not
  // file a second issue beside the Done one it moves out of Done.
  const filing = isEligibleRun(current, 'tracker')
    ? analysis.fixed
        .then(() => runTrackerAutomation(db, id))
        .catch((e) => console.error('[integrations] runTrackerAutomation failed', e))
    : Promise.resolve();
  void filing.then(() =>
    emitRunNotifications(db, id).catch((e) => console.error('[notifications] emitRunNotifications failed', e)),
  );
  // Healing's diff-rename step reads the locator breaks change coverage stores.
  void postRunPrFeedbackInBackground(db, id, analysis).then(() => maybeEnqueueHealActionInBackground(db, id));
  return rollup;
}
