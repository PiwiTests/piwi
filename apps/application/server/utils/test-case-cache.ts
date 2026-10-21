import type { DbClient as DB } from '../database';
import { createKeyedLock } from './keyed-lock';
import {
  loadTestCaseIndex,
  resolveTestCases,
  type ResolveTestCasesOptions,
  type ResolvedTestCases,
  type TestCaseClaim,
  type TestCaseIndex,
} from './test-case-match';

/**
 * Process-level cache of each project's test cases, by natural key (file path, describe path, title) and by external
 * ID (see `test-case-match.ts`).
 *
 * On first access for a project, the full set of test cases is loaded from the DB in a single query and stored in
 * memory. Subsequent lookups for that project (across all streaming batches and concurrent runs) hit the in-memory
 * index and skip the DB entirely. Matching writes go through {@link TestCaseCache.resolve}, which keeps the index in
 * step with the rows it creates, renames and moves.
 *
 * Single-instance only — like the SSE event bus, this cache is local to one Node.js process. It is invalidated when
 * a project is deleted.
 */
class TestCaseCache {
  private readonly cache = new Map<number, TestCaseIndex>();
  // Deduplicates concurrent loads for the same project
  private readonly loading = new Map<number, Promise<TestCaseIndex>>();
  // Matching reads the index, then writes after an await: two batches matching at once for one project would both
  // miss a new test and both create it.
  private readonly matching = createKeyedLock<number>();

  /**
   * Return the project's index, loading it from DB on first call. Concurrent callers for the same project share a
   * single in-flight SELECT; a failed SELECT is not kept, so the next call loads again.
   */
  async getProjectCache(db: DB, projectId: number): Promise<TestCaseIndex> {
    const cached = this.cache.get(projectId);
    if (cached) return cached;

    const inflight = this.loading.get(projectId);
    if (inflight) return inflight;

    const load = loadTestCaseIndex(db, projectId)
      .then((index) => {
        this.cache.set(projectId, index);
        return index;
      })
      .finally(() => this.loading.delete(projectId));

    this.loading.set(projectId, load);
    return load;
  }

  /** Match a batch's tests to their test cases, one batch of a project at a time. */
  resolve(
    db: DB,
    projectId: number,
    runId: number,
    claims: TestCaseClaim[],
    options: ResolveTestCasesOptions = {},
  ): Promise<ResolvedTestCases> {
    return this.matching(projectId, async () =>
      resolveTestCases(db, projectId, runId, await this.getProjectCache(db, projectId), claims, options),
    );
  }

  /** Drop the cache for a project (call when the project is deleted). */
  invalidate(projectId: number): void {
    this.cache.delete(projectId);
    this.loading.delete(projectId);
  }
}

export const testCaseCache = new TestCaseCache();
