import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import type { McpContext } from '../../server/utils/mcp/tools';
import type { User } from '../../server/database/schema';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const emitted: string[] = [];
const emittedPayloads: Array<Record<string, unknown>> = [];
vi.mock('../../server/utils/notifications/emit', () => ({
  emitNotification: async (_db: unknown, event: string, payload: Record<string, unknown>) => {
    emitted.push(event);
    emittedPayloads.push(payload);
  },
}));

// The source control the patch is validated against and the commits fix verification reads.
const scm = vi.hoisted(() => ({
  files: new Map<string, string>(),
  commits: [] as Array<{ sha: string; message: string }>,
}));
vi.mock('../../server/utils/scm', () => ({
  createScmProvider: async () => ({
    fetchFileAtRef: async (path: string) =>
      scm.files.has(path) ? { path, content: scm.files.get(path)!, truncated: false } : null,
    fetchChanges: async () => ({ commits: scm.commits, files: [] }),
    getCommitAuthor: async () => null,
    getDefaultBranch: async () => 'main',
  }),
}));

const { MCP_TOOLS } = await import('../../server/utils/mcp/tools');
const { verifyClusterFixes } = await import('../../server/utils/fix-verification');
const { logMcpToolCall, pruneMcpToolCalls } = await import('../../server/utils/mcp/write-log');
const { getClusterActivity } = await import('#shared/handlers/cluster-activity');
const { listFixAttempts } = await import('#shared/handlers/fix-attempts');
const { setInstanceDecisions, setProjectDecisions } = await import('#shared/handlers/capabilities');

const tool = (name: string) => {
  const found = MCP_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found.handler;
};

const asUser = (id: number, name: string) =>
  ({ id, role: InstanceRole.MEMBER, name, username: name.toLowerCase() }) as User;
const onProject1 = (role: ProjectRole) => buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role }]);
// A Maintainer's key on project 1, and a Viewer of the same project.
const maintainer: McpContext = {
  user: asUser(2, 'Robin'),
  access: onProject1(ProjectRole.MAINTAINER),
  scope: new Set([1]),
  apiKeyId: 7,
};
const viewer: McpContext = { user: asUser(3, 'Sam'), access: onProject1(ProjectRole.VIEWER), scope: new Set([1]) };
const refused = (permission: string) => `This action requires the ${permission} permission on project 1`;

const REMOTE = 'https://github.com/acme/shop.git';
const SOURCE = 'export function total(a: number, b: number) {\n  return a - b;\n}\n';
const PATCH =
  '--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -1,3 +1,3 @@\n export function total(a: number, b: number) {\n-  return a - b;\n+  return a + b;\n }\n';

const DIAGNOSIS = {
  summary: 'The cart total subtracts instead of adding',
  confidenceScore: 80,
  severity: 'high',
  affectedArea: 'cart',
  hypotheses: [
    {
      category: 'app-bug',
      rootCause: 'total() subtracts its operands',
      likelihood: 80,
      evidence: ['expected 30, got -10'],
    },
  ],
  suggestedFix: { description: 'Add the operands', file: 'src/cart.ts', code: null, patch: PATCH },
  investigationSteps: [],
  preventionTips: ['Unit-test total()'],
};

let db: TempDb;
let close: () => Promise<void>;

