/**
 * What ingest dropped or rebuilt for one run, kept as `metadata.ingestHealth`.
 * The server counts what its caps left out and what it rebuilt from traces;
 * the reporter names the submit fallback it took. Every field is optional and
 * absent when nothing happened, so a run ingested whole carries no key.
 */

/** How the reporter delivered a run when its first choice failed. */
export const SUBMIT_FALLBACK_PATHS = ['upload', 'submit', 'recovery'] as const;
export type SubmitFallbackPath = (typeof SUBMIT_FALLBACK_PATHS)[number];

/** Why the reporter fell back. */
export const SUBMIT_FALLBACK_REASONS = ['results-lost', 'finish-failed', 'upload-failed'] as const;
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

/** The counters ingest adds up across the run's batches. */
export const INGEST_HEALTH_COUNTS = [
  'stepsDropped',
  'consoleEntriesDropped',
  'tracesSkipped',
  'evidenceFromTrace',
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
  /** The fallback the reporter took to deliver the run. */
  submitFallback?: SubmitFallback;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
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
  const fallback = readSubmitFallback(source.submitFallback);
  if (fallback) health.submitFallback = fallback;
  return Object.keys(health).length > 0 ? health : null;
}

/** Add `delta`'s counts to `current`'s; a fallback in `delta` replaces the stored one. */
export function addIngestHealth(current: IngestHealth | null, delta: IngestHealth): IngestHealth | null {
  const out: IngestHealth = { ...current };
  for (const key of INGEST_HEALTH_COUNTS) {
    const sum = (current?.[key] ?? 0) + (delta[key] ?? 0);
    if (sum > 0) out[key] = sum;
  }
  if (delta.submitFallback) out.submitFallback = delta.submitFallback;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Run metadata the reporter sent, cleaned for storage: of its `ingestHealth`
 * only the submit fallback is kept, since the counts are the server's own.
 */
export function reporterIngestHealth(metadata: Record<string, unknown>): Record<string, unknown> {
  if (!('ingestHealth' in metadata)) return metadata;
  const { ingestHealth: _sent, ...rest } = metadata;
  const fallback = readIngestHealth(metadata)?.submitFallback;
  return fallback ? { ...rest, ingestHealth: { submitFallback: fallback } } : rest;
}

/**
 * Metadata replacing a run's stored metadata, with the ingest health already
 * recorded on the run carried over: its counts are kept, and the incoming
 * fallback, when there is one, replaces the stored fallback.
 */
export function carryIngestHealth(
  next: Record<string, unknown> | null,
  stored: unknown,
): Record<string, unknown> | null {
  const kept = readIngestHealth(stored);
  if (!kept) return next;
  const incoming = next ? readIngestHealth(next) : null;
  const merged = addIngestHealth(kept, {
    ...(incoming?.submitFallback ? { submitFallback: incoming.submitFallback } : {}),
  });
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
};

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
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
  if (health.submitFallback) {
    const { path, reason } = health.submitFallback;
    lines.push(`${FALLBACK_SENTENCES[path]}${reason ? `: ${REASON_CLAUSES[reason]}` : ''}`);
  }
  return lines;
}
