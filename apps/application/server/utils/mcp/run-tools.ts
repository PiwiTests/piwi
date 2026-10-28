/**
 * Desktop build: the agents' tools for the Playwright runs the desktop shell starts (`run_list`, `run_follow`,
 * `run_control`, `page_snapshot`, `page_act`, `page_locator`, `code_write`). They are the editor service's own
 * (`RunAgent`, `agentTools`), in this app's words, on the hub of those runs (`server/utils/desktop-runs.ts`), and
 * `/mcp` serves them beside the catalog in the desktop build alone, to whoever holds the desktop token. A tool's answer
 * goes to the agent as `RunAgent` makes it: Piwi's JSON, then what came from the page apart, between the markers of a
 * page-content block, then an image said to be the page's too; never JSON of a catalog tool's data. Nothing they do
 * reaches the database, so nothing is logged with the write tools' calls.
 */
import { agentTools, type ToolResult } from '@piwitests/editor/run-host';
import type { CapabilityModule } from '#shared/capabilities';
import { DESKTOP_AGENT_WORDS, desktopRuns } from '../desktop-runs';

/** A run tool as `tools/list` names it, in the module whose tools let agents in. */
export interface DesktopRunTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  module: CapabilityModule;
}

const RUN_TOOLS: DesktopRunTool[] = agentTools(DESKTOP_AGENT_WORDS).map((tool) => ({ ...tool, module: 'agents' }));
const RUN_TOOL_NAMES = new Set(RUN_TOOLS.map((tool) => tool.name));

/** The run tools a surface serves: the desktop app's, none on any other. */
export function desktopRunTools(desktop: boolean): DesktopRunTool[] {
  return desktop ? RUN_TOOLS : [];
}

/** Whether `name` is one of the run tools. */
export function isDesktopRunTool(name: unknown): name is string {
  return typeof name === 'string' && RUN_TOOL_NAMES.has(name);
}

/** What the agent reads when the runs' hub never started: a tool result, as every refusal of these tools is. */
function refusal(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, message }) }], isError: true };
}

/** Runs a run tool, its wait ending as `signal` aborts (the client left). */
export async function callDesktopRunTool(name: string, args: unknown, signal: AbortSignal): Promise<ToolResult> {
  const runs = process.env.PIWI_DESKTOP_TOKEN ? await desktopRuns() : null;
  if (!runs) return refusal('These tools serve the runs the Piwi desktop app starts, in the desktop app alone.');
  return runs.agent.call(name, args, signal);
}
