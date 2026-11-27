/**
 * The storage quota's rules: what `PIWI_STORAGE_QUOTA_BYTES` refuses, and the levels administrators are warned at.
 *
 * Once the stored bytes reach the quota, every file is refused and results are still stored. The bytes stored when the
 * instance first went over are kept (`StorageOver`); past them plus `CEILING_SHARE` of the quota, the ceiling, new
 * runs are refused too. Both stop once the usage falls below the quota, and the ceiling is set again the next time it
 * goes over. Administrators are told once per level crossed, and again only after the usage went back below the level
 * by `REARM_MARGIN`.
 */

/** The share of the quota the results may still take, once the instance is over it, before new runs are refused. */
export const CEILING_SHARE = 0.1;

/** What a request is told when the quota refuses its files (`STORAGE_QUOTA_FILES_REFUSED`). */
export const FILES_REFUSED_MESSAGE = 'The storage quota is reached: files are not kept, results are.';

/** What a request that creates a run is told past the ceiling (`STORAGE_QUOTA_EXCEEDED`). */
export const RUNS_REFUSED_MESSAGE = 'The storage is past its quota: new runs are refused until space is freed.';

/** When the instance went over its quota, and the bytes it stored then: the `storage_quota_over` setting. */
export interface StorageOver {
  /** ISO time. */
  since: string;
  usedBytes: number;
}

/** The quota against the stored bytes, and what it refuses. */
export interface StorageQuotaState {
  quotaBytes: number;
  usedBytes: number;
  /** Since when the instance is over its quota, and the ceiling past which it refuses new runs; null below it. */
  over: { since: string; ceilingBytes: number } | null;
  /** Files are refused: the stored bytes reached the quota. */
  filesRefused: boolean;
  /** New runs are refused: the stored bytes reached the ceiling. */
  runsRefused: boolean;
}

/** A stored `storage_quota_over` setting, or null when it holds none or something else. */
export function readStorageOver(value: unknown): StorageOver | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { since, usedBytes } = value as Record<string, unknown>;
  if (typeof since !== 'string' || Number.isNaN(Date.parse(since))) return null;
  if (typeof usedBytes !== 'number' || !Number.isSafeInteger(usedBytes) || usedBytes < 0) return null;
  return { since, usedBytes };
}

/** The setting once `usedBytes` is read: the one stored while over the quota, a new one on going over, none below. */
export function nextStorageOver(
  stored: StorageOver | null,
  usedBytes: number,
  quotaBytes: number,
  now: Date,
): StorageOver | null {
  if (usedBytes < quotaBytes) return null;
  return stored ?? { since: now.toISOString(), usedBytes };
}

/** The bytes past which new runs are refused: those stored on going over, plus `CEILING_SHARE` of the quota. */
export function storageCeilingBytes(over: StorageOver, quotaBytes: number): number {
  return over.usedBytes + Math.floor(quotaBytes * CEILING_SHARE);
}

/** What the quota refuses with `usedBytes` stored, `over` being the setting `nextStorageOver` keeps. */
export function storageQuotaStateOf(
  quotaBytes: number,
  usedBytes: number,
  over: StorageOver | null,
): StorageQuotaState {
  const filesRefused = usedBytes >= quotaBytes;
  const current =
    filesRefused && over ? { since: over.since, ceilingBytes: storageCeilingBytes(over, quotaBytes) } : null;
  return {
    quotaBytes,
    usedBytes,
    over: current,
    filesRefused,
    runsRefused: current !== null && usedBytes >= current.ceilingBytes,
  };
}

/**
 * The levels administrators are warned at, lowest first: 80% and 95% of the quota, the quota itself (`100`: files are
 * refused) and the ceiling (`'ceiling'`: new runs are refused).
 */
export const STORAGE_WARNING_LEVELS = [80, 95, 100, 'ceiling'] as const;

export type StorageWarningLevel = 0 | (typeof STORAGE_WARNING_LEVELS)[number];

/** How far below a level the usage must fall, in percent of the quota, before that level warns again. */
export const REARM_MARGIN = 5;

/** A level's place among the levels, 0 for none. */
function rank(level: StorageWarningLevel): number {
  return level === 0 ? 0 : STORAGE_WARNING_LEVELS.indexOf(level) + 1;
}

/** The bytes at which a level is reached; the ceiling is out of reach while the instance is not over its quota. */
function levelBytes(level: StorageWarningLevel, quotaBytes: number, ceilingBytes: number | null): number {
  if (level === 'ceiling') return ceilingBytes ?? Infinity;
  return (quotaBytes * level) / 100;
}

/** A level the watch stored, or 0 when it holds none or something else. */
export function readStorageWarningLevel(value: unknown): StorageWarningLevel {
  return STORAGE_WARNING_LEVELS.includes(value as never) ? (value as StorageWarningLevel) : 0;
}

/** The highest level `usedBytes` reaches against `quotaBytes` and the ceiling (null while not over), 0 below the first. */
export function storageWarningLevel(
  usedBytes: number,
  quotaBytes: number,
  ceilingBytes: number | null = null,
): StorageWarningLevel {
  let level: StorageWarningLevel = 0;
  for (const candidate of STORAGE_WARNING_LEVELS) {
    if (usedBytes >= levelBytes(candidate, quotaBytes, ceilingBytes)) level = candidate;
  }
  return level;
}

/**
 * The level administrators were last told of, after `usedBytes` is read: raised to the level reached, kept while the
 * usage stays within `REARM_MARGIN` of it, and lowered once it falls further. `announce` says whether to tell them now.
 */
export function nextStorageWarning(
  told: StorageWarningLevel,
  usedBytes: number,
  quotaBytes: number,
  ceilingBytes: number | null = null,
): { told: StorageWarningLevel; announce: boolean } {
  const reached = storageWarningLevel(usedBytes, quotaBytes, ceilingBytes);
  if (rank(reached) > rank(told)) return { told: reached, announce: true };
  if (reached === told) return { told, announce: false };
  const margin = (quotaBytes * REARM_MARGIN) / 100;
  if (usedBytes >= levelBytes(told, quotaBytes, ceilingBytes) - margin) return { told, announce: false };
  // Fallen well below what they were told: keep the level still reached, so the next crossing of the higher one warns.
  return { told: reached, announce: false };
}

/** The heading of a warning: an email's subject, the banner's first words. */
export function storageWarningTitle(level: Exclude<StorageWarningLevel, 0>): string {
  if (level === 'ceiling') return 'Storage is past its quota: new runs are refused';
  if (level === 100) return 'Storage reached its quota: files are not kept';
  return `Storage is at ${level}% of its quota`;
}

/** What the quota refuses at a level, in a sentence; null while it refuses nothing. */
export function storageRefusalSentence(level: StorageWarningLevel): string | null {
  if (level === 'ceiling') return RUNS_REFUSED_MESSAGE;
  if (level === 100) return FILES_REFUSED_MESSAGE;
  return null;
}