async function insertRun(id: number, status: 'passed' | 'failed', commit: string, branch = 'main') {
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status,
    startTime: new Date(Date.UTC(2026, 0, 1) + id * 3_600_000),
    branch,
    metadata: { scm: { commit, remoteUrl: REMOTE, branch } },
  });
}

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  emitted.length = 0;
  emittedPayloads.length = 0;
  scm.files = new Map([['src/cart.ts', SOURCE]]);
  scm.commits = [];
  await db.insert(schema.users).values([
    { id: 2, username: 'robin', password: '', role: InstanceRole.MEMBER, name: 'Robin' },
    { id: 3, username: 'sam', password: '', role: InstanceRole.MEMBER, name: 'Sam' },
  ]);
  await db.insert(schema.apiKeys).values({ id: 7, userId: 2, name: 'agent', keyHash: 'h', keyPrefix: 'p' });
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'other' },
  ]);
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'totals' });
  await insertRun(1, 'failed', 'aaa1111');
  await db.insert(schema.failureClusters).values({
    id: 1,
    projectId: 1,
    fingerprint: 'fp-1',
    signature: 'expected 30, got -10',
    errorType: 'assertion',
    firstSeenRunId: 1,
    lastSeenRunId: 1,
  });
  await db.insert(schema.testRunsCases).values({ testRunId: 1, testCaseId: 1, status: 'failed', failureClusterId: 1 });
});

afterEach(async () => {
  await close();
});

describe('record_diagnosis', () => {
  test('stores the diagnosis as written by an agent, with its validated patch', async () => {
    const result = (await tool('record_diagnosis')(
      db as never,
      { clusterId: 1, model: 'claude-opus-5-5', diagnosis: DIAGNOSIS },
      maintainer,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ clusterId: 1, category: 'app-bug', confidence: 'high' });
    expect((result.patchValidation as { status: string }).status).toBe('applies');

    const [row] = await db.select().from(schema.failureDiagnoses).where(eq(schema.failureDiagnoses.clusterId, 1));
    expect(row).toMatchObject({ provider: 'agent', model: 'claude-opus-5-5', status: 'completed', feedback: null });
    expect((row!.details as { recordedBy: unknown }).recordedBy).toEqual({ channel: 'mcp', userId: 2, apiKeyId: 7 });
    expect(emitted).toEqual(['diagnosis.completed']);
  });

  test('snapshots the previous diagnosis, its rating with it, before replacing it', async () => {
    await db.insert(schema.failureDiagnoses).values({
      clusterId: 1,
      scope: 'cluster',
      status: 'completed',
      provider: 'anthropic',
      model: 'model-a',
      summary: 'A timing issue',
      feedback: 'down',
    });
    const result = (await tool('record_diagnosis')(
      db as never,
      { clusterId: 1, model: 'claude-opus-5-5', diagnosis: DIAGNOSIS },
      maintainer,
    )) as Record<string, unknown>;
    expect(result.replacedPrevious).toBe(true);
    const versions = await db.select().from(schema.failureDiagnosisVersions);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ provider: 'anthropic', summary: 'A timing issue', feedback: 'down' });
    const [row] = await db.select().from(schema.failureDiagnoses);
    expect(row).toMatchObject({ provider: 'agent', feedback: null });
  });

  test('marks a patch that does not match the source as stale', async () => {
    scm.files = new Map([['src/cart.ts', 'export const total = 0;\n']]);
    const result = (await tool('record_diagnosis')(
      db as never,
      { clusterId: 1, model: 'm', diagnosis: DIAGNOSIS },
      maintainer,
    )) as Record<string, unknown>;
    expect((result.patchValidation as { status: string }).status).toBe('stale-file');
  });

  test('refuses a read-only key', async () => {
    await expect(
      tool('record_diagnosis')(db as never, { clusterId: 1, model: 'm', diagnosis: DIAGNOSIS }, viewer),
    ).rejects.toThrow(refused('ai:run'));
  });

  test('names the field a diagnosis gets wrong', async () => {
    await expect(
      tool('record_diagnosis')(
        db as never,
        { clusterId: 1, model: 'm', diagnosis: { ...DIAGNOSIS, severity: 'catastrophic' } },
        maintainer,
      ),
    ).rejects.toThrow(/diagnosis\.severity/);
    await expect(
      tool('record_diagnosis')(db as never, { clusterId: 1, diagnosis: DIAGNOSIS }, maintainer),
    ).rejects.toThrow(/model/);
  });

  test('is refused where agent diagnoses are declined, and not by a declined ai capability', async () => {
    await setInstanceDecisions(db as never, { ai: 'declined' });
    await expect(
      tool('record_diagnosis')(db as never, { clusterId: 1, model: 'm', diagnosis: DIAGNOSIS }, maintainer),
    ).resolves.toMatchObject({ clusterId: 1 });
    await setProjectDecisions(db as never, 1, { 'agent-diagnoses': 'declined' });
    await expect(
      tool('record_diagnosis')(db as never, { clusterId: 1, model: 'm', diagnosis: DIAGNOSIS }, maintainer),
    ).rejects.toThrow('Agent diagnoses are declined for this project');
  });

  test('returns null for a cluster that does not exist', async () => {
    expect(
      await tool('record_diagnosis')(db as never, { clusterId: 99, model: 'm', diagnosis: DIAGNOSIS }, maintainer),
    ).toBeNull();
  });
});

