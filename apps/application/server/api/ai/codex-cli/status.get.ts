import { requireAuth } from '../../../utils/auth';
import { getCodexCliStatus } from '../../../utils/ai-codex-cli';
import { queryFlag } from '../../../utils/query-params';

defineRouteMeta({
  openAPI: {
    tags: ['AI'],
    summary: 'Local Codex CLI status',
    description:
      'Reports local Codex availability, version, ChatGPT login status and usage since server startup. Pass refresh=true to recheck. Requires settings:manage.',
    'x-required-permission': 'settings:manage',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  return getCodexCliStatus({ force: queryFlag(event, 'refresh') });
});
