import { REPORT_READY_EVENT } from '#shared/notification-events';
import { scopeAllows, type ProjectScope } from '../project-access';

/**
 * Whether a caller whose projects are `scope` can open every project a notification event is about: every one a
 * quality report covers (a report about none, like its snapshot, is anyone's), else its own project. Any other event
 * naming no project reaches nobody.
 */
export function opensEveryProject(scope: ProjectScope, event: Record<string, unknown>): boolean {
  if (event.type === REPORT_READY_EVENT) {
    return ((event.projectIds as number[] | undefined) ?? []).every((id) => scopeAllows(scope, id));
  }
  return typeof event.projectId === 'number' && scopeAllows(scope, event.projectId);
}
