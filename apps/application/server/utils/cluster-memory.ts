/**
 * Resolved-cluster memory — "Fixed before".
 *
 * When a cluster is open, find the resolved clusters it resembles and describe
 * how each was fixed, so a triager (or an AI agent reading the fix plan) can
 * reuse the earlier resolution instead of re-deriving it.
 *
 * The deterministic scoring is pure and lives in `#shared/cluster-memory`; this
 * module selects the resolved-like candidates, computes the fingerprint
 * components and the embedding cosine from stored data, and turns the winners
 * into displayable `FixedBeforeMatch` rows. It reads only what is already
 * stored (status, timestamps, triage note, fix verification, embeddings,
 * affected tests, diagnosis) — no network, no embedding calls — so it runs
 * unchanged in the in-browser demo.
 *
 * This is a read-only comparison path against resolved clusters; it does not
 * touch the open-cluster reconciliation in `cluster-reconcile.ts`.
 */
import { and, desc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { failureClusters, failureDiagnoses, testCases, testRuns, testRunsCases } from '../database/schema';
import { extractErrorSignature, maskSelector } from '#shared/error-fingerprint';
import { cosineSimilarity, parseEmbedding } from './cluster-similarity';
import { normalizeGitUrl } from './scm/git-url';
import { commitUrl } from '#shared/scm-urls';
import { rankFixedBefore, type MemoryCandidate, type MemoryCluster } from '#shared/cluster-memory';
import type { FixedBeforeMatch } from '#shared/fix-plan.types';
import type { RunMetadata } from './run-json-types';
import type { DrizzleDB } from '#shared/handlers/db';

/** Candidates considered before scoring — bounds cost on a large resolved backlog. */
const MAX_CANDIDATES = 100;

type ClusterRow = typeof failureClusters.$inferSelect;

/** A cluster is a "fixed before" candidate when it was resolved or its fix held. */
function isResolvedLike(row: Pick<ClusterRow, 'status' | 'fixLandedRunId' | 'fixVerification'>): boolean {
  if (row.status === 'resolved') return true;
  return row.fixLandedRunId != null && row.fixVerification !== 'regressed';
}

/** Build the comparable shape of a cluster from its stored error + affected tests. */
function toMemoryCluster(
  row: Pick<ClusterRow, 'id' | 'errorType' | 'selector' | 'sampleError' | 'fingerprintSample'>,
  tests: { specFiles: string[]; testTitles: string[] },
): MemoryCluster {
  const sig = extractErrorSignature(row.fingerprintSample || row.sampleError || '');
  return {
    id: row.id,
    errorType: row.errorType,
    normalizedMessage: sig.normalizedMessage,
    maskedSelector: row.selector ? maskSelector(row.selector) : null,
    locator: row.selector,
    specFiles: tests.specFiles,
    testTitles: tests.testTitles,
  };
}

/** Distinct spec files, test titles and a declared owner per cluster, in one query. */
async function affectedTestsByCluster(
  db: DrizzleDB,
  clusterIds: number[],
): Promise<Map<number, { specFiles: string[]; testTitles: string[]; owner: string | null }>> {
  const out = new Map<number, { specFiles: string[]; testTitles: string[]; owner: string | null }>();
  if (clusterIds.length === 0) return out;

  const rows = await db
    .select({
      clusterId: testRunsCases.failureClusterId,
      filePath: testCases.filePath,
      title: testCases.title,
      owner: testCases.owner,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(inArray(testRunsCases.failureClusterId, clusterIds))
    .limit(2000);

  for (const row of rows) {
    if (row.clusterId == null) continue;
    let entry = out.get(row.clusterId);
    if (!entry) out.set(row.clusterId, (entry = { specFiles: [], testTitles: [], owner: null }));
    if (row.filePath && !entry.specFiles.includes(row.filePath)) entry.specFiles.push(row.filePath);
    if (row.title && !entry.testTitles.includes(row.title)) entry.testTitles.push(row.title);
    if (!entry.owner && row.owner) entry.owner = row.owner;
  }
  return out;
}

/** Latest completed diagnosis (summary + feedback) per cluster, in one query. */
async function diagnosisByCluster(
  db: DrizzleDB,
  clusterIds: number[],
): Promise<Map<number, { summary: string | null; feedback: 'up' | 'down' | null }>> {
  const out = new Map<number, { summary: string | null; feedback: 'up' | 'down' | null }>();
  if (clusterIds.length === 0) return out;

  const rows = await db
    .select({
      clusterId: failureDiagnoses.clusterId,
      summary: failureDiagnoses.summary,
      feedback: failureDiagnoses.feedback,
    })
    .from(failureDiagnoses)
    .where(and(inArray(failureDiagnoses.clusterId, clusterIds), eq(failureDiagnoses.status, 'completed')))
    .orderBy(desc(failureDiagnoses.id));

  for (const row of rows) {
    if (row.clusterId == null || out.has(row.clusterId)) continue; // first = latest (id desc)
    out.set(row.clusterId, {
      summary: row.summary,
      feedback: row.feedback === 'up' || row.feedback === 'down' ? row.feedback : null,
    });
  }
  return out;
}

/** The repository URL for the project's commits, from a recent run's metadata. */
async function resolveRepositoryUrl(db: DrizzleDB, runId: number | null): Promise<string | null> {
  if (runId == null) return null;
  const [run] = await db.select({ metadata: testRuns.metadata }).from(testRuns).where(eq(testRuns.id, runId)).limit(1);
  const meta = (run?.metadata as RunMetadata | null) ?? null;
  return normalizeGitUrl(meta?.scm?.remoteUrl ?? null);
}

/**
 * Find the resolved clusters an open cluster resembles, and how each was fixed.
 * Returns at most three, best match first, or an empty array when nothing
 * clears the similarity threshold (so the UI renders nothing rather than noise).
 */
export async function findFixedBefore(db: DrizzleDB, cluster: ClusterRow): Promise<FixedBeforeMatch[]> {
  // Resolved-like candidates in the same project, excluding the cluster itself,
  // most-recently-fixed first and those with no landed fix last, on both
  // dialects (that order breaks scoring ties).
  const candidateRows = await db
    .select()
    .from(failureClusters)
    .where(
      and(
        eq(failureClusters.projectId, cluster.projectId),
        ne(failureClusters.id, cluster.id),
        or(
          eq(failureClusters.status, 'resolved'),
          and(isNotNull(failureClusters.fixLandedRunId), ne(failureClusters.fixVerification, 'regressed')),
        ),
      ),
    )
    .orderBy(sql`${failureClusters.fixLandedAt} DESC NULLS LAST`, desc(failureClusters.updatedAt))
    .limit(MAX_CANDIDATES);

  const candidates = candidateRows.filter(isResolvedLike);
  if (candidates.length === 0) return [];

  const allIds = [cluster.id, ...candidates.map((c) => c.id)];
  const tests = await affectedTestsByCluster(db, allIds);
  const empty = { specFiles: [], testTitles: [], owner: null };

  const openMemory = toMemoryCluster(cluster, tests.get(cluster.id) ?? empty);
  const openVec = cluster.embedding ? parseEmbedding(cluster.embedding) : null;

  const scored: MemoryCandidate[] = candidates.map((row) => {
    // Cosine only when both vectors live in the same model+recipe space.
    let cosine: number | null = null;
    if (openVec && row.embedding && row.embeddingModel && row.embeddingModel === cluster.embeddingModel) {
      const vec = parseEmbedding(row.embedding);
      if (vec) cosine = cosineSimilarity(openVec, vec);
    }
    return { cluster: toMemoryCluster(row, tests.get(row.id) ?? empty), cosine };
  });

  const ranked = rankFixedBefore(openMemory, scored);
  if (ranked.length === 0) return [];

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const diagnoses = await diagnosisByCluster(
    db,
    ranked.map((r) => r.clusterId),
  );
  const repositoryUrl = await resolveRepositoryUrl(db, cluster.lastSeenRunId);

  return ranked.map((match) => {
    const row = byId.get(match.clusterId)!;
    const diag = diagnoses.get(match.clusterId) ?? null;
    const resolvedAt = row.fixLandedAt ?? row.updatedAt;
    return {
      clusterId: row.id,
      title: row.title || row.signature,
      status: row.status,
      resolvedAt: resolvedAt instanceof Date ? resolvedAt.toISOString() : null,
      openMs: row.timeToResolutionMs,
      fixCommit: row.fixCommit,
      fixCommitShort: row.fixCommit ? row.fixCommit.slice(0, 7) : null,
      fixCommitUrl: row.fixCommit ? commitUrl(repositoryUrl, row.fixCommit) : null,
      triageNote: row.triageNote,
      owner: tests.get(row.id)?.owner ?? null,
      // A diagnosis rated unhelpful is not offered as how the cluster was fixed.
      diagnosisTitle: diag?.feedback === 'down' ? null : (diag?.summary ?? null),
      diagnosisFeedback: diag?.feedback ?? null,
      reason: match.reason,
      score: match.score,
    };
  });
}
