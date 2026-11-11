/**
 * Links the issues a run's failing tests name to their failure clusters. A test names the issue its failures are
 * tracked in with a `piwi:issue` annotation; once the run finishes, each cluster the test failed into is linked to
 * that issue, read through the project's Jira binding (the lookup and the rules: `#shared/handlers/declared-issues`).
 *
 * The links written here are read-only by `origin`: no policy writes to them and their status never moves the
 * cluster (`getClusterTrackerLink`, `syncOneLink`). A person who wants the write-backs pins the issue by hand.
 */
import type { DbClient } from '../../database';
import { linkNamedIssues, type DeclaredLinksResult } from '#shared/handlers/declared-issues';
import { readProjectIntegration } from './binding';
import { createTracker } from './connections';
import { loadTrackerRun, runDrivesWrites } from './tracker-run';

export {
  MAX_DECLARED_KEYS_PER_RUN,
  MAX_DECLARED_LINKS_PER_CLUSTER,
  declaredIssueKey,
  type DeclaredLinksResult,
} from '#shared/handlers/declared-issues';

/** How long the step may take before it is aborted, writing nothing. */
export const DECLARED_LINKS_TIMEOUT_MS = 10_000;

/**
 * The link step: run at finalize for a run the `tracker` use and the binding's run scope admit, on a project bound to
 * a Jira connection with a `projectKey`, within {@link DECLARED_LINKS_TIMEOUT_MS}.
 */
export async function linkDeclaredIssues(
  db: DbClient,
  runId: number,
  options: { timeoutMs?: number } = {},
): Promise<DeclaredLinksResult> {
  const result: DeclaredLinksResult = { looked: [], linked: [] };
  const run = await loadTrackerRun(db, runId, 'tracker');
  if (!run?.eligible) return { ...result, skipped: 'ineligible' };
  const binding = await readProjectIntegration(db, run.projectId);
  if (!binding.connectionId) return { ...result, skipped: 'unbound' };
  const projectKey = binding.projectKey;
  if (!projectKey) return { ...result, skipped: 'no-project-key' };
  if (!runDrivesWrites(run, binding.policies.scope)) return { ...result, skipped: 'out-of-scope' };
  const tracker = await createTracker(db, binding.connectionId);
  if (!tracker || tracker.provider !== 'jira' || !tracker.getIssues) return { ...result, skipped: 'no-lookup' };

  const deadline = AbortSignal.timeout(options.timeoutMs ?? DECLARED_LINKS_TIMEOUT_MS);
  return linkNamedIssues(db, runId, {
    projectKey,
    connectionId: binding.connectionId,
    tracker: tracker as typeof tracker & Required<Pick<typeof tracker, 'getIssues'>>,
    deadline,
  });
}
