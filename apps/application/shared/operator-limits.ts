import { z } from 'zod';
import { MIN_STORAGE_QUOTA_BYTES, parseStorageQuotaBytes } from './storage-quota';
import {
  DEFAULT_MAX_SUBMIT_BYTES,
  DEFAULT_MAX_UPLOAD_BYTES,
  MAX_IMPORT_MAX_BYTES,
  MAX_SUBMIT_MAX_BYTES,
  MIN_IMPORT_MAX_BYTES,
  MIN_SUBMIT_MAX_BYTES,
} from './upload-limits';

/**
 * The limits whoever runs the instance (the operator) sets through `PUT /api/operator/limits`: the storage quota, the
 * largest upload and results document, the days of runs the retention sweep keeps, and read-only mode. Each value is
 * the operator's when set, else its environment variable's, else the default. A retention the operator lowers waits
 * `RETENTION_LOWERING_WAIT_DAYS` before the sweep applies it: until then the sweep keeps the days it kept before.
 *
 * The values the server last read from the database are held here (`holdOperatorLimits`), so each reader resolves its
 * value with no query of its own; the demo holds none.
 */

/** Where a limit's value comes from. */
export const LIMIT_SOURCES = ['operator', 'environment', 'default'] as const;
export type LimitSource = (typeof LIMIT_SOURCES)[number];

/** The days a lowered retention waits before the sweep applies it. */
export const RETENTION_LOWERING_WAIT_DAYS = 14;
/** The most days of runs a retention keeps: 100 years. */
export const MAX_RETENTION_DAYS = 36_500;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a write is told while the instance is read-only (`READ_ONLY`). */
export const READ_ONLY_MESSAGE =
  'This instance is read-only: changes and uploads are refused until it is writable again.';

/** A limit's value now and where it comes from. */
export interface LimitSetting<T> {
  value: T;
  source: LimitSource;
}

/** The days of runs the retention sweep keeps (null or 0: every run), and a lowered value waiting to apply. */
export interface RetentionLimit extends LimitSetting<number | null> {
  pending: { value: number | null; source: LimitSource; appliesAt: string } | null;
}

/** Every limit the operator can set, as it applies now. */
export interface InstanceLimits {
  storageQuotaBytes: LimitSetting<number | null>;
  importMaxBytes: LimitSetting<number>;
  submitMaxBytes: LimitSetting<number>;
  retentionDays: RetentionLimit;
  readOnly: LimitSetting<boolean>;
}

/** The limits as stored under one `app_settings` key: the values the operator set, and a lowered retention's wait. */
export interface StoredOperatorLimits {
  storageQuotaBytes?: number;
  importMaxBytes?: number;
  submitMaxBytes?: number;
  retentionDays?: number;
  readOnly?: boolean;
  /** While a lowered retention waits: the days the sweep keeps until `until`, and where they came from. */
  retentionKept?: { days: number | null; source: LimitSource; until: string };
}

/** The environment a value is read from: `process.env` on the server. */
export type LimitEnv = Record<string, string | undefined>;

const bytes = (min: number, max: number) => z.number().int().min(min).max(max);
const STORAGE_QUOTA = bytes(MIN_STORAGE_QUOTA_BYTES, Number.MAX_SAFE_INTEGER);
const IMPORT_MAX = bytes(MIN_IMPORT_MAX_BYTES, MAX_IMPORT_MAX_BYTES);
const SUBMIT_MAX = bytes(MIN_SUBMIT_MAX_BYTES, MAX_SUBMIT_MAX_BYTES);
const RETENTION = z.number().int().min(0).max(MAX_RETENTION_DAYS);

/**
 * What the operator sends: any of the limits, a number or a boolean setting it, `null` clearing it back to the
 * environment's value. The bounds are those of each variable: a quota of 1 MiB at least, an upload of 1 MiB to 5 GiB,
 * a results document of 1 MiB to 512 MiB, a retention of 0 days (every run kept) or more.
 */
