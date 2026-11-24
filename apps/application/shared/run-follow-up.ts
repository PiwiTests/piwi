/**
 * What was sent, as the follow-up view shows it: a run request to one of the
 * person's own apps, or a CI dispatch. Both map to one view (`RunFollowUpView`),
 * so the component that shows it, the run dialog after **Send** and a failure
 * page's "Last re-run" line, never reads two state models.
 *
 * Pure + dependency-free: the app and the tests share it.
 */

import { FINAL_RUN_REQUEST_STATES, type RunRequestState } from '@piwitests/core/run-request';
import type { StatusPaletteKey } from '@piwitests/run-ui/status-palette';
import type { RunRequestView } from '#shared/handlers/run-requests';
import type { CiDispatchRun, CiDispatchView } from '#shared/ci-dispatches';

/** One run request or CI dispatch, as the follow-up view shows it. */
export interface RunFollowUpView {
  kind: 'request' | 'dispatch';
  /** The request's or the dispatch's id. */
  id: string;
  /** The palette entry of its dot. */
  status: StatusPaletteKey;
  /** One sentence for where it stands. */
  sentence: string;
  /** How many tests it names; null when not recorded (a whole suite). */
  tests: number | null;
  /** The one test it runs, by its title, when it runs one. */
  testTitle: string | null;
  /** A dispatch of a Flake Lab experiment, which its facts name in place of its test count. */
  flakeLab: boolean;
  /** Where it went: the app's machine, or the CI (`Jenkins`). */
  target: string | null;
  /** The CI action it went through. */
  action: string | null;
  /** The branch a dispatch was sent on. */
  ref: string | null;
  /** Epoch ms of the send. */
  at: number;
  /** Who sent it. */
  by: string | null;
  /** The CI's page for it: its run once known, else its runs list. */
  ciUrl: string | null;
  /** The run it started, with that run's result once a dispatch's run reports. */
  run: { id: number; result: string | null } | null;
  /** Why no run has reported, once a dispatch has waited long or none reported. */
  causes: string[];
  /** It moves no more: the page stops reading it. */
  final: boolean;
  /** The page can stop it: a run request that waits or runs. A CI run is cancelled in the CI. */
  canStop: boolean;
}

// ── Run requests ─────────────────────────────────────────────────────────────

/** Whether a request moves no more: the page stops reading it. */
export function runRequestIsFinal(request: Pick<RunRequestView, 'state'>): boolean {
  return FINAL_RUN_REQUEST_STATES.has(request.state);
}

/** Whether the requester can still stop it: it waits, its app shows it, or its run goes on. */
export function runRequestCanStop(request: Pick<RunRequestView, 'state'>): boolean {
  return (['waiting', 'claimed', 'starting', 'running', 'stopping'] as RunRequestState[]).includes(request.state);
}

/** The app that holds a request, as its sentence names it. */
function appName(request: Pick<RunRequestView, 'target'>): string {
  return request.target?.deviceName ?? 'your app';
}

/** One sentence for where a request stands, the same on the page's follow-up and in the requester's list. */
export function runRequestSentence(request: Pick<RunRequestView, 'state' | 'outcome' | 'detail' | 'target'>): string {
  switch (request.state) {
    case 'waiting':
      return request.detail
        ? `Waiting for one of your apps to pick it up. ${request.detail}`
        : 'Waiting for one of your apps to pick it up';
    case 'claimed':
      return `${appName(request)} shows it: click Run there`;
    case 'declined':
      return 'You answered Not now in the app';
    case 'expired':
      return request.detail
        ? `None of your apps picked it up within 2 minutes. ${request.detail}`
        : 'None of your apps picked it up within 2 minutes: is the desktop app open and connected?';
    case 'refused':
      return request.detail ? `The app could not run it: ${request.detail}` : 'The app could not run it';
    case 'starting':
      return `Starting in ${appName(request)}`;
    case 'running':
      return `Running in ${appName(request)}`;
    case 'stopping':
      return `Stopping in ${appName(request)}`;
    case 'ended':
      switch (request.outcome) {
        case 'passed':
          return 'Ended: every test passed';
        case 'failed':
          return 'Ended: some tests failed';
        case 'stopped':
          return 'Stopped';
        default:
          return request.detail ? `Ended with an error: ${request.detail}` : 'Ended with an error';
      }
  }
}

