/**
 * Who may read a tracker through a connection: its projects, issue types,
 * create-screen fields, assignable people, issues and icons, as the pickers of
 * the create-issue modal and of a project's Issue tracker settings list them.
 * The server checks it in `requireConnectionAccess`, the demo in its connection
 * routes.
 */
import { can, holdsAnywhere, type AccessSummary } from '#shared/permissions';

/**
 * The one answer for a connection that does not exist, has no credentials, or is
 * not the caller's to read through.
 */
export const CONNECTION_NOT_FOUND = 'Connection not found or has no credentials';

/**
 * Whether a caller may read through a connection bound to `boundProjectIds`:
 * someone who manages connections (`connections:manage`), a Project admin of any
 * project (`project:manage`), or someone who files issues (`issue:create`) on a
 * project bound to it.
 */
export function canReadThroughConnection(access: AccessSummary, boundProjectIds: readonly number[]): boolean {
  if (can(access, 'connections:manage') || holdsAnywhere(access, 'project:manage')) return true;
  return boundProjectIds.some((projectId) => can(access, 'issue:create', projectId));
}
