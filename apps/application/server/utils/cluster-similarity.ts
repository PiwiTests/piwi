/**
 * Vector helpers for embedding-based failure clustering. Vectors are stored as
 * JSON-encoded number[] on `failure_clusters.embedding` (same representation on
 * SQLite and Postgres), so nearest-neighbour search is a brute-force cosine over
 * a project's open clusters — fine given per-project cluster counts are small.
 */

import { condenseErrorText, maskVolatile, stripAnsi } from '#shared/error-fingerprint';

/**
 * Bump when `buildEmbedText` changes what it feeds the embedder, a change to
 * `maskVolatile` or `condenseErrorText` included. The version is part of the
 * stored model tag, so vectors built from an older recipe are treated as stale
 * and re-embedded instead of being compared against fresh ones.
 */
export const EMBEDDING_INPUT_VERSION = 3;

/**
 * Value stored in `failure_clusters.embedding_model`: the model id plus the
 * input-recipe version. Cosine scores are only meaningful between vectors from
 * the same model AND the same input recipe, so both are part of the identity.
 */
export function embeddingModelTag(model: string): string {
  return `${model}#v${EMBEDDING_INPUT_VERSION}`;
}

/** Chars of cleaned cluster text fed to the embedder. */
const EMBED_TEXT_CAP = 2000;

/**
 * Build the text embedded for one cluster. The sample error is stripped of ANSI
 * color codes, its internal stack frames are collapsed, and volatile tokens
 * (received/expected values, URLs, ids, numbers) are masked — the vector should
 * measure the failure's shape, not its per-occurrence noise. The error type,
 * signature and locator lead the text so they carry weight even when the sample
 * is long.
 */
export function buildEmbedText(cluster: {
  signature: string;
  errorType: string | null;
  selector: string | null;
  sampleError: string | null;
}): string {
  const condensed = condenseErrorText(stripAnsi(cluster.sampleError ?? ''));
  const parts = [cluster.errorType, cluster.signature, cluster.selector, condensed].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  return maskVolatile(parts.join('\n')).slice(0, EMBED_TEXT_CAP).trim();
}

/** Cosine similarity in [-1, 1]; 0 for mismatched/empty/zero vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Parse a stored embedding column (JSON number[]) back into a vector, or null. */
export function parseEmbedding(json: string | null | undefined): number[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) && v.every((n) => typeof n === 'number') ? (v as number[]) : null;
  } catch {
    return null;
  }
}
