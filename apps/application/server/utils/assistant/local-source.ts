/**
 * `read_local_source` as the assistant offers it on the desktop app: the
 * desktop tool's own handler, held to the folder linked to a project the user
 * reads (`desktopLinkedFolder`). The model names the project and the file's
 * path in its folder, as the tools' `filePath` fields give it, or an absolute
 * path inside the folder; a path that leaves the folder, through `..` or a
 * symbolic link, is refused. The desktop tools that write, `apply_locator_fix`
 * and `import_local_report`, are never offered.
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { DESKTOP_MCP_TOOL_DEFS } from '#shared/mcp-tools';
import { desktopLinkedFolder } from '../desktop-links';
import { DESKTOP_MCP_TOOLS, type McpTool } from '../mcp/tools';
import { scopeAllows } from '../project-access';

const NAME = 'read_local_source';

const definition = DESKTOP_MCP_TOOL_DEFS.find((t) => t.name === NAME)!;
const desktopHandler = DESKTOP_MCP_TOOLS.find((t) => t.name === NAME)!.handler;

/** `path` resolved inside `folder`, through any symbolic link, or why it is refused. */
export async function resolveInsideFolder(folder: string, path: string): Promise<string> {
  const root = await realpath(folder).catch(() => null);
  if (!root) throw new Error(`the linked folder ${folder} is not on this machine`);
  const target = await realpath(isAbsolute(path) ? path : resolve(root, path)).catch(() => null);
  if (!target) throw new Error(`file not found in the linked folder: ${path}`);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${path} is outside the folder linked to the project`);
  }
  return target;
}

export const ASSISTANT_LOCAL_SOURCE_TOOL: McpTool = {
  name: NAME,
  module: definition.module,
  description:
    "Desktop app only. Read a source file as it is now on this machine, in the folder linked to a project: the current code, not the snippet Piwi captured at failure time. Pass the project and the file's path in its folder (the filePath tool results give), and a line to read a window around it (default ±40 lines); omit the line to read the whole file (up to ~256 KB). Returns the path, the 1-based line range and the text.",
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'number', description: 'The project whose linked folder holds the file' },
      path: { type: 'string', description: "The file's path in the project's folder, or an absolute path inside it" },
      line: { type: 'number', description: '1-based line to center the window on (omit to read the whole file)' },
      contextLines: { type: 'number', description: 'Lines of context on each side of `line` (default 40, max 500)' },
    },
    required: ['projectId', 'path'],
  },
  async handler(db, params, ctx) {
    const projectId = Number(params.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) throw new Error('projectId must be a project id');
    if (!scopeAllows(ctx.scope, projectId)) throw new Error(`No access to project ${projectId}`);
    const folder = desktopLinkedFolder(projectId);
    if (!folder) {
      throw new Error(
        `project ${projectId} has no folder linked on this machine (the user links one in project settings)`,
      );
    }
    const path = await resolveInsideFolder(folder, String(params.path ?? ''));
    return desktopHandler(db, { path, line: params.line, contextLines: params.contextLines }, ctx);
  },
};
