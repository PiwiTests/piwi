import { dashboardVersion } from '../utils/app-version';
import { isAuthEnabled, optionalCaller } from '../utils/auth';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Get server version and runtime info',
    description:
      'Returns the dashboard application version, build provenance, and live runtime info (Node version, operating system and architecture, database backend), for Settings → About, external monitors and client tools. With authentication on, a caller signed in by neither a session nor an API key gets every field null.',
    security: [],
  },
});

/** What the version route answers: every field null for a caller who may not know it. */
interface VersionInfo {
  appVersion: string | null;
  buildSha: string | null;
  buildTime: string | null;
  node: string | null;
  platform: string | null;
  arch: string | null;
  dbBackend: 'postgresql' | 'sqlite' | null;
}

const UNTOLD: VersionInfo = {
  appVersion: null,
  buildSha: null,
  buildTime: null,
  node: null,
  platform: null,
  arch: null,
  dbBackend: null,
};

export default eventHandler(async (event): Promise<VersionInfo> => {
  if (isAuthEnabled(event) && !(await optionalCaller(event))) return UNTOLD;
  const config = useRuntimeConfig(event);
  return {
    appVersion: dashboardVersion(event),
    buildSha: (config.buildSha as string) || null,
    buildTime: (config.buildTime as string) || null,
    node: process.version,
    platform: process.platform as string,
    arch: process.arch as string | null,
    dbBackend: process.env.PIWI_DATABASE_URL ? 'postgresql' : 'sqlite',
  };
});
