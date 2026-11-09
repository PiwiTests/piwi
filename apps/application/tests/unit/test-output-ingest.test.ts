import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { durationStats } from '#shared/utils/stats';
import { InstanceRole, ADMIN_ACCESS } from '#shared/permissions';
import { MAX_TEST_OUTPUT_CHARS } from '@piwitests/core/test-output';
import type { User } from '../../server/database/schema';
import { migrateToLatest } from './temp-db';

/**
 * What a test wrote to stdout and stderr reaches its execution through the batch body and the stream, is stored
 * through `case_payloads` (bounded and hidden again), comes back with the execution and from the MCP
 * `get_test_run_case` tool, and goes with the last execution that names it.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route modules (which import the barrel) load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db, getDialect: () => 'sqlite' }));
vi.mock('../../server/utils/auth', () => ({
  requireAuth: async () => ({ id: 0, role: 'administrator' }),
  isAuthEnabled: () => false,
}));
vi.mock('../../server/utils/run-finalize-side-effects', () => ({ runFinalizeSideEffects: vi.fn(async () => {}) }));
vi.mock('../../server/storage', () => ({
  getStorage: () => ({ async deleteFile() {}, async deleteDirectory() {} }),
}));

interface RouteEvent {
  params?: Record<string, string>;
  body: Record<string, unknown>;
}

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: RouteEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: RouteEvent, name: string) => event.params?.[name]);
vi.stubGlobal('getRequestHeader', () => undefined);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('durationStats', durationStats);

type Route = (event: RouteEvent) => Promise<Record<string, any>>;
const submit = (await import('../../server/api/test-runs/submit.post')).default as unknown as Route;
const start = (await import('../../server/api/test-runs/start.post')).default as unknown as Route;
const events = (await import('../../server/api/test-runs/[id]/events.post')).default as unknown as Route;
const { getTestRunCase } = await import('#shared/handlers/test-cases');
const { MCP_TOOLS } = await import('../../server/utils/mcp/tools');
const { deleteRunsByIds } = await import('../../server/utils/retention');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const PROJECT = 'test-output';

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  const [project] = await db.insert(schema.projects).values({ name: PROJECT }).returning();
  testCaseCache.invalidate(project!.id);
  testSuiteCache.invalidate(project!.id);
});

/** A test case as the reporter sends it, with what it wrote to each stream. */
function loggingCase(title: string, stdout: string | null, stderr: string | null = null) {
  return { title, location: `tests/${title}.spec.ts:3:1`, status: 'failed', duration: 10, stdout, stderr };
}

async function submitRun(testCases: unknown[]): Promise<number> {
  const { runId } = await submit({
    body: {
      projectName: PROJECT,
      status: 'failed',
      startTime: '2026-11-01T10:00:00.000Z',
      duration: 1000,
      totalTests: testCases.length,
      failedTests: testCases.length,
      testCases,
    },
  });
  return runId;
}

async function executionsOf(runId: number) {
  return db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.testRunId, runId));
}

async function payload(id: number | null): Promise<string | null> {
  if (id == null) return null;
  const [row] = await db.select().from(schema.casePayloads).where(eq(schema.casePayloads.id, id));
  return row?.content ?? null;
}

describe('what a test wrote to stdout and stderr', () => {
  test('is stored through case_payloads, once for executions that wrote the same', async () => {
    const runId = await submitRun([
      loggingCase('pays', 'order 4521 created\n', 'payment sandbox answered 502\n'),
      loggingCase('refunds', 'order 4521 created\n'),
      loggingCase('browses', null),
    ]);
    const [pays, refunds, browses] = await executionsOf(runId);
    expect(await payload(pays!.stdoutPayloadId)).toBe('order 4521 created\n');
    expect(await payload(pays!.stderrPayloadId)).toBe('payment sandbox answered 502\n');
    expect(refunds!.stdoutPayloadId).toBe(pays!.stdoutPayloadId);
    expect(refunds!.stderrPayloadId).toBeNull();
    expect(browses!.stdoutPayloadId).toBeNull();
  });

  test('is bounded and hidden again, with no NUL character', async () => {
    const long = Array.from({ length: 10_000 }, (_, i) => `step ${i} of the checkout\n`).join('');
    const runId = await submitRun([
      loggingCase('pays', `GET https://api.example.test/me?access_token=t0k3n-v4lue\u0000 200\n${long}`),
    ]);
    const [pays] = await executionsOf(runId);
    const stored = (await payload(pays!.stdoutPayloadId))!;
    expect(stored.length).toBeLessThanOrEqual(MAX_TEST_OUTPUT_CHARS);
    expect(stored.startsWith('GET https://api.example.test/me?access_token=<hidden> 200\n')).toBe(true);
    expect(stored).toMatch(/\[… \d+ lines \(\d+ characters\) of output cut …\]/);
    expect(stored.endsWith('step 9999 of the checkout\n')).toBe(true);
  });

  test('streams with its test’s result', async () => {
    const { runId, streamToken } = await start({
      body: { projectName: PROJECT, startTime: '2026-11-01T10:00:00.000Z', instanceId: 'local-1' },
    });
    await events({
      params: { id: String(runId) },
      body: { streamToken, testCases: [{ type: 'complete', ...loggingCase('pays', 'seeded the cart\n') }] },
    });
    const [pays] = await executionsOf(runId);
    expect(await payload(pays!.stdoutPayloadId)).toBe('seeded the cart\n');
  });

  test('comes back with the execution, and from get_test_run_case for an agent', async () => {
    const colored = '\u001b[33morder\u001b[39m 4521 created\n';
    const runId = await submitRun([loggingCase('pays', colored, 'payment sandbox answered 502\n')]);
    const [pays] = await executionsOf(runId);

    const execution = await getTestRunCase(db as never, pays!.id);
    expect(execution?.stdout).toBe(colored);
    expect(execution?.stderr).toBe('payment sandbox answered 502\n');

    const getCase = MCP_TOOLS.find((tool) => tool.name === 'get_test_run_case')!.handler;
    const ctx = {
      user: { id: 0, role: InstanceRole.ADMINISTRATOR } as User,
      access: ADMIN_ACCESS,
      scope: 'all' as const,
    };
    const whole = (await getCase(db as never, { executionId: pays!.id }, ctx)) as Record<string, unknown>;
    expect(whole.stdout).toBe('order 4521 created\n');
    expect(whole.stderr).toBe('payment sandbox answered 502\n');
    const steps = (await getCase(db as never, { executionId: pays!.id, include: ['steps'] }, ctx)) as Record<
      string,
      unknown
    >;
    expect('stdout' in steps).toBe(false);
  });

  test('goes with the last execution that names it', async () => {
    const kept = await submitRun([loggingCase('pays', 'shared line\n')]);
    const doomed = await submitRun([loggingCase('pays', 'shared line\n', 'only in the doomed run\n')]);
    const [keptRow] = await executionsOf(kept);
    const [doomedRow] = await executionsOf(doomed);

    await deleteRunsByIds(db as never, [doomed]);
    expect(await payload(doomedRow!.stderrPayloadId)).toBeNull();
    expect(await payload(keptRow!.stdoutPayloadId)).toBe('shared line\n');
  });
});
