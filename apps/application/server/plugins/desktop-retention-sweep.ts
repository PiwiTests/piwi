/** How long after the desktop app's server starts it runs the retention sweep. */
const STARTUP_SWEEP_DELAY_MS = 5 * 60 * 1000;

// The desktop app's server runs the nightly `retention:sweep` once more, a few
// minutes after it starts: the app runs only while its user keeps it open, so
// the 03:17 schedule alone may never fire there. Gated on `PIWI_DESKTOP_TOKEN`,
// so the server, Docker and npx deployments keep the schedule alone.
export default defineNitroPlugin((nitroApp) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) return;

  const timer = setTimeout(() => {
    runTask('retention:sweep').catch((error) => {
      console.error('[RetentionSweep] The sweep after startup failed:', error);
    });
  }, STARTUP_SWEEP_DELAY_MS);
  timer.unref?.();

  nitroApp.hooks.hook('close', () => {
    clearTimeout(timer);
  });
});
