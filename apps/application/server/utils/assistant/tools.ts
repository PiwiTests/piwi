/**
 * The tools the assistant offers a model. They are the MCP read tools, called
 * in-process with the asking user's `McpContext`, so the assistant reads no
 * more than the user can in the dashboard; plus two of its own, `find_tools`
 * and `get_instance_config`.
 *
 * The model is never offered a tool that declares a permission (the write and
 * triage tools, the diagnosis runs) nor a desktop-only tool: it reads, it never
 * writes. A question is offered the core set, the tools of the page it was
 * asked on (`PAGE_TOOLS`), and whatever `find_tools` added earlier in the
 * conversation.
 */
import { toolPermissions, type McpToolName } from '#shared/mcp-tools';
import type { AssistantToolCall } from '#shared/assistant';
import type { DbClient } from '../../database';
import type { AiToolCall, AiToolDef } from '../ai-tool-calls';
import { toolsForCaller } from '../mcp/catalog';
import type { McpContext, McpTool } from '../mcp/tools';
import { getInstanceConfig } from './instance-config';

/** The read tools every question is offered. */
export const CORE_ASSISTANT_TOOLS: readonly McpToolName[] = [
  'describe_piwi',
  'search',
  'list_projects',
  'get_project',
  'list_runs',
  'get_run',
  'explain_failure',
  'get_cluster',
  'list_open_clusters',
  'get_test_case',
  'list_flaky_tests',
  'get_fix_plan',
];

/**
 * The tools a page adds to the core set, by its `app/pages` pattern (the page
 * the browser says the question was asked on). A page missing here adds none.
 */
export const PAGE_TOOLS: Readonly<Record<string, readonly McpToolName[]>> = {
  '/': ['list_recent_activity'],
  '/projects/[id]': [
    'list_clusters',
    'list_failed_cases',
    'get_spec_health',
    'get_slow_tests',
    'get_performance_trend',
    'list_tags',
  ],
  '/projects/[id]/test-cases': ['get_project_test_catalog', 'search_test_cases', 'list_tags'],
  '/projects/[id]/selections': [
    'list_selections',
    'resolve_selection',
    'preview_selection',
    'suggest_selections',
    'analyze_selections',
  ],
  '/projects/[id]/coverage': [
    'get_coverage_summary',
    'get_coverage',
    'compare_coverage',
    'get_coverage_loss',
    'get_change_coverage',
  ],
  '/projects/[id]/locators': ['predict_locator_breaks', 'get_locator_healing'],
  '/projects/[id]/bug-reports': ['list_bug_reports', 'get_bug_report'],
  '/test-runs/[id]': ['get_run_insights', 'list_failed_cases', 'get_failure_groups', 'list_case_traces'],
  '/test-run-cases/[id]': [
    'get_test_run_case',
    'get_test_case_context',
    'get_execution_diagnosis',
    'get_case_screenshots',
    'get_network_requests',
    'get_locator_healing',
  ],
  '/failure-clusters/[id]': [
    'get_cluster_context',
    'get_cluster_diagnosis',
    'get_repo_commits',
    'get_repo_diff',
    'list_links',
  ],
  '/test-cases/[id]': [
    'get_test_case_context',
    'get_test_stability_trend',
    'get_flake_profile',
    'plan_flake_experiment',
  ],
  '/bug-reports/[id]': ['get_bug_report', 'render_steps'],
  '/analytics': ['get_metric_trend', 'compare_periods', 'list_dashboards'],
  '/analytics/d/[id]': ['get_dashboard', 'get_metric_trend', 'compare_periods'],
  '/analytics/dashboards': ['list_dashboards', 'get_dashboard'],
  '/reports': ['get_quality_report', 'list_dashboards'],
  '/reports/[id]': ['get_quality_report'],
  '/setup': ['get_release_notes'],
  '/mcp': ['get_release_notes'],
  '/settings/about': ['get_release_notes'],
};

/** The most characters of one tool result the model reads. */
export const MAX_TOOL_RESULT_CHARS = 12_000;

/** The most tools one `find_tools` call adds. */
const FIND_TOOLS_LIMIT = 5;

const FIND_TOOLS: AiToolDef = {
  name: 'find_tools',
  description:
    'Find more read tools when the ones offered do not cover the question: searches the names and descriptions of the other tools, adds the best matches for the rest of the conversation, and lists the names of the tools still not offered.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'What you need, in a few words (e.g. "coverage of a file")' } },
    required: ['query'],
  },
};

const GET_INSTANCE_CONFIG: AiToolDef = {
  name: 'get_instance_config',
  description:
    "How this Piwi instance is set up: each capability's state (active, available, undecided, declined, not applicable), the AI roles (provider and model), the connected issue trackers, whether authentication is on, server or desktop app, and the version. Its storage and retention are shown to administrators only.",
  inputSchema: { type: 'object', properties: {} },
};

/** The read tools a caller may be offered: served here and declaring no permission, never the desktop-only ones. */
export async function assistantReadTools(db: DbClient, ctx: McpContext): Promise<McpTool[]> {
  const tools = await toolsForCaller(db, ctx.access, { desktop: false });
  return tools.filter((tool) => toolPermissions(tool).length === 0);
}