export const operatorLimitsInputSchema = z
  .object({
    storageQuotaBytes: STORAGE_QUOTA.nullable().optional(),
    importMaxBytes: IMPORT_MAX.nullable().optional(),
    submitMaxBytes: SUBMIT_MAX.nullable().optional(),
    retentionDays: RETENTION.nullable().optional(),
    readOnly: z.boolean().nullable().optional(),
  })
  .strict();

export type OperatorLimitsInput = z.infer<typeof operatorLimitsInputSchema>;

const storedSchema = z.object({
  storageQuotaBytes: STORAGE_QUOTA.optional().catch(undefined),
  importMaxBytes: IMPORT_MAX.optional().catch(undefined),
  submitMaxBytes: SUBMIT_MAX.optional().catch(undefined),
  retentionDays: RETENTION.optional().catch(undefined),
  readOnly: z.boolean().optional().catch(undefined),
  retentionKept: z
    .object({
      days: RETENTION.nullable(),
      source: z.enum(LIMIT_SOURCES),
      until: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
    })
    .optional()
    .catch(undefined),
});

/** A stored value read back as the operator's limits: a field that is not one is left out. */
export function readStoredOperatorLimits(value: unknown): StoredOperatorLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const parsed = storedSchema.parse(value);
  return Object.fromEntries(Object.entries(parsed).filter(([, field]) => field !== undefined)) as StoredOperatorLimits;
}

let held: StoredOperatorLimits = {};

/** The operator's limits as this process last read them; none until the server reads them. */
export function heldOperatorLimits(): StoredOperatorLimits {
  return held;
}

/** Holds the operator's limits the server read or wrote, for every reader of this process. */
export function holdOperatorLimits(limits: StoredOperatorLimits): void {
  held = limits;
}

