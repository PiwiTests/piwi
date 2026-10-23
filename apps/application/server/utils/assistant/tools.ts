/**
 * The tools the assistant offers a model. They are the MCP read tools, called
 * in-process with the asking user's `McpContext`, so the assistant reads no
 * more than the user can in the dashboard; four of its own, `find_tools`,
 * `get_instance_config`, `explain_setting` and `find_anchors`; and the block
 * tools its answer is made of besides text (`blocks.ts`), `propose_change`
 * among them, whose card the user applies: the model itself never writes.
 *
 * The model is never offered a tool that declares a permission (the write and
 * triage tools, the diagnosis runs) nor a desktop-only tool but
 * `read_local_source` on the desktop app, held to the folders linked to the
 * user's projects (`local-source.ts`): it reads, it never writes. A question
 * is offered the core set, the tools of the page it was asked on
 * (`PAGE_TOOLS`), and whatever `find_tools` added earlier in the conversation.
 *
 * Each read records the entities its result names (`entities.ts`), which the
 * answer's blocks may name; with the ones the conversation's earlier answers
 * read, they are the only entities a card or a choice can stand for.
 */
import { toolPermissions, type McpToolName } from '#shared/mcp-tools';
import type { AssistantBlock, AssistantEntityRef, AssistantPageContext, AssistantToolCall } from '#shared/assistant';
import {
  ASSISTANT_BLOCK_LIMITS,
  endsAssistantAnswer,
  isAssistantBlockTool,
  type AssistantBlockTool,
} from '#shared/assistant-blocks';
import type { DbClient } from '../../database';
import type { AiToolCall, AiToolDef } from '../ai-tool-calls';
import { toolsForCaller } from '../mcp/catalog';
import type { McpContext, McpTool } from '../mcp/tools';
import { BLOCK_TOOL_DEFS, FIND_ANCHORS, runBlockTool } from './blocks';
import { AssistantEntitySet, extractEntities } from './entities';
import { findAnchors, loadAnchorFacts, type AnchorFacts } from './guides';
import { getInstanceConfig } from './instance-config';
import { ASSISTANT_LOCAL_SOURCE_TOOL } from './local-source';
import { EXPLAIN_SETTING, explainSetting } from './settings';

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

/**
 * The read tools a caller may be offered: served here and declaring no
 * permission, and on the desktop app (`PIWI_DESKTOP_TOKEN`) `read_local_source`,
 * offered with the core set; never another desktop-only tool.
 */
export async function assistantReadTools(
  db: DbClient,
  ctx: McpContext,
  options: { desktop?: boolean } = {},
): Promise<McpTool[]> {
  const tools = await toolsForCaller(db, ctx.access, { desktop: false });
  const read = tools.filter((tool) => toolPermissions(tool).length === 0);
  const desktop = options.desktop ?? Boolean(process.env.PIWI_DESKTOP_TOKEN);
  return desktop ? [...read, ASSISTANT_LOCAL_SOURCE_TOOL] : read;
}

/** The names a question is offered from `readTools`: the core set, the page's tools and the ones added earlier. */
export function offeredToolNames(
  readTools: readonly McpTool[],
  page: string | null,
  extra: readonly string[],
): string[] {
  const wanted = new Set<string>([
    ...CORE_ASSISTANT_TOOLS,
    ASSISTANT_LOCAL_SOURCE_TOOL.name,
    ...((page && PAGE_TOOLS[page]) || []),
    ...extra,
  ]);
  return readTools.filter((tool) => wanted.has(tool.name)).map((tool) => tool.name);
}

/**
 * Every tool a toolbox built from `readTools` can offer in a conversation: the
 * read tools, the ones `find_tools` may add included, its own and the block
 * tools. The Claude Code CLI is allowed these and no other.
 */
export function assistantToolNames(readTools: readonly McpTool[]): string[] {
  return [
    ...readTools.map((t) => t.name),
    FIND_TOOLS.name,
    GET_INSTANCE_CONFIG.name,
    EXPLAIN_SETTING.name,
    FIND_ANCHORS.name,
    ...BLOCK_TOOL_DEFS.map((t) => t.name),
  ];
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
  /** A read tool's call, as stored with the answer and shown under "What it read"; absent for a block tool. */
  record?: AssistantToolCall;
  /** The block a block tool's call made, once checked. */
  block?: AssistantBlock;
}

/** The tools of one question: what is offered to the model, and the calls run with the user's context. */
export interface AssistantToolbox {
  /** The definitions offered on the next model call. */
  definitions(): AiToolDef[];
  /** Whether a tool makes a block of the answer rather than reading: block tools do not count toward the tool-call limit. */
  isBlockTool(name: string): boolean;
  /** Run one call. A refusal or failure is a result the model reads, never a throw. */
  run(call: AiToolCall): Promise<AssistantToolOutcome>;
  /** The tools `find_tools` added, the earlier ones included, to offer for the rest of the conversation. */
  extraTools(): string[];
}

