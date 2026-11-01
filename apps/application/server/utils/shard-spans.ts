/**
 * The time each shard of a sharded run ran, kept in the run's `metadata.shards`,
 * and the run's span drawn from them: from the first shard's start to the last
 * shard's end, whether the shards ran side by side or one after another.
 */

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
  duration: number;
  metadata?: unknown;
}

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

/**
 * A shard's span from what it reported: from the start it sent to that start
 * plus its duration, or, for a shard that sent no start, its duration up to
 * `receivedAt`, the time its end reached the server.
 */
export function shardSpan(report: ShardReport, receivedAt: number): ShardSpan {
  const duration = Math.max(0, finiteNumber(report.duration) ?? 0);
  const reportedStart =
    typeof report.startTime === 'string' || typeof report.startTime === 'number'
      ? new Date(report.startTime).getTime()
      : NaN;
  const start = Number.isFinite(reportedStart) ? reportedStart : receivedAt - duration;
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

/** A copy of a sharded run's metadata with one more shard. */
export function withShardSpan<T extends Record<string, unknown>>(metadata: T, span: ShardSpan): T {
  return { ...metadata, shards: [...readShardSpans(metadata), span] };
}

/**
 * A sharded run's start and duration from its shards: from the earliest of
 * `startTime` (the run's own) and its shards' starts, to its last shard's end.
 * Null while no shard has ended.
 */
export function shardedRunSpan(startTime: Date, spans: ShardSpan[]): { startTime: Date; duration: number } | null {
  if (spans.length === 0) return null;
  const runStart = startTime.getTime();
  const start = Math.min(
    ...(Number.isFinite(runStart) ? [runStart] : []),
    ...spans.map((span) => Date.parse(span.startTime)),
  );
  const end = Math.max(...spans.map((span) => Date.parse(span.endTime)));
  return { startTime: new Date(start), duration: Math.max(0, end - start) };
}
