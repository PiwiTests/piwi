import type { EntityLink } from '../../database/schema';
import type { DbClient } from '../../database';
import type { ProjectScope } from '../project-access';
import type { UnfurlResult } from '../unfurl/UnfurlProvider';
import { unfurlUrl } from '../unfurl';
import { createTracker } from './connections';
import type { TrackerStatusCategory } from './types';

/** A link's enrichment; a tracker read also gives the status category and assignee. */
export interface LinkUnfurlResult extends UnfurlResult {
  statusCategory?: TrackerStatusCategory | null;
  assignee?: string | null;
}

const EMPTY: LinkUnfurlResult = { title: null, statusText: null, statusColor: null };

/**
 * Refresh a link's enrichment. A link bound to a connection reads its record
 * through that connection's tracker; a link without one keeps the generic unfurl
 * path (rich SCM/OpenGraph), which uses the instance SCM token only for a
 * repository pinned by a project in `readable`, the projects the caller can read.
 */
export async function unfurlLink(
  db: DbClient,
  link: Pick<EntityLink, 'url' | 'connectionId' | 'externalId' | 'key'>,
  readable: ProjectScope,
): Promise<LinkUnfurlResult> {
  if (link.connectionId) {
    const tracker = await createTracker(db, link.connectionId);
    if (!tracker) return EMPTY;
    const idOrKey = link.externalId ?? link.key;
    if (!idOrKey) return EMPTY;
    try {
      const issue = await tracker.getIssue(idOrKey);
      if (issue) {
        return {
          title: issue.title,
          statusText: issue.status,
          statusColor: issue.statusColor,
          statusCategory: issue.statusCategory,
          assignee: issue.assignee?.displayName ?? null,
        };
      }
    } catch {
      return EMPTY;
    }
    return EMPTY;
  }
  return unfurlUrl(link.url, db, readable);
}
