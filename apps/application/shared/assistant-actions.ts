/**
 * The changes the assistant can propose, each a button the dashboard already
 * has: a closed list of actions, each calling one existing REST route. The
 * model only proposes (`propose_change`); the card in the panel calls the
 * route from the browser with the user's own session when they click
 * **Apply**, so the route's permission and the cross-site rules apply as for
 * any click.
 *
 * Each action names its route as its file under `server/api` names it, the
 * method, and the permission that route declares in `x-required-permission`
 * (`tests/unit/assistant-actions.test.ts` reads both from the route's file);
 * the kind of entity it changes, none for an instance-wide change; the schema
 * of its parameters; and the pure builders of the path and body it sends.
 */
import { z } from 'zod';
import { CAPABILITIES, type CapabilityId } from '#shared/capabilities';
import type { AssistantEntityType } from '#shared/assistant';
import type { Permission } from '#shared/permissions';

export const ASSISTANT_ACTION_IDS = [
  'resolve-cluster',
  'ignore-cluster',
  'reopen-cluster',
  'quarantine-test',
  'release-test',
  'diagnose-cluster',
  'diagnose-execution',
  'keep-run',
  'decide-capability',
  'decide-project-capability',
] as const;

export type AssistantActionId = (typeof ASSISTANT_ACTION_IDS)[number];

/** What an action's path and body are built from: the target's id, its project and the parameters. */
export interface AssistantActionCall<P = Record<string, unknown>> {
  /** The id of the entity it changes; null for an instance-wide change. */
  targetId: number | null;
  /** The project of that entity; null for an instance-wide change. */
  projectId: number | null;
  params: P;
}

export interface AssistantAction<P = Record<string, unknown>> {
  id: AssistantActionId;
  /** What it does, in a few words, shown on the card above its title. */
  label: string;
  /** For the model: what it does and when to propose it. */
  description: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  /** The route as its file under `server/api` names it: `/api/failure-clusters/[id]/status`. */
  route: string;
  /** The permission the route declares; held on the target's project, or on the instance when there is no target. */
  permission: Permission;
  /** The kind of entity it changes; null for an instance-wide change. */
  target: AssistantEntityType | null;
  /** The capability it belongs to: not offered while the instance declines it. */
  capability?: CapabilityId;
  params: z.ZodType<P>;
  /** The path it calls, from the app's root, with the query it needs. */
  path: (call: AssistantActionCall<P>) => string;
  /** The JSON body it sends; undefined sends none. */
  body: (call: AssistantActionCall<P>) => Record<string, unknown> | undefined;
}

const note = z.string().trim().max(500).optional();

const noteParams = z.object({
  note: note.describe('A triage note saved with the status; omitted keeps the current one'),
});
const reasonParams = z.object({ reason: note.describe('Why, in one line; kept with the change') });
const forceParams = z.object({
  force: z.boolean().optional().describe('Run it again even when a completed diagnosis exists'),
});

/** Capabilities the instance can decline; the AI and the assistant are left out, since the assistant rides on them. */
const INSTANCE_CAPABILITIES = CAPABILITIES.filter(
  (c) => c.levels.includes('instance') && c.id !== 'ai' && c.id !== 'assistant',
).map((c) => c.id) as [CapabilityId, ...CapabilityId[]];
const PROJECT_CAPABILITIES = CAPABILITIES.filter((c) => c.levels.includes('project')).map((c) => c.id) as [
  CapabilityId,
  ...CapabilityId[],
];

type Params<T extends z.ZodType> = z.infer<T>;

function clusterStatus(
  id: AssistantActionId,
  status: 'resolved' | 'ignored' | 'open',
  label: string,
  description: string,
): AssistantAction<Params<typeof noteParams>> {
  return {
    id,
    label,
    description,
    method: 'PATCH',
    route: '/api/failure-clusters/[id]/status',
    permission: 'triage:write',
    target: 'cluster',
    params: noteParams,
    path: ({ targetId }) => `/api/failure-clusters/${targetId}/status`,
    body: ({ params }) => ({ status, ...(params.note !== undefined ? { triageNote: params.note } : {}) }),
  };
}

const diagnosePath = (base: string, call: AssistantActionCall<Params<typeof forceParams>>) =>
  `${base}/${call.targetId}/diagnose${call.params.force ? '?force=true' : ''}`;

