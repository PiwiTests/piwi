import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { durationStats } from '#shared/utils/stats';
import { HIDDEN_VALUE } from '@piwitests/core/mask';
import { migrateToLatest } from './temp-db';

/**
 * A credential's shape in a test's error (a key Piwi issues, a JWT, `Bearer …`) is hidden as the error is stored: in
 * the execution's error, its steps' and its hooks' errors, its cluster's samples and the live run page, through the
 * batch body and the stream alike.
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
const { runEventBus } = await import('../../server/utils/run-events');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const PROJECT = 'error-credentials';
/** Values in a credential's shape, built from parts so no scanner reads them as live keys. */
const KEY = ['pd_', 'a3'.repeat(32)].join('');
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'c2lnbmF0dXJl'].join('.');

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  const [project] = await db.insert(schema.projects).values({ name: PROJECT }).returning();
  testCaseCache.invalidate(project!.id);
  testSuiteCache.invalidate(project!.id);
});

/** A failed test as the reporter's older versions send it, a key and a token in its error. */
function failedCase(title: string) {
  const error = [
    `Error: 401 for ${KEY}`,
    '',
    `Received: "Bearer ${JWT}"`,
    'Call log:',
    `  - → GET https://api.test/me with \u001b[33m${KEY}\u001b[39m`,
  ].join('\n');
  return {
    title,
    location: `tests/${title}.spec.ts:3:1`,
    status: 'failed',
    duration: 10,
    error,
    steps: [{ title: 'Expect "toBe"', category: 'expect', duration: 1, error: { message: error } }],
    stepEvents: [
      { title: 'Before Hooks', category: 'hook', startedAt: 1, duration: 1, status: 'failed', error: `Error: ${KEY}` },
    ],
  };
}

/** Every text stored of the run's executions and of the project's failure clusters. */
async function storedTexts(runId: number): Promise<string> {
  const executions = await db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.testRunId, runId));
  const clusters = await db.select().from(schema.failureClusters);
  return JSON.stringify([executions, clusters]);
}

async function expectHidden(runId: number) {
  const stored = await storedTexts(runId);
  expect(stored).not.toContain(KEY);
  expect(stored).not.toContain(JWT);
  const [execution] = await db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.testRunId, runId));
  expect(execution!.error).toContain(`Error: 401 for ${HIDDEN_VALUE}`);
  expect((execution!.steps as Array<{ error: { message: string } }>)[0]!.error.message).toBe(execution!.error);
  expect((execution!.stepEvents as Array<{ error: string }>)[0]!.error).toBe(`Error: ${HIDDEN_VALUE}`);
  const [cluster] = await db.select().from(schema.failureClusters);
  expect(cluster!.sampleError).toBe(execution!.error);
  expect(cluster!.fingerprintSample).toBe(execution!.error);
}

describe('a credential in a test’s error', () => {
  test('is hidden as a batch body is stored', async () => {
    const { runId } = await submit({
      body: {
        projectName: PROJECT,
        status: 'failed',
        startTime: '2026-11-01T10:00:00.000Z',
        duration: 1000,
        totalTests: 1,
        failedTests: 1,
        testCases: [failedCase('signs-in')],
      },
    });
    await expectHidden(runId);
  });

  test('is hidden as the stream stores it, and on the live run page', async () => {
    const { runId, streamToken } = await start({
      body: { projectName: PROJECT, startTime: '2026-11-01T10:00:00.000Z', instanceId: 'local-1' },
    });
    const published: unknown[] = [];
    const unsubscribe = runEventBus.subscribe(runId, (event) => published.push(event));
    try {
      await events({
        params: { id: String(runId) },
        body: { streamToken, testCases: [{ type: 'complete', ...failedCase('signs-in') }] },
      });
    } finally {
      unsubscribe();
    }
    await expectHidden(runId);
    const live = JSON.stringify(published);
    expect(live).toContain('test-completed');
    expect(live).not.toContain(KEY);
    expect(live).not.toContain(JWT);
  });
});
