/**
 * What each shard of a sharded run brings when it ends: the time it ran, kept in
 * the run's `metadata.shards`, from which the run's span is drawn (from the
 * first shard's start to the last shard's end, whether the shards ran side by
 * side or one after another), its test durations, kept in
 * `metadata.shardDurations` for the run's duration statistics, its suite
 * setup steps, added to the run's `setupSteps`, and its errors outside any
 * test, added to the run's `runErrors`. The server and the demo record a
 * shard's end through `recordShardEnd`.
 */
import { eq } from 'drizzle-orm';
import { MAX_RUN_ERRORS } from '@piwitests/core/run-errors';
import type { WireRunError } from '@piwitests/core/wire';
import { testRuns } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { createKeyedLock } from './keyed-lock';
import { updateRunMetadata, type MetadataObject, type RunUpdate } from './run-metadata';

/** One shard of a sharded run, as the run's `metadata.shards` keeps it. */
export interface ShardSpan {
  /** The shard's 1-based index, when it reported one. */
  shardIndex: number | null;
  /** When the shard started, as an ISO string. */
  startTime: string;
  /** When the shard ended, as an ISO string. */
  endTime: string;
  /** How long the shard ran, in milliseconds. */
  duration: number;
  /** The workers Playwright ran the shard with, when its configuration says. */
  workers?: number;
  /** The status the shard reported for its run (`passed`, `failed`, `timedout`, `interrupted`), when it sent one. */
  status?: string;
}

/** What a shard reports of itself when it ends: `/finish`'s body, or a batch shard's run body. */
export interface ShardReport {
  shardIndex?: unknown;
  /** The shard's start, as its reporter measured it. */
  startTime?: unknown;
  /** How long the shard ran, in milliseconds. */
  duration?: unknown;
  metadata?: unknown;
  /** The status the shard's reporter gave its run. */
  status?: unknown;
}

/** How far from its arrival a shard's reported start may place its end before its clock counts as wrong. */
const CLOCK_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** The longest duration `test_runs.duration` holds: a 32-bit integer of milliseconds on PostgreSQL. */
export const MAX_RUN_DURATION_MS = 2_147_483_647;

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The workers a shard ran with: Playwright's `actualWorkers`, else the configured count. */
function shardWorkers(metadata: unknown): number | null {
  const meta = record(metadata);
  const actual = finiteNumber(record(meta?.playwrightConfig)?.actualWorkers);
  return actual ?? finiteNumber(record(meta?.htmlReport)?.workers);
}

/** A reported start in epoch milliseconds, or null when it names no time between the epoch and `receivedAt`'s day. */
function reportedStart(value: unknown, receivedAt: number): number | null {
  const time = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) && time >= 0 && time <= receivedAt + CLOCK_TOLERANCE_MS ? time : null;
}

/**
 * A shard's span from what it reported, `receivedAt` being when its end reached
 * the server. A shard with no duration ran from its start to its arrival. The
 * start it sent counts when it puts the shard's end within a day of its
 * arrival; with none, or from a clock further off, the shard ends at its
 * arrival.
 */
export function shardSpan(report: ShardReport, receivedAt: number): ShardSpan {
  const sentStart = reportedStart(report.startTime, receivedAt);
  const sentDuration = finiteNumber(report.duration);
  const sinceStart = sentStart == null ? null : receivedAt - sentStart;
  const duration = Math.min(
    Math.max(0, sentDuration ?? (sinceStart != null && sinceStart <= CLOCK_TOLERANCE_MS ? sinceStart : 0)),
    MAX_RUN_DURATION_MS,
    receivedAt,
  );
  const start =
    sentStart != null && Math.abs(sentStart + duration - receivedAt) <= CLOCK_TOLERANCE_MS
      ? sentStart
      : receivedAt - duration;
  const workers = shardWorkers(report.metadata);
  return {
    shardIndex: finiteNumber(report.shardIndex),
    startTime: new Date(start).toISOString(),
    endTime: new Date(start + duration).toISOString(),
    duration,
    ...(workers != null && { workers }),
    ...(typeof report.status === 'string' && { status: report.status }),
  };
}

function isShardSpan(value: unknown): value is ShardSpan {
  const span = record(value);
  return (
    !!span &&
    typeof span.startTime === 'string' &&
    typeof span.endTime === 'string' &&
    Number.isFinite(Date.parse(span.startTime)) &&
    Number.isFinite(Date.parse(span.endTime))
  );
}

/** The shards a sharded run's metadata holds, in the order they ended. */
export function readShardSpans(metadata: unknown): ShardSpan[] {
  const shards = record(metadata)?.shards;
  return Array.isArray(shards) ? shards.filter(isShardSpan) : [];
}

/**
 * A sharded run's start and duration from its shards: from the first shard's
 * start to the last shard's end, at most `MAX_RUN_DURATION_MS`. Null while no
 * shard has ended.
 */