/** The palette entry of a request's dot: its outcome once it ended, running while it runs, else none. */
export function runRequestStatusKey(request: Pick<RunRequestView, 'state' | 'outcome'>): StatusPaletteKey {
  if (request.state === 'ended') {
    if (request.outcome === 'passed') return 'passed';
    if (request.outcome === 'failed' || request.outcome === 'error') return 'failed';
    return 'skipped';
  }
  if (['starting', 'running', 'stopping'].includes(request.state)) return 'running';
  if (runRequestIsFinal(request)) return 'skipped';
  return 'interrupted';
}

/** A run request as the follow-up view shows it. */
export function runRequestFollowUp(request: RunRequestView): RunFollowUpView {
  return {
    kind: 'request',
    id: request.id,
    status: runRequestStatusKey(request),
    sentence: runRequestSentence(request),
    tests: request.tests.length,
    testTitle: request.tests.length === 1 ? request.tests[0]!.title : null,
    flakeLab: false,
    target: request.target?.deviceName ?? null,
    action: null,
    ref: null,
    at: Date.parse(request.createdAt),
    by: null,
    ciUrl: null,
    run: request.runId == null ? null : { id: request.runId, result: null },
    causes: [],
    final: runRequestIsFinal(request),
    canStop: runRequestCanStop(request),
  };
}

// ── CI dispatches ────────────────────────────────────────────────────────────

/** How long a dispatch waits for its run before the follow-up gives the likely causes, while matching goes on. */
export const CI_DISPATCH_WAIT_HINT_MS = 30 * 60 * 1000;

/** Why a dispatch's run has not reported, most likely first. */
export const CI_DISPATCH_LIKELY_CAUSES = [
  'The job does not pass PIWI_ORIGIN_REF on to the run.',
  'The reporter is not set up in that job.',
  'The job failed before Playwright started.',
];

const DISPATCH_TARGETS: Record<string, string> = {
  github: 'GitHub Actions',
  gitlab: 'GitLab CI',
  bitbucket: 'Bitbucket Pipelines',
  jenkins: 'Jenkins',
  custom: 'the CI server',
};

/** Where a dispatch went, for its "dispatched to Jenkins" line. */
export function ciDispatchTargetName(dispatch: Pick<CiDispatchView, 'provider' | 'preset'>): string {
  const key = dispatch.provider === 'ci-server' ? (dispatch.preset ?? 'custom') : dispatch.provider;
  return DISPATCH_TARGETS[key] ?? 'CI';
}

const RUN_RESULTS: Record<string, string> = {
  initializing: 'is starting',
  running: 'is running',
  finalizing: 'is finishing',
  passed: 'passed',
  failed: 'failed',
  timedout: 'failed',
  interrupted: 'was interrupted',
  cancelled: 'was cancelled',
};

/** How the run that answered a dispatch stands, for its "run #128 passed" line. */
export function dispatchRunResult(run: Pick<CiDispatchRun, 'status'>): string {
  return RUN_RESULTS[run.status] ?? run.status;
}

/** The palette entry of a run that answered a dispatch. */
function runStatusKey(status: string): StatusPaletteKey {
  if (status === 'passed') return 'passed';
  if (status === 'failed' || status === 'timedout') return 'failed';
  if (status === 'interrupted' || status === 'cancelled') return 'interrupted';
  return 'running';
}

/** The palette entry of a dispatch's dot: its run's result once it has a run, waiting grey before. */
function dispatchStatusKey(dispatch: Pick<CiDispatchView, 'state' | 'run'>): StatusPaletteKey {
  if (dispatch.run) return runStatusKey(dispatch.run.status);
  if (dispatch.state === 'refused') return 'failed';
  if (dispatch.state === 'unreported') return 'skipped';
  return 'interrupted';
}

