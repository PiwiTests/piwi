import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import { getPrFeedbackSettings } from '../../utils/scm/pr-feedback-settings';
import { DEFAULT_PR_FEEDBACK } from '#shared/pr-feedback';

defineRouteMeta({
  openAPI: {
    tags: ['Settings'],
    summary: 'Get pull-request feedback settings',
    description:
      'Returns the settings controlling the run summary Piwi posts back to a pull request (comment and commit status), plus the built-in defaults. `siteUrlConfigured` reports whether PIWI_SITE_URL is set — without it the feature stays inert, because comment links would be unusable. Requires `settings:manage` (administrators only).',
    'x-required-permission': 'settings:manage',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const db = await getDatabase();
  const settings = await getPrFeedbackSettings(db);
  return {
    settings,
    defaults: DEFAULT_PR_FEEDBACK,
    siteUrlConfigured: Boolean(process.env.PIWI_SITE_URL?.trim()),
  };
});