describe('record_diagnosis on a failure', () => {
  test('stores the diagnosis on the execution, apart from its cluster, and get_execution_diagnosis reads it', async () => {
    const result = (await tool('record_diagnosis')(
      db as never,
      { executionId: 1, model: 'claude-opus-5-5', diagnosis: DIAGNOSIS },
      maintainer,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ executionId: 1, category: 'app-bug', confidence: 'high' });
    expect(result).not.toHaveProperty('clusterId');
    expect((result.patchValidation as { status: string }).status).toBe('applies');

    const rows = await db.select().from(schema.failureDiagnoses);
    expect(rows).toEqual([
      expect.objectContaining({ scope: 'execution', testRunsCaseId: 1, clusterId: null, provider: 'agent' }),
    ]);
    // The diagnosis panel reads the validation at the top of the details.
    expect((rows[0]!.details as { patchValidation: { status: string } }).patchValidation.status).toBe('applies');
    // The notification is about cluster 1, and opens the failure.
    expect(emitted).toEqual(['diagnosis.completed']);
    expect(emittedPayloads[0]).toMatchObject({ clusterId: 1, executionId: 1, projectId: 1 });

    expect(await tool('get_execution_diagnosis')(db as never, { executionId: 1 }, viewer)).toMatchObject({
      executionId: 1,
      diagnosisId: rows[0]!.id,
      provider: 'agent',
      model: 'claude-opus-5-5',
      summary: DIAGNOSIS.summary,
      severity: 'high',
    });
    expect(await tool('get_cluster_diagnosis')(db as never, { clusterId: 1 }, viewer)).toBeNull();
  });

  test('diagnoses a failure in no cluster, which sends no notification', async () => {
    await insertRun(2, 'failed', 'bbb2222');
    const [execution] = await db
      .insert(schema.testRunsCases)
      .values({ testRunId: 2, testCaseId: 1, status: 'failed' })
      .returning({ id: schema.testRunsCases.id });
    const result = await tool('record_diagnosis')(
      db as never,
      { executionId: execution!.id, model: 'm', diagnosis: DIAGNOSIS },
      maintainer,
    );
    expect(result).toMatchObject({ executionId: execution!.id });
    expect(emitted).toEqual([]);
  });

  test('snapshots the previous diagnosis of the execution before replacing it', async () => {
    await tool('record_diagnosis')(db as never, { executionId: 1, model: 'model-a', diagnosis: DIAGNOSIS }, maintainer);
    const second = (await tool('record_diagnosis')(
      db as never,
      { executionId: 1, model: 'model-b', diagnosis: DIAGNOSIS },
      maintainer,
    )) as Record<string, unknown>;
    expect(second.replacedPrevious).toBe(true);
    const versions = await db.select().from(schema.failureDiagnosisVersions);
    expect(versions).toEqual([expect.objectContaining({ scope: 'execution', testRunsCaseId: 1, model: 'model-a' })]);
  });

  test('refuses an execution that did not fail', async () => {
    await insertRun(2, 'passed', 'bbb2222');
    const [passed] = await db
      .insert(schema.testRunsCases)
      .values({ testRunId: 2, testCaseId: 1, status: 'passed' })
      .returning({ id: schema.testRunsCases.id });
    await expect(
      tool('record_diagnosis')(db as never, { executionId: passed!.id, model: 'm', diagnosis: DIAGNOSIS }, maintainer),
    ).rejects.toThrow('This test run case did not fail');
    expect(await db.select().from(schema.failureDiagnoses)).toHaveLength(0);
  });

  test('takes a clusterId or an executionId, one of them', async () => {
    for (const target of [{}, { clusterId: 1, executionId: 1 }]) {
      await expect(
        tool('record_diagnosis')(db as never, { ...target, model: 'm', diagnosis: DIAGNOSIS }, maintainer),
      ).rejects.toThrow('Pass clusterId or executionId (one of them)');
    }
  });

  test('refuses a read-only key, and returns null for an execution that does not exist', async () => {
    await expect(
      tool('record_diagnosis')(db as never, { executionId: 1, model: 'm', diagnosis: DIAGNOSIS }, viewer),
    ).rejects.toThrow(refused('ai:run'));
    expect(
      await tool('record_diagnosis')(db as never, { executionId: 99, model: 'm', diagnosis: DIAGNOSIS }, maintainer),
    ).toBeNull();
    expect(await tool('get_execution_diagnosis')(db as never, { executionId: 1 }, viewer)).toBeNull();
  });
});

