// The layer's components, composables and utils join the host's: the dashboard extends it with its server render,
// Piwi Runner with `ssr: false`.
export default defineNuxtConfig({
  // The workspace packages it imports, and this one, ship TypeScript source, which the host's Vite must transpile.
  build: {
    transpile: [
      '@piwitests/core',
      '@piwitests/editor',
      '@piwitests/picker-dom',
      '@piwitests/run-model',
      '@piwitests/run-ui',
    ],
  },
});
