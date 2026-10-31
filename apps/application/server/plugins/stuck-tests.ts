import { getDatabase } from '../database';
import { checkStuckTests, STUCK_CHECK_MS } from '../utils/stuck-tests';

/** Check the running tests of this server's live runs for a stuck one, every `STUCK_CHECK_MS`. */
export default defineNitroPlugin((nitroApp) => {
  let checking = false;
  const interval = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      await checkStuckTests(await getDatabase());
    } catch (error) {
      console.error('[StuckTests] Error while checking the running tests:', error);
    } finally {
      checking = false;
    }
  }, STUCK_CHECK_MS);
  interval.unref?.();
  nitroApp.hooks.hook('close', () => clearInterval(interval));
});
