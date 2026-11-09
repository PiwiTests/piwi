/**
 * Reads and writes for capability decisions, and the resolved state each
 * surface renders from.
 *
 * Instance decisions live in `app_settings` under the `capabilities` key,
 * shaped `{ decisions }`; project decisions live in the `projects.capabilities`
 * JSON column. The resolver in `#shared/capabilities` turns evidence and those
 * decisions into a single state per capability. Server and demo both import
 * this module so the two stay in step.
 */
import { eq } from 'drizzle-orm';
import { projects } from '../../server/database/schema';
import { setAppSetting } from '../../server/utils/app-settings';
import { resolveServerProbeSettings } from '#shared/server-probes';
import {
  CAPABILITIES,
  CAPABILITIES_SETTING_KEY,
  applyDecisionPatch,
  parseProjectDecisions,
  resolveCapabilities,
  type CapabilityFacts,
  type CapabilityId,
  type CapabilityModule,
  type CapabilityState,
  type InstanceDecision,
  type ProjectDecision,
} from '#shared/capabilities';
import { getCapabilityEvidence, getInstanceDecisions, resolveInstanceStates } from './setup-status';

import type { DrizzleDB } from './db';

export interface CapabilityStateItem {
  id: CapabilityId;
  module: CapabilityModule;
  state: CapabilityState;
}

export interface CapabilityStates {
  items: CapabilityStateItem[];
}

function toItems(states: Record<CapabilityId, CapabilityState>): CapabilityStateItem[] {
  return CAPABILITIES.map((c) => ({ id: c.id, module: c.module, state: states[c.id] }));
}

/** The resolved instance state for every capability. */
export async function getInstanceCapabilities(db: DrizzleDB): Promise<CapabilityStates> {
  return { items: toItems(await resolveInstanceStates(db)) };
}

/** Read and validate one project's stored decisions. */
async function getProjectDecisions(
  db: DrizzleDB,
  projectId: number,
): Promise<Partial<Record<CapabilityId, ProjectDecision>>> {
  const rows = await db
    .select({ capabilities: projects.capabilities })
    .from(projects)
    .where(eq(projects.id, projectId));
  return parseProjectDecisions(rows[0]?.capabilities ?? null);
}

/**
 * The resolved state for every capability in one project's context: the
 * project's evidence and decision over the instance's decision. Instance-only
 * capabilities carry no project override, so their project state follows the
 * instance decision.
 */
export async function resolveProjectStates(
  db: DrizzleDB,
  projectId: number,
): Promise<Record<CapabilityId, CapabilityState>> {
  const [evidence, instanceDecisions, projectDecisions, projectRow] = await Promise.all([
    getCapabilityEvidence(db, projectId),
    getInstanceDecisions(db),
    getProjectDecisions(db, projectId),
    db
      .select({ serverProbes: projects.serverProbes })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0]),
  ]);

  // Server probes need a server trace to be applicable (same gate as backend
  // logs) and read as configured when the project's settings enable the level.
  const hasServerTrace = (evidence as Record<string, boolean>)['backend-logs'] ?? false;
  const serverProbesConfigured = resolveServerProbeSettings(projectRow?.serverProbes ?? null).enabled;

  const facts: Partial<Record<CapabilityId, CapabilityFacts>> = {};
  for (const def of CAPABILITIES) {
    const has = (evidence as Record<string, boolean>)[def.id] ?? false;
    facts[def.id] = {
      evidence: has,
      configured: def.id === 'mcp' ? true : def.id === 'server-probes' ? serverProbesConfigured : undefined,
      applicable: def.id === 'backend-logs' ? has : def.id === 'server-probes' ? hasServerTrace : true,
      projectDecision: def.levels.includes('project') ? projectDecisions[def.id] : undefined,
      instanceDecision: instanceDecisions[def.id],
    };
  }
  return resolveCapabilities(facts);
}

/**
 * True when a passive-data capability is declined for a project by decision
 * alone: the project declines it, or the instance does and the project does not
 * enable it. Evidence never overrides such a decline, so no evidence probe is
 * needed — two small reads.
 */
export async function isPassiveCapabilityDeclined(
  db: DrizzleDB,
  projectId: number,
  id: CapabilityId,
): Promise<boolean> {
  const [instanceDecisions, projectDecisions] = await Promise.all([
    getInstanceDecisions(db),
    getProjectDecisions(db, projectId),
  ]);
  if (projectDecisions[id] === 'declined') return true;
  return projectDecisions[id] !== 'enabled' && instanceDecisions[id] === 'declined';
}

/**
 * True when an opt-in capability is on for a project: the instance turned it on and the project did not decline it.
 * Neither data nor a project's `enabled` turns it on, so two small reads decide it. The server refuses the routes of
 * such a capability while this is false.
 */
export async function isOptInCapabilityOn(db: DrizzleDB, projectId: number, id: CapabilityId): Promise<boolean> {
  const [instanceDecisions, projectDecisions] = await Promise.all([
    getInstanceDecisions(db),
    getProjectDecisions(db, projectId),
  ]);
  return instanceDecisions[id] === 'enabled' && projectDecisions[id] !== 'declined';
}

/**
 * True when a capability is hidden in a project: its resolved state is declined
 * or not applicable, the rule the pages hide its sections by.
 */
export async function isCapabilityHidden(db: DrizzleDB, projectId: number, id: CapabilityId): Promise<boolean> {
  const state = (await resolveProjectStates(db, projectId))[id];
  return state === 'declined' || state === 'not-applicable';
}

/** The resolved project state for every capability. */
export async function getProjectCapabilities(db: DrizzleDB, projectId: number): Promise<CapabilityStates> {
  return { items: toItems(await resolveProjectStates(db, projectId)) };
}

/** Fold a decision patch onto the instance decisions and store the result. */
export async function setInstanceDecisions(
  db: DrizzleDB,
  decisions: Record<string, unknown>,
): Promise<Partial<Record<CapabilityId, InstanceDecision>>> {
  const next = applyDecisionPatch(await getInstanceDecisions(db), decisions, false);
  await setAppSetting(db, CAPABILITIES_SETTING_KEY, { decisions: next });
  return next;
}

/** Fold a decision patch onto one project's decisions and store the result. */
export async function setProjectDecisions(
  db: DrizzleDB,
  projectId: number,
  decisions: Record<string, unknown>,
): Promise<Partial<Record<CapabilityId, ProjectDecision>>> {
  const rows = await db
    .select({ capabilities: projects.capabilities })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!rows[0]) throw new Error('Project not found');

  const next = applyDecisionPatch(parseProjectDecisions(rows[0].capabilities ?? null), decisions, true);
  await db.update(projects).set({ capabilities: next, updatedAt: new Date() }).where(eq(projects.id, projectId));
  return next;
}
