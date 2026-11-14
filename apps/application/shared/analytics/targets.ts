/**
 * Per-project targets: a goal on a metric of the catalog ("test pass rate at
 * least 98 %"), stored as the `targets` JSON column of `projects`. A target is
 * met or missed over a period; the stat tiles, the portfolio, the insights,
 * the metric widget and the quality report read the verdicts from here.
 */
import { z } from 'zod';
import type { MetricId } from './metrics';

export interface ProjectTargets {
  /** Test pass rate at least this percentage. */
  testPassRate?: number;
  /** At most this many flaky tests in the period. */
  maxFlakyTests?: number;
  /** At most this many wasted CI minutes per week (scaled to the period's length). */
  maxWastedMinutesPerWeek?: number;
  /** The oldest open failure cluster at most this many days old. */
  maxOpenClusterAgeDays?: number;
  /** The median time to fix at most this many days. */
  maxMedianTimeToFixDays?: number;
}

export type TargetKey = keyof ProjectTargets;

export interface TargetDef {
  key: TargetKey;
  metric: MetricId;
  /** `min`: the value must reach the target; `max`: it must stay at or under it. */
  direction: 'min' | 'max';
  /** Sentence case, as the target form shows it. */
  label: string;
  /** The target's unit suffix in the form. */
  suffix: string;
  /** Whether the target is a weekly amount, scaled to the length of the period it is read over. */
  perWeek?: boolean;
  max: number;
}

export const TARGET_DEFS: readonly TargetDef[] = [
  {
    key: 'testPassRate',
    metric: 'test-pass-rate',
    direction: 'min',
    label: 'Test pass rate at least',
    suffix: '%',
    max: 100,
  },
  {
    key: 'maxFlakyTests',
    metric: 'flaky-tests',
    direction: 'max',
    label: 'Flaky tests at most',
    suffix: 'tests',
    max: 100_000,
  },
  {
    key: 'maxWastedMinutesPerWeek',
    metric: 'wasted-ci-minutes',
    direction: 'max',
    label: 'Wasted CI minutes per week at most',
    suffix: 'min',
    perWeek: true,
    max: 1_000_000,
  },
  {
    key: 'maxOpenClusterAgeDays',
    metric: 'oldest-open-failure-cause',
    direction: 'max',
    label: 'Oldest open failure cluster at most',
    suffix: 'days',
    max: 3650,
  },
  {
    key: 'maxMedianTimeToFixDays',
    metric: 'median-time-to-fix',
    direction: 'max',
    label: 'Median time to fix at most',
    suffix: 'days',
    max: 3650,
  },
];

const targetValue = (max: number) => z.number().finite().min(0).max(max).nullable().optional();

export const projectTargetsSchema = z.object(
  Object.fromEntries(TARGET_DEFS.map((d) => [d.key, targetValue(d.max)])) as Record<
    TargetKey,
    ReturnType<typeof targetValue>
  >,
);

/**
 * Targets from outside (a form, an API call), checked: unknown keys dropped,
 * empty values removed. Null when no target is left. Throws a zod error on a
 * value out of range.
 */
export function normalizeProjectTargets(raw: unknown): ProjectTargets | null {
  if (raw == null) return null;
  const parsed = projectTargetsSchema.parse(raw);
  const out: ProjectTargets = {};
  for (const def of TARGET_DEFS) {
    const value = parsed[def.key];
    if (typeof value === 'number') out[def.key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Targets as stored, tolerating a missing or malformed column. */
export function readProjectTargets(raw: unknown): ProjectTargets {
  if (!raw || typeof raw !== 'object') return {};
  const out: ProjectTargets = {};
  for (const def of TARGET_DEFS) {
    const value = (raw as Record<string, unknown>)[def.key];
    if (typeof value === 'number' && Number.isFinite(value)) out[def.key] = value;
  }
  return out;
}

/** The target definition of a metric, when the metric carries one. */
export function targetDefForMetric(metric: MetricId): TargetDef | undefined {
  return TARGET_DEFS.find((d) => d.metric === metric);
}

/** A target read over a period: a weekly amount scaled to the period's length. */
export function targetForPeriod(def: TargetDef, value: number, periodDays: number): number {
  if (!def.perWeek) return value;
  return Math.round(((value * Math.max(periodDays, 1)) / 7) * 10) / 10;
}

/** Whether a value meets a target; null when there is no value to judge. */
export function targetMet(def: TargetDef, target: number, actual: number | null): boolean | null {
  if (actual === null) return null;
  return def.direction === 'min' ? actual >= target : actual <= target;
}

/** One project's target over a period, met or missed. */
export interface ProjectTargetVerdict {
  projectId: number;
  projectName: string;
  key: TargetKey;
  metric: MetricId;
  direction: 'min' | 'max';
  /** The target as the project stores it (per week for a weekly target). */
  stored: number;
  /** The target over the period (a weekly target scaled to the period). */
  target: number;
  actual: number | null;
  /** Null when the period has nothing to judge the target on. */
  met: boolean | null;
}
