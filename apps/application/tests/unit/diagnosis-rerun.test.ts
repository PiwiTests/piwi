import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { AiConfig, ResolvedAiRole } from '../../types/api';
import type { DbClient } from '../../server/database';
import { migrateToLatest } from './temp-db';

/**
 * Re-diagnosing a cluster whose diagnosis was rated: the prompt carries the
 * previous assessment and its rating, and the new version starts unrated.
 */

delete process.env.PIWI_DATABASE_URL;

const prompts = vi.hoisted(() => ({ user: [] as string[] }));

vi.mock('../../server/utils/notifications/emit', () => ({ emitNotification: () => {} }));

vi.mock('../../server/utils/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/utils/ai-provider')>()),
  callAiProvider: async (_config: unknown, input: { user: string }) => {
    prompts.user.push(input.user);
    return {
      text: JSON.stringify({ summary: `Diagnosis ${prompts.user.length}`, category: 'app-bug', confidence: 'medium' }),
      model: 'main-model',
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    };
  },
}));

const { getAppSetting } = await import('../../server/utils/app-settings');
const { runClusterDiagnosis } = await import('../../server/utils/ai-diagnosis');

let db: ReturnType<typeof drizzle<typeof schema>>;

const role: ResolvedAiRole = {
  provider: 'openai',
  apiKey: 'k',
  model: 'main-model',
  baseUrl: 'http://localhost:1',
  temperature: null,
};
const config: AiConfig = {
  ...role,
  autoDiagnose: false,
  source: 'settings',
  roles: { diagnosis: role, research: null, embedding: null },
};

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'adds' });
  await db.insert(schema.failureClusters).values({
    id: 1,
    projectId: 1,
    fingerprint: 'fp-1',
    signature: 'Error: cart is empty',
    errorType: 'assertion',
    sampleError: 'Error: cart is empty',
    firstSeenRunId: 1,
    lastSeenRunId: 1,
    occurrences: 1,
  });
  await db.insert(schema.testRunsCases).values({
    testRunId: 1,
    testCaseId: 1,
    status: 'failed',
    error: 'Error: cart is empty',
    failureClusterId: 1,
  });
});

beforeEach(() => {
  vi.stubGlobal('getAppSetting', getAppSetting);
  prompts.user.length = 0;
});

async function cluster() {
  const [row] = await db.select().from(schema.failureClusters).where(eq(schema.failureClusters.id, 1));
  return row!;
}

describe('re-running a diagnosis rated unhelpful', () => {
  test('the prompt carries the prior assessment and the rating; the new version is unrated', async () => {
    const first = await runClusterDiagnosis(db as unknown as DbClient, await cluster(), config);
    expect(first.status).toBe('completed');
    await db
      .update(schema.failureDiagnoses)
      .set({ feedback: 'down', feedbackNote: 'the cart API is fine' })
      .where(eq(schema.failureDiagnoses.id, first.id));

    const second = await runClusterDiagnosis(db as unknown as DbClient, await cluster(), config);

    const prompt = prompts.user.at(-1)!;
    expect(prompt).toContain('Prior Assessment');
    expect(prompt).toContain('Previous summary: Diagnosis 1');
    expect(prompt).toContain('note: "the cart API is fine"');
    expect(prompt).toContain('Do not repeat this assessment without new evidence.');

    expect(second.status).toBe('completed');
    expect(second.summary).toBe('Diagnosis 2');
    expect(second.feedback).toBeNull();
    expect(second.feedbackNote).toBeNull();

    const versions = await db.select().from(schema.failureDiagnosisVersions);
    expect(versions.map((v) => [v.summary, v.feedback])).toEqual([['Diagnosis 1', 'down']]);
  });
});
