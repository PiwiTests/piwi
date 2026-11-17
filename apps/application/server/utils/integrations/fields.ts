/**
 * The fields of a tracker's create screen for one connection, project and issue
 * type, cached five minutes like the other pickers: the binding form, the create
 * modal and the create path's required-field check all read them.
 */
import type { DbClient } from '../../database';
import type { TrackerField } from '#shared/integrations/fields';
import { createTracker, nullWhenRefused } from './connections';
import { createFieldsCache } from './picker-cache';

/**
 * The create screen's fields, or null when the connection cannot list them (no
 * credentials, or a tracker without create metadata). A tracker error propagates.
 */
export async function getCreateFields(
  db: DbClient,
  connectionId: number,
  projectKey: string,
  issueType: string,
): Promise<TrackerField[] | null> {
  const cacheKey = createFieldsKey(connectionId, projectKey, issueType);
  const cached = createFieldsCache.get(cacheKey);
  if (cached) return cached;
  const tracker = await nullWhenRefused(createTracker(db, connectionId));
  if (!tracker?.listCreateFields) return null;
  const fields = await tracker.listCreateFields(projectKey, issueType);
  createFieldsCache.set(cacheKey, fields);
  return fields;
}

/** Drop the cached screen, so the next read asks the tracker again — after it refused a create. */
export function forgetCreateFields(connectionId: number, projectKey: string, issueType: string): void {
  createFieldsCache.delete(createFieldsKey(connectionId, projectKey, issueType));
}

function createFieldsKey(connectionId: number, projectKey: string, issueType: string): string {
  return `${connectionId}:${projectKey}:${issueType}`;
}
