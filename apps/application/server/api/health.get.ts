import { getDatabase } from '../database';
import { appSettings } from '../database/schema';
import { DESKTOP_LAUNCH_NONCE_HEADER, answerDesktopChallenge, desktopLaunchNonce } from '../utils/desktop-access';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Health check',
    description:
      'Liveness/readiness probe for containers, load balancers, and uptime monitors. Verifies the database is reachable with a lightweight query. Returns 200 when healthy, 503 when the database cannot be queried. Public.',
    security: [],
  },
});

export default eventHandler(async (event) => {
  // Piwi Picker checks this before it sends the desktop app's token.
  await answerDesktopChallenge(event);
  try {
    const db = await getDatabase();
    await db.select({ key: appSettings.key }).from(appSettings).limit(1);
  } catch (error) {
    console.error('[health] Database check failed:', error);
    setResponseStatus(event, 503);
    return { status: 'error', database: 'unreachable' };
  }

  // The desktop shell checks this before it loads its session bootstrap.
  const nonce = desktopLaunchNonce();
  if (nonce) setResponseHeader(event, DESKTOP_LAUNCH_NONCE_HEADER, nonce);
  return { status: 'ok', database: 'ok' };
});
