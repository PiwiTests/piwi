import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import { readAiSettings } from '../../utils/ai-settings';

defineRouteMeta({
  openAPI: {
    tags: ['Settings'],
    summary: 'Get AI settings',
    description:
      'Returns full AI configuration: per-role provider settings (diagnosis, research, embedding, assistant), API key presence, auto-diagnose toggle, custom instructions, and SCM token presence. `canStoreSecrets` is false when `PIWI_SECRET_KEY` is unset, in which case an API key or SCM token cannot be saved. `claudeCliAvailable` is true when the server may run the local Claude Code CLI: the desktop app, or `PIWI_CLAUDE_CLI_PATH` set. Requires `settings:manage` (administrators only).',
    'x-required-permission': 'settings:manage',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const db = await getDatabase();
  return readAiSettings(db);
});
