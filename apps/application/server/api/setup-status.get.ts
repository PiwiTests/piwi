import { getDatabase } from '../database';
import { requireAuth } from '../utils/auth';
import { getSetupStatus } from '#shared/handlers/setup-status';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Setup and capability status',
    description:
      "Reports which of Piwi's optional capabilities show evidence of being active on this instance (results arriving, capture fixtures installed, locator healing, clustering, AI diagnosis, notifications, SCM, tags, markers, quarantine). Evidence-based rather than config-based: a configured-but-unused capability reads as inactive. Drives the capability ladder of Settings → Capabilities. Requires `settings:manage` (administrators only).",
    'x-required-permission': 'settings:manage',
  },
});

export default eventHandler(async (event) => {
  // Administrators only (`settings:manage` above): the response describes how
  // this instance is configured.
  await requireAuth(event);
  const db = await getDatabase();
  const appVersion = useRuntimeConfig(event).public.appVersion as string | undefined;
  return getSetupStatus(db, appVersion);
});
