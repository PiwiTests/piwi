import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import type { User } from '../../server/database/schema';
import { ADMIN_ACCESS, InstanceRole } from '#shared/permissions';
import { recordRouteMeta, underRoutePermission, type RouteAccessState } from './route-access';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route modules (which import the barrel) are loaded.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));
vi.mock('../../server/utils/project-access', async (importOriginal) =>
  (await import('./route-access')).projectAccessMock(state, await importOriginal<object>()),
);

interface RouteEvent {
  params: Record<string, string>;
  body: unknown;
}
vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getRouterParam', (event: RouteEvent, name: string) => event.params[name]);
vi.stubGlobal('readBody', async (event: RouteEvent) => event.body);
vi.stubGlobal('getRequestHeader', () => undefined);
vi.stubGlobal('apiError', apiError);

const gate = underRoutePermission(
  state,
  (await import('../../server/api/test-runs/[id]/gate.post')).default as unknown as (
    event: RouteEvent,
  ) => Promise<{ verdict: string; violations: Array<{ rule: string }>; facts: { failedTests: number } }>,
);

type Attempt = { browserName: string; retries: number; status: string };

/** One run of one test tagged `@critical` (stored as the reporter sends it, without the `@`), each Playwright project's attempts as Playwright reports them. */
async function runOf(attempts: Attempt[]) {
  await state.db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'checkout.spec.ts', title: 'pays' });
  await state.db.insert(schema.testRunsCases).values(
    attempts.map((attempt) => ({
      testRunId: 1,
      testCaseId: 1,
      browserName: attempt.browserName,
      retries: attempt.retries,
      status: attempt.status,
      tags: ['critical'],
    })),
  );
}

beforeEach(async () => {
  const db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'gate-projects' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
  state.db = db;
  state.caller = { user: { id: 0, role: InstanceRole.ADMINISTRATOR, name: 'System' } as User, access: ADMIN_ACCESS };
});

describe('the gate over a run of several Playwright projects', () => {
  test('counts a test that failed in one project, whatever it did in another', async () => {
    await runOf([
      { browserName: 'desktop', retries: 0, status: 'passed' },
      { browserName: 'mobile', retries: 0, status: 'failed' },
      { browserName: 'mobile', retries: 1, status: 'failed' },
    ]);

    const result = await gate({ params: { id: '1' }, body: { maxFailed: 0, requireTags: ['@critical'] } });

    expect(result).toMatchObject({ verdict: 'failed', facts: { failedTests: 1 } });
    expect(result.violations.map((v) => v.rule).sort()).toEqual(['max-failed', 'required-tag']);
  });

  test('passes a test whose failed attempt in a project passed on its retry there', async () => {
    await runOf([
      { browserName: 'desktop', retries: 0, status: 'passed' },
      { browserName: 'mobile', retries: 0, status: 'failed' },
      { browserName: 'mobile', retries: 1, status: 'passed' },
    ]);

    const result = await gate({ params: { id: '1' }, body: { maxFailed: 0, requireTags: ['@critical'] } });

    expect(result).toMatchObject({ verdict: 'passed', violations: [], facts: { failedTests: 0 } });
  });
});
