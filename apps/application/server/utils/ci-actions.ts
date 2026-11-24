/**
 * CI actions — server-side settings access and Check.
 *
 * The settings live on the project row (`projects.ciRerun`) as a list of named
 * actions (`shared/ci-actions.ts`); a value with no `actions` list is
 * converted when read. Check says whether an action's target takes what a
 * dispatch sends, without starting anything: each kind of target's provider
 * reads it (`./ci-providers/`).
 */
import { eq } from 'drizzle-orm';
import { projects } from '../database/schema';
import { ciProvider } from './ci-providers';
import {
  resolveCiActionsSettings,
  type CiAction,
  type CiActionCheckResult,
  type CiActionsSettings,
} from '#shared/ci-actions';
import type { CiServerUse } from './ci-server-dispatch';
import type { DbClient } from '../database';

/** The project's CI actions (disabled and empty when unset). */
export async function getCiActionsSettings(db: DbClient, projectId: number): Promise<CiActionsSettings> {
  const [project] = await db.select({ ciRerun: projects.ciRerun }).from(projects).where(eq(projects.id, projectId));
  return resolveCiActionsSettings(project?.ciRerun ?? null);
}

/**
 * Check an action before its first dispatch, through its kind's provider: a
 * GitHub workflow file, a Bitbucket pipelines file or a Jenkins job is read; a
 * GitLab pipeline and a Custom request declare nothing Piwi can read without
 * starting them.
 */
export function checkCiAction(
  db: DbClient,
  projectId: number,
  action: CiAction,
  use: CiServerUse,
): Promise<CiActionCheckResult> {
  return ciProvider(action.target.type).check(db, projectId, action, use);
}
