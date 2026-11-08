// Piwi Runner's window: a single-page app on the shared run layer. `nuxt generate` writes its files; the Node host
// (`server/host.ts`) serves them, so the window has no server of its own.
export default defineNuxtConfig({
  extends: ['../../packages/run-ui'],
  modules: ['@nuxt/ui', '@vueuse/nuxt'],
  ssr: false,
  css: ['~/assets/css/main.css'],
  colorMode: { storageKey: 'piwi-runner-color-mode' },
  app: { head: { title: 'Piwi Runner' } },
  devtools: { enabled: false },
  telemetry: false,
  compatibilityDate: '2025-02-23',
});
