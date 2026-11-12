import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import { setAppSetting, deleteAppSetting } from '../../utils/app-settings';
import { getPrFeedbackSettings } from '../../utils/scm/pr-feedback-settings';
import {
  DEFAULT_PR_FEEDBACK,
  PR_FEEDBACK_KEY,
  resolvePrFeedbackSettings,
  type PrFeedbackSettings,
} from '#shared/pr-feedback';

defineRouteMeta({
  openAPI: {
    tags: ['Settings'],
    summary: 'Save pull-request feedback settings',
    description:
      'Updates what Piwi posts back to a pull request when a run finishes. Send `settings: null` to reset to the built-in defaults (feedback off). Requires `settings:manage` (administrators only).',
    'x-required-permission': 'settings:manage',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const db = await getDatabase();

  const body = (await readBody(event)) as { settings?: Partial<PrFeedbackSettings> | null };

  if (body.settings === null) {
    await deleteAppSetting(db, PR_FEEDBACK_KEY);
  } else {
    // Store the fully-resolved object so a partial payload can never leave a
    // half-configured state that posts something unintended to a pull request.
    await setAppSetting(db, PR_FEEDBACK_KEY, resolvePrFeedbackSettings(body.settings));
  }

  const settings = await getPrFeedbackSettings(db);
  return {
    settings,
    defaults: DEFAULT_PR_FEEDBACK,
    siteUrlConfigured: Boolean(process.env.PIWI_SITE_URL?.trim()),
  };
});
