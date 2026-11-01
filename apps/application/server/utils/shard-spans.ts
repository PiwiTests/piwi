/**
 * What each shard of a sharded run brings when it ends: the time it ran, kept in
 * the run's `metadata.shards`, from which the run's span is drawn (from the
 * first shard's start to the last shard's end, whether the shards ran side by
 * side or one after another), and its test durations, kept in
 * `metadata.shardDurations` for the run's duration statistics. The server and
 * the demo record a shard's end through `recordShardEnd`.
 */
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
}

/** What a shard reports of itself when it ends: `/finish`'s body, or a batch shard's run body. */
export interface ShardReport {
  shardIndex?: unknown;
  /** The shard's start, as its reporter measured it. */
  startTime?: unknown;
  /** How long the shard ran, in milliseconds. */
  duration?: unknown;
  metadata?: unknown;
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

/**
 * Record one shard's end in its sharded run. `change` makes the shard's own
 * changes to the run's metadata (or returns null to record nothing), `span`
 * joins the run's `metadata.shards`, and the run's start and duration become
 * those of its shards (`shardedRunSpan`), all in one write with `set`. Shards
 * of one run record their ends one at a time, so shards ending at once each
 * keep their span. Returns the metadata written, or null when nothing was.
 */
export function recordShardEnd(
  db: DrizzleDB,
  runId: number,
  span: ShardSpan,
  change: (metadata: MetadataObject) => MetadataObject | null,
  set: RunUpdate = {},
): Promise<MetadataObject | null> {
  return shardEndLock(runId, () =>
    updateRunMetadata(
      db,
      runId,
      (metadata) => {
        const next = change(metadata);
        return next && { ...next, shards: [...readShardSpans(next), span] };
      },
      (metadata) => ({ ...set, ...shardedRunSpan(readShardSpans(metadata)) }),
    ),
  );
}