/** Whether a dispatch moves no more: refused, unreported, or its run ended. */
export function ciDispatchIsFinal(dispatch: Pick<CiDispatchView, 'state'>): boolean {
  return dispatch.state === 'ended' || dispatch.state === 'unreported' || dispatch.state === 'refused';
}

/** Whether a dispatch has waited long enough for its run that the follow-up gives the likely causes. */
function waitedLong(dispatch: Pick<CiDispatchView, 'state' | 'run' | 'at'>, now: number): boolean {
  return dispatch.state === 'unreported' || (dispatch.run == null && now - dispatch.at >= CI_DISPATCH_WAIT_HINT_MS);
}

/** One sentence for where a dispatch stands. */
export function ciDispatchSentence(
  dispatch: Pick<CiDispatchView, 'provider' | 'preset' | 'state' | 'detail' | 'run' | 'at'>,
  now = Date.now(),
): string {
  const target = ciDispatchTargetName(dispatch);
  if (dispatch.run) return `Dispatched to ${target}: run #${dispatch.run.id} ${dispatchRunResult(dispatch.run)}`;
  switch (dispatch.state) {
    case 'refused':
      return dispatch.detail ? `${target} refused the dispatch: ${dispatch.detail}` : `${target} refused the dispatch`;
    case 'unreported':
      return `Dispatched to ${target}: no run reported within six hours`;
    default:
      return waitedLong(dispatch, now)
        ? `Dispatched to ${target}: no run has reported yet`
        : `Dispatched to ${target}: waiting for the run to report…`;
  }
}

/** A CI dispatch as the follow-up view shows it. */
export function ciDispatchFollowUp(dispatch: CiDispatchView, now = Date.now()): RunFollowUpView {
  return {
    kind: 'dispatch',
    id: dispatch.id,
    status: dispatchStatusKey(dispatch),
    sentence: ciDispatchSentence(dispatch, now),
    tests: dispatch.tests,
    testTitle: null,
    flakeLab: dispatch.kind === 'flakeLab',
    target: ciDispatchTargetName(dispatch),
    action: dispatch.actionName,
    ref: dispatch.ref,
    at: dispatch.at,
    by: dispatch.byName,
    ciUrl: dispatch.state === 'refused' ? null : dispatch.url,
    run: dispatch.run ? { id: dispatch.run.id, result: dispatchRunResult(dispatch.run) } : null,
    causes: waitedLong(dispatch, now) ? CI_DISPATCH_LIKELY_CAUSES : [],
    final: ciDispatchIsFinal(dispatch),
    canStop: false,
  };
}

const testCount = (n: number) => `${n} test${n === 1 ? '' : 's'}`;

/**
 * What a follow-up runs, through what and on which branch, as one line of facts: `3 tests · Smoke · staging on main`,
 * `Flake Lab · Smoke · staging on main`. A dispatch names its action, else its CI; a request its tests alone.
 */
export function runFollowUpFacts(
  followUp: Pick<RunFollowUpView, 'kind' | 'tests' | 'testTitle' | 'flakeLab' | 'action' | 'target' | 'ref'>,
): string {
  const what =
    followUp.testTitle ?? (followUp.flakeLab ? 'Flake Lab' : followUp.tests ? testCount(followUp.tests) : null);
  const through = followUp.kind === 'dispatch' ? (followUp.action ?? followUp.target) : null;
  const where = through && followUp.ref ? `${through} on ${followUp.ref}` : through;
  return [what, where].filter(Boolean).join(' · ');
}

/** How many ms until a follow-up is read again: a request every 2 s, a dispatch every 5 s until matched, then every 30 s; null once final. */
export function runFollowUpPollMs(followUp: Pick<RunFollowUpView, 'kind' | 'final' | 'run'>): number | null {
  if (followUp.final) return null;
  if (followUp.kind === 'request') return 2_000;
  return followUp.run ? 30_000 : 5_000;
}
