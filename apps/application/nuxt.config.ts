// https://nuxt.com/docs/api/configuration/nuxt-config
import { cpSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { resolve, dirname, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { GENERATED_DOCS_PAGES } from './shared/docs-generated-pages';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const nodeRequire = createRequire(import.meta.url);

const isDemo = process.env.PIWI_DEMO_MODE === 'true';

// Static head description for the demo shell — same wording as the docs
// site's og: cards (apps/docs/.vitepress/config.mts).
const demoDescription =
  'CI throws away every report it makes. Piwi keeps them — then groups failures by root cause, scores flaky tests, and finds the locator you should have used. Self-hosted, zero telemetry.';

// The dashboard version is authoritative in `application/package.json`
// (kept in sync across the monorepo by release-please) — read it once at
// config-eval time so the running app can report what it is.
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

// The documentation pages and the changelog ship inside the server build, read
// by the MCP describe_piwi and get_release_notes tools so they answer for the
// running version with no network. Generated docs pages are left out (the tools
// render the same registries), and a checkout without either source simply
// bundles nothing — the tools then point at the published copies.
const docsDir = resolve(__dirname, '../docs');
const changelogDir = resolve(__dirname, '../..');
// The workflow skills `piwi skills add` installs, served by the MCP server as
// prompts (prompts/list, prompts/get) in the version of this build.
const skillsDir = resolve(__dirname, '../../packages/reporter/templates/skills');
const serverAssets = [
  ...(existsSync(resolve(docsDir, 'guide'))
    ? [
        {
          baseName: 'piwi-docs',
          dir: docsDir,
          pattern:
            '{index.md,guide/**/*.md,features/**/*.md,recipes/**/*.md,operate/**/*.md,reference/**/*.md,snippets/*}',
          ignore: ['**/node_modules/**', ...Object.keys(GENERATED_DOCS_PAGES).map((page) => `${page}.md`)],
        },
      ]
    : []),
  ...(existsSync(resolve(changelogDir, 'CHANGELOG.md'))
    ? [{ baseName: 'piwi-changelog', dir: changelogDir, pattern: 'CHANGELOG.md', ignore: ['**/node_modules/**'] }]
    : []),
  ...(existsSync(skillsDir) ? [{ baseName: 'piwi-skills', dir: skillsDir, pattern: '*/SKILL.md' }] : []),
];

// Read the demo seed version hash at build time so it can be injected into
// runtimeConfig for staleness detection in the browser.
let demoDataVersion = '';
if (isDemo) {
  try {
    const versionFile = resolve(__dirname, 'public/demo/seed.version.json');
    const versionInfo = JSON.parse(readFileSync(versionFile, 'utf-8'));
    demoDataVersion = versionInfo.hash;
  } catch {
    console.warn(
      '[Config] public/demo/seed.version.json not found or invalid. Run `npm run app:seed:demo` before building.',
    );
  }
}

const demoPwaConfig = isDemo
  ? {
      strategies: 'injectManifest' as const,
      srcDir: 'service-worker',
      filename: 'demo-sw.ts',
      registerType: 'autoUpdate' as const,
      injectManifest: {
        // Setting injectionPoint to undefined prevents vite-pwa/workbox from
        // injecting a precache manifest into the SW source.  The SW only
        // intercepts demo API calls and does not use Workbox precaching at all.
        injectionPoint: undefined,
      },
      // No PWA manifest or icons needed for the demo.
      manifest: false as const,
      devOptions: {
        enabled: false,
      },
    }
  : // The option is `disable` (`disabled` is ignored): the normal build
    // generates no Workbox service worker and no page registers `/sw.js`.
    { disable: true };

export default defineNuxtConfig({
  modules: ['@nuxt/ui', '@vueuse/nuxt', '@vite-pwa/nuxt'],
  ssr: isDemo ? false : undefined,
  // Baked into the demo's static HTML and shown until the app first renders,
  // which waits on the in-browser database: without it a first visit is a blank
  // page, and crawlers that render the page find nothing describing it.
  spaLoadingTemplate: isDemo ? 'demo/loading-template.html' : undefined,

  // `flaky` joins the default semantic colors so a flaky badge can carry the
  // test outcome palette's purple (mapped in app.config.ts).
  ui: {
    theme: {
      colors: ['primary', 'secondary', 'success', 'info', 'warning', 'error', 'flaky'],
    },
  },

  // The light/dark/system choice lives in a cookie, read by the server for the
  // first render and shared by every port on the host (the desktop app picks a
  // free one when its preferred port is taken).
  colorMode: {
    storage: 'cookie',
    storageKey: 'piwi-color-mode',
    cookieAttrs: { maxAge: 60 * 60 * 24 * 365, path: '/', sameSite: 'lax' },
  },

  components: {
    dirs: [{ path: '~/components', pathPrefix: false }],
  },

  // @piwitests/core and @piwitests/picker-dom ship TypeScript source (shared
  // with the reporter); Vite must transpile them since node_modules is not
  // transpiled by default. Nuxt also passes this list to Nitro's
  // externals.inline, so they are bundled into the server build instead of
  // being copied as TypeScript into .output/server/node_modules.
  build: {
    transpile: ['@piwitests/core', '@piwitests/picker-dom'],
  },

  devtools: {
    enabled: false,
  },

  // Production builds emit no server source maps: through the Vite SSR build and
  // the Nitro bundle they add over a gigabyte to the build's peak heap (past
  // Node's 4 GB default in the Docker image), and nothing reads them — the server
  // runs without --enable-source-maps and the desktop staging strips every *.map.
  // `nuxt dev` keeps them.
  $production: {
    sourcemap: { server: false },
  },
  // The demo is a static SPA (ssr: false), so nothing set through
  // useHead/useSeoMeta exists until the JS bundle runs — link previews and
  // search snippets only see what is baked into the shell here.
  app: isDemo
    ? {
        baseURL: '/demo/',
        head: {
          htmlAttrs: { lang: 'en' },
          // Every page title the app sets gains the suffix, so the indexed
          // entry page reads "Piwi Dashboard (live demo)".
          title: 'Piwi Dashboard',
          titleTemplate: '%s (live demo)',
          meta: [
            { name: 'description', content: demoDescription },
            { property: 'og:type', content: 'website' },
            { property: 'og:site_name', content: 'Piwi Dashboard' },
            { property: 'og:title', content: 'Piwi Dashboard (live demo)' },
            { property: 'og:description', content: demoDescription },
            { property: 'og:image', content: 'https://piwitests.dev/og-image.png' },
            { property: 'og:image:width', content: '1200' },
            { property: 'og:image:height', content: '630' },
            { property: 'og:url', content: 'https://piwitests.dev/demo/' },
            { name: 'twitter:card', content: 'summary_large_image' },
            { name: 'twitter:title', content: 'Piwi Dashboard (live demo)' },
            { name: 'twitter:description', content: demoDescription },
            { name: 'twitter:image', content: 'https://piwitests.dev/og-image.png' },
          ],
          link: [
            // Every demo route serves this same shell (a prerendered copy, or the site's
            // 404 redirect), so each names the entry page as the one URL to index.
            { rel: 'canonical', href: 'https://piwitests.dev/demo/' },
            { rel: 'icon', href: '/demo/favicon.ico', sizes: 'any' },
            { rel: 'icon', type: 'image/svg+xml', href: '/demo/logo.svg' },
          ],
        },
      }
    : {},

  // No icon is ever fetched from the iconify CDN at runtime: the collections
  // are installed locally for the server endpoint, and the client bundle
  // carries every icon the source references — the static demo has no server
  // to ask, and a self-hosted instance makes no outbound calls.
  icon: {
    fallbackToApi: false,
    clientBundle: {
      // Icon names also live in .ts maps (status/browser/SCM icons in
      // app/utils and shared/), which the default scan globs skip.
      scan: {
        globInclude: ['**/*.{vue,jsx,tsx,md,mdc,mdx,yml,yaml}', '**/*.{ts,js,mjs}', '../shared/**/*.{ts,js}'],
      },
      sizeLimitKb: 512,
    },
  },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    authEnabled: process.env.PIWI_AUTH_ENABLED === 'true',
    // Allowlist of glob patterns (comma/newline separated) for wait steps counted
    // as "wasted time". When set, locks the in-app "Wasted time" setting.
    wastedWaitPatterns: process.env.PIWI_WASTED_WAIT_PATTERNS || '',
    ai: {
      provider: process.env.PIWI_AI_PROVIDER || '',
      apiKey: process.env.PIWI_AI_API_KEY || '',
      model: process.env.PIWI_AI_MODEL || '',
      baseUrl: process.env.PIWI_AI_BASE_URL || '',
      autoDiagnose: process.env.PIWI_AI_AUTO_DIAGNOSE === 'true',
      temperature: process.env.PIWI_AI_TEMPERATURE || '',
      researchModel: process.env.PIWI_AI_RESEARCH_MODEL || '',
      researchProvider: process.env.PIWI_AI_RESEARCH_PROVIDER || '',
      researchBaseUrl: process.env.PIWI_AI_RESEARCH_BASE_URL || '',
      researchApiKey: process.env.PIWI_AI_RESEARCH_API_KEY || '',
      researchTemperature: process.env.PIWI_AI_RESEARCH_TEMPERATURE || '',
      embeddingProvider: process.env.PIWI_AI_EMBEDDING_PROVIDER || '',
      embeddingModel: process.env.PIWI_AI_EMBEDDING_MODEL || '',
      embeddingBaseUrl: process.env.PIWI_AI_EMBEDDING_BASE_URL || '',
      embeddingApiKey: process.env.PIWI_AI_EMBEDDING_API_KEY || '',
    },
    authSecret: (() => {
      if (process.env.PIWI_AUTH_ENABLED === 'true' && !process.env.PIWI_AUTH_SECRET) {
        throw new Error(
          'PIWI_AUTH_ENABLED is true but PIWI_AUTH_SECRET is not set. ' +
            "Generate one with: node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"",
        );
      }
      return process.env.PIWI_AUTH_SECRET || 'default-secret-change-in-production-use-random-string';
    })(),
    oauth: {
      google: {
        clientId: process.env.PIWI_OAUTH_GOOGLE_CLIENT_ID || '',
        clientSecret: process.env.PIWI_OAUTH_GOOGLE_CLIENT_SECRET || '',
      },
      github: {
        clientId: process.env.PIWI_OAUTH_GITHUB_CLIENT_ID || '',
        clientSecret: process.env.PIWI_OAUTH_GITHUB_CLIENT_SECRET || '',
      },
      // Optional access-control allowlists for OAuth sign-in.
      // Comma-separated verified email domains (applies to all providers).
      allowedDomains: process.env.PIWI_OAUTH_ALLOWED_DOMAINS || '',
      // Comma-separated GitHub org logins the user must belong to.
      githubAllowedOrgs: process.env.PIWI_OAUTH_GITHUB_ALLOWED_ORGS || '',
    },
    public: {
      siteUrl: process.env.PIWI_SITE_URL || '',
      // Instance-default date/time formatting, read on the client. Empty means
      // "not pinned by env" — the client then layers the stored app setting and
      // the per-viewer override on top (see app/plugins/locale.client.ts). A
      // non-empty value here locks the admin setting in the UI.
      dateLocale: process.env.PIWI_LOCALE || '',
      dateTimeZone: process.env.PIWI_TIME_ZONE || '',
      // Auth is always "on" in the demo so role-based UI (admin-only controls,
      // project affectation, members) engages for the selected "act as" user.
      authEnabled: process.env.PIWI_AUTH_ENABLED === 'true' || isDemo,
      demoMode: process.env.PIWI_DEMO_MODE === 'true',
      demoDataVersion,
      // Authoritative dashboard version — read from the committed package.json
      // (release-please-maintained), so it works even in the static demo build
      // with no server round-trip.
      appVersion: pkg.version as string,
      buildSha: process.env.PIWI_BUILD_SHA || '',
      buildTime: new Date().toISOString(),
      nodeVersion: process.version,
      // True only in the Tauri desktop build — the launcher starts the bundled
      // server with NUXT_PUBLIC_DESKTOP=true (desktop/src-tauri/src/lib.rs),
      // which Nuxt maps onto this key. Gates desktop-only UI (see useIsDesktop):
      // single-user with auth off, so account/user management is hidden and the
      // local connection details are surfaced.
      desktop: false,
      // Mounts the guided tour (app.vue): on in the demo build; a dev server
      // turns it on with NUXT_PUBLIC_DEMO_TOUR=true, as the screenshot
      // harness's `tour` mode does.
      demoTour: isDemo,
      oauthProviders: [
        ...(process.env.PIWI_OAUTH_GOOGLE_CLIENT_ID && process.env.PIWI_OAUTH_GOOGLE_CLIENT_SECRET
          ? (['google'] as const)
          : []),
        ...(process.env.PIWI_OAUTH_GITHUB_CLIENT_ID && process.env.PIWI_OAUTH_GITHUB_CLIENT_SECRET
          ? (['github'] as const)
          : []),
      ],
    },
  },

  // Allow overriding build directory to avoid conflicts when running multiple
  // dev servers (e.g., auth server in CI, demo build).
  buildDir: process.env.PIWI_BUILD_DIR || undefined,

  experimental: {
    // Disable buildCache in demo mode: restoring an SSR cache when generating
    // a SPA (ssr: false) causes Rollup to look for client.precomputed.mjs
    // inside the cache directory, which doesn't exist, breaking the build.
    // Disable it on CI too: its key hashes `app/**`, this config and the app's
    // package.json, not `shared/**`, `packages/core`, `packages/picker-dom` or
    // the root lockfile, so a change there could build the client from a stale
    // cache and test and ship it.
    buildCache: !isDemo && !process.env.CI,
    // Enable payloadExtraction in demo mode so that the statically generated
    // HTML pages can be hydrated with fixture data embedded during prerender,
    // avoiding extra network round-trips in the SPA.
    payloadExtraction: isDemo,
    // When a prefetched <NuxtLink> target declares preload hints via useHead,
    // forward them (downgraded to rel="prefetch") into the current document so
    // the next navigation's critical assets are already warm.
    prefetchPreloadTags: true,
  },

  compatibilityDate: '2025-02-23',

  // No other site may frame the dashboard (clickjacking). A route that sets its
  // own Content-Security-Policy (a sandboxed file, a share view, the desktop
  // shell's page policy) replaces this one and keeps X-Frame-Options. Badges and
  // charts are images, which neither header restricts.
  routeRules: {
    '/**': {
      headers: { 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "frame-ancestors 'self'" },
    },
  },

  nitro: {
    hooks: {
      // The app's `$fetch` and `useFetch` carry no typed route map. With one,
      // every call on a URL built at run time is matched against every server
      // route at type level, and past about 220 routes TypeScript gives up
      // ("excessive stack depth"). A call site names its response type instead,
      // with `ApiResponse<typeof handler>` or a type from `types/api.ts`.
      'types:extend'(types) {
        types.routes = {};
      },
    },
    // Pre-render /_openapi.json so it ships as a static file in the demo.
    // Nitro's built-in OpenAPI handler reads compiled route metadata (from
    // defineRouteMeta transforms) and writes the full spec to
    // .output/public/_openapi.json, which the /docs page fetches at runtime.
    prerender: isDemo ? { failOnError: false, routes: ['/_openapi.json'] } : undefined,
    // The demo's prerender cache lives in memory (a generate run discards it
    // anyway), so the prerenderer never imports @nuxt/nitro-server's disk cache
    // driver, which it registers by file:// URL on Windows.
    storage: isDemo ? { 'internal:nuxt:prerender': { driver: 'memory' } } : undefined,
    serverAssets,
    publicAssets: [
      {
        // Serve the Playwright trace viewer static files at /trace-viewer/.
        // These assets are bundled with playwright-core and served directly from
        // node_modules. During `nuxt build`, Nitro copies them to .output/public/.
        baseURL: '/trace-viewer',
        dir: resolve(dirname(nodeRequire.resolve('playwright-core/package.json')), 'lib/vite/traceViewer'),
        maxAge: 60 * 60 * 24,
      },
    ],
    openAPI: {
      // Nitro only registers the /_openapi.json (and scalar/swagger UI) handlers in
      // production builds when `production` is set — by default they're dev-only.
      // 'prerender' makes `nuxt generate` (demo, ssr:false, no live server at runtime)
      // bake the spec into a static file; 'runtime' serves it live from the real SSR server.
      production: isDemo ? 'prerender' : 'runtime',
      meta: {
        title: 'Piwi Dashboard API',
        description:
          'REST API for storing and querying Playwright test results, traces, failure diagnoses, and project statistics.',
        version: pkg.version as string,
        // Security scheme definitions for endpoint-level `security` annotations,
        // rendered by the in-app reference (app/pages/docs.vue).
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'pd_<64-hex>',
              description:
                'API key authentication (Bearer token with pd_ prefix). Obtain an API key via POST /api/users/:id/api-keys.',
            },
            sessionCookie: {
              type: 'apiKey',
              in: 'cookie',
              // Sealed-session cookie name, pinned in server/utils/auth.ts
              // (SESSION_COOKIE_NAME) rather than left to h3's `h3` default.
              name: 'piwi_session',
              description: 'Session cookie authentication (sealed session cookie). Set via POST /api/auth/login.',
            },
          },
        },
        // Default security requirement for all endpoints.
        // Override with `security: []` on auth endpoints (login, oauth, ai/status).
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      } as any,
      // The reference UI is rendered in-app by app/pages/docs.vue from the
      // generated /_openapi.json — self-contained (no CDN), and it also covers the
      // static demo where no live server exists. Disabling Nitro's built-in Scalar
      // and Swagger routes here avoids them colliding with that page.
      ui: {
        scalar: false,
        swagger: false,
      },
    },
    // npm dependencies stay external: Nitro traces the files the server uses and
    // copies them into .output/server/node_modules. The Docker image, the desktop
    // staging (apps/desktop/scripts/stage-server.mjs) and @piwitests/server
    // (packages/server/scripts/copy-output.mjs) prune the sharp and libsql
    // platform binaries in that folder and install the target platform's beside
    // it. Nitro's top-level `noExternals` does not fit that: it bundles every
    // dependency and refuses any external, native modules included.
    // date-fns and drizzle-orm are bundled all the same: Node parses a package's
    // whole `exports` map again for every file it loads from it, theirs list
    // hundreds of entries, and the server loads hundreds of their files, which
    // adds seconds to every server start.
    externals: {
      inline: ['date-fns', 'drizzle-orm'],
    },
    experimental: {
      openAPI: true,
      // Windows-only workaround to avoid Nitro build issues caused by ESM/CJS externals
      // resolution on Windows. legacyExternals swaps the plugin that traces the externals
      // above for Nitro's older one, which avoids intermittent build timeouts / failures
      // during Nitro server bundling on Windows. `nuxi build` sets NODE_ENV=production
      // before it loads this file.
      // See: https://github.com/nuxt/nuxt/issues/31836
      // Never in the demo, whose only server bundle is the prerenderer: the older
      // resolver resolves bare imports from the project root rather than the importing
      // file, which would hand Nitro's runtime the hoisted hookable 6 in place of its own
      // hookable 5 (whose callHook() always returns a promise), and every prerendered
      // route would answer 500.
      legacyExternals: !isDemo && process.platform === 'win32' && process.env.NODE_ENV === 'production',
      tasks: true,
    },
    scheduledTasks: {
      // Run the notification, auto-heal and integration outbox sweepers every minute. The
      // tracker status pull ticks here too and runs on the cadence PIWI_INTEGRATIONS_SYNC_MINUTES
      // sets at run time (default every 15 min).
      '* * * * *': ['notifications:sweep', 'heal:sweep', 'integrations:sweep', 'integrations:sync'],
      // Fire the report schedules that are due (a missed tick fires on the next sweep)
      '*/5 * * * *': ['reports:schedule'],
      // Read the final state of the pull requests a gate failed on (overrides and escapes)
      '*/10 * * * *': ['gate:sweep'],
      // Nightly data retention: run pruning (opt-in), outbox pruning, orphan sweep
      '17 3 * * *': ['retention:sweep'],
      // Nightly feature-graph sweep: prune stale changes edges, branch-tagged
      // rows and canonical nodes unseen for thirty runs (independent of retention).
      '23 3 * * *': ['graph:sweep'],
    },
  },

  vite: {
    // Every client dependency is listed: Vite's startup scan cannot follow
    // Nuxt's virtual entry, so an unlisted one is discovered while a page
    // loads, and Vite re-bundles and reloads that page. reka-ui and its
    // subpath entries stay unlisted: Nuxt UI transpiles reka-ui, which keeps it
    // out of pre-bundling, and all its entries must load the same copy.
    optimizeDeps: {
      include: [
        'date-fns',
        // The locales useLocaleSettings loads on demand.
        'date-fns/locale/cs',
        'date-fns/locale/da',
        'date-fns/locale/de',
        'date-fns/locale/en-GB',
        'date-fns/locale/es',
        'date-fns/locale/fi',
        'date-fns/locale/fr',
        'date-fns/locale/fr-CA',
        'date-fns/locale/it',
        'date-fns/locale/ja',
        'date-fns/locale/ko',
        'date-fns/locale/nb',
        'date-fns/locale/nl',
        'date-fns/locale/pl',
        'date-fns/locale/pt',
        'date-fns/locale/pt-BR',
        'date-fns/locale/sv',
        'date-fns/locale/zh-CN',
        'date-fns/locale/zh-TW',
        'drizzle-orm',
        'drizzle-orm/pg-core',
        'drizzle-orm/sqlite-core',
        'drizzle-orm/sqlite-proxy',
        // The guided tour's engine, loaded when a tour starts.
        'driver.js',
        // The languages shared/highlight.ts registers.
        'highlight.js/lib/core',
        'highlight.js/lib/languages/bash',
        'highlight.js/lib/languages/css',
        'highlight.js/lib/languages/diff',
        'highlight.js/lib/languages/javascript',
        'highlight.js/lib/languages/json',
        'highlight.js/lib/languages/powershell',
        'highlight.js/lib/languages/python',
        'highlight.js/lib/languages/typescript',
        'highlight.js/lib/languages/xml',
        'highlight.js/lib/languages/yaml',
        'marked',
        'pdf-lib',
        'vue-virtual-scroller',
        'write-excel-file/universal',
        'zod',
      ],

      // sql.js bundles a WASM binary and must not be pre-bundled by Vite;
      // excluding it ensures the WASM file is loaded at runtime via locateFile.
      exclude: ['sql.js'],
    },
  },

  hooks: {
    // Each page's route records its source file, relative to `app/pages`, for
    // the command palette's *View page source*.
    'pages:extend': (pages) => {
      const pagesDir = resolve(__dirname, 'app/pages');
      const stamp = (list: typeof pages) => {
        for (const page of list) {
          if (page.file) page.meta = { ...page.meta, sourceFile: relative(pagesDir, page.file).split(sep).join('/') };
          if (page.children) stamp(page.children);
        }
      };
      stamp(pages);
    },
    'nitro:build:public-assets': (nitro) => {
      // Copy migrations folders to output during build
      const sourceMigrations = resolve(__dirname, 'server/database/migrations');
      const targetMigrations = resolve(nitro.options.output.serverDir, 'database/migrations');

      if (existsSync(sourceMigrations)) {
        console.log('[Build] Copying SQLite migrations to output...');
        mkdirSync(dirname(targetMigrations), { recursive: true });
        cpSync(sourceMigrations, targetMigrations, { recursive: true });
        console.log('[Build] SQLite migrations copied successfully');
      }

      const sourceMigrationsPg = resolve(__dirname, 'server/database/migrations-pg');
      const targetMigrationsPg = resolve(nitro.options.output.serverDir, 'database/migrations-pg');

      if (existsSync(sourceMigrationsPg)) {
        console.log('[Build] Copying PostgreSQL migrations to output...');
        mkdirSync(dirname(targetMigrationsPg), { recursive: true });
        cpSync(sourceMigrationsPg, targetMigrationsPg, { recursive: true });
        console.log('[Build] PostgreSQL migrations copied successfully');
      }

      // Ensure the sql.js WASM file is present in public/demo for the browser demo build
      if (isDemo) {
        const wasmSrc = resolve(__dirname, 'node_modules/sql.js/dist/sql-wasm-browser.wasm');
        const wasmDst = resolve(__dirname, 'public/demo/sql-wasm-browser.wasm');
        if (existsSync(wasmSrc) && !existsSync(wasmDst)) {
          console.log('[Build] Copying sql-wasm-browser.wasm to public/demo...');
          cpSync(wasmSrc, wasmDst);
          console.log('[Build] sql-wasm-browser.wasm copied successfully');
        }
        const seedSrc = resolve(__dirname, 'public/demo/seed.sql');
        if (!existsSync(seedSrc)) {
          console.warn('[Build] WARNING: public/demo/seed.sql not found. Run `npm run app:seed:demo` before building.');
        }
      }
    },
  },

  // Service worker for demo mode: intercepts /api/ calls and serves them
  // from the in-browser SQLite database so no real server is needed.
  pwa: demoPwaConfig,
});
