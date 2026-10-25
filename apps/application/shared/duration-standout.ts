/**
 * When a duration on an execution's evidence stands out: the one rule the
 * timeline colors a step or a request by. A duration stands out when it lasts
 * at least `STANDOUT_MIN_MS` and either takes at least `STANDOUT_SHARE` of the
 * test or is much slower than its usual time (`isMuchSlower`), so a test of
 * quick steps colors none of them, and a request that held the test up is the
 * row the eye lands on.
 *
 * The module also holds the one "much slower" rule (`isMuchSlower`: twice as
 * long and at least 1 s longer) and the key a step is matched on from one
 * execution to another (`stepMatchKey`): the Attempts tab reads both when it
 * compares a failing attempt's steps to the passing one's, and the usual
 * durations (`buildUsualDurations`) read the same key over the test's last
 * passing executions.
 */
import { pauseSpans, stepLabel, unpausedDuration } from '@piwitests/core/step-analysis';
import type { FailureTimeline, TimelineItem } from '#shared/failure-timeline';
import { requestRouteKey } from '#shared/utils/route';
import { median } from './utils/stats';

/** The shortest duration that can stand out, in ms. */
export const STANDOUT_MIN_MS = 1000;

/** The smallest share of the test a duration must take to stand out. */
export const STANDOUT_SHARE = 1 / 3;

/** A duration is much slower than another when it is at least this many times as long… */
export const SLOWER_FACTOR = 2;

/** …and at least this many ms longer. */
export const SLOWER_MIN_DELTA_MS = 1000;

/** The fewest past executions a step or a route must appear in to have a usual duration. */
export const USUAL_MIN_SAMPLES = 2;

/**
 * Why a duration stands out: `share`, it takes a large part of the test;
 * `usual`, it is much slower than in the test's last passing runs. A duration
 * that does both stands out by `share`.
 */
export type DurationStandoutReason = 'share' | 'usual';

export interface DurationStandout {
  reason: DurationStandoutReason;
  /** The duration's share of the test: 0.41 for 41%, above 1 for a request that outlasts the test; null without a test duration. */
  share: number | null;
  /** The usual duration it is compared with, in ms; null when there is none. */
  usual: number | null;
}

export interface DurationStandoutInput {
  /** The duration, in ms. */
  ms: number | null | undefined;
  /** The test's duration, in ms; without one, nothing stands out by share. */
  testMs: number | null | undefined;
  /** The usual duration of the same step or request, in ms; without one, nothing stands out by it. */
  usualMs?: number | null;
}

function positive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Whether `ms` is much slower than `thanMs`: at least `SLOWER_FACTOR` times as long and `SLOWER_MIN_DELTA_MS` longer. */
export function isMuchSlower(ms: number, thanMs: number): boolean {
  return ms - thanMs >= SLOWER_MIN_DELTA_MS && ms >= SLOWER_FACTOR * thanMs;
}

/** Whether a duration stands out in its test or against its usual time, and why; null when it does not. */
export function durationStandout({ ms, testMs, usualMs }: DurationStandoutInput): DurationStandout | null {
  if (!positive(ms) || ms < STANDOUT_MIN_MS) return null;
  const share = positive(testMs) ? ms / testMs : null;
  const usual = positive(usualMs) ? usualMs : null;
  if (share != null && share >= STANDOUT_SHARE) return { reason: 'share', share, usual };
  if (usual != null && isMuchSlower(ms, usual)) return { reason: 'usual', share, usual };
  return null;
}

/**
 * Why a duration stands out, in words: `41% of the test`, `longer than the
 * whole test`, or `usually 600 ms` with the usual time in `formatMs`.
 */
export function standoutReasonText(standout: DurationStandout, formatMs: (ms: number) => string): string {
  if (standout.reason === 'usual' && standout.usual != null) return `usually ${formatMs(standout.usual)}`;
  const share = standout.share ?? 0;
  return share > 1 ? 'longer than the whole test' : `${Math.round(share * 100)}% of the test`;
}

/**
 * A duration's share of the test as a label: `19%`, `<1%` for a sliver, and
 * `>100%` for a request that outlasts the test. Empty without a test duration.
 */
