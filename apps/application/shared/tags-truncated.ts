import { addTagsTruncated, keepTagsTruncated } from '@piwitests/core/test-meta';

function withTagsTruncated(
  metadata: Record<string, unknown> | null,
  merged: ReturnType<typeof keepTagsTruncated>,
): Record<string, unknown> | null {
  if (merged) return { ...metadata, tagsTruncated: merged };
  if (!metadata || !('tagsTruncated' in metadata)) return metadata;
  const { tagsTruncated: _dropped, ...rest } = metadata;
  return rest;
}

/** A run's metadata without `tagsTruncated`, for a shard whose cut tags are added as it is counted in. */
export function withoutTagsTruncated(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  return withTagsTruncated(metadata, null);
}

/**
 * Keep the tests whose tags were cut that a run recorded (`metadata.tagsTruncated`) when its reporter's metadata
 * replaces the stored one. The reporter reports the same tests each time it sends its metadata, so the two count once.
 */
export function carryTagsTruncated(
  next: Record<string, unknown> | null,
  stored: unknown,
): Record<string, unknown> | null {
  const kept = (stored as Record<string, unknown> | null)?.tagsTruncated;
  return withTagsTruncated(next, keepTagsTruncated(kept, next?.tagsTruncated));
}

/**
 * Add the tests whose tags were cut that another shard or batch of the run reports (`sent`, its metadata) to the
 * ones the run's metadata holds: their counts add up.
 */
export function addRunTagsTruncated(metadata: Record<string, unknown>, sent: unknown): Record<string, unknown> {
  const merged = addTagsTruncated(metadata.tagsTruncated, (sent as Record<string, unknown> | null)?.tagsTruncated);
  return withTagsTruncated(metadata, merged) ?? {};
}