/** The environment of the server, and none in a browser. */
export function processEnv(): LimitEnv {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

/** A byte count an environment variable sets, clamped to `[min, max]`; null when unset, blank or not a number. */
function bytesFromEnv(raw: string | undefined, min: number, max: number): number | null {
  if (raw == null || raw.trim() === '') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/** The storage quota: the operator's, else `PIWI_STORAGE_QUOTA_BYTES` (a whole number, 1 MiB at least), else none. */
export function storageQuotaSetting(stored: StoredOperatorLimits, env: LimitEnv): LimitSetting<number | null> {
  if (stored.storageQuotaBytes !== undefined) return { value: stored.storageQuotaBytes, source: 'operator' };
  const fromEnv = parseStorageQuotaBytes(env.PIWI_STORAGE_QUOTA_BYTES);
  return fromEnv === null ? { value: null, source: 'default' } : { value: fromEnv, source: 'environment' };
}

/** The largest multipart upload: the operator's, else `PIWI_IMPORT_MAX_BYTES` (clamped), else 500 MiB. */
export function importMaxBytesSetting(stored: StoredOperatorLimits, env: LimitEnv): LimitSetting<number> {
  if (stored.importMaxBytes !== undefined) return { value: stored.importMaxBytes, source: 'operator' };
  const fromEnv = bytesFromEnv(env.PIWI_IMPORT_MAX_BYTES, MIN_IMPORT_MAX_BYTES, MAX_IMPORT_MAX_BYTES);
  return fromEnv === null
    ? { value: DEFAULT_MAX_UPLOAD_BYTES, source: 'default' }
    : { value: fromEnv, source: 'environment' };
}

/** The largest results document sent as JSON: the operator's, else `PIWI_SUBMIT_MAX_BYTES` (clamped), else 256 MiB. */
export function submitMaxBytesSetting(stored: StoredOperatorLimits, env: LimitEnv): LimitSetting<number> {
  if (stored.submitMaxBytes !== undefined) return { value: stored.submitMaxBytes, source: 'operator' };
  const fromEnv = bytesFromEnv(env.PIWI_SUBMIT_MAX_BYTES, MIN_SUBMIT_MAX_BYTES, MAX_SUBMIT_MAX_BYTES);
  return fromEnv === null
    ? { value: DEFAULT_MAX_SUBMIT_BYTES, source: 'default' }
    : { value: fromEnv, source: 'environment' };
}

/** The retention the operator's value or the environment sets, any wait aside. */
function retentionTarget(stored: StoredOperatorLimits, env: LimitEnv): LimitSetting<number | null> {
  if (stored.retentionDays !== undefined) return { value: stored.retentionDays, source: 'operator' };
  const raw = env.PIWI_RETENTION_DAYS;
  if (raw == null || raw.trim() === '') return { value: null, source: 'default' };
  const days = Number(raw);
  return Number.isFinite(days) && days >= 0
    ? { value: Math.floor(days), source: 'environment' }
    : { value: null, source: 'default' };
}

/**
 * The days of runs the retention sweep keeps at `now`: the operator's, else `PIWI_RETENTION_DAYS`, else every run
 * (null). While a lowered retention waits, the days kept before it, with the lowered value as `pending`.
 */
export function retentionDaysSetting(stored: StoredOperatorLimits, env: LimitEnv, now: Date): RetentionLimit {
  const target = retentionTarget(stored, env);
  const kept = stored.retentionKept;
  if (kept && Date.parse(kept.until) > now.getTime()) {
    return { value: kept.days, source: kept.source, pending: { ...target, appliesAt: kept.until } };
  }
  return { ...target, pending: null };
}

/** Whether the instance is read-only: only the operator turns it on. */
export function readOnlySetting(stored: StoredOperatorLimits): LimitSetting<boolean> {
  return stored.readOnly === undefined
    ? { value: false, source: 'default' }
    : { value: stored.readOnly, source: 'operator' };
}

/** Whether the instance is read-only, by the operator's limits this process holds: never in a browser. */
export function isReadOnly(): boolean {
  return readOnlySetting(heldOperatorLimits()).value;
}

/** Every limit as it applies at `now`. */
export function instanceLimitsOf(stored: StoredOperatorLimits, env: LimitEnv, now: Date): InstanceLimits {
  return {
    storageQuotaBytes: storageQuotaSetting(stored, env),
    importMaxBytes: importMaxBytesSetting(stored, env),
    submitMaxBytes: submitMaxBytesSetting(stored, env),
    retentionDays: retentionDaysSetting(stored, env, now),
    readOnly: readOnlySetting(stored),
  };
}

/** The days a retention keeps, every run (no retention, or 0) counting as the longest. */
function keptSpan(days: number | null): number {
  return days === null || days <= 0 ? Infinity : days;
}

/**
 * The stored limits once `input` is applied at `now`: a number or boolean sets a limit, `null` clears it. A retention
 * that keeps fewer days than the sweep keeps now, the environment's included once cleared to it, waits
 * `RETENTION_LOWERING_WAIT_DAYS`, the sweep keeping its days until then; one that keeps as many or more applies at once
 * and ends any wait. While a lowered retention waits, a retention that keeps as many days as it or more, but fewer than
 * the sweep keeps, keeps that wait and its end; only one that keeps still fewer days waits again from `now`. A wait
 * that ended is dropped.
 */
export function applyOperatorLimits(
  stored: StoredOperatorLimits,
  input: OperatorLimitsInput,
  env: LimitEnv,
  now: Date,
): StoredOperatorLimits {
  const next: StoredOperatorLimits = { ...stored };
  const keys = ['storageQuotaBytes', 'importMaxBytes', 'submitMaxBytes', 'retentionDays', 'readOnly'] as const;
  for (const key of keys) {
    const value = input[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  if (input.retentionDays !== undefined) {
    const before = retentionDaysSetting(stored, env, now);
    delete next.retentionKept;
    const after = retentionTarget(next, env);
    if (keptSpan(after.value) < keptSpan(before.value)) {
      const pending = before.pending;
      if (pending && stored.retentionKept && keptSpan(after.value) >= keptSpan(pending.value)) {
        next.retentionKept = stored.retentionKept;
      } else {
        const until = new Date(now.getTime() + RETENTION_LOWERING_WAIT_DAYS * DAY_MS).toISOString();
        next.retentionKept = { days: before.value, source: before.source, until };
      }
    }
  } else if (next.retentionKept && Date.parse(next.retentionKept.until) <= now.getTime()) {
    delete next.retentionKept;
  }
  return next;
}
