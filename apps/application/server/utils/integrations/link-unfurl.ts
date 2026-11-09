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
 * Refresh a link's enrichment, through the connection its project is bound to
 * (`projectConnectionId`) and no other. A link on that connection reads its
 * record through the connection's tracker; any other link keeps the generic
 * unfurl path (rich SCM/OpenGraph), which reads a Jira URL only through that
 * same connection, and uses the instance SCM token only for a repository pinned
 * by a project in `readable`, the projects the caller can read.
 */
export async function unfurlLink(
  db: DbClient,
  link: Pick<EntityLink, 'url' | 'connectionId' | 'externalId' | 'key'>,
  readable: ProjectScope,
  projectConnectionId: number | null,
): Promise<LinkUnfurlResult> {
  if (link.connectionId != null && link.connectionId === projectConnectionId) {
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
  return unfurlUrl(link.url, db, readable, projectConnectionId);
}
