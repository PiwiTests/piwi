import { eq } from 'drizzle-orm';
import { projects } from '../../database/schema';
import type { DbClient } from '../../database';
import type { RunMetadata } from '../run-json-types';
import { createScmProvider } from './index';
import { normalizeGitUrl, FALLBACK_DEFAULT_BRANCH } from './git-url';
import { mostCommonRunBranch, type DefaultBranchProject } from './stored-default-branch';
import { TtlCache } from '../ttl-cache';
import { runOrigin } from '#shared/run-eligibility';

/**
 * How long a repository whose default branch its SCM provider did not give (no
 * token, no access, an error) is not asked again for one project.
 */
const FAILED_LOOKUP_TTL_MS = 10 * 60 * 1000;

/**
 * The SCM lookup of a repository's default branch per project: shared while it
 * runs, since a finished run starts several readers of the default branch at
 * once, and kept for {@link FAILED_LOOKUP_TTL_MS} when it found none.
 */
const providerLookups = new TtlCache<Promise<string | null>>(FAILED_LOOKUP_TTL_MS);

function providerDefaultBranch(db: DbClient, projectId: number, repositoryUrl: string): Promise<string | null> {
  const key = `${projectId}\x00${repositoryUrl}`;
  const pending = providerLookups.get(key);
  if (pending) return pending;
  const lookup = (async () => {
    const provider = await createScmProvider(repositoryUrl, db, projectId).catch(() => null);
    return (await provider?.getDefaultBranch().catch(() => null)) ?? null;
  })();
  providerLookups.set(key, lookup);
  void lookup.then((branch) => {
    if (branch) providerLookups.delete(key);
  });
  return lookup;
}

/**
 * The effective default branch of a project, resolved through one chain the
 * whole codebase shares:
 *
 *   1. An explicit project setting (`projects.default_branch`) — also the slot a
 *      provider-resolved value is cached into.
 *   2. The SCM provider API (`default_branch` / `mainbranch.name`), fetched from
 *      the run's remote URL and cached back onto the project row so later runs
 *      skip the call. A token-less or failing fetch falls through, and the
 *      provider is not asked about that repository again for ten minutes.
 *   3. The reporter's `metadata.defaultBranch` hint.
 *   4. The most common branch among the project's runs.
 *   5. `'main'`, the documented last resort.
 *
 * Steps 4–5 are shared with `resolveStoredDefaultBranch` (`stored-default-branch.ts`),
 * the no-network variant the ingest hot path uses, so every canonical-graph path agrees.
 *
 * Steps 2 and 3 never read a private run's metadata.
 *
 * Always returns a branch name — never null — so callers get a usable default.
 */
export async function resolveDefaultBranch(
  db: DbClient,
  project: DefaultBranchProject,
  runMetadata?: unknown,
): Promise<string> {
  const configured = project.defaultBranch?.trim();
  if (configured) return configured;

  // A private run's metadata never sets the project's default branch.
  const meta = runOrigin(runMetadata) === 'request' ? null : ((runMetadata as RunMetadata | null) ?? null);

  const repositoryUrl = normalizeGitUrl(meta?.scm?.remoteUrl ?? null);
  if (repositoryUrl) {
    const fetched = await providerDefaultBranch(db, project.id, repositoryUrl);
    if (fetched) {
      // Cache on the project row so subsequent runs short-circuit at step 1.
      await db
        .update(projects)
        .set({ defaultBranch: fetched })
        .where(eq(projects.id, project.id))
        .catch(() => {
          /* best-effort cache; resolution already succeeded */
        });
      return fetched;
    }
  }

  const hint = meta?.defaultBranch?.trim();
  if (hint) return hint;

  const common = await mostCommonRunBranch(db, project.id);
  if (common) return common;

  return FALLBACK_DEFAULT_BRANCH;
}
