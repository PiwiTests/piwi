/**
 * The storage quota's warning levels: how much of `PIWI_STORAGE_QUOTA_BYTES` the stored bytes reach. Administrators
 * are told once per level crossed, and again only after the usage went back below the level by `REARM_MARGIN`.
 */

/** The levels, in percent of the quota, at which administrators are warned. */
export const STORAGE_WARNING_LEVELS = [80, 95] as const;

export type StorageWarningLevel = 0 | (typeof STORAGE_WARNING_LEVELS)[number];

/** How far below a level the usage must fall, in percent of the quota, before that level warns again. */
export const REARM_MARGIN = 5;

/** The highest level `usedBytes` reaches against `quotaBytes`, 0 below the first. */
export function storageWarningLevel(usedBytes: number, quotaBytes: number): StorageWarningLevel {
  const percent = (usedBytes / quotaBytes) * 100;
  let level: StorageWarningLevel = 0;
  for (const threshold of STORAGE_WARNING_LEVELS) if (percent >= threshold) level = threshold;
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
): { told: StorageWarningLevel; announce: boolean } {
  const reached = storageWarningLevel(usedBytes, quotaBytes);
  if (reached > told) return { told: reached, announce: true };
  if (reached === told) return { told, announce: false };
  const percent = (usedBytes / quotaBytes) * 100;
  if (percent >= told - REARM_MARGIN) return { told, announce: false };
  // Fallen well below what they were told: keep the level still reached, so the next crossing of the higher one warns.
  return { told: reached, announce: false };
}
