import { requireAuth } from '../../../utils/auth';
import { getClaudeCliStatus } from '../../../utils/ai-claude-cli';
import { queryFlag } from '../../../utils/query-params';

defineRouteMeta({
  openAPI: {
    tags: ['AI'],
    summary: 'Local Claude CLI status',
    description:
      'Reports whether the local `claude` CLI (Claude Code) is installed, its version, whether it is signed in and how, and the running usage tally. `error` explains why it cannot run, including a Claude subscription sign-in outside the desktop app (a server needs an API key or a cloud provider). Pass `?refresh=true` to bypass the short status cache. Requires `settings:manage` (administrators only).',
    parameters: [{ name: 'refresh', in: 'query', required: false, schema: { type: 'boolean' } }],
    'x-required-permission': 'settings:manage',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  return getClaudeCliStatus({ force: queryFlag(event, 'refresh') });
});
