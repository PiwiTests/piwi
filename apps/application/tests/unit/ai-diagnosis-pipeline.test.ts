import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { ref, watch } from 'vue';
import * as schema from '../../server/database/schema.sqlite';
import type { AiConfig, ResolvedAiRole } from '../../types/api';
import type { DbClient } from '../../server/database';
import type { DiagnosisStage } from '#shared/ai-diagnosis';

declare global {
  // Exposed when the test process runs with `--expose-gc` (the unit-test scripts set it).
  var gc: (() => void) | undefined;
}

delete process.env.PIWI_DATABASE_URL;

const clues = vi.hoisted(() => ({
  /** execution id → strength of its top clue; an execution not listed has no clue */
  strengthByExecution: new Map<number, string>(),
}));

const provider = vi.hoisted(() => ({
  /** Which provider calls ran, in order. */
  calls: [] as string[],
  researchFails: false,
}));

vi.mock('#shared/handlers/test-cases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#shared/handlers/test-cases')>()),
  getFailureClues: async (_db: unknown, executionId: number) => {
    const strength = clues.strengthByExecution.get(executionId);
    return { clues: strength ? [{ strength }] : [] };
  },
}));

vi.mock('../../server/utils/ai-context', () => ({
  buildDiagnosisContext: async () => ({
    scope: 'cluster',
    text: 'context',
    sections: [],
    coverage: {},
    scmChanges: null,
    images: [],
    sourceFiles: [],
    tokenEstimate: 1,
    textTokenEstimate: 1,
    imageTokenEstimate: 0,
  }),
}));

vi.mock('../../server/utils/notifications/emit', () => ({ emitNotification: () => {} }));

vi.mock('../../server/utils/ai-provider', async (importOriginal) => {
  const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: null, cacheReadInputTokens: null };
  return {
    ...(await importOriginal<typeof import('../../server/utils/ai-provider')>()),
    callAiProvider: async () => {
      provider.calls.push('research');
      if (provider.researchFails) throw new Error('research model unavailable');
      return { text: '{"hypotheses":[],"dataGaps":[],"notes":""}', model: 'research-model', ...usage };
    },
    streamAiProvider: async function* () {
      provider.calls.push('diagnosis');
      yield { type: 'text', data: '{"summary":"Checkout button is disabled",' };
      yield { type: 'text', data: '"category":"app-bug"}' };
      yield { type: 'done', data: { model: 'main-model', ...usage } };
    },
  };
});

const { getAppSetting } = await import('../../server/utils/app-settings');
const { selectAutoDiagnoseClusters, streamClusterDiagnosis, loadDiagnosisSystemPrompt } =
  await import('../../server/utils/ai-diagnosis');
const { contextStalenessHash, diagnosisPromptHash } = await import('#shared/diagnosis-staleness');
const { DIAGNOSIS_JSON_SCHEMA } = await import('#shared/ai-diagnosis');
const { diagnosisFrame } = await import('../../server/utils/diagnosis-stream-frames');
const { useStreamingDiagnosis } = await import('../../app/composables/useStreamingDiagnosis');

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let tmpDir: string;
let client: ReturnType<typeof createClient>;
let runIds: number[];

async function seedRun(): Promise<number> {
  const [row] = await db
    .insert(schema.testRuns)
    .values({ projectId: 1, status: 'failed', startTime: new Date() })
    .returning({ id: schema.testRuns.id });
  return row!.id;
}

/** A cluster first seen in the n-th run (1-based), so a higher n is a newer cluster. */
async function seedCluster(n: number): Promise<schema.FailureCluster> {
  const [row] = await db
    .insert(schema.failureClusters)
    .values({
      projectId: 1,
      fingerprint: `fp-${n}`,
      signature: `sig-${n}`,
      errorType: 'assertion',
      sampleError: `sig-${n}\nExpected: 1\nReceived: 2`,
      firstSeenRunId: runIds[n - 1]!,
      lastSeenRunId: runIds[n - 1]!,
      occurrences: 1,
    })
    .returning();
  return row!;
}

async function seedDiagnosis(
  clusterId: number,
  status: string,
  updatedAt = new Date(),
  extra: { feedback?: string; contextSha?: string | null } = {},
): Promise<void> {
  await db.insert(schema.failureDiagnoses).values({ clusterId, scope: 'cluster', status, updatedAt, ...extra });
}

