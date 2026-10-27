import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import {
  assistantAllowanceStatus,
  assistantAvailability,
  assistantOwnerOf,
  assistantSubscriptionLimit,
} from '../../utils/assistant/turn';
import type { AssistantStatus } from '#shared/assistant';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: 'Assistant status',
    description:
      'Whether the in-app assistant can answer on this instance (`available`), and why not (`reason`: `not-configured` when no AI provider is set, `declined` when the `assistant` capability or AI is declined). With it available, the provider and model of the assistant role (the diagnosis role when the assistant role is unset), and `toolMode`: `native` when the model calls tools natively (Anthropic, an OpenAI-compatible model that does, and the Claude Code CLI when the installed CLI can run the answer itself with the tools of the assistant attached), `json-action` when it answers one JSON object per reply, null until an OpenAI-compatible model has answered once. `allowance` is what the daily token caps leave the caller over the last 24 hours, the cap that binds first (`{ scope, limit, used, freesAt }`, `scope` `user` for `PIWI_AI_ASSISTANT_DAILY_TOKENS_PER_USER` or `instance` for `PIWI_AI_ASSISTANT_DAILY_TOKENS`, `freesAt` when the oldest answer it counts passes 24 hours), null when no cap is set. `subscription` is the usage limit of the Claude subscription as the Claude Code CLI last reported it (`{ status, window, utilization, resetsAt, reportedAt }`, `status` one of `allowed`, `allowed_warning`, `rejected`), with the CLI as the provider, else null.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event): Promise<AssistantStatus> => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  const { status, role } = await assistantAvailability(db);
  if (!status.available) return { ...status, allowance: null, subscription: null };
  return {
    ...status,
    allowance: await assistantAllowanceStatus(db, assistantOwnerOf(event, user)),
    subscription: assistantSubscriptionLimit(role),
  };
});
