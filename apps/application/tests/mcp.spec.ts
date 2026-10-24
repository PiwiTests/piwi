import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { MCP_TOOL_DEFS } from '#shared/mcp-tools';

function rpc(method: string, params?: Record<string, unknown>, id = 1) {
  return { jsonrpc: '2.0', id, method, params: params ?? {} };
}

async function mcp(request: any, method: string, params?: Record<string, unknown>) {
  const res = await request.post('/mcp', { data: rpc(method, params) });
  expect(res.ok(), `${method} should succeed`).toBeTruthy();
  return res.json();
}

test.describe.serial('MCP server', () => {
  let projectId: number;
  let runId: number;

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.MCP_TEST,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 5000,
        totalTests: 3,
        passedTests: 1,
        failedTests: 2,
        skippedTests: 0,
        testCases: [
          { title: 'login works', status: 'passed', duration: 1000, location: 'tests/auth.spec.ts:5:1' },
          {
            title: 'checkout fails',
            status: 'failed',
            duration: 2000,
            location: 'tests/checkout.spec.ts:10:1',
            error: 'Expected button to be visible',
            retries: 0,
            steps: [
              {
                title: 'Navigate',
                subtitle: '/checkout',
                category: 'navigation',
                duration: 500,
                params: { url: 'https://shop.example.com/checkout' },
              },
              {
                title: 'Click',
                subtitle: "getByRole('button', { name: 'Pay' })",
                category: 'action',
                duration: 1500,
                failed: true,
                error: { message: 'Expected button to be visible' },
                params: { locator: "getByRole('button', { name: 'Pay' })" },
              },
            ],
          },
          {
            title: 'payment fails',
            status: 'failed',
            duration: 2000,
            location: 'tests/payment.spec.ts:15:1',
            error: 'Expected button to be visible',
            retries: 1,
          },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    projectId = data.projectId;
    runId = data.runId;
  });

  test('initialize — returns server info and capabilities', async ({ request }) => {
    const body = await mcp(request, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    });
    expect(body.result.protocolVersion).toBe('2024-11-05');
    expect(body.result.serverInfo.name).toBe('piwi-dashboard');
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.capabilities.prompts).toBeDefined();
  });

  test('ping — returns empty result', async ({ request }) => {
    const body = await mcp(request, 'ping');
    expect(body.result).toEqual({});
  });

  test('tools/list — returns all tools', async ({ request }) => {
    const body = await mcp(request, 'tools/list');
    const tools: { name: string }[] = body.result.tools;
    expect(tools.length).toBe(MCP_TOOL_DEFS.length);
    const names = tools.map((t) => t.name);
    expect(names).toContain('list_projects');
    expect(names).toContain('get_run');
    expect(names).toContain('get_cluster_context');
    expect(names).toContain('search_test_cases');
    expect(names).toContain('get_test_run_case');
    expect(names).toContain('list_recent_activity');
    expect(names).toContain('get_repo_commits');
    expect(names).toContain('get_repo_diff');
    // New tools
    expect(names).toContain('get_run_insights');
    expect(names).toContain('get_spec_health');
    expect(names).toContain('get_network_requests');
    expect(names).toContain('get_locator_healing');
    expect(names).toContain('search');
    expect(names).toContain('explain_failure');
    expect(names).toContain('set_cluster_status');
    expect(names).toContain('triage_cluster');
    expect(names).toContain('triage_gap');
    expect(names).toContain('decide_merge_suggestion');
    expect(names).toContain('dismiss_quarantine_proposal');
    expect(names).toContain('set_bug_report_status');
    expect(names).toContain('rerun_cluster_in_ci');
    expect(names).toContain('link_issue');
    expect(names).toContain('set_cluster_bisect');
    expect(names).toContain('record_diagnosis');
    expect(names).toContain('report_fix_attempt');
    expect(names).toContain('set_run_incident');
    expect(names).toContain('list_open_clusters');
    expect(names).toContain('get_fix_plan');
    expect(names).toContain('create_test_function');
    expect(names).toContain('create_issue');
    expect(names).toContain('analyze_selections');
    expect(names).toContain('get_impacted_tests');
    // Every tool has a description and inputSchema
    for (const t of tools) {
      expect(t).toHaveProperty('description');
      expect(t).toHaveProperty('inputSchema');
    }
  });

  test('prompts/list — advertises the setup_piwi prompt', async ({ request }) => {
    const body = await mcp(request, 'prompts/list');
    const prompts: { name: string; description: string; arguments: unknown[] }[] = body.result.prompts;
    const setup = prompts.find((p) => p.name === 'setup_piwi');
    expect(setup).toBeDefined();
    expect(setup!.description.length).toBeGreaterThan(20);
    expect(Array.isArray(setup!.arguments)).toBe(true);
  });

  test('prompts/get investigate_failure — serves the bundled workflow skill', async ({ request }) => {
    const list = await mcp(request, 'prompts/list');
    const names = (list.result.prompts as { name: string }[]).map((p) => p.name);
    expect(names).toContain('investigate_failure');
    const body = await mcp(request, 'prompts/get', { name: 'investigate_failure', arguments: { focus: 'cluster 1' } });
    const text: string = body.result.messages[0].content.text;
    expect(text).toContain('Work on: cluster 1');
    expect(text).toContain('report_fix_attempt');
  });

  test('prompts/get setup_piwi — returns server-aware setup messages', async ({ request }) => {
    const body = await mcp(request, 'prompts/get', {
      name: 'setup_piwi',
      arguments: { projectName: PROJECT.MCP_TEST },
    });
    const messages: { role: string; content: { type: string; text: string } }[] = body.result.messages;
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].role).toBe('user');
    const text = messages[0].content.text;
    // Server-aware: the message names this project and includes a runnable init command.
    expect(text).toContain(`--project ${PROJECT.MCP_TEST}`);
    expect(text).toContain('npx @piwitests/reporter init --server-url');
    // Auth is disabled in the test server, so it should say no key is needed.
    expect(text).toContain('Authentication: not required');
  });

  test('prompts/get — unknown prompt returns invalid-params error', async ({ request }) => {
    const body = await mcp(request, 'prompts/get', { name: 'nope' });
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32602);
  });

  test('tools/call list_projects — returns project list with stats', async ({ request }) => {
    const body = await mcp(request, 'tools/call', { name: 'list_projects', arguments: {} });
    const text = body.result.content[0].text;
    const { items: projects } = JSON.parse(text);
    expect(Array.isArray(projects)).toBe(true);
    const project = projects.find((p: any) => p.name === PROJECT.MCP_TEST);
    expect(project).toBeDefined();
    expect(project.id).toBe(projectId);
    expect(project.totalRuns).toBeGreaterThan(0);
  });

  test('tools/call get_project — returns project with runs', async ({ request }) => {
    const body = await mcp(request, 'tools/call', { name: 'get_project', arguments: { projectId } });
    const data = JSON.parse(body.result.content[0].text);
    expect(data.id).toBe(projectId);
    expect(data.name).toBe(PROJECT.MCP_TEST);
    expect(Array.isArray(data.runs)).toBe(true);
    expect(data.runs.length).toBeGreaterThan(0);
  });

  test('tools/call list_runs — filters by projectId', async ({ request }) => {
    const body = await mcp(request, 'tools/call', { name: 'list_runs', arguments: { projectId } });
    const result = JSON.parse(body.result.content[0].text);
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].status).toBe('failed');
  });

  test('tools/call get_run — returns summary and failed cases', async ({ request }) => {
    const body = await mcp(request, 'tools/call', { name: 'get_run', arguments: { runId } });
    const run = JSON.parse(body.result.content[0].text);
    expect(run.id).toBe(runId);
    expect(run.status).toBe('failed');
    expect(run.failed).toBe(2);
    expect(run.passed).toBe(1);
    // Default filter is "failed" — should include the 2 failed cases
    expect(run.cases.length).toBe(2);
    expect(run.cases[0]).toHaveProperty('title');
    expect(run.cases[0]).toHaveProperty('status');
    // Null values should be omitted from compact output
    expect(run.cases[0].error).not.toBeNull();
  });

  test('tools/call get_run with statusFilter=all — returns all cases', async ({ request }) => {
    const body = await mcp(request, 'tools/call', {
      name: 'get_run',
      arguments: { runId, statusFilter: 'all' },
    });
    const run = JSON.parse(body.result.content[0].text);
    expect(run.total).toBe(3);
    expect(run.cases.length).toBe(3);
  });

  test('tools/call get_run — paginates cases with pageSize', async ({ request }) => {
    const body = await mcp(request, 'tools/call', {
      name: 'get_run',
      arguments: { runId, statusFilter: 'all', pageSize: 2 },
    });
    const run = JSON.parse(body.result.content[0].text);
    expect(run.cases.length).toBe(2);
    expect(run.nextCursor).toBeTruthy();
    const page2 = await mcp(request, 'tools/call', {
      name: 'get_run',
      arguments: { runId, statusFilter: 'all', pageSize: 2, cursor: run.nextCursor },
    });
    const run2 = JSON.parse(page2.result.content[0].text);
    expect(run2.cases.length).toBe(1);
    // Pages are disjoint
    const ids1 = run.cases.map((c: any) => c.executionId);
    const ids2 = run2.cases.map((c: any) => c.executionId);
    expect(ids1.some((x: number) => ids2.includes(x))).toBe(false);
  });

  test('tools/call list_failed_cases — returns failed cases for project', async ({ request }) => {
    const body = await mcp(request, 'tools/call', {
      name: 'list_failed_cases',
      arguments: { projectId, runId },
    });
    const result = JSON.parse(body.result.content[0].text);
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBe(2);
    expect(result.items[0]).toHaveProperty('title');
    expect(result.items[0]).toHaveProperty('error');
  });

  test('tools/call list_clusters — returns cluster list', async ({ request }) => {
    const body = await mcp(request, 'tools/call', { name: 'list_clusters', arguments: { projectId } });
    const result = JSON.parse(body.result.content[0].text);
    expect(Array.isArray(result.items)).toBe(true);
    // Two similar errors should be grouped into at least one cluster
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]).toHaveProperty('id');
    expect(result.items[0]).toHaveProperty('status');
  });

  test('tools/call list_failed_cases — cursor paginates without error (regression)', async ({ request }) => {
    const p1 = JSON.parse(
      (await mcp(request, 'tools/call', { name: 'list_failed_cases', arguments: { projectId, runId, pageSize: 1 } }))
        .result.content[0].text,
    );
    expect(p1.items.length).toBe(1);
    expect(p1.nextCursor).toBeTruthy();
    expect(String(p1.nextCursor)).not.toBe('undefined');
    const p2res = await mcp(request, 'tools/call', {
      name: 'list_failed_cases',
      arguments: { projectId, runId, pageSize: 1, cursor: p1.nextCursor },
    });
    // The bug made this a JSON-RPC error (Number("undefined") → NaN SQL query).
    expect(p2res.error).toBeUndefined();
    const p2 = JSON.parse(p2res.result.content[0].text);
    expect(p2.items.length).toBe(1);
    expect(p2.items[0].executionId).not.toBe(p1.items[0].executionId);
  });

  test('tools/call list_flaky_tests — stat fields are populated (regression)', async ({ request }) => {
    const result = JSON.parse(
      (await mcp(request, 'tools/call', { name: 'list_flaky_tests', arguments: { projectId } })).result.content[0].text,
    );
    expect(Array.isArray(result.items)).toBe(true);
    // The bug stripped every stat via dropNulls; when present, flakyScore is a number.
    for (const item of result.items) {
      expect(typeof item.flakyScore).toBe('number');
      expect(typeof item.runCount).toBe('number');
    }
  });

  test('tools/call get_test_case_context — returns evidence sections (regression)', async ({ request }) => {
    const run = JSON.parse(
      (await mcp(request, 'tools/call', { name: 'get_run', arguments: { runId, statusFilter: 'failed' } })).result
        .content[0].text,
    );
    const execId = run.cases[0].executionId;
    const ctx = JSON.parse(
      (await mcp(request, 'tools/call', { name: 'get_test_case_context', arguments: { executionId: execId } })).result
        .content[0].text,
    );
    // Execution scope carries evidence: context sections or the raw execution.
    const hasEvidence = (ctx.sections?.length ?? 0) > 0 || !!ctx.rawExecution;
    expect(hasEvidence).toBe(true);
  });

  test('tools/call get_test_run_case — steps carry their 1.63 subtitle and params', async ({ request }) => {
    const run = JSON.parse(
      (await mcp(request, 'tools/call', { name: 'get_run', arguments: { runId, statusFilter: 'failed' } })).result
        .content[0].text,
    );
    const checkout = run.cases.find((c: { title: string }) => c.title === 'checkout fails');
    expect(checkout).toBeTruthy();
    const res = JSON.parse(
      (
        await mcp(request, 'tools/call', {
          name: 'get_test_run_case',
          arguments: { executionId: checkout.executionId, include: ['steps'] },
        })
      ).result.content[0].text,
    );
    const nav = res.steps.find((s: { title: string }) => s.title === 'Navigate');
    expect(nav.subtitle).toBe('/checkout');
    expect(nav.params.url).toBe('https://shop.example.com/checkout');
    const click = res.steps.find((s: { subtitle?: string }) => s.subtitle === "getByRole('button', { name: 'Pay' })");
    expect(click.params.locator).toBe("getByRole('button', { name: 'Pay' })");
  });

  test('tools/call explain_failure — carries situation and nextStep (and story when a combination matches)', async ({
    request,
  }) => {
    const run = JSON.parse(
      (await mcp(request, 'tools/call', { name: 'get_run', arguments: { runId, statusFilter: 'failed' } })).result
        .content[0].text,
    );
    const execId = run.cases[0].executionId;
    const res = JSON.parse(
      (await mcp(request, 'tools/call', { name: 'explain_failure', arguments: { executionId: execId } })).result
        .content[0].text,
    );
    // A failing execution always has a situation sentence and a computed next step.
    expect(typeof res.situation).toBe('string');
    expect(res.situation.length).toBeGreaterThan(0);
    expect(res.nextStep).toBeTruthy();
    expect(typeof res.nextStep.kind).toBe('string');
    expect(res.nextStep.primary).toBeTruthy();
    // `story` is present only when a known clue combination matches; when present
    // it is one sentence over a set of clue ids.
    if (res.story) {
      expect(typeof res.story.sentence).toBe('string');
      expect(Array.isArray(res.story.clueIds)).toBe(true);
    }
  });

  test('tools/call get_run_insights — returns baseline comparison shape', async ({ request }) => {
    const insights = JSON.parse(
      (await mcp(request, 'tools/call', { name: 'get_run_insights', arguments: { runId } })).result.content[0].text,
    );
    expect(insights.runId).toBe(runId);
    expect(typeof insights.passRate).toBe('number');
    expect(typeof insights.hasBaseline).toBe('boolean');
    // Empty arrays are stripped by dropNulls; when present, it's an array.
    if (insights.newRegressions !== undefined) expect(Array.isArray(insights.newRegressions)).toBe(true);
  });

  test('tools/call search — global search returns grouped results', async ({ request }) => {
    const res = JSON.parse(
      (await mcp(request, 'tools/call', { name: 'search', arguments: { q: 'checkout' } })).result.content[0].text,
    );
    expect(res).toHaveProperty('projects');
    expect(res).toHaveProperty('runs');
    expect(res).toHaveProperty('cases');
  });

  test('tools/call set_cluster_status — triages a cluster', async ({ request }) => {
    const clusters = JSON.parse(
      (await mcp(request, 'tools/call', { name: 'list_clusters', arguments: { projectId } })).result.content[0].text,
    );
    const clusterId = clusters.items[0].id;
    const res = JSON.parse(
      (
        await mcp(request, 'tools/call', {
          name: 'set_cluster_status',
          arguments: { clusterId, status: 'resolved', triageNote: 'fixed by test' },
        })
      ).result.content[0].text,
    );
    expect(res.ok).toBe(true);
    expect(res.status).toBe('resolved');
  });

  test('tools/call create_test_function — registers a catalog entry', async ({ request }) => {
    const res = JSON.parse(
      (
        await mcp(request, 'tools/call', {
          name: 'create_test_function',
          arguments: {
            projectId,
            name: 'addToCart',
            kind: 'helper',
            module: './helpers/cart',
            params: [],
            steps: [{ action: 'click', target: { testId: 'add-to-cart' } }],
          },
        })
      ).result.content[0].text,
    );
    expect(res.id).toBeGreaterThan(0);
    expect(res.name).toBe('addToCart');
    expect(res.module).toBe('./helpers/cart');
    expect(res.source).toBe('ai-extracted');
  });

  test('tools/call create_test_function — rejects a name that is not a valid identifier', async ({ request }) => {
    const body = await mcp(request, 'tools/call', {
      name: 'create_test_function',
      arguments: {
        projectId,
        name: 'not a valid name',
        kind: 'helper',
        module: './helpers/cart',
        params: [],
        steps: [{ action: 'click', target: { testId: 'x' } }],
      },
    });
    // A tool that throws surfaces as an isError tool result the model can read,
    // not a JSON-RPC protocol error clients render as a transport failure.
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Error');
  });

  test('tools/call with unknown tool — returns method error', async ({ request }) => {
    const body = await mcp(request, 'tools/call', { name: 'nonexistent_tool', arguments: {} });
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32602);
  });

  test('unknown method — returns method not found error', async ({ request }) => {
    const body = await mcp(request, 'unknown/method');
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32601);
  });

  test('batch requests — handles array of JSON-RPC messages', async ({ request }) => {
    const res = await request.post('/mcp', {
      data: [rpc('ping', {}, 1), rpc('tools/list', {}, 2)],
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    const ping = body.find((r: any) => r.id === 1);
    const list = body.find((r: any) => r.id === 2);
    expect(ping.result).toEqual({});
    expect(list.result.tools.length).toBe(MCP_TOOL_DEFS.length);
  });

  test('tools/list — ?modules=core narrows to the core module', async ({ request }) => {
    const res = await request.post('/mcp?modules=core', { data: rpc('tools/list') });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    const coreNames = new Set(MCP_TOOL_DEFS.filter((t) => t.module === 'core').map((t) => t.name));
    // Every listed tool belongs to the core module …
    for (const name of names) expect(coreNames.has(name), `${name} should be a core-module tool`).toBe(true);
    // … and a known tool from each other module is gone.
    expect(names).not.toContain('get_locator_healing'); // healing
    expect(names).not.toContain('create_issue'); // workflow
    expect(names).not.toContain('get_cluster_diagnosis'); // agents
  });

  /** Call a tool and parse its JSON text result; `isError` results come back as `{ error }`. */
  async function callTool(request: any, name: string, args: Record<string, unknown> = {}) {
    const body = await mcp(request, 'tools/call', { name, arguments: args });
    const text: string = body.result.content[0].text;
    return body.result.isError ? { error: text } : JSON.parse(text);
  }

  test('tools/call describe_piwi — overview quotes the docs and describes this instance', async ({ request }) => {
    const overview = await callTool(request, 'describe_piwi');
    expect(overview.tagline).toBe('Your Playwright results, kept and explained.');
    expect(overview.thisInstance.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(overview.thisInstance.authentication).toBe('off');
    // Auth is off, so the caller is a virtual admin and sees the capability states.
    expect(overview.thisInstance.capabilities).toBeDefined();
    // The jobs are quoted from the bundled "What Piwi does" page.
    expect(overview.jobs.length).toBeGreaterThanOrEqual(3);
    expect(overview.jobs[0]).toContain('Keep the history');
    expect(Object.keys(overview.topics)).toEqual(
      expect.arrayContaining(['ecosystem', 'choices', 'configuration', 'feedback', 'docs']),
    );
    expect(overview.ecosystem.map((p: { id: string }) => p.id)).toEqual(
      expect.arrayContaining(['server', 'reporter', 'desktop', 'extension', 'mcp']),
    );
  });

  test('tools/call describe_piwi — reads one docs section and searches the docs', async ({ request }) => {
    const section = await callTool(request, 'describe_piwi', { page: 'guide/ci#sharding' });
    expect(section.section).toBe('Sharding');
    expect(section.url).toBe('https://piwitests.dev/guide/ci#sharding');
    expect(section.markdown).toMatch(/^## Sharding/);

    const page = await callTool(request, 'describe_piwi', { page: '/operate/deployment.md' });
    expect(page.outline.length).toBeGreaterThan(3);
    // The Docker quick start is a snippet include, served as the command itself.
    expect(page.markdown).toContain('docker run');

    const found = await callTool(request, 'describe_piwi', { query: 'retention days' });
    expect(found.hits[0]).toMatchObject({ page: 'operate/storage', anchor: 'data-retention' });
    expect(found.variables.map((v: { name: string }) => v.name)).toContain('PIWI_RETENTION_DAYS');

    const missing = await callTool(request, 'describe_piwi', { page: 'guide/no-such-page' });
    expect(missing.error).toContain('No docs page');

    // A generated page is answered from its registry, under its own name.
    const tools = await callTool(request, 'describe_piwi', { page: 'reference/mcp-tools' });
    expect(tools.page).toBe('reference/mcp-tools');
    expect(tools.note).toContain('MCP tool catalog');
    expect(tools.modules.length).toBeGreaterThan(0);
  });

  test('tools/call describe_piwi — topics: choices, configuration, mcp, feedback, docs', async ({ request }) => {
    const choices = await callTool(request, 'describe_piwi', { topic: 'choices' });
    const database = choices.decisions.find((d: { id: string }) => d.id === 'database');
    expect(database.current).toMatch(/SQLite|PostgreSQL/);
    expect(database.page).toBe('operate/database');

    const config = await callTool(request, 'describe_piwi', { topic: 'configuration', query: 'secret key' });
    expect(config.variables.map((v: { name: string }) => v.name)).toContain('PIWI_SECRET_KEY');

    const mcpTopic = await callTool(request, 'describe_piwi', { topic: 'mcp' });
    const served = mcpTopic.modules.flatMap((m: { tools: string[] }) => m.tools).map((t: string) => t.split(' ')[0]);
    expect(served).toEqual(expect.arrayContaining(MCP_TOOL_DEFS.map((t) => t.name)));
    expect(mcpTopic.desktopOnly.tools).toContain('apply_locator_fix');

    const feedback = await callTool(request, 'describe_piwi', { topic: 'feedback' });
    expect(feedback.bug.url).toContain('issues/new');

    const docs = await callTool(request, 'describe_piwi', { topic: 'docs' });
    const pages = docs.groups.flatMap((g: { pages: { page: string }[] }) => g.pages.map((p) => p.page));
    expect(pages).toEqual(expect.arrayContaining(['guide/getting-started', 'features/mcp', 'operate/authentication']));

    const unknown = await callTool(request, 'describe_piwi', { topic: 'nope' });
    expect(unknown.error).toContain('Unknown topic');
  });

  test('tools/call get_release_notes — current release, one version, a range and a search', async ({ request }) => {
    const latest = await callTool(request, 'get_release_notes');
    expect(latest.current.version).toBe(latest.runningVersion);
    expect(latest.recent.length).toBeGreaterThan(1);

    const one = await callTool(request, 'get_release_notes', { version: '0.33.0' });
    expect(one.releases[0].highlights.length).toBeGreaterThan(0);
    // Commit links are stripped: entries read as plain text.
    expect(JSON.stringify(one.releases[0])).not.toContain('/commit/');

    const range = await callTool(request, 'get_release_notes', { since: '0.30.0' });
    expect(range.releases.every((r: { version: string }) => r.version !== '0.30.0')).toBe(true);
    expect(range.count).toBe(range.releases.length);

    const search = await callTool(request, 'get_release_notes', { query: 'share links' });
    expect(search.matches.length).toBeGreaterThan(0);

    const missing = await callTool(request, 'get_release_notes', { version: '99.0.0' });
    expect(missing.error).toContain('No release 99.0.0');
  });
});
