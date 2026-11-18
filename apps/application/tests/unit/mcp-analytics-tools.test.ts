import { describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { ADMIN_ACCESS, InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { MCP_TOOLS } = await import('../../server/utils/mcp/tools');
const { createDashboard, dashboardActorFor } = await import('../../shared/handlers/dashboards');

const handler = (name: string) => {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.handler;
};

// A Viewer of project 1 only. The refusal comes before any query, so no database is needed.
const ctx = {
  user: null,
  access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.VIEWER }]),
  scope: new Set([1]),
};
const db = {} as never;

describe('the analytics and report tools enforce the project scope', () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ['get_quality_report', { dashboard: 'executive', projectIds: [1, 2] }],
    ['get_dashboard', { id: 'overview', projectIds: [2] }],
    ['get_metric_trend', { metric: 'test-pass-rate', projectIds: [2] }],
    ['compare_periods', { a: 'last-7d', b: 'last-14d', projectIds: [2] }],
  ];
  for (const [name, params] of calls) {
    it(`${name} refuses a project out of scope instead of leaving it out of the answer`, async () => {
      await expect(handler(name)(db, params, ctx)).rejects.toThrow('No access to project 2');
    });
  }
});

describe('get_dashboard lays the scope arguments over the dashboard’s', () => {
  it('a false allEnvironments or allBranches reads the defaults over a dashboard that counts every one', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ authEnabled: false }));
    const store = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrateToLatest(store);
    const everything = await createDashboard(
      store as any,
      {
        name: 'Everything',
        visibility: 'shared',
        definition: {
          v: 1,
          scope: { allEnvironments: true, defaultBranchOnly: false },
          bands: [{ title: 'Widgets', widgets: [] }],
        },
      },
      dashboardActorFor(null, null),
    );
    const admin = { user: null, access: ADMIN_ACCESS, scope: 'all' as const };
    const scopeOf = async (params: Record<string, unknown>) =>
      ((await handler('get_dashboard')(store as never, { id: String(everything.id), ...params }, admin)) as any)
        .scope as Record<string, string>;
    expect(await scopeOf({})).toMatchObject({ allEnvironments: 'true', allBranches: 'true' });
    const defaults = await scopeOf({ allEnvironments: false, allBranches: false });
    expect(defaults.allEnvironments).toBeUndefined();
    expect(defaults.allBranches).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