describe('report_fix_attempt', () => {
  test('records the attempt as applied over MCP, once', async () => {
    const first = (await tool('report_fix_attempt')(
      db as never,
      { clusterId: 1, kind: 'patch', commit: 'bbb2222', patch: PATCH },
      maintainer,
    )) as Record<string, unknown>;
    expect(first).toMatchObject({ clusterId: 1, outcome: 'applied', recorded: true, commitTrailer: 'Piwi-Cluster: 1' });
    const again = (await tool('report_fix_attempt')(
      db as never,
      { clusterId: 1, kind: 'patch', commit: 'bbb2222', patch: PATCH },
      maintainer,
    )) as Record<string, unknown>;
    expect(again.recorded).toBe(false);

    const rows = await db.select().from(schema.handbackOutcomes);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'fix-attempt',
      subjectType: 'cluster',
      subjectId: 1,
      outcome: 'applied',
      channel: 'mcp',
      actorUserId: 2,
      actorApiKeyId: 7,
      commitSha: 'bbb2222',
    });
    expect((rows[0]!.details as { patchHash: string }).patchHash).toMatch(/^[0-9a-f]{8}$/);
  });

  test('refuses a read-only key', async () => {
    await expect(
      tool('report_fix_attempt')(db as never, { clusterId: 1, kind: 'patch', commit: 'bbb2222' }, viewer),
    ).rejects.toThrow(refused('run:control'));
  });

  test('refuses an attempt with neither a commit nor a branch, and a locator edit without the edit', async () => {
    await expect(tool('report_fix_attempt')(db as never, { clusterId: 1, kind: 'patch' }, maintainer)).rejects.toThrow(
      /commit/,
    );
    await expect(
      tool('report_fix_attempt')(db as never, { clusterId: 1, kind: 'locator-edit', branch: 'fix' }, maintainer),
    ).rejects.toThrow(/edit/);
    await expect(
      tool('report_fix_attempt')(db as never, { clusterId: 1, kind: 'rewrite', branch: 'fix' }, maintainer),
    ).rejects.toThrow(/kind/);
  });

  test("takes the diagnosis of one of the cluster's failures", async () => {
    const recorded = (await tool('record_diagnosis')(
      db as never,
      { executionId: 1, model: 'm', diagnosis: DIAGNOSIS },
      maintainer,
    )) as { diagnosisId: number };
    await expect(
      tool('report_fix_attempt')(
        db as never,
        { clusterId: 1, kind: 'patch', commit: 'bbb2222', diagnosisId: recorded.diagnosisId },
        maintainer,
      ),
    ).resolves.toMatchObject({ clusterId: 1, outcome: 'applied', recorded: true });
  });

  test('refuses the diagnosis of a failure in another cluster', async () => {
    await db.insert(schema.failureClusters).values({
      id: 2,
      projectId: 1,
      fingerprint: 'fp-2',
      signature: 'other',
      errorType: 'assertion',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
    });
    const [other] = await db
      .insert(schema.testRunsCases)
      .values({ testRunId: 1, testCaseId: 1, status: 'failed', failureClusterId: 2 })
      .returning({ id: schema.testRunsCases.id });
    const recorded = (await tool('record_diagnosis')(
      db as never,
      { executionId: other!.id, model: 'm', diagnosis: DIAGNOSIS },
      maintainer,
    )) as { diagnosisId: number };
    await expect(
      tool('report_fix_attempt')(
        db as never,
        { clusterId: 1, kind: 'fix-plan', branch: 'fix', diagnosisId: recorded.diagnosisId },
        maintainer,
      ),
    ).rejects.toThrow('diagnosisId is not a diagnosis of this cluster or of one of its failures');
  });

  test('refuses a diagnosis of another cluster', async () => {
    await expect(
      tool('report_fix_attempt')(
        db as never,
        { clusterId: 1, kind: 'fix-plan', branch: 'fix', diagnosisId: 42 },
        maintainer,
      ),
    ).rejects.toThrow('diagnosisId is not a diagnosis of this cluster');
  });
});

