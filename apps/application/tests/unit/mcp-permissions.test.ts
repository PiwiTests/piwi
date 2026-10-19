/**
 * The MCP tools hold a caller to the same permissions as the REST API: each
 * write tool checks, on the project it acts on, the permission its REST twin
 * declares, and `tools/list` leaves out the tools a caller can use nowhere.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import type { McpContext } from '../../server/utils/mcp/tools';
import type { User } from '../../server/database/schema';
import {
  ADMIN_ACCESS,
  INSTANCE_PERMISSIONS,
  PROJECT_PERMISSIONS,
  InstanceRole,
  ProjectRole,
  buildAccessSummary,
  type AccessSummary,
  type RoleBindingGrant,
} from '#shared/permissions';
import { DESKTOP_MCP_TOOL_DEFS, MCP_TOOL_DEFS, toolPermissions, type McpToolDef } from '#shared/mcp-tools';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const { MCP_TOOLS, assertPermission } = await import('../../server/utils/mcp/tools');
const { narrowToolsByAccess } = await import('../../server/utils/mcp/filter');

const member = (...grants: RoleBindingGrant[]) => buildAccessSummary(InstanceRole.MEMBER, grants);
const caller = (access: AccessSummary, scope: Set<number> | 'all' = new Set([1])): McpContext => ({
  user: { id: 2, role: access.instanceRole, name: 'Robin', username: 'robin' } as User,
  access,
  scope,
});

const contributor = caller(member({ projectId: 1, role: ProjectRole.CONTRIBUTOR }));
const maintainerOfOne = caller(
  member({ projectId: 1, role: ProjectRole.MAINTAINER }, { projectId: 2, role: ProjectRole.VIEWER }),
  new Set([1, 2]),
);
const administrator = caller(buildAccessSummary(InstanceRole.ADMINISTRATOR, []), 'all');
const authOff: McpContext = { user: null, access: ADMIN_ACCESS, scope: 'all' };
const EVERY_PERMISSION = [...PROJECT_PERMISSIONS, ...INSTANCE_PERMISSIONS];

describe('assertPermission', () => {
  test('a Contributor can create an issue but not triage', () => {
    expect(() => assertPermission(contributor, 'issue:create', 1)).not.toThrow();
    expect(() => assertPermission(contributor, 'link:write', 1)).not.toThrow();
    expect(() => assertPermission(contributor, 'triage:write', 1)).toThrow(
      'This action requires the triage:write permission on project 1 (held by the Maintainer and Project admin roles)',
    );
  });

  test('a Maintainer on project 1 cannot triage project 2, which they only read', () => {
    expect(() => assertPermission(maintainerOfOne, 'triage:write', 1)).not.toThrow();
    expect(() => assertPermission(maintainerOfOne, 'triage:write', 2)).toThrow(
      'This action requires the triage:write permission on project 2',
    );
    expect(() => assertPermission(maintainerOfOne, 'project:read', 2)).not.toThrow();
  });

  test('an instance permission needs an administrator, whatever the project roles', () => {
    const projectAdminEverywhere = caller(member({ projectId: null, role: ProjectRole.PROJECT_ADMIN }), 'all');
    expect(() => assertPermission(projectAdminEverywhere, 'storage:manage')).toThrow(
      'This action requires the storage:manage permission (administrators only)',
    );
    // A project permission asked without a project is never granted to a member.
    expect(() => assertPermission(projectAdminEverywhere, 'triage:write')).toThrow();
  });

  test('an administrator can do everything', () => {
    for (const permission of EVERY_PERMISSION) {
      expect(() => assertPermission(administrator, permission, 1), permission).not.toThrow();
      expect(() => assertPermission(administrator, permission, 2), permission).not.toThrow();
    }
    expect(() => assertPermission(administrator, 'storage:manage')).not.toThrow();
  });

  test('with authentication off everything is allowed', () => {
    for (const permission of EVERY_PERMISSION) {
      expect(() => assertPermission(authOff, permission, 7), permission).not.toThrow();
    }
    expect(() => assertPermission(authOff, 'storage:manage')).not.toThrow();
  });
});

describe('the write tools check it on the project they act on', () => {
  let db: TempDb;
  let close: () => Promise<void>;
  const tool = (name: string) => MCP_TOOLS.find((t) => t.name === name)!.handler;

  beforeEach(async () => {
    ({ db, close } = await openTempDb());
    await db.insert(schema.projects).values([
      { id: 1, name: 'shop' },
      { id: 2, name: 'other' },
    ]);
    await db.insert(schema.testRuns).values([
      { id: 1, projectId: 1, status: 'failed', startTime: new Date() },
      { id: 2, projectId: 2, status: 'failed', startTime: new Date() },
    ]);
    const cluster = (id: number, projectId: number) => ({
      id,
      projectId,
      fingerprint: `fp-${id}`,
      signature: `Error ${id}`,
      errorType: 'assertion',
      firstSeenRunId: id,
      lastSeenRunId: id,
      occurrences: 1,
    });
    await db.insert(schema.failureClusters).values([cluster(1, 1), cluster(2, 2)]);
  });

  afterEach(async () => {
    await close();
  });

  test('a Contributor gets past the permission to file an issue, and is refused triage', async () => {
    await expect(
      tool('create_issue')(db as never, { entityType: 'failure_cluster', entityId: 1 }, contributor),
    ).rejects.toThrow('No Jira connection is configured');
    await expect(
      tool('set_cluster_status')(db as never, { clusterId: 1, status: 'resolved' }, contributor),
    ).rejects.toThrow('This action requires the triage:write permission on project 1');
  });

  test('a Maintainer on project 1 triages its cluster, and not the cluster of project 2', async () => {
    await expect(
      tool('set_cluster_status')(db as never, { clusterId: 1, status: 'resolved' }, maintainerOfOne),
    ).resolves.toMatchObject({ id: 1, status: 'resolved' });
    await expect(
      tool('set_cluster_status')(db as never, { clusterId: 2, status: 'resolved' }, maintainerOfOne),
    ).rejects.toThrow('This action requires the triage:write permission on project 2');
  });

  test('the instance stats need an administrator', async () => {
    await expect(tool('get_instance_stats')(db as never, {}, maintainerOfOne)).rejects.toThrow('administrators only');
    await expect(tool('get_instance_stats')(db as never, {}, administrator)).resolves.toBeTruthy();
    await expect(tool('get_instance_stats')(db as never, {}, authOff)).resolves.toBeTruthy();
  });
});

describe('tools/list leaves out the tools a caller can use nowhere', () => {
  const catalog: readonly McpToolDef[] = MCP_TOOL_DEFS;
  const listed = (access: AccessSummary) => narrowToolsByAccess(catalog, access).map((t) => t.name);
  const readTools = catalog.filter((t) => toolPermissions(t).length === 0).map((t) => t.name);

  test('a Contributor sees the tools to file and link issues, not the triage ones', () => {
    const names = listed(contributor.access);
    for (const name of ['create_issue', 'link_issue', 'set_bug_report_status']) {
      expect(names, name).toContain(name);
    }
    for (const name of [
      'set_cluster_status',
      'triage_cluster',
      'run_cluster_diagnosis',
      'set_run_incident',
      'get_instance_stats',
    ]) {
      expect(names, name).not.toContain(name);
    }
    expect(names).toEqual(expect.arrayContaining(readTools));
  });

  test('a Maintainer on one project sees the triage tools, not the administrator ones', () => {
    const names = listed(maintainerOfOne.access);
    for (const name of [
      'triage_cluster',
      'dismiss_quarantine_proposal',
      'record_diagnosis',
      'rerun_cluster_in_ci',
      'set_run_incident',
    ]) {
      expect(names, name).toContain(name);
    }
    expect(names).not.toContain('get_instance_stats');
  });

  test('a member with no role sees the read tools only', () => {
    expect(listed(member())).toEqual(readTools);
  });

  test('an administrator, and everyone with authentication off, sees the whole catalog', () => {
    const all = catalog.map((t) => t.name);
    expect(listed(administrator.access)).toEqual(all);
    expect(listed(ADMIN_ACCESS)).toEqual(all);
  });
});

/** Each tool that declares a permission, and the REST route(s) doing the same action. */
const REST_TWINS: Record<string, string[]> = {
  create_issue: ['integrations/issues.post.ts'],
  get_instance_stats: ['admin/stats.get.ts'],
  set_cluster_status: ['failure-clusters/[id]/status.patch.ts'],
  set_cluster_base_commit: ['failure-clusters/[id]/base-commit.patch.ts'],
  submit_diagnosis_feedback: ['failure-diagnoses/[id]/feedback.patch.ts'],
  run_cluster_diagnosis: ['failure-clusters/[id]/diagnose.post.ts'],
  run_execution_diagnosis: ['test-run-cases/[id]/diagnose.post.ts'],
  triage_cluster: ['failure-clusters/bulk.post.ts', 'failure-clusters/[id]/quarantine.post.ts'],
  triage_gap: ['projects/[id]/gaps/[gapId]/triage.post.ts'],
  decide_merge_suggestion: [
    'cluster-merge-suggestions/[id]/approve.post.ts',
    'cluster-merge-suggestions/[id]/reject.post.ts',
  ],
  move_tests_to_new_cluster: ['failure-clusters/[id]/extract-cases.post.ts'],
  dismiss_quarantine_proposal: ['projects/[id]/quarantine/[testCaseId]/dismiss.post.ts'],
  set_test_quarantine: ['projects/[id]/quarantine.post.ts', 'projects/[id]/quarantine/[testCaseId].delete.ts'],
  set_bug_report_status: ['bug-reports/[id].patch.ts'],
  rerun_cluster_in_ci: ['failure-clusters/[id]/rerun.post.ts'],
  set_cluster_bisect: ['failure-clusters/[id]/bisect.post.ts'],
  record_diagnosis: ['failure-clusters/[id]/agent-diagnosis.post.ts', 'test-run-cases/[id]/agent-diagnosis.post.ts'],
  report_fix_attempt: ['failure-clusters/[id]/fix-attempts.post.ts'],
  set_run_incident: ['test-runs/[id]/incident.post.ts'],
  link_issue: ['links/index.post.ts'],
  unlink_issue: ['links/[id].delete.ts'],
  create_test_function: ['projects/[id]/test-functions.post.ts'],
  import_local_report: ['desktop/import-local.post.ts'],
};

