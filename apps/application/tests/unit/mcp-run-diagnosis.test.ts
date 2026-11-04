/**
 * `run_execution_diagnosis` runs Piwi's AI diagnosis on one failing execution,
 * through the same handler as the failure page's Diagnose, and
 * `get_execution_diagnosis` reads the stored result back. Both run tools refuse
 * with the same answer on an instance with no AI provider.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import type { McpContext } from '../../server/utils/mcp/tools';
import type { User } from '../../server/database/schema';
import type { AiConfig, ResolvedAiRole } from '../../types/api';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

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

// `hold`, when set, keeps the next model call waiting until it resolves: a diagnosis in flight.
const ai = vi.hoisted(() => ({ configured: true, calls: 0, waiting: 0, hold: null as Promise<void> | null }));
const emitted = vi.hoisted(() => [] as Array<{ event: string; clusterId: number; executionId?: number }>);
vi.mock('../../server/utils/notifications/emit', () => ({
  emitNotification: (_db: unknown, event: string, payload: { clusterId: number; executionId?: number }) => {
    emitted.push({ event, clusterId: payload.clusterId, executionId: payload.executionId });
  },
}));
vi.mock('../../server/utils/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/utils/ai-provider')>()),
  resolveAiConfig: async () => (ai.configured ? config : null),
  callAiProvider: async () => {
    const hold = ai.hold;
    ai.hold = null;
    ai.waiting += 1;
    if (hold) await hold;
    ai.calls += 1;
    return {
      text: JSON.stringify({ summary: `Diagnosis ${ai.calls}`, category: 'test-bug', confidence: 'medium' }),
      model: 'main-model',
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    };
  },
}));

const { MCP_TOOLS } = await import('../../server/utils/mcp/tools');
const { getAppSetting } = await import('../../server/utils/app-settings');

const tool = (name: string) => {
  const found = MCP_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found.handler;
};

const asUser = (id: number, name: string) =>
  ({ id, role: InstanceRole.MEMBER, name, username: name.toLowerCase() }) as User;
const onProject1 = (projectRole: ProjectRole) =>
  buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: projectRole }]);
const maintainer: McpContext = {
  user: asUser(2, 'Robin'),
  access: onProject1(ProjectRole.MAINTAINER),
  scope: new Set([1]),
};
const viewer: McpContext = { user: asUser(3, 'Sam'), access: onProject1(ProjectRole.VIEWER), scope: new Set([1]) };

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  // A Nitro auto-import the diagnosis reads its instructions with.
  vi.stubGlobal('getAppSetting', getAppSetting);
  ({ db, close } = await openTempDb());
  ai.configured = true;
  ai.calls = 0;
  ai.waiting = 0;
  ai.hold = null;
  emitted.length = 0;
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'totals' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
  await db.insert(schema.failureClusters).values({
    id: 1,
    projectId: 1,
    fingerprint: 'fp-1',
    signature: 'expected 30, got -10',
    errorType: 'assertion',
    firstSeenRunId: 1,
    lastSeenRunId: 1,
    occurrences: 1,
  });
  await db.insert(schema.testRunsCases).values({
    id: 1,
    testRunId: 1,
    testCaseId: 1,
    status: 'failed',
    error: 'Error: expected 30, got -10',
    failureClusterId: 1,
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await close();
});

describe('run_execution_diagnosis', () => {
  test('diagnoses a failure, then returns its completed diagnosis until forced', async () => {
    const first = (await tool('run_execution_diagnosis')(db as never, { executionId: 1 }, maintainer)) as Record<
      string,
      unknown
    >;
    expect(first).toMatchObject({
      executionId: 1,
      status: 'completed',
      provider: 'openai',
      model: 'main-model',
      category: 'test-bug',
      summary: 'Diagnosis 1',
    });

    const again = await tool('run_execution_diagnosis')(db as never, { executionId: 1 }, maintainer);
    expect(again).toMatchObject({ diagnosisId: first.diagnosisId, summary: 'Diagnosis 1' });
    expect(ai.calls).toBe(1);

    const forced = await tool('run_execution_diagnosis')(db as never, { executionId: 1, force: true }, maintainer);
    expect(forced).toMatchObject({ diagnosisId: first.diagnosisId, summary: 'Diagnosis 2' });
    expect(await db.select().from(schema.failureDiagnosisVersions)).toHaveLength(1);

    const [row] = await db.select().from(schema.failureDiagnoses);
    expect(row).toMatchObject({ scope: 'execution', testRunsCaseId: 1, clusterId: null });
    // The notifications are about the execution's cluster, and open the failure.
    expect(emitted).toEqual([
      { event: 'diagnosis.completed', clusterId: 1, executionId: 1 },
      { event: 'diagnosis.completed', clusterId: 1, executionId: 1 },
    ]);
    expect(await tool('get_execution_diagnosis')(db as never, { executionId: 1 }, viewer)).toMatchObject({
      executionId: 1,
      summary: 'Diagnosis 2',
      model: 'main-model',
    });
  });

  test('diagnoses a failure in no cluster, which sends no notification', async () => {
    await db.insert(schema.testRunsCases).values({
      id: 2,
      testRunId: 1,
      testCaseId: 1,
      repeatEachIndex: 1,
      status: 'failed',
      error: 'Error: page crashed',
    });
    expect(await tool('run_execution_diagnosis')(db as never, { executionId: 2 }, maintainer)).toMatchObject({
      executionId: 2,
      status: 'completed',
    });
    expect(emitted).toEqual([]);
  });

  test('refuses an execution that did not fail, without calling the model', async () => {
    await db
      .insert(schema.testRunsCases)
      .values({ id: 3, testRunId: 1, testCaseId: 1, repeatEachIndex: 1, status: 'passed' });
    await expect(tool('run_execution_diagnosis')(db as never, { executionId: 3 }, maintainer)).rejects.toThrow(
      'Execution 3 did not fail: there is nothing to diagnose',
    );
    expect(ai.waiting).toBe(0);
  });

  test('returns the stored diagnosis without an AI provider', async () => {
    await db.insert(schema.failureDiagnoses).values({
      scope: 'execution',
      testRunsCaseId: 1,
      status: 'completed',
      provider: 'agent',
      model: 'claude-opus-5-5',
      summary: 'Recorded by an agent',
    });
    ai.configured = false;
    expect(await tool('run_execution_diagnosis')(db as never, { executionId: 1 }, maintainer)).toMatchObject({
      executionId: 1,
      provider: 'agent',
      summary: 'Recorded by an agent',
    });
  });

  test("runs while the cluster's own diagnosis is in flight, and refuses a second run of the same failure", async () => {
    let release!: () => void;
    ai.hold = new Promise<void>((resolve) => (release = resolve));
    const clusterRun = tool('run_cluster_diagnosis')(db as never, { clusterId: 1, force: true }, maintainer);
    await vi.waitFor(() => expect(ai.waiting).toBe(1));
    await expect(tool('run_execution_diagnosis')(db as never, { executionId: 1 }, maintainer)).resolves.toMatchObject({
      status: 'completed',
    });

    let releaseFailure!: () => void;
    ai.hold = new Promise<void>((resolve) => (releaseFailure = resolve));
    const failureRun = tool('run_execution_diagnosis')(db as never, { executionId: 1, force: true }, maintainer);
    await vi.waitFor(() => expect(ai.waiting).toBe(3));
    await expect(
      tool('run_execution_diagnosis')(db as never, { executionId: 1, force: true }, maintainer),
    ).rejects.toThrow('A diagnosis is already running for this failure');
    release();
    releaseFailure();
    await expect(clusterRun).resolves.toMatchObject({ clusterId: 1, status: 'completed' });
    await expect(failureRun).resolves.toMatchObject({ executionId: 1, status: 'completed' });
  });

  test('says to record a diagnosis when no AI provider is configured', async () => {
    ai.configured = false;
    await expect(tool('run_execution_diagnosis')(db as never, { executionId: 1 }, maintainer)).rejects.toThrow(
      'AI diagnosis is not configured on this instance; write the diagnosis and call record_diagnosis',
    );
  });

  test('refuses a read-only key, and returns null for an execution that does not exist', async () => {
    await expect(tool('run_execution_diagnosis')(db as never, { executionId: 1 }, viewer)).rejects.toThrow(
      'This action requires the ai:run permission on project 1',
    );
    expect(await tool('run_execution_diagnosis')(db as never, { executionId: 99 }, maintainer)).toBeNull();
    expect(ai.calls).toBe(0);
  });
});

describe('run_cluster_diagnosis', () => {
  test('returns the stored diagnosis without an AI provider', async () => {
    await db.insert(schema.failureDiagnoses).values({
      clusterId: 1,
      scope: 'cluster',
      status: 'completed',
      provider: 'agent',
      model: 'claude-opus-5-5',
      summary: 'Recorded by an agent',
    });
    ai.configured = false;
    expect(await tool('run_cluster_diagnosis')(db as never, { clusterId: 1 }, maintainer)).toMatchObject({
      clusterId: 1,
      provider: 'agent',
      summary: 'Recorded by an agent',
    });
  });

  test('refuses with an error, not a result, when no AI provider is configured', async () => {
    ai.configured = false;
    await expect(tool('run_cluster_diagnosis')(db as never, { clusterId: 1 }, maintainer)).rejects.toThrow(
      'AI diagnosis is not configured on this instance; write the diagnosis and call record_diagnosis',
    );
    expect(await db.select().from(schema.failureDiagnoses)).toHaveLength(0);
  });
});
