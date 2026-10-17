/**
 * Gate evaluations: every `POST /api/test-runs/:id/gate` is stored with its
 * policy, verdict and violations, and the pull request it judged. A failed
 * verdict records the `gate` hand-back as `suggested` (do not merge); the PR
 * state sweep (`gate-overrides.ts`) records what happened next.
 *
 * With the project's `gateStatus` on and pull-request feedback posting commit
 * statuses, the verdict is also posted as the `<statusContext>/gate` commit
 * status. An inconclusive verdict (an environment incident) posts nothing and
 * records no outcome.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { gateEvaluations, projects } from '../database/schema';
import { recordOutcome } from './outcomes';
import { createScmProvider } from './scm';
import { normalizeGitUrl } from './scm/git-url';
import { getPrFeedbackSettings } from './scm/pr-feedback';
import { readPrFeedbackPost, recordPrFeedbackPost, runPrNumber } from './scm/pr-feedback-posts';
import { buildGateStatus } from '#shared/pr-feedback';
import type { GateOutcomeDetails } from '#shared/handback-outcomes';
import type { GateResult } from '@piwitests/core/gate';
import type { RunMetadata } from './run-json-types';
import type { DbClient } from '../database';

/** Who asked for the evaluation: `piwi gate`, or any other API client. */
export type GateSource = 'cli' | 'api';

/** The request header `piwi gate` sends, with the value `cli`. */
export const GATE_CLIENT_HEADER = 'x-piwi-client';

/** The source named by the `X-Piwi-Client` header. */
export function gateSource(header: string | null | undefined): GateSource {
  return header?.trim().toLowerCase() === 'cli' ? 'cli' : 'api';
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v == null || v === false || (Array.isArray(v) && v.length === 0)) continue;
      out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

/**
 * A stable hash of a policy: 16 hex characters of the SHA-256 of its JSON with
 * sorted keys. Rules left out, switched off or empty do not change it.
 */
export function gatePolicyHash(policy: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(policy)))
    .digest('hex')
    .slice(0, 16);
}

export interface GateEvaluationInput {
  projectId: number;
  runId: number;
  runMetadata: unknown;
  /** The policy as evaluated, `maxUncoveredChanges` and `minPatchCoverage` included when asked. */
  policy: Record<string, unknown>;
  result: Pick<GateResult, 'passed' | 'verdict' | 'violations'>;
  source: GateSource;
  /** The clusters of the run's new regressions, read later for an escape. */
  clusterIds: number[];
  evaluatedAt?: Date;
}

export interface StoredGateEvaluation {
  id: number;
  prNumber: number | null;
  commit: string | null;
}

/**
 * Store an evaluation. The pull request is the one the run's CI provider named,
 * else the one its feedback was posted on.
 */
export async function recordGateEvaluation(db: DbClient, input: GateEvaluationInput): Promise<StoredGateEvaluation> {
  const meta = (input.runMetadata as RunMetadata | null) ?? null;
  const commit = meta?.scm?.commit?.trim() || null;
  const prNumber =
    runPrNumber(input.runMetadata) ?? (await readPrFeedbackPost(db, input.runId).catch(() => null))?.prNumber ?? null;
  const evaluatedAt = input.evaluatedAt ?? new Date();
  const [row] = await db
    .insert(gateEvaluations)
    .values({
      projectId: input.projectId,
      runId: input.runId,
      commitSha: commit,
      prNumber,
      policy: input.policy,
      policyHash: gatePolicyHash(input.policy),
      passed: input.result.passed,
      verdict: input.result.verdict,
      violations: input.result.violations,
      clusterIds: [...new Set(input.clusterIds)].sort((a, b) => a - b),
      source: input.source,
      evaluatedAt,
    })
    .returning({ id: gateEvaluations.id });
  const id = row!.id;

  if (input.result.verdict === 'failed') {
    const details: GateOutcomeDetails = {
      prNumber,
      verdict: 'failed',
      rules: [...new Set(input.result.violations.map((v) => v.rule))],
    };
    await recordOutcome(db, {
      projectId: input.projectId,
      kind: 'gate',
      subjectType: 'gate-evaluation',
      subjectId: id,
      outcome: 'suggested',
      runId: input.runId,
      commit,
      details: { ...details },
      at: evaluatedAt,
    });
  }
  return { id, prNumber, commit };
}

/**
 * Post the verdict as the `<statusContext>/gate` commit status, when the
 * project opted in and pull-request feedback posts commit statuses. Returns
 * true when the host accepted it. Best-effort: every failure returns false.
 */
export async function postGateCommitStatus(
  db: DbClient,
  input: {
    projectId: number;
    runId: number;
    runMetadata: unknown;
    runUrl: string;
    result: Pick<GateResult, 'verdict' | 'violations'>;
  },
): Promise<boolean> {
  try {
    // An incident run gets no feedback, and a status links to the dashboard only through `PIWI_SITE_URL`.
    if (input.result.verdict === 'inconclusive' || !/^https?:\/\//.test(input.runUrl)) return false;
    const [project] = await db
      .select({ gateStatus: projects.gateStatus })
      .from(projects)
      .where(eq(projects.id, input.projectId));
    if (!project?.gateStatus) return false;
    const settings = await getPrFeedbackSettings(db);
    if (!settings.enabled || !settings.status) return false;

    const meta = (input.runMetadata as RunMetadata | null) ?? null;
    const commit = meta?.scm?.commit?.trim() || null;
    const repositoryUrl = normalizeGitUrl(meta?.scm?.remoteUrl ?? null);
    if (!commit || !repositoryUrl) return false;
    const provider = await createScmProvider(repositoryUrl, db, input.projectId);
    if (!provider) return false;

    const context = `${settings.statusContext}/gate`;
    const posted = await provider.postCommitStatus(
      commit,
      buildGateStatus({ verdict: input.result.verdict, violations: input.result.violations }, input.runUrl, context),
    );
    if (posted) {
      await recordPrFeedbackPost(db, {
        projectId: input.projectId,
        runId: input.runId,
        repositoryUrl,
        prNumber: runPrNumber(input.runMetadata),
        statuses: [context],
      });
    }
    return posted;
  } catch (e) {
    console.error(`[gate] could not post the gate status of run #${input.runId}`, e);
    return false;
  }
}
