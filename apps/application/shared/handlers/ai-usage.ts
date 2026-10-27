/**
 * AI diagnosis usage and quality over a window, per provider and model. Shared
 * by the settings endpoint and the demo mirror.
 *
 * Every diagnosis version counts once: the current one by its creation time
 * (when it started), and each earlier version by the time it was snapshotted.
 * A rating moves neither, so rating an old diagnosis never brings it back into
 * the window, and a rating stays on the version it rated. Diagnoses an agent
 * recorded carry the provider `agent` and the model the agent named, so they
 * get their own rows.
 *
 * Quality per model: the ratings and the suggested patches of the completed
 * diagnoses in the window, and the `verified` and `regressed` outcomes of the
 * diagnosis kind recorded in the window, read from the outcome rows still
 * stored (their details name the provider and the model).
 *
 * Assistant answers count as their own kind, `assistantTurns`, from the usage
 * rows each answer records; their tokens join the model's totals.
 */
import { and, count, eq, gte, inArray, isNotNull, ne, sql, sum } from 'drizzle-orm';
import {
  assistantUsage,
  failureDiagnoses,
  failureDiagnosisVersions,
  handbackOutcomes,
} from '../../server/database/schema';
import { HANDBACK_MIN_SAMPLE } from '#shared/analytics/metrics';
import { storedPatchValidation } from '#shared/patch';
import type { AiUsageModelRow, AiUsageSummary } from '../../types/api';
import type { DrizzleDB } from './db';

type QualityCounts = Pick<
  AiUsageModelRow,
  'helpful' | 'rated' | 'patchesChecked' | 'patchesApplying' | 'verified' | 'regressed'
>;

const emptyQuality = (): QualityCounts => ({
  helpful: 0,
  rated: 0,
  patchesChecked: 0,
  patchesApplying: 0,
  verified: 0,
  regressed: 0,
});

const modelKey = (provider: string | null | undefined, model: string | null | undefined) =>
  `${provider ?? ''}\u0000${model ?? ''}`;

/** A patch whose hunks were checked against the source: it applies, or it does not. */
const CHECKED_PATCH = new Set(['applies', 'applies-with-offset', 'stale-file', 'invalid']);
const APPLYING_PATCH = new Set(['applies', 'applies-with-offset']);

type QualityRow = QualityCounts & { provider: string | null; model: string };

async function readQuality(db: DrizzleDB, since: Date): Promise<Map<string, QualityRow>> {
  const out = new Map<string, QualityRow>();
  const tally = (provider: string | null, model: string | null) => {
    const key = modelKey(provider, model);
    const row = out.get(key) ?? { provider, model: model ?? '', ...emptyQuality() };
    out.set(key, row);
    return row;
  };
  for (const table of [failureDiagnoses, failureDiagnosisVersions]) {
    const rows = await db
      .select({ provider: table.provider, model: table.model, feedback: table.feedback, details: table.details })
      .from(table)
      .where(and(isNotNull(table.model), eq(table.status, 'completed'), gte(table.createdAt, since)));
    for (const r of rows) {
      const row = tally(r.provider, r.model);
      if (r.feedback === 'up' || r.feedback === 'down') row.rated++;
      if (r.feedback === 'up') row.helpful++;
      const status = storedPatchValidation(r.details)?.status;
      if (status && CHECKED_PATCH.has(status)) row.patchesChecked++;
      if (status && APPLYING_PATCH.has(status)) row.patchesApplying++;
    }
  }
  const outcomes = await db
    .select({ outcome: handbackOutcomes.outcome, details: handbackOutcomes.details })
    .from(handbackOutcomes)
    .where(
      and(
        eq(handbackOutcomes.kind, 'diagnosis'),
        inArray(handbackOutcomes.outcome, ['verified', 'regressed']),
        gte(handbackOutcomes.createdAt, since),
      ),
    );
  for (const o of outcomes) {
    const d = o.details as { provider?: string | null; model?: string | null } | null;
    if (!d?.model) continue;
    const row = tally(d.provider ?? null, d.model);
    if (o.outcome === 'verified') row.verified++;
    else row.regressed++;
  }
  return out;
}

interface UsageRow {
  provider: string | null;
  model: string | null;
  diagnoses: unknown;
  failed: unknown;
  inputTokens: unknown;
  outputTokens: unknown;
  durationTotal: unknown;
  durationCount: unknown;
}

