import { describe, expect, test } from 'vitest';
import {
  DESKTOP_MCP_TOOL_DEFS,
  MCP_TOOL_DEFS,
  toolDetails,
  toolParameters,
  toolPermissions,
  toolSummary,
  type McpToolDef,
} from '#shared/mcp-tools';

const TOOLS: readonly McpToolDef[] = [...MCP_TOOL_DEFS, ...DESKTOP_MCP_TOOL_DEFS];
const byName = (name: string) => TOOLS.find((t) => t.name === name)!;

describe('MCP tool descriptions', () => {
  test.each(TOOLS.map((t) => [t.name, t] as const))('%s opens with a one-sentence summary', (_name, tool) => {
    const summary = toolSummary(tool.description);
    expect(summary).not.toContain('\n');
    expect(summary).toMatch(/\.$/);
    expect(summary.length).toBeLessThanOrEqual(170);
    // The `/mcp` page renders the summary inside the row's toggle button.
    expect(summary).not.toMatch(/\]\(/);
  });

  test.each(TOOLS.filter((t) => toolPermissions(t).length).map((t) => [t.name, t] as const))(
    '%s ends with the permission it requires',
    (_name, tool) => {
      const last = tool.description.split('\n\n').at(-1)!;
      expect(last).toMatch(/^Requires `/);
      for (const permission of toolPermissions(tool)) expect(last).toContain(`\`${permission}\``);
    },
  );

  test('every tool name a description mentions is in code', () => {
    const names = TOOLS.map((t) => t.name).filter((name) => name.includes('_'));
    const bare = TOOLS.flatMap((tool) =>
      names
        .filter((name) => new RegExp(`(?<![\`\\w])${name}(?![\`\\w])`).test(tool.description))
        .map((name) => `${tool.name} mentions ${name}`),
    );
    expect(bare).toEqual([]);
  });

  test('splits a description into its summary and the Markdown after it', () => {
    const fixPlan = byName('get_fix_plan').description;
    expect(toolSummary(fixPlan)).toBe('Get everything needed to fix one failure cluster, in one answer.');
    expect(toolDetails(fixPlan)).toMatch(/^Prefer it over assembling/);
    expect(toolDetails(fixPlan)).toContain('It carries:\n- the diagnosis and its validated patch\n- ');
    expect(toolDetails(byName('list_runs').description)).toBe('');
  });
});

describe('toolParameters', () => {
  test('lists the top-level arguments with their type, whether they are required and their values', () => {
    const params = toolParameters(byName('list_runs'));
    expect(params.map((p) => p.name)).toEqual(['projectId', 'status', 'branch', 'pageSize', 'cursor']);
    expect(params[0]).toMatchObject({ type: 'number', required: true, values: [] });
    expect(params[1]).toMatchObject({ type: 'string', required: false });
    expect(params[1]!.values).toContain('timedout');
  });

  test('names an array by its item type and a union by its members', () => {
    const include = toolParameters(byName('get_test_run_case')).find((p) => p.name === 'include')!;
    expect(include).toMatchObject({ type: 'string[]', values: ['steps', 'console', 'webVitals', 'aria', 'source'] });
    const receiver = toolParameters(byName('create_test_function')).find((p) => p.name === 'receiver')!;
    expect(receiver.type).toBe('string or null');
  });

  test('returns nothing for a tool without arguments', () => {
    expect(toolParameters(byName('list_projects'))).toEqual([]);
  });
});