describe('set_run_incident', () => {
  test('marks and clears a run through the run page handler', async () => {
    const marked = (await tool('set_run_incident')(
      db as never,
      { runId: 1, incident: true, reason: 'staging was down' },
      maintainer,
    )) as Record<string, unknown>;
    expect(marked).toMatchObject({
      runId: 1,
      incident: { rule: 'person', reason: 'staging was down' },
      decision: 'marked',
    });
    const cleared = (await tool('set_run_incident')(db as never, { runId: 1, incident: false }, maintainer)) as Record<
      string,
      unknown
    >;
    expect(cleared).toMatchObject({ runId: 1, decision: 'cleared' });
    expect(cleared.incident).toBeUndefined();
  });

  test('takes the run page permission: a Viewer may not flag a run; a bad argument is refused', async () => {
    await expect(tool('set_run_incident')(db as never, { runId: 1, incident: true }, viewer)).rejects.toThrow(
      refused('run:submit or run:control'),
    );
    await expect(tool('set_run_incident')(db as never, { runId: 1, incident: 'yes' }, maintainer)).rejects.toThrow(
      '`incident` must be true or false',
    );
  });

  test('each call lands in the write log with the run, its project and the key', async () => {
    const args = { runId: 1, incident: true, reason: 'staging was down' };
    await tool('set_run_incident')(db as never, args, maintainer);
    expect(await logMcpToolCall(db as never, maintainer, 'set_run_incident', args, 'ok')).toBe(1);
    expect(await tool('set_run_incident')(db as never, { runId: 99, incident: false }, maintainer)).toBeNull();
    await logMcpToolCall(db as never, maintainer, 'set_run_incident', { runId: 99, incident: false }, 'not-found');

    const rows = await db.select().from(schema.mcpToolCalls).orderBy(schema.mcpToolCalls.id);
    expect(rows.map((r) => [r.tool, r.subjectType, r.subjectId, r.projectId, r.apiKeyId, r.userId, r.result])).toEqual([
      ['set_run_incident', 'run', 1, 1, 7, 2, 'ok'],
      ['set_run_incident', 'run', 99, null, 7, 2, 'not-found'],
    ]);
  });
});

