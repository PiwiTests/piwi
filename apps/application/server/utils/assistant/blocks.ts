/**
 * The block tools the assistant offers a model, one per kind of block of an
 * answer besides text, and `find_anchors`, which its guides are built from.
 * A block tool's call is checked before anything reaches the browser: its
 * shape and limits (`shared/assistant-blocks.ts`), then what needs the
 * instance: a guide's anchors and routes, a page's route, a patch's
 * validation at its run's commit, a proposal's permission on its target's
 * project. A call that fails is answered with why, so the model can fix it
 * once.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AssistantEntityType, AssistantPageContext } from '#shared/assistant';
import { ASSISTANT_ACTIONS, ASSISTANT_ACTION_IDS } from '#shared/assistant-actions';
import type { CapabilityState } from '#shared/capabilities';
import {
  ASSISTANT_BLOCK_INPUTS,
  blockGuides,
  checkAssistantBlock,
  type AssistantBlockTool,
  type AssistantToolBlock,
} from '#shared/assistant-blocks';
import { parseUnifiedDiff } from '#shared/patch';
import { can } from '#shared/permissions';
import type { DbClient } from '../../database';
import { failureClusters, testRunsCases } from '../../database/schema';
import type { AiToolDef } from '../ai-tool-calls';
import type { McpContext } from '../mcp/tools';
import {
  resolveCaseProjectId,
  resolveClusterProjectId,
  resolveRunProjectId,
  resolveTestRunCaseProjectId,
  scopeAllows,
} from '../project-access';
import { validatePatchAtRun } from '../run-sources';
import type { AssistantEntitySet } from './entities';
import {
  answerGuideCheckEnv,
  checkGuidePlan,
  checkNavigateRoute,
  projectExists,
  readProjectStates,
  type AnswerAnchorFacts,
} from './guides';

/** A zod schema's properties in one line for a tool description: `{ note?: string, decision: "a" | "b" }`. */
function paramsLine(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema, { io: 'input' }) as {
    properties?: Record<string, { type?: string; enum?: unknown[] }>;
    required?: string[];
  };
  const required = new Set(json.required ?? []);
  const fields = Object.entries(json.properties ?? {}).map(([name, field]) => {
    const type = field.enum ? field.enum.map((v) => JSON.stringify(v)).join(' | ') : (field.type ?? 'value');
    return `${name}${required.has(name) ? '' : '?'}: ${type}`;
  });
  return fields.length ? `{ ${fields.join(', ')} }` : '{}';
}

/** The actions `propose_change` offers, one line each, for its description. */
const ACTION_LINES = ASSISTANT_ACTION_IDS.map((id) => {
  const action = ASSISTANT_ACTIONS[id];
  const target = action.target ? `target: ${action.target}` : 'no target';
  return `- ${id} (${target}; params: ${paramsLine(action.params)}): ${action.description}`;
}).join('\n');

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
  propose_change: `Propose a change the user applies with a click: a card naming the action, its target and what changes, with Apply and Dismiss. Nothing changes until the user clicks Apply, and you never apply it yourself, so never say it is done. One card per target ("quarantine these three tests" is three cards). The target must be an entity a tool result of this conversation named, and the user must hold the action's permission on its project; a refusal says which permission is missing. The actions:\n${ACTION_LINES}`,
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
    "Search the dashboard's guide anchors, everything a guide (show_guide) can point at: pages, tabs, sections, settings fields, primary actions and sidebar links. Returns the ones this user can see, those on the user's page first, each with its id, the pages it renders on (the first is its main page), what it shows, when it shows, whether it is on the user's current page, and whether a stop at it needs a route with a real id.",
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
  anchorFacts: () => Promise<AnswerAnchorFacts>;
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

/** The project an entity a proposal targets belongs to; null when it is missing. */
const PROJECT_OF: Record<AssistantEntityType, (db: DbClient, id: number) => Promise<number | null>> = {
  project: projectExists,
  run: resolveRunProjectId,
  execution: resolveTestRunCaseProjectId,
  cluster: resolveClusterProjectId,
  'test-case': resolveCaseProjectId,
};

/** Whether a capability in this state is hidden: declined, or not applicable. */
function isHiddenState(state: CapabilityState): boolean {
  return state === 'declined' || state === 'not-applicable';
}

/**
 * Whether the user can apply a proposal here: its target readable, its
 * capability declined neither for the target's project nor, for an action
 * with no target, on the instance, and the action's permission held on the
 * target's project (on the instance for an action with no target). The
 * target's project, or why not.
 */
async function proposalProject(
  block: Extract<AssistantToolBlock, { kind: 'proposal' }>,
  env: BlockToolEnv,
): Promise<{ projectId: number | null } | { error: string }> {
  const action = ASSISTANT_ACTIONS[block.action];
  let projectId: number | null = null;
  if (block.target) {
    const { type, id } = block.target;
    projectId = await PROJECT_OF[type](env.db, id);
    if (projectId === null || !scopeAllows(env.ctx.scope, projectId)) {
      return { error: `target: ${type} ${id} is missing or not readable by the user` };
    }
  }
  if (action.capability) {
    const facts = await env.anchorFacts();
    const states = projectId === null ? facts.states : await readProjectStates(env.db, facts, projectId);
    const state = states[action.capability];
    if (isHiddenState(state)) {
      const where = isHiddenState(facts.states[action.capability]) ? 'on this instance' : `for project ${projectId}`;
      return { error: `action: ${block.action} needs the ${action.capability} capability, ${state} ${where}` };
    }
  }
  if (can(env.ctx.access, action.permission, projectId ?? undefined)) return { projectId };
  return {
    error: `action: ${block.action} needs the ${action.permission} permission${projectId === null ? '' : ` on project ${projectId}`}, which the user does not hold; do not propose it: say so, and that someone holding it can make the change`,
  };
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
    const guideEnv = await answerGuideCheckEnv(env.db, env.ctx, await env.anchorFacts(), env.context);
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

  if (block.kind === 'proposal') {
    const checked = await proposalProject(block, env);
    if ('error' in checked) return checked;
    block = { ...block, projectId: checked.projectId };
  }

  return { block };
}
