/**
 * The tools a caller is offered, the one filtering `/mcp` and the assistant
 * both apply: the catalog of this surface (the shared tools, plus the
 * desktop-only ones on the desktop app), less the tools of a declined
 * capability and the ones whose permission the caller holds on no project.
 */
import type { H3Event } from 'h3';
import type { AccessSummary } from '#shared/permissions';
import { getRequestAccess } from '../auth';
import { getProjectScope } from '../project-access';
import type { DbClient } from '../../database';
import type { User } from '../../database/schema';
import { narrowToolsByAccess } from './filter';
import { serveableTools } from './served';
import { DESKTOP_MCP_TOOLS, MCP_TOOLS, type McpContext, type McpTool } from './tools';

/** Every tool of a surface: the shared catalog, plus the desktop-only tools when `desktop`. */
export function mcpCatalog(desktop: boolean): McpTool[] {
  return desktop ? [...MCP_TOOLS, ...DESKTOP_MCP_TOOLS] : MCP_TOOLS;
}

/** The tools of a surface this instance serves and the caller can use on at least one project. */
export async function toolsForCaller(
  db: DbClient,
  access: AccessSummary,
  options: { desktop: boolean },
): Promise<McpTool[]> {
  return narrowToolsByAccess(await serveableTools(db, mcpCatalog(options.desktop)), access);
}

/**
 * The tool context of a request: the caller, their access and the projects
 * they read, loaded once. Every tool honors the scope and every write tool
 * checks its permission on the project it acts on, so a tool reads and does
 * no more than the caller can in the dashboard.
 */
export async function requestMcpContext(event: H3Event, db: DbClient, user: User): Promise<McpContext> {
  const access = await getRequestAccess(event);
  const scope = await getProjectScope(db, user);
  return { user, access, scope, apiKeyId: (event.context.apiKeyId as number | undefined) ?? null };
}