describe('fix attempts in fix verification', () => {
  async function passAt(runId: number, commit: string, branch = 'main') {
    await insertRun(runId, 'passed', commit, branch);
    await db.insert(schema.testRunsCases).values({ testRunId: runId, testCaseId: 1, status: 'passed' });
    return verifyClusterFixes(db as never, runId);
  }

  test('an agent reads the fix plan, edits, reports the attempt, and CI passes on the new commit: verified, on the timeline', async () => {
    const plan = (await tool('get_fix_plan')(db as never, { clusterId: 1 }, maintainer)) as {
      verify: { commitTrailer: string };
    };
    expect(plan.verify.commitTrailer).toBe('Piwi-Cluster: 1');

    await tool('report_fix_attempt')(
      db as never,
      { clusterId: 1, kind: 'fix-plan', commit: 'ccc3333', note: 'Add the operands' },
      maintainer,
    );
    const fixes = await passAt(2, 'ccc3333');
    expect(fixes.map((f) => f.clusterId)).toEqual([1]);

    const [attempt] = await listFixAttempts(db as never, 1);
    expect(attempt).toMatchObject({ outcome: 'verified', runId: 2 });
    expect(attempt!.details.link).toBe('commit');

    const activity = await getClusterActivity(db as never, 1);
    expect(activity.map((a) => [a.type, a.status])).toEqual([
      ['fix-attempt', 'verified'],
      ['fix-attempt', 'applied'],
    ]);
    expect(activity[0]!.text).toBe('The fix attempt (the fix plan at ccc3333) was verified by run #2');
    expect(activity[1]).toMatchObject({
      text: 'An agent recorded a fix attempt: the fix plan at ccc3333',
      apiKey: 'agent',
    });
  });

  test('a Piwi-Cluster trailer ties an attempt reported on a branch to the commit that fixed the cluster', async () => {
    await tool('report_fix_attempt')(db as never, { clusterId: 1, kind: 'patch', branch: 'fix/cart' }, maintainer);
    scm.commits = [{ sha: 'ddd4444', message: 'Fix the cart total\n\nPiwi-Cluster: 1' }];
    await passAt(2, 'ddd4444');
    const [attempt] = await listFixAttempts(db as never, 1);
    expect(attempt).toMatchObject({ outcome: 'verified' });
    expect(attempt!.details.link).toBe('trailer');
  });

  test('an attempt nothing ties to the fix stays applied', async () => {
    await tool('report_fix_attempt')(db as never, { clusterId: 1, kind: 'patch', commit: 'eee5555' }, maintainer);
    scm.commits = [{ sha: 'fff6666', message: 'Unrelated\n\nPiwi-Cluster: 9' }];
    await passAt(2, 'fff6666');
    const [attempt] = await listFixAttempts(db as never, 1);
    expect(attempt!.outcome).toBe('applied');
  });

  test('a verified attempt regresses when the cluster fails again', async () => {
    await tool('report_fix_attempt')(db as never, { clusterId: 1, kind: 'patch', commit: 'ccc3333' }, maintainer);
    await passAt(2, 'ccc3333');
    await insertRun(3, 'failed', 'ggg7777');
    await db
      .insert(schema.testRunsCases)
      .values({ testRunId: 3, testCaseId: 1, status: 'failed', failureClusterId: 1 });
    await db.update(schema.failureClusters).set({ lastSeenRunId: 3 }).where(eq(schema.failureClusters.id, 1));
    await verifyClusterFixes(db as never, 3);
    const [attempt] = await listFixAttempts(db as never, 1);
    expect(attempt).toMatchObject({ outcome: 'regressed', runId: 3 });
  });
});

