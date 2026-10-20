import { mergeExternalIdDuplicates } from '@piwitests/core/test-meta';

/**
 * Keep the duplicate external IDs a run recorded (`metadata.externalIdDuplicates`, written by ingest from every
 * shard) when the reporter's metadata replaces the stored one, merged with the reporter's own list.
 */
export function carryExternalIdDuplicates(
  next: Record<string, unknown> | null,
  stored: unknown,
): Record<string, unknown> | null {
  const kept = (stored as Record<string, unknown> | null)?.externalIdDuplicates;
  if (!Array.isArray(kept) || kept.length === 0) return next;
  const merged = mergeExternalIdDuplicates(kept, next?.externalIdDuplicates);
  return { ...next, externalIdDuplicates: merged };
}
