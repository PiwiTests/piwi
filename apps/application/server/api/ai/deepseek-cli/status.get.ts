import { requireAuth } from '../../../utils/auth';
import { getDeepseekCliStatus } from '../../../utils/ai-deepseek-cli';

defineRouteMeta({
  openAPI: {
    tags: ['AI'],
    summary: 'Official DeepSeek Harness CLI status',
    description:
      'Reports the official dsh CLI version, isolated profile compatibility, local DeepSeek credential presence and usage. Stored credentials are checked for presence; remote validity is checked on use. Requires settings:manage.',
    'x-required-permission': 'settings:manage',
  },
});
export default eventHandler(async (event) => {
  await requireAuth(event);
  return getDeepseekCliStatus();
});
