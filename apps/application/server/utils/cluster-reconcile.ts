/**
 * Embedding-based reconciliation of failure clusters.
 *
 * The deterministic fingerprint (shared/error-fingerprint.ts) is the fast,
 * always-on primary path. This is the optional semantic layer: after a run, the
 * clusters first seen in that run — plus a budget-capped backfill of older open
 * clusters that have no usable vector yet — are embedded and compared (cosine)
 * against the project's other open clusters. Near-duplicates above a threshold
 * are merged into the longest-lived cluster via `mergeFailureClusters`, which
 * records a fingerprint alias so future failures route to the survivor. Pairs
 * in the ambiguous band are adjudicated by a reasoning model (fed the clusters'
 * error text plus affected-test and overlap context) or recorded as merge
 * suggestions for human review. A pair already decided against (a person's
 * rejection, a hand split, the adjudicator's "no") is never merged, and a pair
 * the adjudicator already judged is not judged again.
 *
 * Vectors are only comparable within one `embeddingModelTag` (model id +
 * input-recipe version): after a model switch or recipe change, stale vectors
 * drop out of the candidate pool and the backfill re-embeds them over the
 * following runs, instead of scoring vectors from different spaces against
 * each other. The backfill also re-embeds the stale vectors of the resolved
 * clusters "Fixed before" compares open ones against (`cluster-memory.ts`),
 * after the open ones and within the same cap; those are never merged.
 *
 * Runs only when an `embedding` AI role is configured; otherwise it's a no-op,
 * so clustering still works with zero AI configuration. Invoked fire-and-forget
 * from the run-finalization path (see ai-diagnosis.ts#autoDiagnoseRun). Passes
 * are serialized per project (in-process) so runs that finish together can't
 * interleave merges of the same clusters.
 */

