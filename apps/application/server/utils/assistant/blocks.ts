/**
 * The block tools the assistant offers a model, one per kind of block of an
 * answer besides text, and `find_anchors`, which its guides are built from.
 * A block tool's call is checked before anything reaches the browser: its
 * shape and limits (`shared/assistant-blocks.ts`), then what needs the
 * instance: a guide's anchors and routes, a page's route, a patch's
 * validation at its run's commit. A call that fails is answered with why,
 * so the model can fix it once.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AssistantPageContext } from '#shared/assistant';
import {
  ASSISTANT_BLOCK_INPUTS,
  blockGuides,
  checkAssistantBlock,
  type AssistantBlockTool,
  type AssistantToolBlock,
} from '#shared/assistant-blocks';
import { parseUnifiedDiff } from '#shared/patch';
import type { DbClient } from '../../database';
import { failureClusters, testRunsCases } from '../../database/schema';
import type { AiToolDef } from '../ai-tool-calls';
import type { McpContext } from '../mcp/tools';
import {
  resolveClusterProjectId,
  resolveRunProjectId,
  resolveTestRunCaseProjectId,
  scopeAllows,
} from '../project-access';
import { validatePatchAtRun } from '../run-sources';
import type { AssistantEntitySet } from './entities';
import { checkGuidePlan, checkNavigateRoute, checkRouteEntities, type AnchorFacts, type GuideCheckEnv } from './guides';

const BLOCK_TOOL_DESCRIPTIONS: Record<AssistantBlockTool, string> = {
  show_code:
    'Show a snippet with a copy button: a config file, a test, a fixture. For a shell command use show_command instead.',
  show_command:
    'Show a shell command with a copy button: its bash form and, whenever it differs (environment variables, paths, quoting, line continuations), its Windows PowerShell form, so it works for every user.',
  show_patch:
    'Show a unified diff that fixes a failure. It is checked against the files at the commit of the run, execution or failure cluster it fixes, which must be one a tool result of this conversation named.',
  show_entity:
    'Show a run, execution, failure cluster, test or project as a card with its status, from the tool result that named it. Only an entity a tool result of this conversation named.',
  offer_options:
    'Offer two to four ways to solve the problem, each with a one-line summary, its trade-off and its effort, at most one recommended; an option can carry the guide picking it plays. Ends your answer: the user picks one, and the pick comes back with their next message.',
  ask: 'Ask the user to choose, with radio buttons (one answer) or checkboxes (several), and an optional "Other" field: among entities from tool results ("which of these tests…", each choice an entity) or among setup options ("which CI provider"). Ends your answer: the picks come back with their next message.',
  checklist:
    'Show the steps of a multi-step setup, in order, for the user to tick as they go. A step can carry its shell command (bash and PowerShell) and a guide to where in the dashboard it is done.',
  show_guide:
    "Show me: a walkthrough on the dashboard's real screens, each stop an anchor find_anchors returned, with a short title and body. For 'where is…' and 'how do I … in the dashboard'.",
  navigate:
    "Offer a link that opens a page of the dashboard: a route from the app's root with real ids from tool results.",
};

/** A zod schema as a tool's input schema: JSON Schema of what the model sends, without the `$schema` line. */
function inputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export const BLOCK_TOOL_DEFS: readonly AiToolDef[] = (Object.keys(BLOCK_TOOL_DESCRIPTIONS) as AssistantBlockTool[]).map(
  (name) => ({
    name,
    description: BLOCK_TOOL_DESCRIPTIONS[name],
    inputSchema: inputSchema(ASSISTANT_BLOCK_INPUTS[name]),
  }),
);

export const FIND_ANCHORS: AiToolDef = {
  name: 'find_anchors',
  description:
    "Search the dashboard's guide anchors, everything a guide (show_guide) can point at: pages, tabs, sections, settings fields, primary actions and sidebar links. Returns the ones this user can see, each with its id, the pages it renders on (the first is its main page), what it shows, when it shows, whether it is on the user's current page, and whether a stop at it needs a route with a real id.",
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'What to point at, in a few words (e.g. "flaky tests tab")' } },
    required: ['query'],
  },
};

/** What a block tool's checks read beyond its arguments. */
interface BlockToolEnv {
  db: DbClient;
  ctx: McpContext;
  context: AssistantPageContext | null;
  entities: AssistantEntitySet;
  /** The ids of the blocks this answer already sent. */
  usedIds: ReadonlySet<string>;
  /** The capability states and access anchors are checked against, loaded once per answer. */
  anchorFacts: () => Promise<AnchorFacts>;
}

/** The run whose commit a patch's files are read at, for its target; null when the target is missing or unreadable. */
async function patchRun(
  db: DbClient,
  ctx: McpContext,
  target: { type: 'run' | 'execution' | 'cluster'; id: number },
): Promise<number | null> {
  const resolve = {
    run: resolveRunProjectId,
    execution: resolveTestRunCaseProjectId,
    cluster: resolveClusterProjectId,
  }[target.type];
  const projectId = await resolve(db, target.id);
  if (projectId === null || !scopeAllows(ctx.scope, projectId)) return null;
  if (target.type === 'run') return target.id;
  if (target.type === 'execution') {
    const [row] = await db
      .select({ runId: testRunsCases.testRunId })
      .from(testRunsCases)
      .where(eq(testRunsCases.id, target.id));
    return row?.runId ?? null;
  }
  const [row] = await db
    .select({ runId: failureClusters.lastSeenRunId })
    .from(failureClusters)
    .where(eq(failureClusters.id, target.id));
  return row?.runId ?? null;
}

/** Run one block tool: the checked block, or why it was refused. */
export async function runBlockTool(
  tool: AssistantBlockTool,
  args: Record<string, unknown>,
  env: BlockToolEnv,
): Promise<{ block: AssistantToolBlock } | { error: string }> {
  const checked = checkAssistantBlock(tool, args, {
    entity: (type, id) => {
      const found = env.entities.get(type, id);
      return found ? { type: found.type, id: found.id, label: found.label } : undefined;
    },
    usedIds: env.usedIds,
  });
  if (!checked.ok) return { error: checked.error };
  let block = checked.block;
  if (block.kind === 'entity') {
    // The card's status is the one the tool result gave, never the model's.
    const status = env.entities.get(block.entity.type, block.entity.id)?.status;
    if (status) block = { ...block, status };
  }

  const guides = blockGuides(block);
  if (guides.length > 0 || block.kind === 'navigate') {
    const guideEnv: GuideCheckEnv = {
      facts: await env.anchorFacts(),
      context: env.context,
      checkRoute: (route) => checkRouteEntities(env.db, env.ctx, route),
    };
    for (const { where, guide } of guides) {
      const problem = await checkGuidePlan(guide, guideEnv, where);
      if (problem) return { error: problem };
    }
    if (block.kind === 'navigate') {
      const problem = await checkNavigateRoute(block.route, guideEnv);
      if (problem) return { error: problem };
    }
  }

  if (block.kind === 'patch') {
    if (parseUnifiedDiff(block.patch).files.length === 0) {
      return { error: 'patch: not a unified diff (--- a/<path>, +++ b/<path>, then @@ hunks)' };
    }
    const target = ASSISTANT_BLOCK_INPUTS.show_patch.parse(args).target;
    const runId = await patchRun(env.db, env.ctx, target);
    if (runId === null) return { error: `target: ${target.type} ${target.id} is missing or not readable by the user` };
    block = { ...block, validation: await validatePatchAtRun(env.db, runId, block.patch) };
  }

  return { block };
}
