import { describe, test, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

delete process.env.PIWI_DATABASE_URL;
const { getAiUsageSummary } = await import('#shared/handlers/ai-usage');

const NOW = new Date('2026-10-01T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: daysAgo(90) });
  const cluster = { projectId: 1, errorType: 'assertion', firstSeenRunId: 1, lastSeenRunId: 1 };
  await db.insert(schema.failureClusters).values([
    { ...cluster, id: 1, fingerprint: 'a', signature: 'a' },
    { ...cluster, id: 2, fingerprint: 'b', signature: 'b' },
    { ...cluster, id: 3, fingerprint: 'c', signature: 'c' },
  ]);
  const usage = { provider: 'openai', model: 'm', status: 'completed', inputTokens: 100, outputTokens: 10 };
  const applies = { patchValidation: { status: 'applies', filesChecked: 1, filesInPatch: 1, errors: [] } };
  await db.insert(schema.failureDiagnoses).values([
    // Made 60 days ago, rated yesterday: outside a 30-day window.
    { ...usage, id: 1, clusterId: 1, scope: 'cluster', feedback: 'up', createdAt: daysAgo(60), updatedAt: daysAgo(1) },
    // Re-run 5 days ago, rated helpful, its patch applies.
    {
      ...usage,
      id: 2,
      clusterId: 2,
      scope: 'cluster',
      feedback: 'up',
      details: applies,
      createdAt: daysAgo(5),
      updatedAt: daysAgo(5),
    },
    // Recorded by an agent, with the model it named and no tokens.
    {
      id: 3,
      clusterId: 3,
      scope: 'cluster',
      status: 'completed',
      provider: 'agent',
      model: 'agent-model',
      feedback: 'down',
      details: { suggestedFix: { patchValidation: { status: 'stale-file' } } },
      createdAt: daysAgo(2),
      updatedAt: daysAgo(2),
    },
  ]);
  // The version the re-run replaced (rated unhelpful, no patch), and a stale running snapshot.
  await db.insert(schema.failureDiagnosisVersions).values([
    {
      ...usage,
      diagnosisId: 2,
      clusterId: 2,
      scope: 'cluster',
      inputTokens: 40,
      feedback: 'down',
      details: { patchValidation: { status: 'unchecked' } },
      createdAt: daysAgo(5),
    },
    { ...usage, diagnosisId: 2, clusterId: 2, scope: 'cluster', status: 'running', createdAt: daysAgo(6) },
  ]);
  // A fix confirmed the re-run's diagnosis, then the failure came back; an older confirmation is out of the window.
  const outcome = { projectId: 1, kind: 'diagnosis', subjectType: 'cluster', subjectId: 2, suggestionKey: '2@1' };
  const details = { diagnosisId: 2, provider: 'openai', model: 'm' };
  await db.insert(schema.handbackOutcomes).values([
    { ...outcome, outcome: 'verified', channel: 'inferred', details, dedupeKey: 'v', createdAt: daysAgo(3) },
    { ...outcome, outcome: 'regressed', channel: 'inferred', details, dedupeKey: 'r', createdAt: daysAgo(1) },
    {
      ...outcome,
      subjectId: 1,
      outcome: 'verified',
      channel: 'inferred',
      details,
      dedupeKey: 'o',
      createdAt: daysAgo(50),
    },
  ]);
});

describe('getAiUsageSummary', () => {
  test('counts each version by creation time, not by when it was rated', async () => {
    const summary = await getAiUsageSummary(db, 30, NOW);
    expect(summary.totals).toEqual({ diagnoses: 3, assistantTurns: 0, inputTokens: 140, outputTokens: 20 });
    expect(summary.byModel).toHaveLength(2);
    expect(summary.byModel[0]).toMatchObject({ provider: 'openai', model: 'm', diagnoses: 2, failed: 0 });
  });

  test('a wider window reaches the older diagnosis', async () => {
    expect((await getAiUsageSummary(db, 90, NOW)).totals.diagnoses).toBe(4);
  });

  test('each model carries its ratings, its patches that apply, and what the fixes made of it', async () => {
    const summary = await getAiUsageSummary(db, 30, NOW);
    expect(summary.minRatings).toBe(10);
    const model = summary.byModel.find((r) => r.provider === 'openai')!;
    // A rating stays on the version it rated: the current one up, the replaced one down.
    expect(model).toMatchObject({ helpful: 1, rated: 2, patchesChecked: 1, patchesApplying: 1 });
    expect(model).toMatchObject({ verified: 1, regressed: 1 });
  });

  test('a diagnosis an agent recorded is its own row, its patch read from its suggested fix', async () => {
    const agent = (await getAiUsageSummary(db, 30, NOW)).byModel.find((r) => r.provider === 'agent')!;
    expect(agent).toMatchObject({
      model: 'agent-model',
      diagnoses: 1,
      inputTokens: 0,
      helpful: 0,
      rated: 1,
      patchesChecked: 1,
      patchesApplying: 0,
    });
  });

  test('a fix inside the window counts for a model whose diagnoses predate it', async () => {
    const summary = await getAiUsageSummary(db, 4, NOW);
    expect(summary.byModel.find((r) => r.provider === 'openai')).toMatchObject({
      diagnoses: 0,
      verified: 1,
      regressed: 1,
    });
  });
});
