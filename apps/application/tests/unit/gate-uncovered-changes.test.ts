import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import type { User } from '../../server/database/schema';
import { ADMIN_ACCESS, InstanceRole } from '#shared/permissions';
import type { ChangeCoverage } from '#shared/handlers/change-coverage';
import { recordRouteMeta, underRoutePermission, type RouteAccessState } from './route-access';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route modules (which import the barrel) are loaded.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
const coverage = vi.hoisted(() => ({ value: null as ChangeCoverage | null }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));
vi.mock('../../server/utils/project-access', async (importOriginal) =>
  (await import('./route-access')).projectAccessMock(state, await importOriginal<object>()),
);
vi.mock('../../server/utils/scm/change-coverage', () => ({ readChangeCoverage: vi.fn(async () => coverage.value) }));

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
  ) => Promise<{ verdict: string; warnings?: string[] }>,
);

function changeCoverage(over: Partial<ChangeCoverage> = {}): ChangeCoverage {
  return {
    runId: 1,
    baseSha: 'a',
    headSha: 'b',
    baseBranch: 'main',
    windowRuns: 30,
    files: [],
    tickets: [],
    reachedFiles: 4,
    uncoveredFiles: 3,
    notCounted: { notObservable: 2, outOfScope: 1, deleted: 0 },
    patchCoverage: {
      commit: 'b',
      changedLines: 40,
      executedLines: 30,
      unitLines: 30,
      e2eLines: 0,
      undeterminedLines: 0,
      suites: [],
      areas: [],
      files: 3,
    },
    filesTruncated: false,
    totalChangedFiles: null,
    scmAvailable: true,
    ...over,
  };
}

beforeEach(async () => {
  const db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values({ id: 1, name: 'gate-uncovered-changes' });
  await db
    .insert(schema.testRuns)
    .values({ id: 1, projectId: 1, status: 'passed', startTime: new Date(), totalTests: 0 });
  state.db = db;
  state.caller = { user: { id: 0, role: InstanceRole.ADMINISTRATOR, name: 'System' } as User, access: ADMIN_ACCESS };
  coverage.value = changeCoverage();
});

describe('the gate’s warn-only uncovered changes', () => {
  test('warns on the uncovered changes over the threshold, and on the patch coverage under the minimum', async () => {
    const result = await gate({ params: { id: '1' }, body: { maxUncoveredChanges: 2, minPatchCoverage: 80 } });
    expect(result.verdict).toBe('passed');
    expect(result.warnings).toEqual([
      '3 uncovered changes (threshold 2): changed files no test reached — warn-only.',
      'Patch coverage 75%: 30 of the 40 changed lines ran (minimum 80%) — warn-only.',
    ]);
  });

  test('says nothing when the change meets both', async () => {
    const result = await gate({ params: { id: '1' }, body: { maxUncoveredChanges: 3, minPatchCoverage: 75 } });
    expect(result.warnings).toBeUndefined();
  });

  test('warns that it could not count without a diff, instead of passing silently', async () => {
    coverage.value = changeCoverage({ scmAvailable: false });
    const result = await gate({ params: { id: '1' }, body: { maxUncoveredChanges: 0 } });
    expect(result.verdict).toBe('passed');
    expect(result.warnings).toEqual([
      'Uncovered changes could not be counted: no source control diff for this run (a token, a baseline) — warn-only.',
    ]);
  });
});