/** The names a question is offered from `readTools`: the core set, the page's tools and the ones added earlier. */
export function offeredToolNames(
  readTools: readonly McpTool[],
  page: string | null,
  extra: readonly string[],
): string[] {
  const wanted = new Set<string>([...CORE_ASSISTANT_TOOLS, ...((page && PAGE_TOOLS[page]) || []), ...extra]);
  return readTools.filter((tool) => wanted.has(tool.name)).map((tool) => tool.name);
}

/** The read tools matching a `find_tools` query, best first: each query word found in the name or description scores. */
export function matchTools(candidates: readonly McpTool[], query: string): McpTool[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  return candidates
    .map((tool) => {
      const name = tool.name.replace(/_/g, ' ');
      const description = tool.description.toLowerCase();
      const score = words.reduce((n, w) => n + (name.includes(w) ? 3 : 0) + (description.includes(w) ? 1 : 0), 0);
      return { tool, score };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((m) => m.tool);
}

/** One line for a person about a tool call, from its name and its simple arguments; never its result. */
export function toolCallSummary(name: string, args: Record<string, unknown>): string {
  const label = name.replace(/_/g, ' ');
  const shown = Object.entries(args)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .slice(0, 3)
    .map(([k, v]) => {
      const value = String(v);
      return `${k} ${value.length > 40 ? `${value.slice(0, 39)}…` : value}`;
    });
  const line = `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
  return shown.length > 0 ? `${line} (${shown.join(', ')})` : line;
}

/** A tool's result as the model reads it, cut at {@link MAX_TOOL_RESULT_CHARS}. */
export function capToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const rest = text.length - MAX_TOOL_RESULT_CHARS;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (cut: ${rest} more characters; narrow the question, or page with pageSize and cursor)`;
}

export interface AssistantToolOutcome {
  content: string;
  isError: boolean;
  record: AssistantToolCall;
}

/** The tools of one question: what is offered to the model, and the calls run with the user's context. */
export interface AssistantToolbox {
  /** The definitions offered on the next model call. */
  definitions(): AiToolDef[];
  /** Run one call. A refusal or failure is a result the model reads, never a throw. */
  run(call: AiToolCall): Promise<AssistantToolOutcome>;
  /** The tools `find_tools` added, the earlier ones included, to offer for the rest of the conversation. */
  extraTools(): string[];
}

export function createAssistantToolbox(opts: {
  db: DbClient;
  ctx: McpContext;
  readTools: readonly McpTool[];
  page: string | null;
  extraTools: readonly string[];
}): AssistantToolbox {
  const byName = new Map(opts.readTools.map((t) => [t.name, t]));
  const extra = new Set(opts.extraTools.filter((name) => byName.has(name)));
  const offered = () => new Set(offeredToolNames(opts.readTools, opts.page, [...extra]));

  async function runTool(call: AiToolCall): Promise<{ data: unknown; error?: string }> {
    if (call.invalidArguments !== undefined) return { data: null, error: 'The arguments were not a JSON object' };
    if (call.name === FIND_TOOLS.name) return { data: findTools(String(call.arguments.query ?? '')) };
    if (call.name === GET_INSTANCE_CONFIG.name) return { data: await getInstanceConfig(opts.db, opts.ctx) };
    const tool = offered().has(call.name) ? byName.get(call.name) : undefined;
    if (!tool) return { data: null, error: `Unknown tool: ${call.name}. Call find_tools to look for one.` };
    try {
      return { data: await tool.handler(opts.db, call.arguments, opts.ctx) };
    } catch (err) {
      return { data: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  function findTools(query: string) {
    const current = offered();
    const candidates = opts.readTools.filter((t) => !current.has(t.name));
    const added = matchTools(candidates, query).slice(0, FIND_TOOLS_LIMIT);
    for (const tool of added) extra.add(tool.name);
    const addedNames = new Set(added.map((t) => t.name));
    return {
      added: added.map((t) => ({ name: t.name, description: t.description })),
      notOffered: candidates.filter((t) => !addedNames.has(t.name)).map((t) => t.name),
    };
  }

  return {
    definitions() {
      const names = offered();
      return [
        ...opts.readTools
          .filter((t) => names.has(t.name))
          .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        FIND_TOOLS,
        GET_INSTANCE_CONFIG,
      ];
    },
    async run(call) {
      const { data, error } = await runTool(call);
      const record: AssistantToolCall = {
        name: call.name,
        arguments: call.arguments,
        summary: toolCallSummary(call.name, call.arguments),
        ...(error ? { error: error.slice(0, 400) } : {}),
      };
      if (error) return { content: `Error: ${error.slice(0, 400)}`, isError: true, record };
      const content = data === null ? 'Not found, or not visible to this user.' : JSON.stringify(data);
      return { content: capToolResult(content), isError: false, record };
    },
    extraTools() {
      return [...extra];
    },
  };
}
