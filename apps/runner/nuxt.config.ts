import { version } from './package.json';

// Piwi Runner's window: a single-page app on the shared run layer. `nuxt generate` writes its files; the Node host
// (`server/host.ts`) serves them, so the window has no server of its own.
export default defineNuxtConfig({
  extends: ['../../packages/run-ui'],
  modules: ['@nuxt/ui', '@vueuse/nuxt'],
  ssr: false,
  css: ['~/assets/css/main.css'],
  colorMode: { storageKey: 'piwi-runner-color-mode' },
  app: { head: { title: 'Piwi Runner' } },
  runtimeConfig: { public: { runnerVersion: version } },
  // Every icon the window and the layer name is bundled: the window asks no icon service.
  icon: {
    provider: 'none',
    fallbackToApi: false,
    clientBundle: { scan: { globInclude: ['**/*.{vue,ts}'] }, sizeLimitKb: 256 },
  },
  devtools: { enabled: false },
  telemetry: false,
  compatibilityDate: '2025-02-23',
});