describe('the write log', () => {
  test('logs a write tool with its key, subject and project, and never a read tool', async () => {
    expect(
      await logMcpToolCall(db as never, maintainer, 'set_cluster_status', { clusterId: 1, status: 'resolved' }, 'ok'),
    ).toBe(1);
    expect(await logMcpToolCall(db as never, maintainer, 'get_cluster', { clusterId: 1 }, 'ok')).toBe(0);
    expect(await logMcpToolCall(db as never, maintainer, 'triage_cluster', { clusterIds: [1, 1, 5] }, 'ok')).toBe(2);
    await logMcpToolCall(db as never, maintainer, 'triage_gap', { projectId: 1, gapId: 4 }, 'error', 'gap not found');

    const rows = await db.select().from(schema.mcpToolCalls).orderBy(schema.mcpToolCalls.id);
    expect(rows.map((r) => [r.tool, r.subjectType, r.subjectId, r.projectId, r.apiKeyId, r.result])).toEqual([
      ['set_cluster_status', 'cluster', 1, 1, 7, 'ok'],
      ['triage_cluster', 'cluster', 1, 1, 7, 'ok'],
      ['triage_cluster', 'cluster', 5, null, 7, 'ok'],
      ['triage_gap', 'gap', 4, 1, 7, 'error'],
    ]);
    expect(rows[3]!.error).toBe('gap not found');

    const activity = await getClusterActivity(db as never, 1);
    expect(activity.map((a) => a.text)).toEqual(['An agent triaged the cluster', 'An agent changed the status']);
  });

  test('logs a call about a failure on the execution and its project', async () => {
    await logMcpToolCall(db as never, maintainer, 'record_diagnosis', { executionId: 1 }, 'ok');
    await logMcpToolCall(
      db as never,
      maintainer,
      'unlink_issue',
      { entityType: 'test_runs_case', entityId: 1, url: 'https://example.com/1' },
      'ok',
    );
    await logMcpToolCall(db as never, maintainer, 'set_test_quarantine', { testCaseId: 1, quarantined: true }, 'ok');
    const rows = await db.select().from(schema.mcpToolCalls).orderBy(schema.mcpToolCalls.id);
    expect(rows.map((r) => [r.tool, r.subjectType, r.subjectId, r.projectId])).toEqual([
      ['record_diagnosis', 'execution', 1, 1],
      ['unlink_issue', 'execution', 1, 1],
      ['set_test_quarantine', 'test-case', 1, 1],
    ]);
  });

  test('logs a move of tests on the cluster it left and on the cluster it created', async () => {
    await db.insert(schema.failureClusters).values({
      id: 2,
      projectId: 1,
      fingerprint: 'split:x',
      signature: 'expected 30, got -10',
      errorType: 'assertion',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
    });
    await logMcpToolCall(
      db as never,
      maintainer,
      'move_tests_to_new_cluster',
      { clusterId: 1, testCaseIds: [1] },
      'ok',
      null,
      { sourceClusterId: 1, clusterId: 2, movedTests: 1 },
    );
    const rows = await db.select().from(schema.mcpToolCalls).orderBy(schema.mcpToolCalls.id);
    expect(rows.map((r) => [r.subjectType, r.subjectId, r.projectId])).toEqual([
      ['cluster', 1, 1],
      ['cluster', 2, 1],
    ]);
    const activity = await getClusterActivity(db as never, 2);
    expect(activity.map((a) => a.text)).toEqual(['An agent moved tests to a new cluster']);
  });

  test('writes nothing when the instance declined it', async () => {
    await setInstanceDecisions(db as never, { 'agent-write-log': 'declined' });
    expect(await logMcpToolCall(db as never, maintainer, 'set_cluster_status', { clusterId: 1 }, 'ok')).toBe(0);
    expect(await db.select().from(schema.mcpToolCalls)).toHaveLength(0);
  });

  test('is pruned on the notification horizon', async () => {
    const day = 24 * 60 * 60 * 1000;
    await db.insert(schema.mcpToolCalls).values([
      { tool: 'set_cluster_status', result: 'ok', createdAt: new Date(Date.now() - 40 * day) },
      { tool: 'set_cluster_status', result: 'ok', createdAt: new Date(Date.now() - 2 * day) },
    ]);
    expect(await pruneMcpToolCalls(db as never, 30)).toBe(1);
    expect(await db.select().from(schema.mcpToolCalls)).toHaveLength(1);
  });
});
