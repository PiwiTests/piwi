defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Get server version and runtime info',
    description:
      'Returns the dashboard application version, build provenance, and live runtime info (Node version, operating system and architecture, database backend). Public — used by the Settings → About page and external monitors.',
    security: [],
  },
});

export default eventHandler((event) => {
  const config = useRuntimeConfig(event);

  return {
    appVersion: config.public.appVersion as string,
    buildSha: (config.public.buildSha as string) || null,
    buildTime: (config.public.buildTime as string) || null,
    node: process.version,
    platform: process.platform as string,
    arch: process.arch as string | null,
    dbBackend: process.env.PIWI_DATABASE_URL ? 'postgresql' : 'sqlite',
  };
});