function routePermissions(file: string): string[] {
  const source = readFileSync(new URL(`../../server/api/${file}`, import.meta.url), 'utf8');
  const match = /'x-required-permission':\s*(\[[^\]]*\]|'[^']*')/.exec(source);
  if (!match) throw new Error(`${file} declares no x-required-permission`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/** Each handler's source in `server/utils/mcp/tools.ts`, by tool name. */
function handlerSources(): Map<string, string> {
  const source = readFileSync(new URL('../../server/utils/mcp/tools.ts', import.meta.url), 'utf8');
  const starts = [...source.matchAll(/^ {2}async (\w+)\(/gm)];
  return new Map(starts.map((m, i) => [m[1]!, source.slice(m.index, starts[i + 1]?.index ?? source.length)] as const));
}

describe('each write tool takes the permission of its REST twin', () => {
  const catalog: readonly McpToolDef[] = [...MCP_TOOL_DEFS, ...DESKTOP_MCP_TOOL_DEFS];
  const declaring = catalog.filter((t) => toolPermissions(t).length > 0);

  test('every tool declaring a permission names its REST twin here', () => {
    expect(declaring.map((t) => t.name).sort()).toEqual(Object.keys(REST_TWINS).sort());
  });

  test.each(declaring.map((t) => [t.name, t] as const))('%s', (name, def) => {
    const twin = [...new Set(REST_TWINS[name]!.flatMap(routePermissions))].sort();
    expect([...toolPermissions(def)].sort()).toEqual(twin);
  });

  test('a handler checks the permissions its tool declares, and a read tool checks none', () => {
    const sources = handlerSources();
    for (const def of catalog) {
      const body = sources.get(def.name);
      expect(body, def.name).toBeDefined();
      const permissions = toolPermissions(def);
      for (const permission of permissions)
        expect(body, `${def.name} checks ${permission}`).toContain(`'${permission}'`);
      if (permissions.length === 0) expect(body, def.name).not.toMatch(/assertPermission|holdsAnywhere/);
    }
  });
});
