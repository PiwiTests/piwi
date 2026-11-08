import { eq } from 'drizzle-orm';
import { getDatabase } from '../database';
import { projects } from '../database/schema';
import { setRunTargetVersion } from '@piwitests/editor/run-target';
import { startDesktopRuns } from '../utils/desktop-runs';

// The desktop (Tauri) build only: the hub of the Playwright runs the shell
// starts (`utils/desktop-runs.ts`), opened as the server starts and closed with
// it. Gated on `PIWI_DESKTOP_TOKEN`, so the server / Docker / npx deployments
// open no socket.
export default defineNitroPlugin((nitroApp) => {
  const token = process.env.PIWI_DESKTOP_TOKEN;
  if (!token) return;
  const version = String(useRuntimeConfig().public.appVersion ?? '');
  setRunTargetVersion(version);
  const opening = startDesktopRuns({
    token,
    version,
    projectName: async (id) => {
      const db = await getDatabase();
      const [row] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, id)).limit(1);
      return row?.name ?? null;
    },
    log: (message) => console.log(message),
  });
  nitroApp.hooks.hook('close', async () => (await opening).close());
});
