import { describe, it, expect } from 'vitest';
import { filterServeableTools, narrowToolsByModule } from '../../server/utils/mcp/filter';
import { MCP_TOOL_DEFS as CATALOG, type McpToolDef } from '#shared/mcp-tools';
import { CAPABILITIES, type CapabilityId, type CapabilityModule, type CapabilityState } from '#shared/capabilities';

/** A full states map at `undecided`, with the given overrides applied. */
function statesWith(overrides: Partial<Record<CapabilityId, CapabilityState>>): Record<CapabilityId, CapabilityState> {
  const states = {} as Record<CapabilityId, CapabilityState>;
  for (const c of CAPABILITIES) states[c.id] = 'undecided';
  return { ...states, ...overrides };
}

/** The hosted catalog, as the route serves it. */
const MCP_TOOL_DEFS: readonly McpToolDef[] = CATALOG;

const DIAGNOSIS = ['run_cluster_diagnosis', 'run_execution_diagnosis', 'submit_diagnosis_feedback'];

describe('filterServeableTools', () => {
  it('drops every tool whose capability is declined', () => {
    const names = filterServeableTools(MCP_TOOL_DEFS, statesWith({ ai: 'declined' })).map((t) => t.name);
    for (const name of DIAGNOSIS) expect(names).not.toContain(name);
    // Reading a diagnosis needs no AI: an agent may have recorded it.
    expect(names).toContain('get_cluster_diagnosis');
    // A different declined capability drops its own tools, not the ai ones.
    const scmDeclined = filterServeableTools(MCP_TOOL_DEFS, statesWith({ scm: 'declined' })).map((t) => t.name);
    expect(scmDeclined).not.toContain('get_repo_commits');
    expect(scmDeclined).toContain('run_cluster_diagnosis');
  });

  it('drops the scenario-gap tools when test-map is declined, keeping the scm-backed one', () => {
    const names = filterServeableTools(MCP_TOOL_DEFS, statesWith({ 'test-map': 'declined' })).map((t) => t.name);
    for (const name of ['list_scenario_gaps', 'draft_scenario', 'get_feature_graph']) {
      expect(names, name).not.toContain(name);
    }
    // get_change_coverage rides `scm`, not `test-map`, so it stays.
    expect(names).toContain('get_change_coverage');
  });

  it('keeps a tool whose capability is undecided, available or active', () => {
    for (const st of ['undecided', 'available', 'active'] as CapabilityState[]) {
      const names = filterServeableTools(MCP_TOOL_DEFS, statesWith({ ai: st })).map((t) => t.name);
      for (const name of DIAGNOSIS) expect(names, `${name} with ai=${st}`).toContain(name);
    }
  });

  it('never drops a tool that has no capability, even with every capability declined', () => {
    const allDeclined = {} as Record<CapabilityId, CapabilityState>;
    for (const c of CAPABILITIES) allDeclined[c.id] = 'declined';
    const kept = filterServeableTools(MCP_TOOL_DEFS, allDeclined);
    expect(kept.every((t) => !t.capability)).toBe(true);
    for (const t of MCP_TOOL_DEFS.filter((t) => !t.capability)) {
      expect(kept.map((k) => k.name)).toContain(t.name);
    }
  });
});

describe('narrowToolsByModule', () => {
  it('null means no narrowing', () => {
    expect(narrowToolsByModule(MCP_TOOL_DEFS, null)).toHaveLength(MCP_TOOL_DEFS.length);
  });

  it('narrows to the given modules', () => {
    const core = narrowToolsByModule(MCP_TOOL_DEFS, new Set<CapabilityModule>(['core']));
    expect(core.length).toBeGreaterThan(0);
    expect(core.every((t) => t.module === 'core')).toBe(true);
    expect(core.map((t) => t.name)).not.toContain('get_locator_healing'); // healing
    expect(core.map((t) => t.name)).not.toContain('create_issue'); // workflow
  });

  it('never re-adds a tool the decline filter already dropped', () => {
    const served = filterServeableTools(MCP_TOOL_DEFS, statesWith({ ai: 'declined' }));
    const agents = narrowToolsByModule(served, new Set<CapabilityModule>(['agents']));
    for (const name of DIAGNOSIS) expect(agents.map((t) => t.name)).not.toContain(name);
  });
});
