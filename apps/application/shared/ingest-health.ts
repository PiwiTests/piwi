/**
 * What ingest dropped or rebuilt for one run, kept as `metadata.ingestHealth`.
 * The server counts what its caps left out and what it rebuilt from traces;
 * the reporter names the submit fallback it took. The files the storage quota
 * refused are counted by both, apart: the server for the parts of an upload it
 * skipped (`tracesNotKept` and the rest), the reporter for the files it did not
 * send once refused (`reporterNotKept`), and a reader shows their sum. Every
 * field is optional and absent when nothing happened, so a run ingested whole
 * carries no key.
 */
import { heldOperatorLimits, processEnv, storageQuotaSetting } from './operator-limits';

/** How the reporter delivered a run when its first choice failed. */
export const SUBMIT_FALLBACK_PATHS = ['upload', 'submit', 'recovery'] as const;
export type SubmitFallbackPath = (typeof SUBMIT_FALLBACK_PATHS)[number];

/**
 * Why the reporter fell back. `run-ended`: the dashboard ended the run while it streamed, as it does once another run
 * with the same run label started (`cancelInstanceRuns`).
 */
export const SUBMIT_FALLBACK_REASONS = ['results-lost', 'finish-failed', 'upload-failed', 'run-ended'] as const;
export type SubmitFallbackReason = (typeof SUBMIT_FALLBACK_REASONS)[number];

export interface SubmitFallback {
  /**
   * `upload`: the multipart upload instead of finishing the live stream;
   * `submit`: the plain JSON submit instead of the multipart upload;
   * `recovery`: the copy the reporter saved locally when every submit failed,
   * sent by a later run.
   */
  path: SubmitFallbackPath;
  reason?: SubmitFallbackReason;
}

/** The counts of the files the storage quota refused, by kind, which the reporter sends under the same names. */
export const NOT_KEPT_COUNTS = ['tracesNotKept', 'attachmentsNotKept', 'reportsNotKept'] as const;

/** Files the storage quota refused, by kind. */
export type NotKeptCounts = { [K in (typeof NOT_KEPT_COUNTS)[number]]?: number };

/** The counters ingest adds up across the run's batches. */
export const INGEST_HEALTH_COUNTS = [
  'stepsDropped',
  'consoleEntriesDropped',
  'tracesSkipped',
  'evidenceFromTrace',
  ...NOT_KEPT_COUNTS,
] as const;

export interface IngestHealth {
  /** Steps the step cap left out, across the run's executions (the failing steps are always kept). */
  stepsDropped?: number;
  /** Console entries the console cap left out, across the run's executions. */
  consoleEntriesDropped?: number;
  /** Traces sent with the run that were not stored. */
  tracesSkipped?: number;
  /** Executions whose console, network or ARIA evidence was rebuilt from their trace. */
  evidenceFromTrace?: number;
  /** Traces of an upload the server did not keep because the storage quota was reached. */
  tracesNotKept?: number;
  /** Attachments (screenshots, videos, other files) of an upload the server did not keep, the quota reached. */
  attachmentsNotKept?: number;
  /** Reports of an upload the server did not keep because the storage quota was reached. */
  reportsNotKept?: number;
  /**
   * The files the reporter did not send once the storage quota refused them, as it last counted them: each count
   * covers the run so far, so a write keeps the larger of the stored and the sent one, and a sharded run adds up its
   * shards' (one count each).
   */
  reporterNotKept?: NotKeptCounts;
  /** The fallback the reporter took to deliver the run. */
  submitFallback?: SubmitFallback;
}

/** The largest count kept: more steps, console entries or files than any run holds. */
export const MAX_INGEST_COUNT = 1_000_000_000;