/** Failed calls of one block tool in an answer after which it is refused without a check. */
const BLOCK_TOOL_ATTEMPTS = 2;

export function createAssistantToolbox(opts: {
  db: DbClient;
  ctx: McpContext;
  readTools: readonly McpTool[];
  page: string | null;
  extraTools: readonly string[];
  /** The page the question was asked on, which guides start from. */
  context?: AssistantPageContext | null;
  /** The entities the conversation's earlier answers read. */
  entities?: Iterable<AssistantEntityRef>;
}): AssistantToolbox {
  const byName = new Map(opts.readTools.map((t) => [t.name, t]));
  const extra = new Set(opts.extraTools.filter((name) => byName.has(name)));
  const offered = () => new Set(offeredToolNames(opts.readTools, opts.page, [...extra]));
  const context = opts.context ?? null;
  const entities = new AssistantEntitySet(opts.entities);
  const usedIds = new Set<string>();
  const blockFailures = new Map<string, number>();
  let facts: Promise<AnchorFacts> | null = null;
  const anchorFacts = () => (facts ??= loadAnchorFacts(opts.db, opts.ctx));

  async function runTool(call: AiToolCall): Promise<{ data: unknown; error?: string }> {
    if (call.invalidArguments !== undefined) return { data: null, error: 'The arguments were not a JSON object' };
    if (call.name === FIND_TOOLS.name) return { data: findTools(String(call.arguments.query ?? '')) };
    if (call.name === GET_INSTANCE_CONFIG.name) return { data: await getInstanceConfig(opts.db, opts.ctx) };
    if (call.name === EXPLAIN_SETTING.name) {
      return { data: await explainSetting(opts.db, opts.ctx, String(call.arguments.fieldId ?? '')) };
    }
    if (call.name === FIND_ANCHORS.name) {
      return { data: findAnchors(String(call.arguments.query ?? ''), await anchorFacts(), context) };
    }
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

  /** One block tool's call: refused past the answer's block limit or after its failed attempts, else checked. */
  async function runBlock(tool: AssistantBlockTool, call: AiToolCall): Promise<AssistantToolOutcome> {
    const refuse = (reason: string): AssistantToolOutcome => ({ content: `Error: ${reason}`, isError: true });
    if (call.invalidArguments !== undefined) return refuse('The arguments were not a JSON object');
    const failures = blockFailures.get(call.name) ?? 0;
    if (failures >= BLOCK_TOOL_ATTEMPTS) {
      return refuse(`${call.name} failed its checks ${failures} times in this answer; answer in text instead.`);
    }
    if (usedIds.size >= ASSISTANT_BLOCK_LIMITS.maxBlocks) {
      return refuse(`This answer has the most blocks one answer can have (${ASSISTANT_BLOCK_LIMITS.maxBlocks}).`);
    }
    const outcome = await runBlockTool(tool, call.arguments, {
      db: opts.db,
      ctx: opts.ctx,
      context,
      entities,
      usedIds,
      anchorFacts,
    });
    if ('error' in outcome) {
      blockFailures.set(call.name, failures + 1);
      const next = failures + 1 < BLOCK_TOOL_ATTEMPTS ? 'Fix the call and make it once more' : 'Answer in text instead';
      return refuse(`Not shown: ${outcome.error.slice(0, 600)}. ${next}.`);
    }
    usedIds.add(outcome.block.id);
    return {
      content: endsAssistantAnswer(outcome.block)
        ? 'Shown to the user. Your answer ends here; their reply comes with their next message.'
        : 'Shown to the user.',
      isError: false,
      block: outcome.block,
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
        EXPLAIN_SETTING,
        FIND_ANCHORS,
        ...BLOCK_TOOL_DEFS,
      ];
    },
    isBlockTool: isAssistantBlockTool,
    async run(call) {
      if (isAssistantBlockTool(call.name)) return runBlock(call.name, call);
      const { data, error } = await runTool(call);
      const record: AssistantToolCall = {
        name: call.name,
        arguments: call.arguments,
        summary: toolCallSummary(call.name, call.arguments),
        ...(error ? { error: error.slice(0, 400) } : {}),
      };
      if (error) return { content: `Error: ${error.slice(0, 400)}`, isError: true, record };
      const found = extractEntities(call.name, data);
      if (found.length > 0) {
        entities.add(found);
        record.entities = found.map(({ type, id, label }) => ({ type, id, label }));
      }
      const content = data === null ? 'Not found, or not visible to this user.' : JSON.stringify(data);
      return { content: capToolResult(content), isError: false, record };
    },
    extraTools() {
      return [...extra];
    },
  };
}
