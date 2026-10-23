import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import { assistantAvailability } from '../../utils/assistant/turn';
import type { AssistantStatus } from '#shared/assistant';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: 'Assistant status',
    description:
      'Whether the in-app assistant can answer on this instance (`available`), and why not (`reason`: `not-configured` when no AI provider is set, `declined` when the `assistant` capability or AI is declined). With it available, the provider and model of the assistant role (the diagnosis role when the assistant role is unset), and `toolMode`: `native` when the model calls tools natively (Anthropic, an OpenAI-compatible model that does, and the Claude Code CLI when the installed CLI can run the answer itself with the tools of the assistant attached), `json-action` when it answers one JSON object per reply, null until an OpenAI-compatible model has answered once.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event): Promise<AssistantStatus> => {
  await requireAuth(event);
  return (await assistantAvailability(await getDatabase())).status;
});