async function seedFailingExecution(clusterId: number, runId: number): Promise<number> {
  const [testCase] = await db
    .insert(schema.testCases)
    .values({ projectId: 1, filePath: 'a.spec.ts', title: `case ${clusterId}` })
    .returning({ id: schema.testCases.id });
  const [execution] = await db
    .insert(schema.testRunsCases)
    .values({ testRunId: runId, testCaseId: testCase!.id, status: 'failed', failureClusterId: clusterId })
    .returning({ id: schema.testRunsCases.id });
  return execution!.id;
}

const diagnosisRole: ResolvedAiRole = {
  provider: 'openai',
  apiKey: 'k',
  model: 'main-model',
  baseUrl: 'http://localhost:1',
  temperature: null,
};
const researchRole: ResolvedAiRole = { ...diagnosisRole, model: 'research-model' };

function aiConfig(research: ResolvedAiRole | null): AiConfig {
  return {
    ...diagnosisRole,
    autoDiagnose: false,
    source: 'settings',
    roles: { diagnosis: diagnosisRole, research, embedding: null },
  };
}

beforeEach(async () => {
  // Nitro auto-imports getAppSetting into the server utils under test.
  vi.stubGlobal('getAppSetting', getAppSetting);
  clues.strengthByExecution.clear();
  provider.calls.length = 0;
  provider.researchFails = false;
  delete process.env.PIWI_AI_AUTO_DIAGNOSE_MAX;
  vi.spyOn(console, 'debug').mockImplementation(() => {});

  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-ai-pipeline-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  dbc = db as unknown as DbClient;
  await db.insert(schema.projects).values({ id: 1, name: 'p1' });
  runIds = [];
  for (let i = 0; i < 5; i++) runIds.push(await seedRun());
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await client.close();
  globalThis.gc?.();
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' || attempt >= 40) throw error;
      if (!globalThis.gc) {
        const junk: Buffer[] = [];
        for (let i = 0; i < 60; i++) junk.push(Buffer.alloc(1 << 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
});

describe('selectAutoDiagnoseClusters', () => {
  const ids = (clusters: schema.FailureCluster[]) => clusters.map((c) => c.id);

  test('clusters that already have a diagnosis never take a budget slot', async () => {
    process.env.PIWI_AI_AUTO_DIAGNOSE_MAX = '2';
    const staleAt = new Date(Date.now() - 10 * 60 * 1000);
    const undiagnosed = await seedCluster(1);
    const staleRunning = await seedCluster(2);
    const failed = await seedCluster(3);
    const running = await seedCluster(4);
    const completed = await seedCluster(5);
    await seedDiagnosis(staleRunning.id, 'running', staleAt);
    await seedDiagnosis(failed.id, 'failed');
    await seedDiagnosis(running.id, 'running');
    await seedDiagnosis(completed.id, 'completed');

    const chosen = await selectAutoDiagnoseClusters(
      dbc,
      [completed, running, failed, staleRunning, undiagnosed],
      runIds[4]!,
    );

    // The two newest clusters are settled or in progress; the budget goes to the next two.
    expect(ids(chosen)).toEqual([failed.id, staleRunning.id]);
  });

  test('nothing is selected when every cluster already has a diagnosis', async () => {
    const a = await seedCluster(1);
    const b = await seedCluster(2);
    await seedDiagnosis(a.id, 'completed');
    await seedDiagnosis(b.id, 'running');

    expect(await selectAutoDiagnoseClusters(dbc, [b, a], runIds[1]!)).toEqual([]);
  });

  test('the budget defaults to three', async () => {
    const clusters = [];
    for (let n = 1; n <= 5; n++) clusters.push(await seedCluster(n));

    const chosen = await selectAutoDiagnoseClusters(dbc, clusters, runIds[4]!);

    expect(ids(chosen)).toEqual([clusters[4]!.id, clusters[3]!.id, clusters[2]!.id]);
  });

  test('an invalid budget falls back to the default', async () => {
    process.env.PIWI_AI_AUTO_DIAGNOSE_MAX = 'lots';
    const clusters = [];
    for (let n = 1; n <= 4; n++) clusters.push(await seedCluster(n));

    expect(await selectAutoDiagnoseClusters(dbc, clusters, runIds[3]!)).toHaveLength(3);
  });

  test('the weakest top clue is diagnosed first, then the newest cluster', async () => {
    const strong = await seedCluster(1);
    const weak = await seedCluster(2);
    const none = await seedCluster(3);
    const newerNone = await seedCluster(4);
    clues.strengthByExecution.set(await seedFailingExecution(strong.id, runIds[0]!), 'strong');
    clues.strengthByExecution.set(await seedFailingExecution(weak.id, runIds[1]!), 'weak');
    await seedFailingExecution(none.id, runIds[2]!);
    await seedFailingExecution(newerNone.id, runIds[3]!);
    process.env.PIWI_AI_AUTO_DIAGNOSE_MAX = '4';

    const chosen = await selectAutoDiagnoseClusters(dbc, [strong, weak, none, newerNone], runIds[3]!);

    expect(ids(chosen)).toEqual([newerNone.id, none.id, weak.id, strong.id]);
  });
});

describe('selectAutoDiagnoseClusters and ratings', () => {
  const ids = (clusters: schema.FailureCluster[]) => clusters.map((c) => c.id);

  test('ignored clusters never take a budget slot', async () => {
    process.env.PIWI_AI_AUTO_DIAGNOSE_MAX = '1';
    const older = await seedCluster(1);
    const ignored = await seedCluster(2);
    await db.update(schema.failureClusters).set({ status: 'ignored' }).where(eq(schema.failureClusters.id, ignored.id));
    const ignoredRow = { ...ignored, status: 'ignored' };

    expect(ids(await selectAutoDiagnoseClusters(dbc, [ignoredRow, older], runIds[1]!))).toEqual([older.id]);
  });

  test('a diagnosis rated unhelpful is written again once the evidence changed since it', async () => {
    // The mocked context has no sections, so its hash is the hash of nothing.
    const current = await contextStalenessHash([]);
    const changed = await seedCluster(1);
    const unchanged = await seedCluster(2);
    const helpful = await seedCluster(3);
    const unhashed = await seedCluster(4);
    await seedDiagnosis(changed.id, 'completed', new Date(), { feedback: 'down', contextSha: 'evidence-before' });
    await seedDiagnosis(unchanged.id, 'completed', new Date(), { feedback: 'down', contextSha: current });
    await seedDiagnosis(helpful.id, 'completed', new Date(), { feedback: 'up', contextSha: 'evidence-before' });
    await seedDiagnosis(unhashed.id, 'completed', new Date(), { feedback: 'down', contextSha: null });

    const chosen = await selectAutoDiagnoseClusters(dbc, [unhashed, helpful, unchanged, changed], runIds[4]!);

    expect(ids(chosen)).toEqual([changed.id]);
  });
});

describe('the prompt hash', () => {
  test('a completed diagnosis stores the hash of the instructions it was written under', async () => {
    const cluster = await seedCluster(1);
    await streamClusterDiagnosis(dbc, cluster, aiConfig(null));

    const [row] = await db
      .select()
      .from(schema.failureDiagnoses)
      .where(eq(schema.failureDiagnoses.clusterId, cluster.id));
    const expected = await diagnosisPromptHash(await loadDiagnosisSystemPrompt(dbc, cluster), DIAGNOSIS_JSON_SCHEMA);
    expect(row!.status).toBe('completed');
    expect((row!.details as { promptSha?: string }).promptSha).toBe(expected);
  });

  test('the hash moves with the instructions and the schema', async () => {
    const a = await diagnosisPromptHash('Explain the failure.', { type: 'object' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await diagnosisPromptHash('Explain the failure.', { type: 'object' })).toBe(a);
    expect(await diagnosisPromptHash('Explain the failure in French.', { type: 'object' })).not.toBe(a);
    expect(await diagnosisPromptHash('Explain the failure.', { type: 'array' })).not.toBe(a);
  });
});

describe('streamClusterDiagnosis stages', () => {
  /** Runs a streaming diagnosis and returns the stage and chunk events in the order they arrived. */
  async function streamEvents(config: AiConfig): Promise<string[]> {
    const cluster = await seedCluster(1);
    const events: string[] = [];
    await streamClusterDiagnosis(dbc, cluster, config, {
      onStage: (stage) => events.push(`stage:${stage}`),
      onChunk: (chunk) => events.push(chunk.type),
    });
    return events;
  }

  test('a single-model setup announces only the diagnosis stage, before any thinking', async () => {
    expect(await streamEvents(aiConfig(null))).toEqual(['stage:diagnosis', 'text', 'text', 'done']);
    expect(provider.calls).toEqual(['diagnosis']);
  });

  test('a distinct research model announces research first, then diagnosis', async () => {
    expect(await streamEvents(aiConfig(researchRole))).toEqual([
      'stage:research',
      'stage:diagnosis',
      'text',
      'text',
      'done',
    ]);
    expect(provider.calls).toEqual(['research', 'diagnosis']);
  });

  test('a research role identical to the main model runs no research stage', async () => {
    const same: ResolvedAiRole = { ...diagnosisRole };
    expect(await streamEvents(aiConfig(same))).toEqual(['stage:diagnosis', 'text', 'text', 'done']);
    expect(provider.calls).toEqual(['diagnosis']);
  });

  test('a failed research stage still moves on to the diagnosis stage', async () => {
    provider.researchFails = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await streamEvents(aiConfig(researchRole))).toEqual([
      'stage:research',
      'stage:diagnosis',
      'text',
      'text',
      'done',
    ]);
  });
});

describe('the stage frame', () => {
  test('is an SSE event named stage carrying the stage name', () => {
    expect(diagnosisFrame.stage('research')).toBe('event: stage\ndata: {"stage":"research"}\n\n');
    expect(diagnosisFrame.stage('diagnosis')).toBe('event: stage\ndata: {"stage":"diagnosis"}\n\n');
  });

  test('the streaming composable follows the stages of a stream', async () => {
    const frames = [
      diagnosisFrame.stage('research'),
      diagnosisFrame.stage('diagnosis'),
      diagnosisFrame.thinking('Looking at the button'),
      diagnosisFrame.result({ id: 1, status: 'completed' }),
    ];
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    vi.stubGlobal('ref', ref);
    vi.stubGlobal('unref', (value: unknown) =>
      value && typeof value === 'object' && 'value' in value ? value.value : value,
    );
    vi.stubGlobal('onScopeDispose', () => {});
    vi.stubGlobal('$fetch', { raw: async () => ({ ok: true, status: 200, _data: body }) });

    const streaming = useStreamingDiagnosis(7);
    const seen: Array<DiagnosisStage | null> = [];
    watch(streaming.stage, (stage) => seen.push(stage), { flush: 'sync' });
    await streaming.startStream();

    expect(seen).toEqual(['research', 'diagnosis']);
    expect(streaming.thinkingText.value).toBe('Looking at the button');
    expect(streaming.status.value).toBe('complete');
  });

  /** Stub what the streaming composable reads from Nuxt, with `$fetch` answering `raw` and plain calls. */
  function stubStreamingGlobals(
    raw: () => Promise<unknown>,
    get: (url: string) => Promise<unknown> = async () => ({}),
  ) {
    vi.stubGlobal('ref', ref);
    vi.stubGlobal('unref', (value: unknown) =>
      value && typeof value === 'object' && 'value' in value ? value.value : value,
    );
    vi.stubGlobal('onScopeDispose', () => {});
    vi.stubGlobal('$fetch', Object.assign(get, { raw }));
  }

  const jsonStream = (value: unknown) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
        controller.close();
      },
    });

  test('a refusal is an error carrying its message, not a silent success', async () => {
    stubStreamingGlobals(async () => ({
      ok: false,
      status: 503,
      _data: jsonStream({ statusCode: 503, message: 'AI diagnosis is not configured' }),
    }));
    const streaming = useStreamingDiagnosis(7);
    await streaming.startStream();
    expect(streaming.status.value).toBe('error');
    expect(streaming.error.value).toBe('AI diagnosis is not configured');
  });

  test('a diagnosis already running is followed until it completes', async () => {
    vi.useFakeTimers();
    try {
      const answers = [{ diagnosis: { id: 3, status: 'running' } }, { diagnosis: { id: 3, status: 'completed' } }];
      const polled: string[] = [];
      stubStreamingGlobals(
        async () => ({ ok: false, status: 409, _data: jsonStream({ message: 'Diagnosis is already running' }) }),
        async (url) => {
          polled.push(url);
          return answers.shift();
        },
      );
      const streaming = useStreamingDiagnosis(7);
      const done = streaming.startStream();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(streaming.status.value).toBe('streaming');
      await vi.advanceTimersByTimeAsync(3_000);
      await done;
      expect(polled).toEqual(['/api/failure-clusters/7/diagnosis', '/api/failure-clusters/7/diagnosis']);
      expect(streaming.status.value).toBe('complete');
      expect(streaming.result.value).toMatchObject({ id: 3, status: 'completed' });
    } finally {
      vi.useRealTimers();
    }
  });
});
