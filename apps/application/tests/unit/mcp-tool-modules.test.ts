import { describe, it, expect } from 'vitest';
import { MCP_TOOL_DEFS, DESKTOP_MCP_TOOL_DEFS } from '#shared/mcp-tools';
import { CAPABILITY_BY_ID, CAPABILITY_MODULES } from '#shared/capabilities';

// Every tool the MCP server can serve, hosted plus desktop-only.
const ALL_TOOLS = [...MCP_TOOL_DEFS, ...DESKTOP_MCP_TOOL_DEFS];

describe('MCP tool modules', () => {
  it('every tool declares a known module', () => {
    for (const tool of ALL_TOOLS) {
      expect(CAPABILITY_MODULES, `${tool.name} has module "${tool.module}"`).toContain(tool.module);
    }
  });

  it('every declared capability is a registry id', () => {
    for (const tool of ALL_TOOLS) {
      if (tool.capability) {
        expect(CAPABILITY_BY_ID[tool.capability], `${tool.name} names capability "${tool.capability}"`).toBeDefined();
      }
    }
  });

  it("a tool's module matches its capability's module", () => {
    for (const tool of ALL_TOOLS) {
      if (tool.capability) {
        expect(CAPABILITY_BY_ID[tool.capability].module, `${tool.name} (${tool.capability})`).toBe(tool.module);
      }
    }
  });

  it('the diagnosis, healing, scm, fixtures, coverage and integrations tools carry their capability', () => {
    const byName = new Map(ALL_TOOLS.map((t) => [t.name, t]));
    const expected: Record<string, string> = {
      run_cluster_diagnosis: 'ai',
      run_execution_diagnosis: 'ai',
      submit_diagnosis_feedback: 'ai',
      record_diagnosis: 'agent-diagnoses',
      get_locator_healing: 'locator-healing',
      apply_locator_fix: 'locator-healing',
      create_issue: 'integrations',
      list_links: 'integrations',
      link_issue: 'integrations',
      unlink_issue: 'integrations',
      dismiss_quarantine_proposal: 'quarantine',
      set_test_quarantine: 'quarantine',
      get_repo_commits: 'scm',
      rerun_cluster_in_ci: 'scm',
      get_repo_diff: 'scm',
      get_network_requests: 'fixtures',
      get_slow_tests: 'fixtures',
      get_performance_trend: 'fixtures',
      get_coverage: 'coverage',
      compare_coverage: 'coverage',
      get_coverage_loss: 'coverage',
    };
    for (const [name, capability] of Object.entries(expected)) {
      expect(byName.get(name)?.capability, name).toBe(capability);
    }
  });

  it('the diagnosis read tools carry no capability: they read what an agent recorded as well', () => {
    const byName = new Map(ALL_TOOLS.map((t) => [t.name, t]));
    for (const name of ['get_cluster_diagnosis', 'get_execution_diagnosis']) {
      expect(byName.get(name), name).toBeDefined();
      expect(byName.get(name)!.capability, name).toBeUndefined();
    }
  });
});
