/**
 * The assistant's `get_instance_config` tool: how this instance is set up, in
 * the facts the dashboard already shows a signed-in user (capability states,
 * the AI roles' providers and models, the connected trackers, authentication,
 * the surface and the version). Never an API key. How the instance is deployed
 * (storage, run retention) is shown to administrators only, as `describe_piwi`
 * does.
 */
import { resolveInstanceStates } from '#shared/handlers/setup-status';
import type { DbClient } from '../../database';
import { resolveAiConfig } from '../ai-provider';
import { AI_ROLES } from '../ai-settings';
import { listTrackerConnections } from '../integrations/connections';
import { adminFacts, capabilitiesByState, instanceFacts } from '../mcp/about-piwi';
import { dropNulls } from '../mcp/json';
import type { McpContext } from '../mcp/tools';

export async function getInstanceConfig(db: DbClient, ctx: McpContext): Promise<unknown> {
  const facts = instanceFacts(ctx);
  const admin = facts.admin ? await adminFacts(db) : null;
  const [states, ai, trackers] = await Promise.all([
    admin ? admin.states : resolveInstanceStates(db),
    resolveAiConfig(db),
    listTrackerConnections(db),
  ]);
  const roles = ai
    ? Object.fromEntries(
        AI_ROLES.map((role) => {
          const resolved = ai.roles[role];
          return [role, resolved ? dropNulls({ provider: resolved.provider, model: resolved.model || null }) : null];
        }),
      )
    : null;
  return dropNulls({
    version: facts.version,
    surface: facts.surface,
    database: facts.database,
    authentication: facts.authentication,
    capabilities: capabilitiesByState(states),
    ai: ai
      ? dropNulls({
          roles,
          assistant: ai.roles.assistant ? null : 'uses the diagnosis model',
          autoDiagnose: ai.autoDiagnose,
          configuredFrom: ai.source === 'env' ? 'environment variables' : 'Settings → AI',
        })
      : 'not configured',
    issueTrackers: trackers.map((t) => ({ provider: t.provider, name: t.name })),
    ...(admin
      ? { storage: admin.storage, retention: admin.retention }
      : { note: 'How this instance is deployed (storage, retention) is shown to administrators only.' }),
  });
}
