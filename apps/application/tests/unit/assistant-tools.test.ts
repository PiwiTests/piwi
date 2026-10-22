/**
 * The tools the assistant offers a model: read tools only, routed per page,
 * `find_tools` adding more for the rest of the conversation, and
 * `get_instance_config` keeping the deployment shape to administrators.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import { ADMIN_ACCESS, InstanceRole, ProjectRole, buildAccessSummary, type AccessSummary } from '#shared/permissions';
import { DESKTOP_MCP_TOOL_DEFS, MCP_TOOL_DEFS, toolPermissions } from '#shared/mcp-tools';

delete process.env.PIWI_DATABASE_URL;
delete process.env.PIWI_DESKTOP_TOKEN;

vi.stubGlobal('useRuntimeConfig', () => ({ ai: {}, authEnabled: false, public: { appVersion: '0.59.0' } }));

const tools = await import('../../server/utils/assistant/tools');
const { setInstanceDecisions } = await import('#shared/handlers/capabilities');
type McpContext = import('../../server/utils/mcp/tools').McpContext;

const appDir = resolve(__dirname, '../..');
const READ_TOOLS = new Set(MCP_TOOL_DEFS.filter((t) => toolPermissions(t).length === 0).map((t) => t.name));

const context = (access: AccessSummary, scope: McpContext['scope'] = 'all'): McpContext => ({
  user: { id: 2, role: access.instanceRole, name: 'Robin', username: 'robin' } as User,
  access,
  scope,
});
const member = context(
  buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.MAINTAINER }]),
  new Set([1]),
);
const administrator = context(ADMIN_ACCESS);

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
});
afterEach(async () => {
  await close();
});
afterAll(() => vi.unstubAllGlobals());

describe('the routing map', () => {
  test('names read tools only, of the shared catalog', () => {
    const named = [...tools.CORE_ASSISTANT_TOOLS, ...Object.values(tools.PAGE_TOOLS).flat()];
    for (const name of named) expect(READ_TOOLS.has(name), `${name} is a read tool of the shared catalog`).toBe(true);
  });

  test('keys every page by a pattern of app/pages', () => {
    for (const pattern of Object.keys(tools.PAGE_TOOLS)) {
      const base = join(appDir, 'app/pages', pattern === '/' ? 'index' : pattern);
      expect(existsSync(`${base}.vue`) || existsSync(join(base, 'index.vue')), `${pattern} is a page`).toBe(true);
    }
  });

  test('offers the core set, the page tools and the earlier additions', () => {
    const readTools = tools.CORE_ASSISTANT_TOOLS.length;
    const catalog = MCP_TOOL_DEFS.filter((t) => READ_TOOLS.has(t.name)) as never;
    expect(tools.offeredToolNames(catalog, null, [])).toHaveLength(readTools);
    const onCluster = tools.offeredToolNames(catalog, '/failure-clusters/[id]', ['get_coverage']);
    expect(onCluster).toEqual(
      expect.arrayContaining(['get_cluster_context', 'get_repo_diff', 'get_coverage', 'get_run']),
    );
    expect(tools.offeredToolNames(catalog, '/no-such-page', [])).toHaveLength(readTools);
  });
});

describe('assistantReadTools', () => {
  test('never offers a tool that declares a permission, nor a desktop-only tool, even to an administrator', async () => {
    for (const ctx of [administrator, member]) {
      const offered = await tools.assistantReadTools(db as never, ctx);
      expect(offered.length).toBeGreaterThan(30);
      for (const tool of offered) {
        expect(toolPermissions(tool), `${tool.name} declares no permission`).toEqual([]);
      }
      const names = new Set(offered.map((t) => t.name));
      for (const desktop of DESKTOP_MCP_TOOL_DEFS) expect(names.has(desktop.name)).toBe(false);
      for (const write of [
        'set_cluster_status',
        'run_cluster_diagnosis',
        'create_issue',
        'submit_diagnosis_feedback',
      ]) {
        expect(names.has(write), write).toBe(false);
      }
    }
  });

  test('drops the tools of a declined capability', async () => {
    await setInstanceDecisions(db as never, { scm: 'declined' });
    const names = new Set((await tools.assistantReadTools(db as never, administrator)).map((t) => t.name));
    expect(names.has('get_repo_diff')).toBe(false);
    expect(names.has('get_run')).toBe(true);
  });
});

describe('the toolbox', () => {
  async function box(ctx: McpContext, page: string | null = null, extraTools: string[] = []) {
    const readTools = await tools.assistantReadTools(db as never, ctx);
    return tools.createAssistantToolbox({ db: db as never, ctx, readTools, page, extraTools });
  }

  test('offers its own two tools after the read tools', async () => {
    const names = (await box(member)).definitions().map((d) => d.name);
    expect(names.slice(-2)).toEqual(['find_tools', 'get_instance_config']);
    expect(names).toContain('list_projects');
    expect(names).not.toContain('get_coverage');
  });

  test('refuses a tool it does not offer, a write tool included', async () => {
    const toolbox = await box(administrator);
    const write = await toolbox.run({
      id: '1',
      name: 'set_cluster_status',
      arguments: { clusterId: 1, status: 'resolved' },
    });
    expect(write).toMatchObject({ isError: true, record: { name: 'set_cluster_status' } });
    expect(write.content).toContain('Unknown tool: set_cluster_status');
    const unoffered = await toolbox.run({ id: '2', name: 'get_coverage', arguments: {} });
    expect(unoffered.content).toContain('Unknown tool');
  });

  test('runs a read tool with the caller context, so a project out of scope is refused', async () => {
    await db.insert((await import('../../server/database/schema.sqlite')).projects).values([
      { id: 1, name: 'shop' },
      { id: 2, name: 'admin-console' },
    ]);
    const toolbox = await box(member);
    const listed = await toolbox.run({ id: '1', name: 'list_projects', arguments: {} });
    expect(listed.isError).toBe(false);
    expect(listed.content).toContain('shop');
    expect(listed.content).not.toContain('admin-console');
    const refused = await toolbox.run({ id: '2', name: 'get_project', arguments: { projectId: 2 } });
    expect(refused).toMatchObject({ isError: true, record: { error: 'No access to project 2' } });
  });

  test('find_tools adds the best matches for the rest of the conversation', async () => {
    const toolbox = await box(member);
    const found = await toolbox.run({ id: '1', name: 'find_tools', arguments: { query: 'coverage of a file' } });
    const result = JSON.parse(found.content) as { added: Array<{ name: string }>; notOffered: string[] };
    expect(result.added.map((t) => t.name)).toContain('get_coverage');
    expect(result.added.length).toBeLessThanOrEqual(5);
    expect(result.notOffered).not.toContain('get_coverage');
    expect(toolbox.definitions().map((d) => d.name)).toContain('get_coverage');
    expect(toolbox.extraTools()).toContain('get_coverage');
  });

  test('marks arguments that were not a JSON object without running the tool', async () => {
    const toolbox = await box(member);
    const outcome = await toolbox.run({ id: '1', name: 'list_projects', arguments: {}, invalidArguments: 'oops' });
    expect(outcome).toMatchObject({ isError: true, record: { error: 'The arguments were not a JSON object' } });
  });

  test('get_instance_config shows the deployment shape to administrators only, and never a key', async () => {
    const forMember = JSON.parse(
      (await (await box(member)).run({ id: '1', name: 'get_instance_config', arguments: {} })).content,
    );
    expect(forMember).toMatchObject({ version: '0.59.0', authentication: 'off', ai: 'not configured' });
    expect(forMember.capabilities).toBeDefined();
    expect(forMember.storage).toBeUndefined();
    expect(forMember.note).toContain('administrators only');
    const forAdmin = JSON.parse(
      (await (await box(administrator)).run({ id: '1', name: 'get_instance_config', arguments: {} })).content,
    );
    expect(forAdmin.storage).toBe('local disk');
    expect(JSON.stringify(forAdmin)).not.toMatch(/apiKey|api_key/);
  });
});

describe('helpers', () => {
  test('a tool call reads as one line, never its result', () => {
    expect(tools.toolCallSummary('get_run', { runId: 42, statusFilter: 'failed', filters: { a: 1 } })).toBe(
      'Get run (runId 42, statusFilter failed)',
    );
    expect(tools.toolCallSummary('list_projects', {})).toBe('List projects');
  });

  test('a long result is cut, saying how to narrow it', () => {
    const long = 'x'.repeat(tools.MAX_TOOL_RESULT_CHARS + 500);
    const capped = tools.capToolResult(long);
    expect(capped.length).toBeLessThan(long.length);
    expect(capped).toContain('500 more characters');
    expect(tools.capToolResult('short')).toBe('short');
  });

  test('find_tools ranks name matches above description matches', () => {
    const catalog = MCP_TOOL_DEFS.filter((t) => READ_TOOLS.has(t.name)) as never;
    expect(tools.matchTools(catalog, 'flaky tests')[0]!.name).toBe('list_flaky_tests');
    expect(tools.matchTools(catalog, 'zz')).toEqual([]);
  });
});