/** A count as kept: a whole number above 0, held to `MAX_INGEST_COUNT`. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_INGEST_COUNT)
    : undefined;
}

function readSubmitFallback(value: unknown): SubmitFallback | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { path, reason } = value as Record<string, unknown>;
  if (!SUBMIT_FALLBACK_PATHS.includes(path as SubmitFallbackPath)) return undefined;
  return {
    path: path as SubmitFallbackPath,
    ...(SUBMIT_FALLBACK_REASONS.includes(reason as SubmitFallbackReason)
      ? { reason: reason as SubmitFallbackReason }
      : {}),
  };
}

/** The well-formed counts of files not kept in `source`; undefined when it holds none. */
function readNotKept(source: unknown): NotKeptCounts | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const counts: NotKeptCounts = {};
  for (const key of NOT_KEPT_COUNTS) {
    const n = positiveInt((source as Record<string, unknown>)[key]);
    if (n !== undefined) counts[key] = n;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

/** Two sets of counts of files not kept, joined kind by kind with `join`; undefined when neither holds any. */
function joinNotKept(
  a: NotKeptCounts | undefined,
  b: NotKeptCounts | undefined,
  join: (a: number, b: number) => number,
): NotKeptCounts | undefined {
  const counts: NotKeptCounts = {};
  for (const key of NOT_KEPT_COUNTS) {
    const n = Math.min(join(a?.[key] ?? 0, b?.[key] ?? 0), MAX_INGEST_COUNT);
    if (n > 0) counts[key] = n;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

const sum = (a: number, b: number) => a + b;

/** The run's ingest health, keeping only well-formed fields; null when it holds none. */
export function readIngestHealth(metadata: unknown): IngestHealth | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).ingestHealth;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const health: IngestHealth = {};
  for (const key of INGEST_HEALTH_COUNTS) {
    const n = positiveInt(source[key]);
    if (n !== undefined) health[key] = n;
  }
  const reporterNotKept = readNotKept(source.reporterNotKept);
  if (reporterNotKept) health.reporterNotKept = reporterNotKept;
  const fallback = readSubmitFallback(source.submitFallback);
  if (fallback) health.submitFallback = fallback;
  return Object.keys(health).length > 0 ? health : null;
}

/**
 * Add `delta`'s counts to `current`'s, the reporter's files not kept too (a shard's join its run's); a fallback in
 * `delta` replaces the stored one.
 */
export function addIngestHealth(current: IngestHealth | null, delta: IngestHealth): IngestHealth | null {
  const out: IngestHealth = { ...current };
  for (const key of INGEST_HEALTH_COUNTS) {
    const total = Math.min((current?.[key] ?? 0) + (delta[key] ?? 0), MAX_INGEST_COUNT);
    if (total > 0) out[key] = total;
  }
  const reporterNotKept = joinNotKept(current?.reporterNotKept, delta.reporterNotKept, sum);
  if (reporterNotKept) out.reporterNotKept = reporterNotKept;
  if (delta.submitFallback) out.submitFallback = delta.submitFallback;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Whether the instance sets a storage quota (the operator's, or `PIWI_STORAGE_QUOTA_BYTES`), the one that refuses a
 * reporter's files.
 */
function hasStorageQuota(): boolean {
  return storageQuotaSetting(heldOperatorLimits(), processEnv()).value !== null;
}

/**
 * The files a reporter says it did not send, while the instance sets a storage quota: the `tracesNotKept`,
 * `attachmentsNotKept` and `reportsNotKept` of the ingest health it sends, or the `reporterNotKept` of stored
 * metadata sent through again, whose other counts are the server's own.
 */
function sentNotKept(health: IngestHealth | null): NotKeptCounts | undefined {
  if (!health || !hasStorageQuota()) return undefined;
  return health.reporterNotKept ?? readNotKept(health);
}

/** What the reporter may tell of a run's ingest: its submit fallback, and the files it did not send (`sentNotKept`). */
function reportedIngestHealth(health: IngestHealth | null): IngestHealth {
  const reported: IngestHealth = {};
  const notKept = sentNotKept(health);
  if (notKept) reported.reporterNotKept = notKept;
  if (health?.submitFallback) reported.submitFallback = health.submitFallback;
  return reported;
}

/**
 * The files a reporter's run metadata says it did not send once the storage quota refused them, as the run's ingest
 * health keeps them (`reporterNotKept`); empty when it says none.
 */
export function reportedNotKept(metadata: unknown): IngestHealth {
  const notKept = sentNotKept(readIngestHealth(metadata));
  return notKept ? { reporterNotKept: notKept } : {};
}

/** `metadata` with `delta` added to its ingest health (`addIngestHealth`). */
export function withIngestHealth(metadata: Record<string, unknown>, delta: IngestHealth): Record<string, unknown> {
  const health = addIngestHealth(readIngestHealth(metadata), delta);
  return { ...metadata, ...(health ? { ingestHealth: health } : {}) };
}

/**
 * `metadata` with the files its reporter says it did not send (`reportedNotKept`): each count the larger of the
 * stored one and the reporter's, which counts the files it left out of the whole run so far, so the same counts sent
 * again change nothing.
 */
export function withReportedNotKept(
  metadata: Record<string, unknown>,
  reported: IngestHealth,
): Record<string, unknown> {
  const health = readIngestHealth(metadata) ?? {};
  const reporterNotKept = joinNotKept(health.reporterNotKept, reported.reporterNotKept, Math.max);
  return reporterNotKept ? { ...metadata, ingestHealth: { ...health, reporterNotKept } } : metadata;
}

/** `metadata` without the files its reporter says it did not send, which a sharded run adds shard by shard. */
export function withoutReportedNotKept(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  const health = readIngestHealth(metadata);
  if (!metadata || !health) return metadata;
  const { ingestHealth: _health, ...rest } = metadata;
  delete health.reporterNotKept;
  return Object.keys(health).length > 0 ? { ...rest, ingestHealth: health } : rest;
}

/**
 * Run metadata the reporter sent, cleaned for storage: of its `ingestHealth`
 * only the submit fallback and the files it did not send are kept, since the
 * other counts are the server's own.
 */
export function reporterIngestHealth(metadata: Record<string, unknown>): Record<string, unknown> {
  if (!('ingestHealth' in metadata)) return metadata;
  const { ingestHealth: _sent, ...rest } = metadata;
  const reported = reportedIngestHealth(readIngestHealth(metadata));
  return Object.keys(reported).length > 0 ? { ...rest, ingestHealth: reported } : rest;
}

/**
 * Metadata replacing a run's stored metadata, with the ingest health already
 * recorded on the run carried over: its counts are kept, the incoming
 * fallback, when there is one, replaces the stored fallback, and each count
 * of files the reporter did not send is the larger of the stored and the
 * incoming one (`withReportedNotKept`), so a write that carries the stored
 * metadata back counts nothing twice.
 */
export function carryIngestHealth(
  next: Record<string, unknown> | null,
  stored: unknown,
): Record<string, unknown> | null {
  const kept = readIngestHealth(stored);
  if (!kept) return next;
  const incoming = next ? readIngestHealth(next) : null;
  const merged: IngestHealth = { ...kept };
  const reporterNotKept = joinNotKept(kept.reporterNotKept, incoming?.reporterNotKept, Math.max);
  if (reporterNotKept) merged.reporterNotKept = reporterNotKept;
  if (incoming?.submitFallback) merged.submitFallback = incoming.submitFallback;
  return { ...next, ingestHealth: merged };
}

const FALLBACK_SENTENCES: Record<SubmitFallbackPath, string> = {
  upload: 'Delivered by the batch upload instead of the live stream',
  submit: 'Delivered by the plain JSON submit, without its traces and reports',
  recovery: 'Delivered later from the copy the reporter saved when every submit failed',
};

const REASON_CLAUSES: Record<SubmitFallbackReason, string> = {
  'results-lost': 'the live stream lost results',
  'finish-failed': 'finishing the live stream failed',
  'upload-failed': 'the batch upload failed',
  'run-ended': 'another run with the same run label ended its live run',
};

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

const NOT_KEPT_NOUNS: Record<(typeof NOT_KEPT_COUNTS)[number], [string, string]> = {
  tracesNotKept: ['trace', 'traces'],
  attachmentsNotKept: ['attachment', 'attachments'],
  reportsNotKept: ['report', 'reports'],
};

/** "3 traces and 12 attachments were not kept: the storage quota was reached", or null when every file was kept. */
function notKeptSentence(health: IngestHealth): string | null {
  // The server's own and the reporter's, kind by kind.
  const counts = joinNotKept(readNotKept(health), health.reporterNotKept, sum) ?? {};
  const parts: string[] = [];
  let total = 0;
  for (const key of NOT_KEPT_COUNTS) {
    const n = counts[key];
    if (!n) continue;
    parts.push(plural(n, ...NOT_KEPT_NOUNS[key]));
    total += n;
  }
  if (parts.length === 0) return null;
  const listed = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`;
  return `${listed} ${total === 1 ? 'was' : 'were'} not kept: the storage quota was reached`;
}

/** One sentence per thing ingest dropped or rebuilt, in reading order. */
export function describeIngestHealth(health: IngestHealth | null): string[] {
  if (!health) return [];
  const lines: string[] = [];
  if (health.stepsDropped) {
    lines.push(`${plural(health.stepsDropped, 'step', 'steps')} not stored: the step cap kept the failing steps`);
  }
  if (health.consoleEntriesDropped) {
    lines.push(
      `${plural(health.consoleEntriesDropped, 'console entry', 'console entries')} not stored: the console cap kept the first and the latest`,
    );
  }
  if (health.tracesSkipped) lines.push(`${plural(health.tracesSkipped, 'trace', 'traces')} sent but not stored`);
  if (health.evidenceFromTrace) {
    lines.push(
      `Console, network or ARIA evidence of ${plural(health.evidenceFromTrace, 'execution', 'executions')} rebuilt from the trace`,
    );
  }
  const notKept = notKeptSentence(health);
  if (notKept) lines.push(notKept);
  if (health.submitFallback) {
    const { path, reason } = health.submitFallback;
    lines.push(`${FALLBACK_SENTENCES[path]}${reason ? `: ${REASON_CLAUSES[reason]}` : ''}`);
  }
  return lines;
}