import { and, asc, count, countDistinct, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { failureClusters, testCases, testRunsCases } from '../database/schema';
import { mergeFailureClusters } from '#shared/handlers/failure-cluster-ops';
import {
  DECIDED_AGAINST_STATUSES,
  getMergePairState,
  recordMergeSuggestion,
} from '#shared/handlers/cluster-merge-suggestions';
import { embedTexts } from './ai-embeddings';
import { buildEmbedText, cosineSimilarity, embeddingModelTag, parseEmbedding } from './cluster-similarity';
import { adjudicateClusterPair } from './cluster-adjudicate';
import type { ClusterForAdjudication, ClusterPairOverlap } from './cluster-adjudicate';
import type { ResolvedAiRole } from '~~/types/api';
import type { DbClient } from '../database';

function threshold(envVar: string, fallback: number): number {
  const v = Number(process.env[envVar]);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : fallback;
}

/** Cosine ≥ this → auto-merge (clearly the same root cause). */
const MERGE_THRESHOLD = threshold('PIWI_CLUSTER_SIMILARITY_THRESHOLD', 0.92);
/** Cosine in [SUGGEST_THRESHOLD, MERGE_THRESHOLD) → ambiguous band (adjudicate / suggest). */
const SUGGEST_THRESHOLD = Math.min(MERGE_THRESHOLD, threshold('PIWI_CLUSTER_SUGGEST_THRESHOLD', 0.8));

const MAX_NEW_PER_RUN = 50; // cost guard: cap clusters from this run embedded per pass
const MAX_BACKFILL_PER_RUN = 50; // cost guard: cap older clusters (re-)embedded per pass
const MAX_ADJUDICATIONS_PER_RUN = 5; // cost guard: cap reasoning-model calls per run

interface ReconcileRoles {
  embeddingRole: ResolvedAiRole;
  /** Reasoning model used to adjudicate the ambiguous band; null disables adjudication. */
  reasoningRole?: ResolvedAiRole | null;
}

interface ReconcileStats {
  embedded: number;
  merged: number;
  suggested: number;
}

interface ClusterRow {
  id: number;
  signature: string;
  errorType: string | null;
  selector: string | null;
  sampleError: string | null;
  embedding: string | null;
  embeddingModel: string | null;
}

const CLUSTER_FIELDS = {
  id: failureClusters.id,
  signature: failureClusters.signature,
  errorType: failureClusters.errorType,
  selector: failureClusters.selector,
  sampleError: failureClusters.sampleError,
  embedding: failureClusters.embedding,
  embeddingModel: failureClusters.embeddingModel,
};

/**
 * Per-project pass serialization. Merges are multi-row operations, and the
 * `dead` bookkeeping below is per-pass, so two concurrent passes over the same
 * project could both pick the same victim. In-process chaining is enough for
 * the supported single-instance deployment; multi-instance deployments would
 * need a database-level lock instead.
 */
const reconcileQueues = new Map<number, Promise<unknown>>();

export async function reconcileNewClusters(
  db: DbClient,
  projectId: number,
  runId: number,
  roles: ReconcileRoles,
): Promise<ReconcileStats> {
  const prev = reconcileQueues.get(projectId) ?? Promise.resolve();
  const pass = prev.catch(() => {}).then(() => reconcilePass(db, projectId, runId, roles));
  reconcileQueues.set(projectId, pass);
  try {
    return await pass;
  } finally {
    if (reconcileQueues.get(projectId) === pass) reconcileQueues.delete(projectId);
  }
}

async function reconcilePass(
  db: DbClient,
  projectId: number,
  runId: number,
  roles: ReconcileRoles,
): Promise<ReconcileStats> {
  const { embeddingRole, reasoningRole } = roles;
  const tag = embeddingModelTag(embeddingRole.model);

  // Clusters first seen in this run (the ones that may be near-duplicates of
  // existing ones, or of each other).
  let fresh: ClusterRow[] = await db
    .select(CLUSTER_FIELDS)
    .from(failureClusters)
    .where(
      and(
        eq(failureClusters.projectId, projectId),
        eq(failureClusters.firstSeenRunId, runId),
        eq(failureClusters.status, 'open'),
      ),
    )
    .orderBy(asc(failureClusters.id))
    .limit(MAX_NEW_PER_RUN + 1);
  if (fresh.length > MAX_NEW_PER_RUN) {
    fresh = fresh.slice(0, MAX_NEW_PER_RUN);
    console.warn(
      `[cluster-reconcile] run ${runId}: more than ${MAX_NEW_PER_RUN} new clusters; the overflow is picked up by backfill on later runs`,
    );
  }

  // Older open clusters without a vector in the current model+recipe space:
  // never embedded (created before an embedding role existed, or past a
  // previous pass's cap) or embedded by a different model/recipe. Most
  // recently seen first — they're the likeliest future merge partners.
  let backfill: ClusterRow[] = await db
    .select(CLUSTER_FIELDS)
    .from(failureClusters)
    .where(
      and(
        eq(failureClusters.projectId, projectId),
        eq(failureClusters.status, 'open'),
        ne(failureClusters.firstSeenRunId, runId),
        or(
          isNull(failureClusters.embedding),
          isNull(failureClusters.embeddingModel),
          ne(failureClusters.embeddingModel, tag),
        ),
      ),
    )
    .orderBy(desc(failureClusters.lastSeenRunId), asc(failureClusters.id))
    .limit(MAX_BACKFILL_PER_RUN + 1);
  if (backfill.length > MAX_BACKFILL_PER_RUN) {
    backfill = backfill.slice(0, MAX_BACKFILL_PER_RUN);
    console.log(
      `[cluster-reconcile] project ${projectId}: embedding backfill capped at ${MAX_BACKFILL_PER_RUN} clusters this pass`,
    );
  }

  // The clusters "Fixed before" compares an open cluster against (`findFixedBefore`: resolved, or a fix that held)
  // whose vector is from another model or recipe, with what the open backfill leaves of its cap, in the order
  // "Fixed before" reads them. They are embedded only: never a source or a candidate of a merge or a suggestion.
  const fixedBudget = MAX_BACKFILL_PER_RUN - backfill.length;
  const fixedBefore: ClusterRow[] =
    fixedBudget > 0
      ? await db
          .select(CLUSTER_FIELDS)
          .from(failureClusters)
          .where(
            and(
              eq(failureClusters.projectId, projectId),
              ne(failureClusters.status, 'open'),
              or(
                eq(failureClusters.status, 'resolved'),
                and(isNotNull(failureClusters.fixLandedRunId), ne(failureClusters.fixVerification, 'regressed')),
              ),
              isNotNull(failureClusters.embedding),
              or(isNull(failureClusters.embeddingModel), ne(failureClusters.embeddingModel, tag)),
            ),
          )
          .orderBy(sql`${failureClusters.fixLandedAt} DESC NULLS LAST`, desc(failureClusters.updatedAt))
          .limit(fixedBudget)
      : [];

  if (fresh.length === 0 && backfill.length === 0 && fixedBefore.length === 0) {
    return { embedded: 0, merged: 0, suggested: 0 };
  }

  // Embed everything that lacks a vector in the current space. A fixed cluster keeps its `updatedAt`, which
  // "Fixed before" shows as when it was resolved.
  const fixedIds = new Set(fixedBefore.map((c) => c.id));
  const toEmbed = [...fresh.filter((c) => !c.embedding || c.embeddingModel !== tag), ...backfill, ...fixedBefore];
  let embedded = 0;
  if (toEmbed.length > 0) {
    const vectors = await embedTexts(
      embeddingRole,
      // The fingerprint is computed from the raw error at ingest; only the
      // embedder input is cleaned (ANSI/volatile-token/stack noise masked).
      toEmbed.map((c) => buildEmbedText(c)),
    );
    for (let i = 0; i < toEmbed.length; i++) {
      const vec = vectors[i];
      if (!vec || vec.length === 0) continue;
      const json = JSON.stringify(vec);
      const id = toEmbed[i]!.id;
      await db
        .update(failureClusters)
        .set({ embedding: json, embeddingModel: tag, ...(fixedIds.has(id) ? {} : { updatedAt: new Date() }) })
        .where(eq(failureClusters.id, id));
      toEmbed[i]!.embedding = json;
      toEmbed[i]!.embeddingModel = tag;
      embedded++;
    }
  }

  // Candidate pool: every open cluster in the project whose vector lives in
  // the current model+recipe space. Stale vectors are invisible until the
  // backfill re-embeds them — no score against them is meaningful.
  const pool = await db
    .select({ id: failureClusters.id, embedding: failureClusters.embedding })
    .from(failureClusters)
    .where(
      and(
        eq(failureClusters.projectId, projectId),
        eq(failureClusters.status, 'open'),
        isNotNull(failureClusters.embedding),
        eq(failureClusters.embeddingModel, tag),
      ),
    );

  const poolVecs = pool
    .map((p) => ({ id: p.id, vec: parseEmbedding(p.embedding) }))
    .filter((p): p is { id: number; vec: number[] } => p.vec !== null);

  const dead = new Set<number>(); // clusters already merged away this pass
  const seenPairs = new Set<string>(); // pairs already evaluated this pass (A→B and B→A are one pair)
  let merged = 0;
  let suggested = 0;
  let adjudications = 0;

  // Lazy fetch of a pool cluster's details for adjudication / suggestion display.
  const detailCache = new Map<number, ClusterRow>();
  const getDetails = async (id: number): Promise<ClusterRow | null> => {
    const source = [...fresh, ...backfill].find((c) => c.id === id);
    if (source) return source;
    if (detailCache.has(id)) return detailCache.get(id)!;
    const [row] = await db.select(CLUSTER_FIELDS).from(failureClusters).where(eq(failureClusters.id, id));
    if (!row) return null;
    detailCache.set(id, row);
    return row;
  };

  // Newly-backfilled clusters seek a neighbour too — that's what lets a
  // pre-existing backlog of near-duplicates collapse once embeddings turn on.
  const sources = [...fresh, ...backfill].filter((c) => c.embeddingModel === tag);

  for (const c of sources) {
    if (dead.has(c.id)) continue;
    const vec = parseEmbedding(c.embedding);
    if (!vec) continue;

    let best = { id: 0, score: 0 };
    for (const p of poolVecs) {
      if (p.id === c.id || dead.has(p.id)) continue;
      const score = cosineSimilarity(vec, p.vec);
      if (score > best.score) best = { id: p.id, score };
    }
    if (!best.id || best.score < SUGGEST_THRESHOLD) continue;

    // Keep the lower id (oldest / longest-lived triage history) as survivor.
    const [keep, drop] = best.id < c.id ? [best.id, c.id] : [c.id, best.id];
    const pairKey = `${keep}:${drop}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    const recorded = await getMergePairState(db, keep, drop);
    if (recorded && DECIDED_AGAINST_STATUSES.has(recorded.status)) continue;

    if (best.score >= MERGE_THRESHOLD) {
      await mergeFailureClusters(db, keep, drop);
      dead.add(drop);
      merged++;
      continue;
    }

    // Ambiguous band: adjudicate with the reasoning model (budget-capped), else
    // record a suggestion for human review.
    // A pair already in review keeps its suggestion; the adjudicator judges a pair once.
    if (recorded) continue;
    if (reasoningRole && adjudications < MAX_ADJUDICATIONS_PER_RUN) {
      adjudications++;
      const other = await getDetails(best.id);
      const context = other ? await buildAdjudicationContext(db, c.id, best.id).catch(() => null) : null;
      const verdict = other
        ? await adjudicateClusterPair(
            reasoningRole,
            toAdjudicationCluster(c, context?.a),
            toAdjudicationCluster(other, context?.b),
            context?.overlap,
          ).catch(() => null)
        : null;
      if (verdict?.merge && verdict.confidence === 'high') {
        await mergeFailureClusters(db, keep, drop);
        dead.add(drop);
        merged++;
        continue;
      }
      if (verdict?.merge) {
        await recordMergeSuggestion(db, {
          projectId,
          clusterAId: keep,
          clusterBId: drop,
          score: best.score,
          method: 'llm',
          llmConfidence: verdict.confidence,
          llmReason: verdict.reason,
        });
        suggested++;
        continue;
      }
      if (verdict) {
        await recordMergeSuggestion(db, {
          projectId,
          clusterAId: keep,
          clusterBId: drop,
          score: best.score,
          method: 'llm',
          llmConfidence: verdict.confidence,
          llmReason: verdict.reason,
          status: 'declined',
        });
      }
      // A failed adjudication records nothing, so a later pass can try again.
      continue;
    }

    await recordMergeSuggestion(db, {
      projectId,
      clusterAId: keep,
      clusterBId: drop,
      score: best.score,
      method: 'embedding',
    });
    suggested++;
  }

  return { embedded, merged, suggested };
}

/** Which tests a cluster affects — grounding for the adjudicator beyond error text. */
interface ClusterUsage {
  affectedTests: Array<{ file: string; title: string; occurrences: number }>;
  totalTests: number;
  totalRuns: number;
}

function toAdjudicationCluster(row: ClusterRow, usage?: ClusterUsage): ClusterForAdjudication {
  return {
    signature: row.signature,
    errorType: row.errorType,
    selector: row.selector,
    sampleError: row.sampleError,
    ...(usage ?? {}),
  };
}

async function clusterUsage(db: DbClient, clusterId: number): Promise<ClusterUsage> {
  const top = await db
    .select({ file: testCases.filePath, title: testCases.title, occurrences: count() })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testCases.id, testRunsCases.testCaseId))
    .where(eq(testRunsCases.failureClusterId, clusterId))
    .groupBy(testCases.id, testCases.filePath, testCases.title)
    .orderBy(desc(count()))
    .limit(5);
  const [totals] = await db
    .select({
      tests: countDistinct(testRunsCases.testCaseId),
      runs: countDistinct(testRunsCases.testRunId),
    })
    .from(testRunsCases)
    .where(eq(testRunsCases.failureClusterId, clusterId));
  return {
    affectedTests: top.map((t) => ({ file: t.file, title: t.title, occurrences: Number(t.occurrences) })),
    totalTests: Number(totals?.tests ?? 0),
    totalRuns: Number(totals?.runs ?? 0),
  };
}

async function clusterOverlap(db: DbClient, aId: number, bId: number): Promise<ClusterPairOverlap> {
  const bCases = db
    .select({ id: testRunsCases.testCaseId })
    .from(testRunsCases)
    .where(eq(testRunsCases.failureClusterId, bId));
  const [tests] = await db
    .select({ n: countDistinct(testRunsCases.testCaseId) })
    .from(testRunsCases)
    .where(and(eq(testRunsCases.failureClusterId, aId), inArray(testRunsCases.testCaseId, bCases)));

  const bRuns = db
    .select({ id: testRunsCases.testRunId })
    .from(testRunsCases)
    .where(eq(testRunsCases.failureClusterId, bId));
  const [runs] = await db
    .select({ n: countDistinct(testRunsCases.testRunId) })
    .from(testRunsCases)
    .where(and(eq(testRunsCases.failureClusterId, aId), inArray(testRunsCases.testRunId, bRuns)));

  return { sharedTests: Number(tests?.n ?? 0), sharedRuns: Number(runs?.n ?? 0) };
}

async function buildAdjudicationContext(
  db: DbClient,
  aId: number,
  bId: number,
): Promise<{ a: ClusterUsage; b: ClusterUsage; overlap: ClusterPairOverlap }> {
  const [a, b, overlap] = await Promise.all([
    clusterUsage(db, aId),
    clusterUsage(db, bId),
    clusterOverlap(db, aId, bId),
  ]);
  return { a, b, overlap };
}