export async function getAiUsageSummary(db: DrizzleDB, days: number, now: Date = new Date()): Promise<AiUsageSummary> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // Plain SQL CASE so the expressions work on both SQLite and PostgreSQL.
  const current: UsageRow[] = await db
    .select({
      provider: failureDiagnoses.provider,
      model: failureDiagnoses.model,
      diagnoses: count(),
      failed: sql<number>`sum(case when ${failureDiagnoses.status} = 'failed' then 1 else 0 end)`,
      inputTokens: sum(failureDiagnoses.inputTokens),
      outputTokens: sum(failureDiagnoses.outputTokens),
      durationTotal: sum(failureDiagnoses.durationMs),
      durationCount: count(failureDiagnoses.durationMs),
    })
    .from(failureDiagnoses)
    .where(and(isNotNull(failureDiagnoses.model), gte(failureDiagnoses.createdAt, since)))
    .groupBy(failureDiagnoses.provider, failureDiagnoses.model);

  // A version snapshotted while still running never finished, so it spent nothing to report.
  const earlier: UsageRow[] = await db
    .select({
      provider: failureDiagnosisVersions.provider,
      model: failureDiagnosisVersions.model,
      diagnoses: count(),
      failed: sql<number>`sum(case when ${failureDiagnosisVersions.status} = 'failed' then 1 else 0 end)`,
      inputTokens: sum(failureDiagnosisVersions.inputTokens),
      outputTokens: sum(failureDiagnosisVersions.outputTokens),
      durationTotal: sum(failureDiagnosisVersions.durationMs),
      durationCount: count(failureDiagnosisVersions.durationMs),
    })
    .from(failureDiagnosisVersions)
    .where(
      and(
        isNotNull(failureDiagnosisVersions.model),
        ne(failureDiagnosisVersions.status, 'running'),
        gte(failureDiagnosisVersions.createdAt, since),
      ),
    )
    .groupBy(failureDiagnosisVersions.provider, failureDiagnosisVersions.model);

  const assistant = await db
    .select({
      provider: assistantUsage.provider,
      model: assistantUsage.model,
      turns: count(),
      inputTokens: sum(assistantUsage.inputTokens),
      outputTokens: sum(assistantUsage.outputTokens),
    })
    .from(assistantUsage)
    .where(and(isNotNull(assistantUsage.model), gte(assistantUsage.createdAt, since)))
    .groupBy(assistantUsage.provider, assistantUsage.model);

  const quality = await readQuality(db, since);

  // sum/count come back as string | number | null depending on the driver — normalize to numbers.
  const merged = new Map<string, AiUsageModelRow & { durationTotal: number; durationCount: number }>();
  for (const r of [...current, ...earlier]) {
    const key = modelKey(r.provider, r.model);
    const row = merged.get(key) ?? {
      provider: r.provider,
      model: r.model ?? '',
      diagnoses: 0,
      failed: 0,
      assistantTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      avgDurationMs: null,
      durationTotal: 0,
      durationCount: 0,
      ...emptyQuality(),
      ...quality.get(key),
    };
    row.diagnoses += Number(r.diagnoses ?? 0);
    row.failed += Number(r.failed ?? 0);
    row.inputTokens += Number(r.inputTokens ?? 0);
    row.outputTokens += Number(r.outputTokens ?? 0);
    row.durationTotal += Number(r.durationTotal ?? 0);
    row.durationCount += Number(r.durationCount ?? 0);
    merged.set(key, row);
  }

  for (const r of assistant) {
    const key = modelKey(r.provider, r.model);
    const row = merged.get(key) ?? {
      provider: r.provider,
      model: r.model ?? '',
      diagnoses: 0,
      failed: 0,
      assistantTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      avgDurationMs: null,
      durationTotal: 0,
      durationCount: 0,
      ...emptyQuality(),
      ...quality.get(key),
    };
    row.assistantTurns += Number(r.turns ?? 0);
    row.inputTokens += Number(r.inputTokens ?? 0);
    row.outputTokens += Number(r.outputTokens ?? 0);
    merged.set(key, row);
  }

  // A model whose diagnoses predate the window can still have a fix confirm one inside it.
  for (const [key, q] of quality) {
    if (!merged.has(key)) {
      merged.set(key, {
        ...q,
        diagnoses: 0,
        failed: 0,
        assistantTurns: 0,
        inputTokens: 0,
        outputTokens: 0,
        avgDurationMs: null,
        durationTotal: 0,
        durationCount: 0,
      });
    }
  }

  const byModel: AiUsageModelRow[] = [...merged.values()]
    .map(({ durationTotal, durationCount, ...row }) => ({
      ...row,
      avgDurationMs: durationCount > 0 ? Math.round(durationTotal / durationCount) : null,
    }))
    .sort((a, b) => b.inputTokens - a.inputTokens);

  return {
    days,
    minRatings: HANDBACK_MIN_SAMPLE,
    totals: {
      diagnoses: byModel.reduce((acc, r) => acc + r.diagnoses, 0),
      assistantTurns: byModel.reduce((acc, r) => acc + r.assistantTurns, 0),
      inputTokens: byModel.reduce((acc, r) => acc + r.inputTokens, 0),
      outputTokens: byModel.reduce((acc, r) => acc + r.outputTokens, 0),
    },
    byModel,
  };
}
