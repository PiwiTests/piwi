/**
 * The agents' write log: `logMcpToolCall` writes one `mcp_tool_calls` row per
 * subject of a write tool's call (the API key, the tool, what it acted on and
 * the result); read tools are never logged. Nothing is written when the
 * instance declined the `agent-write-log` capability, and a failure to log
 * never fails the call. `pruneMcpToolCalls` keeps the log on the notification
 * outbox's horizon.
 */
import { lt } from 'drizzle-orm';
import { mcpToolCalls } from '../../database/schema';
import { getInstanceDecisions } from '#shared/handlers/setup-status';
import { getSuggestionProjectId } from '#shared/handlers/cluster-merge-suggestions';
import {
  isMcpWriteTool,
  mcpCallProjectId,
  mcpCallSubjects,
  type McpCallSubject,
  type McpCallSubjectType,
} from '#shared/mcp-write-log';
import {
  resolveBugReportProjectId,
  resolveClusterProjectId,
  resolveDiagnosisProjectId,
  resolveRunProjectId,
  resolveCaseProjectId,
  resolveTestRunCaseProjectId,
} from '../project-access';
import type { DbClient } from '../../database';
import type { McpContext } from './tools';

/** How a call ended: done, refused or failed (`error`), or about something that does not exist. */
export type McpCallResult = 'ok' | 'error' | 'not-found';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const PROJECT_OF: Partial<
  Record<McpCallSubjectType, (db: DbClient, id: number, viewerId: number | null) => Promise<number | null>>
> = {
  cluster: resolveClusterProjectId,
  execution: resolveTestRunCaseProjectId,
  'bug-report': resolveBugReportProjectId,
  run: resolveRunProjectId,
  'test-case': resolveCaseProjectId,
  diagnosis: resolveDiagnosisProjectId,
  suggestion: getSuggestionProjectId,
};

async function subjectProjectId(db: DbClient, subject: McpCallSubject | null): Promise<number | null> {
  const resolve = subject ? PROJECT_OF[subject.type] : undefined;
  return resolve ? await resolve(db, subject!.id, null).catch(() => null) : null;
}

/** Whether the instance keeps the agents' write log. */
export async function writeLogEnabled(db: DbClient): Promise<boolean> {
  return (await getInstanceDecisions(db))['agent-write-log'] !== 'declined';
}

/**
 * Log one call of a write tool, with what it answered (`output`) when it did.
 * Read tools, and every call on an instance that declined the log, write nothing.
 */
export async function logMcpToolCall(
  db: DbClient,
  ctx: McpContext,
  tool: string,
  args: Record<string, unknown>,
  result: McpCallResult,
  error?: string | null,
  output?: unknown,
): Promise<number> {
  if (!isMcpWriteTool(tool)) return 0;
  try {
    if (!(await writeLogEnabled(db))) return 0;
    const subjects: Array<McpCallSubject | null> = mcpCallSubjects(tool, args, output);
    if (subjects.length === 0) subjects.push(null);
    const named = mcpCallProjectId(args);
    const at = new Date();
    const rows = [];
    for (const subject of subjects) {
      rows.push({
        projectId: (await subjectProjectId(db, subject)) ?? named,
        apiKeyId: ctx.apiKeyId ?? null,
        // With authentication off the request carries a synthetic user whose id is 0, which no row has.
        userId: ctx.user?.id ? ctx.user.id : null,
        tool,
        subjectType: subject?.type ?? null,
        subjectId: subject?.id ?? null,
        result,
        error: error ? error.slice(0, 400) : null,
        createdAt: at,
      });
    }
    await db.insert(mcpToolCalls).values(rows);
    return rows.length;
  } catch (e) {
    console.error('[mcp] write log failed', e);
    return 0;
  }
}

/** Delete logged calls older than the cutoff. Returns how many. */
export async function pruneMcpToolCalls(db: DbClient, olderThanDays: number, now = Date.now()): Promise<number> {
  const old = lt(mcpToolCalls.createdAt, new Date(now - olderThanDays * MS_PER_DAY));
  const pruned = await db.delete(mcpToolCalls).where(old).returning({ id: mcpToolCalls.id });
  return pruned.length;
}
