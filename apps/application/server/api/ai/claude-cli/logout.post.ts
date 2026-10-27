import { requireAuth } from '../../../utils/auth';
import { claudeCliEnabled, runClaudeLogout } from '../../../utils/ai-claude-cli';

defineRouteMeta({
  openAPI: {
    tags: ['AI'],
    summary: 'Sign out of the local Claude CLI',
    description: 'Runs `claude auth logout`. Desktop app only. Requires `settings:manage` (administrators only).',
    'x-required-permission': 'settings:manage',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);

  if (!claudeCliEnabled()) {
    throw apiError({
      statusCode: 400,
      message:
        'The local Claude CLI is only available in the Piwi desktop app, or on a server with PIWI_CLAUDE_CLI_PATH set',
    });
  }

  const result = await runClaudeLogout();
  if (!result.success) {
    throw apiError({ statusCode: 500, message: result.error || 'Sign-out failed' });
  }
  return { success: true };
});
