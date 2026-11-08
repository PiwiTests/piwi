// The layer's components, composables and utils join the host's: the dashboard extends it with its server render,
// Piwi Runner with `ssr: false`.
export default defineNuxtConfig({
  // @piwitests/editor and this package ship TypeScript source, which the host's Vite must transpile.
  build: {
    transpile: ['@piwitests/editor', '@piwitests/run-ui'],
  },
});