/** Every action, by id. */
export const ASSISTANT_ACTIONS: { readonly [K in AssistantActionId]: AssistantAction<any> } = {
  'resolve-cluster': clusterStatus(
    'resolve-cluster',
    'resolved',
    'Resolve a failure cluster',
    'Mark a failure cluster resolved, once its fix is in; a failure after a recorded fix sets it back to open.',
  ),
  'ignore-cluster': clusterStatus(
    'ignore-cluster',
    'ignored',
    'Ignore a failure cluster',
    'Mark a failure cluster ignored: a failure the team accepts, whose status the fix verdicts never change.',
  ),
  'reopen-cluster': clusterStatus(
    'reopen-cluster',
    'open',
    'Reopen a failure cluster',
    'Set a resolved or ignored failure cluster back to open.',
  ),
  'quarantine-test': {
    id: 'quarantine-test',
    label: 'Quarantine a test',
    description:
      'Quarantine a test: it keeps running and reporting, and stops failing the CI gate until it is released.',
    method: 'POST',
    route: '/api/projects/[id]/quarantine',
    permission: 'quarantine:write',
    target: 'test-case',
    capability: 'quarantine',
    params: reasonParams,
    path: ({ projectId }) => `/api/projects/${projectId}/quarantine`,
    body: ({ targetId, params }) => ({ testCaseId: targetId, ...(params.reason ? { reason: params.reason } : {}) }),
  },
  'release-test': {
    id: 'release-test',
    label: 'Release a test from quarantine',
    description: 'Release a quarantined test, so its failures fail the CI gate again.',
    method: 'DELETE',
    route: '/api/projects/[id]/quarantine/[testCaseId]',
    permission: 'quarantine:write',
    target: 'test-case',
    capability: 'quarantine',
    params: reasonParams,
    path: ({ projectId, targetId }) => `/api/projects/${projectId}/quarantine/${targetId}`,
    body: ({ params }) => (params.reason ? { reason: params.reason } : undefined),
  },
  'diagnose-cluster': {
    id: 'diagnose-cluster',
    label: 'Diagnose a failure cluster',
    description: "Run the AI diagnosis of a failure cluster with the diagnosis model; it spends that model's tokens.",
    method: 'POST',
    route: '/api/failure-clusters/[id]/diagnose',
    permission: 'ai:run',
    target: 'cluster',
    capability: 'ai',
    params: forceParams,
    path: (call) => diagnosePath('/api/failure-clusters', call),
    body: () => undefined,
  },
  'diagnose-execution': {
    id: 'diagnose-execution',
    label: 'Diagnose an execution',
    description:
      "Run the AI diagnosis of one failed execution with the diagnosis model; it spends that model's tokens.",
    method: 'POST',
    route: '/api/test-run-cases/[id]/diagnose',
    permission: 'ai:run',
    target: 'execution',
    capability: 'ai',
    params: forceParams,
    path: (call) => diagnosePath('/api/test-run-cases', call),
    body: () => undefined,
  },
  'keep-run': {
    id: 'keep-run',
    label: 'Keep a run',
    description: 'Keep a run forever: retention and the cleanup never delete it.',
    method: 'PATCH',
    route: '/api/test-runs/[id]',
    permission: 'project:read',
    target: 'run',
    params: z.object({ reason: z.string().trim().max(200).optional().describe('Why the run is kept') }),
    path: ({ targetId }) => `/api/test-runs/${targetId}`,
    body: ({ params }) => ({ keep: true, ...(params.reason ? { keepReason: params.reason } : {}) }),
  },
  'decide-capability': {
    id: 'decide-capability',
    label: 'Decide a capability',
    description:
      'Decline an optional capability for the whole instance (its pages and nudges go), or reconsider a declined one, as on the Setup page.',
    method: 'PATCH',
    route: '/api/capabilities',
    permission: 'settings:manage',
    target: null,
    params: z.object({
      capability: z.enum(INSTANCE_CAPABILITIES),
      decision: z.enum(['declined', 'reconsider']).describe('reconsider clears a stored decline'),
    }),
    path: () => '/api/capabilities',
    body: ({ params }) => ({ decisions: { [params.capability]: params.decision === 'declined' ? 'declined' : null } }),
  },
  'decide-project-capability': {
    id: 'decide-project-capability',
    label: 'Decide a capability for a project',
    description:
      "Decline or enable an optional capability for one project, overriding the instance's decision, or go back to it (default).",
    method: 'PATCH',
    route: '/api/projects/[id]/capabilities',
    permission: 'project:manage',
    target: 'project',
    params: z.object({
      capability: z.enum(PROJECT_CAPABILITIES),
      decision: z.enum(['declined', 'enabled', 'default']).describe("default follows the instance's decision"),
    }),
    path: ({ targetId }) => `/api/projects/${targetId}/capabilities`,
    body: ({ params }) => ({
      decisions: { [params.capability]: params.decision === 'default' ? null : params.decision },
    }),
  },
};

export function isAssistantActionId(value: unknown): value is AssistantActionId {
  return typeof value === 'string' && (ASSISTANT_ACTION_IDS as readonly string[]).includes(value);
}

/** The request applying a proposal: its method, path and body, built by its action. */
export function assistantActionRequest(proposal: {
  action: AssistantActionId;
  target: { id: number } | null;
  projectId: number | null;
  params: Record<string, unknown>;
}): { method: AssistantAction['method']; path: string; body: Record<string, unknown> | undefined } {
  const action = ASSISTANT_ACTIONS[proposal.action];
  const call = { targetId: proposal.target?.id ?? null, projectId: proposal.projectId, params: proposal.params };
  return { method: action.method, path: action.path(call), body: action.body(call) };
}