export function shareOfTestLabel(ms: number | null | undefined, testMs: number | null | undefined): string {
  if (!positive(testMs)) return '';
  const pct = ((positive(ms) ? ms : 0) / testMs) * 100;
  if (pct > 100) return '>100%';
  if (pct > 0 && pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

/** The fields a step is matched on from one execution to another. */
export interface MatchableStep {
  title?: unknown;
  /** The step's target (rendered locator or URL), carried separately by newer Playwright. */
  subtitle?: unknown;
  /** The step's curated params: what tells apart two steps that share a label. */
  params?: Record<string, string | number | boolean> | null;
}

/**
 * The key a step is matched on from one execution to another: its label (the
 * title and the target) and its params, so two `Click` steps on different
 * targets stay apart. A step without params matches on its label.
 */
export function stepMatchKey(step: MatchableStep): string {
  return `${stepLabel(step)}\x00${step.params ? JSON.stringify(step.params) : ''}`;
}

// ── Usual durations ─────────────────────────────────────────────────────────

/** A stored step, as the usual durations read it. */
type StepRow = MatchableStep & { duration?: unknown; startTime?: unknown };

/** A stored request, as the usual durations read it. */
export interface UsualRequestRow {
  method?: string | null;
  url?: string | null;
  status?: number | null;
  duration?: number | null;
}

/** One past passing execution of the test: its steps and step events as stored, and its requests. */
export interface PastExecution {
  steps?: unknown;
  /** Its step events, whose `pause` events are the stops it made at Piwi's pause bar. */
  stepEvents?: unknown;
  networkRequests?: UsualRequestRow[] | null;
}

/** The usual duration, in ms, of each step and request route over past passing executions. */
export interface UsualDurations {
  /** By `stepMatchKey`. */
  steps: Map<string, number>;
  /** By step label alone, for a step whose params change from one run to the next. */
  stepLabels: Map<string, number>;
  /** By `requestRouteKey`. */
  requests: Map<string, number>;
}

function stepRows(value: unknown): StepRow[] {
  return Array.isArray(value) ? value.filter((row): row is StepRow => row != null && typeof row === 'object') : [];
}

/** A recorded duration: a positive finite number of ms; zero or missing records nothing. */
function recordedMs(value: unknown): number | null {
  return typeof value === 'number' && positive(value) ? value : null;
}

/** An answered request: one with a response that is not a server error. */
function answered(request: UsualRequestRow): boolean {
  const status = request.status ?? 0;
  return status > 0 && status < 500;
}

/** The durations recorded per key, and the executions (by position) each key appeared in. */
type Samples = Map<string, { durations: number[]; executions: Set<number> }>;

function addSample(samples: Samples, key: string, ms: number, execution: number) {
  const entry = samples.get(key) ?? { durations: [], executions: new Set<number>() };
  entry.durations.push(ms);
  entry.executions.add(execution);
  samples.set(key, entry);
}

/** The median of every key seen in at least `minSamples` executions, rounded to the ms. */
function medians(samples: Samples, minSamples: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, { durations, executions }] of samples) {
    if (executions.size >= minSamples) out.set(key, Math.round(median(durations)!));
  }
  return out;
}

/**
 * The usual duration of each step and each request route over past passing
 * executions of one test: the median of the durations recorded for it, kept
 * when at least `minSamples` executions ran it. A step is matched by
 * `stepMatchKey`, and by its label alone for a step whose params change from
 * run to run; a request by its route (`GET /api/report/:id`), so two ids of
 * one endpoint share a usual time. A step repeated in a loop adds each of its
 * durations, each less the time the test stood stopped at Piwi's pause bar
 * while it ran. A request with no response or a server error records nothing.
 */
export function buildUsualDurations(past: PastExecution[], minSamples = USUAL_MIN_SAMPLES): UsualDurations {
  const steps: Samples = new Map();
  const labels: Samples = new Map();
  const requests: Samples = new Map();
  past.forEach((execution, index) => {
    const pauses = pauseSpans(execution.stepEvents);
    for (const step of stepRows(execution.steps)) {
      const ms = recordedMs(pauses.length ? unpausedDuration(step, pauses) : step.duration);
      const label = stepLabel(step);
      if (ms == null || !label) continue;
      addSample(steps, stepMatchKey(step), ms, index);
      addSample(labels, label, ms, index);
    }
    for (const request of execution.networkRequests ?? []) {
      const ms = recordedMs(request.duration);
      if (ms == null || !answered(request)) continue;
      addSample(requests, requestRouteKey(request.method, request.url), ms, index);
    }
  });
  return {
    steps: medians(steps, minSamples),
    stepLabels: medians(labels, minSamples),
    requests: medians(requests, minSamples),
  };
}

/** A step's usual duration: by its key, else by its label; null when it has none. */
export function usualStepDuration(usual: UsualDurations, step: MatchableStep | null | undefined): number | null {
  if (!step) return null;
  const label = stepLabel(step);
  if (!label) return null;
  return usual.steps.get(stepMatchKey(step)) ?? usual.stepLabels.get(label) ?? null;
}

/** A request's usual duration, by its route; null when it has none. */
export function usualRequestDuration(
  usual: UsualDurations,
  request: UsualRequestRow | null | undefined,
): number | null {
  if (!request) return null;
  return usual.requests.get(requestRouteKey(request.method, request.url)) ?? null;
}

/**
 * The timeline with `usual` set on each step and request that has a usual
 * duration. Items point at their row by `ref.index`: a step into the
 * execution's stored steps, a request into its requests in stored order.
 */
export function attachUsualDurations(
  timeline: FailureTimeline,
  rows: { steps?: unknown; networkRequests?: UsualRequestRow[] | null },
  usual: UsualDurations,
): FailureTimeline {
  const steps = Array.isArray(rows.steps) ? (rows.steps as Array<MatchableStep | null>) : [];
  const requests = rows.networkRequests ?? [];
  const withUsual = (item: TimelineItem, ms: number | null): TimelineItem =>
    ms == null ? item : { ...item, usual: ms };
  return {
    ...timeline,
    lanes: {
      ...timeline.lanes,
      steps: timeline.lanes.steps.map((item) => withUsual(item, usualStepDuration(usual, steps[item.ref.index]))),
      network: timeline.lanes.network.map((item) =>
        withUsual(item, usualRequestDuration(usual, requests[item.ref.index])),
      ),
    },
  };
}
