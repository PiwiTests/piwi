/**
 * Effective test ownership: who answers for a failing test.
 *
 * Two sources, in priority order:
 *
 * 1. A `piwi:owner` annotation on the test — explicit, and always wins.
 * 2. The repository's CODEOWNERS, matched against the spec's file path.
 *
 * The second is the point. Asking every team to annotate every test is how
 * ownership features die; the repository already records who owns which files,
 * and Piwi can read it because it runs inside the network with an SCM token it
 * already has. That makes ownership work on day one with zero test edits.
 *
 * Resolution happens at read time against a short TTL cache rather than being
 * stored on the test case. CODEOWNERS changes without any test changing, so a
 * persisted copy would be wrong until the next run reported that spec.
 */
import { and, eq, desc } from 'drizzle-orm';
import { notPrivateRun } from '#shared/run-eligibility';
import { testRuns } from '../../database/schema';
import { createScmProvider } from './index';
import { normalizeGitUrl } from './git-url';
import { TtlCache } from '../ttl-cache';
import { primaryOwnerForPath, type CompiledCodeowners } from '@piwitests/core/codeowners';
import type { RunMetadata } from '../run-json-types';
import type { DbClient } from '../../database';

/** CODEOWNERS changes on merge, not on every run — an hour is plenty. */
const codeownersCache = new TtlCache<CompiledCodeowners | null>(60 * 60 * 1000);

/**
 * The repository coordinates for a project, read from its most recent run that
 * carried SCM metadata. Projects have no repository column of their own; the
 * reporter records it per run.
 */
async function resolveRepository(
  db: DbClient,
  projectId: number,
): Promise<{ repositoryUrl: string; ref: string } | null> {
  const rows = await db
    .select({ metadata: testRuns.metadata })
    .from(testRuns)
    .where(and(eq(testRuns.projectId, projectId), notPrivateRun(testRuns.origin)))
    .orderBy(desc(testRuns.startTime))
    .limit(20);

  for (const row of rows) {
    const meta = (row.metadata as RunMetadata | null) ?? null;
    const repositoryUrl = normalizeGitUrl(meta?.scm?.remoteUrl ?? null);
    if (!repositoryUrl) continue;
    // Prefer the default branch over the run's own branch: a feature branch's
    // CODEOWNERS is a proposal, not yet the repository's answer.
    const ref = meta?.defaultBranch || meta?.scm?.branch || 'HEAD';
    return { repositoryUrl, ref };
  }
  return null;
}

/**
 * Load and cache the project's CODEOWNERS. Returns `null` when the project has
 * no reachable repository or the repository has no CODEOWNERS file — both are
 * ordinary, and callers fall back to annotation-only ownership.
 */
export async function getProjectCodeowners(db: DbClient, projectId: number): Promise<CompiledCodeowners | null> {
  const repo = await resolveRepository(db, projectId);
  if (!repo) return null;

  const key = `${projectId}:${repo.repositoryUrl}:${repo.ref}`;
  const hit = codeownersCache.get(key);
  if (hit !== undefined) return hit;

  try {
    const provider = await createScmProvider(repo.repositoryUrl, db, projectId);
    const compiled = provider ? await provider.fetchCodeowners(repo.ref) : null;
    codeownersCache.set(key, compiled);
    return compiled;
  } catch {
    // A rate limit or an outage must not break the page that asked; cache the
    // miss for the cache's one-hour TTL so one bad token does not retry on
    // every request.
    codeownersCache.set(key, null);
    return null;
  }
}

/** One test's declared owner and file path, as stored. */
export interface OwnableTest {
  filePath: string;
  /** From the `piwi:owner` annotation; wins when present. */
  owner?: string | null;
}

export interface ResolvedOwner {
  owner: string | null;
  source: 'annotation' | 'codeowners' | null;
}

/**
 * Resolve owners for a batch of tests. Takes the batch rather than one test so
 * the CODEOWNERS file is fetched once per call, not once per row.
 */
export async function resolveOwners<T extends OwnableTest>(
  db: DbClient,
  projectId: number,
  tests: T[],
): Promise<Map<T, ResolvedOwner>> {
  const result = new Map<T, ResolvedOwner>();
  if (tests.length === 0) return result;

  const needsCodeowners = tests.some((test) => !test.owner);
  const compiled = needsCodeowners ? await getProjectCodeowners(db, projectId) : null;

  for (const test of tests) {
    if (test.owner) {
      result.set(test, { owner: test.owner, source: 'annotation' });
      continue;
    }
    const derived = compiled ? primaryOwnerForPath(compiled, test.filePath) : null;
    result.set(test, derived ? { owner: derived, source: 'codeowners' } : { owner: null, source: null });
  }

  return result;
}

/**
 * The owner the repository's CODEOWNERS names for one spec file, shaped as the
 * `resolveOwner` option of `getTestRunCase`. A failed CODEOWNERS read resolves
 * to no owner, so it never blocks the page or the agent tool that asked.
 */
export function codeownersOwnerResolver(db: DbClient, projectId: number) {
  return async (filePath: string): Promise<string | null> => {
    const test: OwnableTest = { filePath, owner: null };
    const resolved = await resolveOwners(db, projectId, [test]).catch(() => new Map<OwnableTest, ResolvedOwner>());
    return resolved.get(test)?.owner ?? null;
  };
}

/**
 * Attach the effective owner to each row of a list, leaving the row's own
 * `owner` field authoritative when it already has one. Shaped for the read
 * paths (flaky leaderboard, pull-request comment) that need the answer inline.
 */
export async function withResolvedOwners<T extends OwnableTest>(
  db: DbClient,
  projectId: number,
  rows: T[],
): Promise<Array<T & { owner: string | null; ownerSource: ResolvedOwner['source'] }>> {
  const resolved = await resolveOwners(db, projectId, rows);
  return rows.map((row) => {
    const entry = resolved.get(row) ?? { owner: row.owner ?? null, source: null };
    return { ...row, owner: entry.owner, ownerSource: entry.source };
  });
}

/**
 * Fill in a fix plan's owner from CODEOWNERS when the tests declared none.
 *
 * Lives here rather than in `fix-plan.ts` so that module stays free of the SCM
 * client (and its node-only crypto), which is what lets the in-browser demo
 * serve fix plans at all.
 */
export async function enrichFixPlanOwnership<
  T extends { ownership: { owner: string | null; source: string | null }; failingTests: Array<{ filePath: string }> },
>(db: DbClient, projectId: number, plan: T): Promise<T> {
  if (plan.ownership.owner || plan.failingTests.length === 0) return plan;

  const resolved = await resolveOwners(db, projectId, plan.failingTests).catch(() => new Map());
  for (const test of plan.failingTests) {
    const owner = resolved.get(test)?.owner;
    if (owner) return { ...plan, ownership: { owner, source: 'codeowners' } };
  }
  return plan;
}