export function shardedRunSpan(spans: ShardSpan[]): { startTime: Date; duration: number } | null {
  if (spans.length === 0) return null;
  const start = Math.min(...spans.map((span) => Date.parse(span.startTime)));
  const end = Math.max(...spans.map((span) => Date.parse(span.endTime)));
  return { startTime: new Date(start), duration: Math.min(Math.max(0, end - start), MAX_RUN_DURATION_MS) };
}

/** Whether a run's metadata holds the end of shard `shardIndex` already. A shard with no index is never one. */
export function hasShardEnded(metadata: unknown, shardIndex: number | null): boolean {
  return shardIndex != null && readShardSpans(metadata).some((span) => span.shardIndex === shardIndex);
}

/** Run statuses from the least to the most severe, as Playwright's merge-reports ranks its shards' statuses. */
const SHARD_STATUS_SEVERITY = ['passed', 'interrupted', 'timedout', 'failed'];

/**
 * A sharded run's status once every shard ended: the most severe status its shards reported (`failed`, then
 * `timedout`, then `interrupted`), as Playwright's merge-reports settles it, and `failed` when a test failed. A shard
 * that reported none, or one of another name, changes nothing.
 */
export function shardedRunStatus(spans: ShardSpan[], failedTests: number): string {
  let status = failedTests > 0 ? 'failed' : 'passed';
  for (const span of spans) {
    if (SHARD_STATUS_SEVERITY.indexOf(span.status ?? '') > SHARD_STATUS_SEVERITY.indexOf(status)) status = span.status!;
  }
  return status;
}

/** The test durations a sharded run's shards reported so far. */
export function readShardDurations(metadata: unknown): number[] {
  const durations = record(metadata)?.shardDurations;
  return Array.isArray(durations) ? durations.filter((d): d is number => typeof d === 'number') : [];
}

/** A copy of a sharded run's metadata with one shard's test durations added to the others'. */
export function withShardDurations(metadata: MetadataObject, durations: unknown[]): MetadataObject {
  const added = durations.filter((d): d is number => typeof d === 'number' && Number.isFinite(d));
  return { ...metadata, shardDurations: [...readShardDurations(metadata), ...added] };
}

/** Shards of one run record their ends one at a time. */
const shardEndLock = createKeyedLock<number>();

/** Run `task` while no shard of run `runId` records its end (`recordShardEnd`): a rewrite of the run's errors. */
export function whileNoShardEnds<T>(runId: number, task: () => Promise<T>): Promise<T> {
  return shardEndLock(runId, task);
}

/** The suite setup steps and the errors outside any test a run holds. */
async function readShardAdditions(
  db: DrizzleDB,
  runId: number,
): Promise<{ setupSteps: unknown[]; runErrors: unknown[] }> {
  const [run] = await db
    .select({ setupSteps: testRuns.setupSteps, runErrors: testRuns.runErrors })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  return {
    setupSteps: Array.isArray(run?.setupSteps) ? run.setupSteps : [],
    runErrors: Array.isArray(run?.runErrors) ? run.runErrors : [],
  };
}

/**
 * Record one shard's end in its sharded run. `change` makes the shard's own
 * changes to the run's metadata (or returns null to record nothing), `span`
 * joins the run's `metadata.shards`, the shard's `setupSteps` (its suite-level
 * hooks and fixtures) join the run's, its `runErrors` (stored as
 * `storableRunErrors` keeps them) join the run's up to `MAX_RUN_ERRORS`, and
 * the run's start and duration become those of its shards (`shardedRunSpan`),
 * all in one write with `set`. Shards of one run record their ends one at a
 * time, so shards ending at once each keep their span, their steps and their
 * errors. Returns the metadata written, or null when nothing was.
 */
export function recordShardEnd(
  db: DrizzleDB,
  runId: number,
  span: ShardSpan,
  change: (metadata: MetadataObject) => MetadataObject | null,
  set: RunUpdate = {},
  setupSteps: readonly unknown[] = [],
  runErrors: readonly WireRunError[] = [],
): Promise<MetadataObject | null> {
  return shardEndLock(runId, async () => {
    const held = setupSteps.length > 0 || runErrors.length > 0 ? await readShardAdditions(db, runId) : null;
    const steps = held && setupSteps.length > 0 ? [...held.setupSteps, ...setupSteps] : null;
    const errors = held && runErrors.length > 0 ? [...held.runErrors, ...runErrors].slice(0, MAX_RUN_ERRORS) : null;
    return updateRunMetadata(
      db,
      runId,
      (metadata) => {
        const next = change(metadata);
        return next && { ...next, shards: [...readShardSpans(next), span] };
      },
      (metadata) => ({
        ...set,
        ...(steps && { setupSteps: steps }),
        ...(errors && { runErrors: errors }),
        ...shardedRunSpan(readShardSpans(metadata)),
      }),
    );
  });
}
