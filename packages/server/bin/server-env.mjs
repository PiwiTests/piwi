// Preloaded before the bundled server starts: `node --import` in the Docker image,
// a static import in the `piwi-server` launcher.
//
// The prebuilt server bakes its runtime config at build time and only honors
// NUXT_*-prefixed overrides at run time (NUXT_PUBLIC_SITE_URL sets
// `runtimeConfig.public.siteUrl`). Each operator-facing PIWI_* variable the server
// reads through `runtimeConfig` is mirrored onto its override here, so setting it
// takes effect on both the server and the browser (public) config. An override the
// operator set directly wins. Variables the server reads straight from
// `process.env` (PIWI_SECRET_KEY, PIWI_AI_LANGUAGE, the PIWI_AI_MAX_* limits, ...)
// need no mapping.
const RUNTIME_CONFIG_ENV = {
  PIWI_AUTH_SECRET: 'NUXT_AUTH_SECRET',

  PIWI_SITE_URL: 'NUXT_PUBLIC_SITE_URL',
  PIWI_LOCALE: 'NUXT_PUBLIC_DATE_LOCALE',
  PIWI_TIME_ZONE: 'NUXT_PUBLIC_DATE_TIME_ZONE',
  PIWI_WASTED_WAIT_PATTERNS: 'NUXT_WASTED_WAIT_PATTERNS',

  PIWI_AI_PROVIDER: 'NUXT_AI_PROVIDER',
  PIWI_AI_API_KEY: 'NUXT_AI_API_KEY',
  PIWI_AI_MODEL: 'NUXT_AI_MODEL',
  PIWI_AI_BASE_URL: 'NUXT_AI_BASE_URL',
  PIWI_AI_AUTO_DIAGNOSE: 'NUXT_AI_AUTO_DIAGNOSE',
  PIWI_AI_TEMPERATURE: 'NUXT_AI_TEMPERATURE',
  PIWI_AI_RESEARCH_PROVIDER: 'NUXT_AI_RESEARCH_PROVIDER',
  PIWI_AI_RESEARCH_API_KEY: 'NUXT_AI_RESEARCH_API_KEY',
  PIWI_AI_RESEARCH_MODEL: 'NUXT_AI_RESEARCH_MODEL',
  PIWI_AI_RESEARCH_BASE_URL: 'NUXT_AI_RESEARCH_BASE_URL',
  PIWI_AI_RESEARCH_TEMPERATURE: 'NUXT_AI_RESEARCH_TEMPERATURE',
  PIWI_AI_EMBEDDING_PROVIDER: 'NUXT_AI_EMBEDDING_PROVIDER',
  PIWI_AI_EMBEDDING_API_KEY: 'NUXT_AI_EMBEDDING_API_KEY',
  PIWI_AI_EMBEDDING_MODEL: 'NUXT_AI_EMBEDDING_MODEL',
  PIWI_AI_EMBEDDING_BASE_URL: 'NUXT_AI_EMBEDDING_BASE_URL',
  PIWI_AI_ASSISTANT_PROVIDER: 'NUXT_AI_ASSISTANT_PROVIDER',
  PIWI_AI_ASSISTANT_API_KEY: 'NUXT_AI_ASSISTANT_API_KEY',
  PIWI_AI_ASSISTANT_MODEL: 'NUXT_AI_ASSISTANT_MODEL',
  PIWI_AI_ASSISTANT_BASE_URL: 'NUXT_AI_ASSISTANT_BASE_URL',
  PIWI_AI_ASSISTANT_TEMPERATURE: 'NUXT_AI_ASSISTANT_TEMPERATURE',

  PIWI_OAUTH_GOOGLE_CLIENT_ID: 'NUXT_OAUTH_GOOGLE_CLIENT_ID',
  PIWI_OAUTH_GOOGLE_CLIENT_SECRET: 'NUXT_OAUTH_GOOGLE_CLIENT_SECRET',
  PIWI_OAUTH_GITHUB_CLIENT_ID: 'NUXT_OAUTH_GITHUB_CLIENT_ID',
  PIWI_OAUTH_GITHUB_CLIENT_SECRET: 'NUXT_OAUTH_GITHUB_CLIENT_SECRET',
  PIWI_OAUTH_ALLOWED_DOMAINS: 'NUXT_OAUTH_ALLOWED_DOMAINS',
  PIWI_OAUTH_GITHUB_ALLOWED_ORGS: 'NUXT_OAUTH_GITHUB_ALLOWED_ORGS',
}
// On Fly.io an app answers at https://<app>.fly.dev, and `fly launch` may rename the app when its
// name is taken: without a site URL of its own, the instance takes it from the app's name.
const flyApp = process.env.FLY_APP_NAME
if (!process.env.PIWI_SITE_URL && !process.env.NUXT_PUBLIC_SITE_URL && flyApp && /^[a-z0-9-]+$/i.test(flyApp)) {
  process.env.PIWI_SITE_URL = `https://${flyApp}.fly.dev`
}

for (const [piwiName, nuxtName] of Object.entries(RUNTIME_CONFIG_ENV)) {
  if (process.env[piwiName]) process.env[nuxtName] ??= process.env[piwiName]
}

// Authentication is switched on in both the server and the public (browser) config.
if (process.env.PIWI_AUTH_ENABLED === 'true') {
  process.env.NUXT_AUTH_ENABLED ??= 'true'
  process.env.NUXT_PUBLIC_AUTH_ENABLED ??= 'true'
}

// The login page lists its sign-in buttons from `public.oauthProviders`. Derive it
// from the providers that have both a client id and a secret, unless the operator
// set NUXT_PUBLIC_OAUTH_PROVIDERS directly.
const configuredProviders = ['google', 'github'].filter((provider) => {
  const key = provider.toUpperCase()
  return process.env[`NUXT_OAUTH_${key}_CLIENT_ID`] && process.env[`NUXT_OAUTH_${key}_CLIENT_SECRET`]
})
if (configuredProviders.length > 0) {
  process.env.NUXT_PUBLIC_OAUTH_PROVIDERS ??= JSON.stringify(configuredProviders)
}
