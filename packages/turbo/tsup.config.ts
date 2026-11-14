import { defineConfig } from 'tsup';

// Two entries: the config helper (`@piwitests/turbo`) and the fixtures (`@piwitests/turbo/test`). Only the fixtures
// import the hooks, so the hooks' state exists once per process.
export default defineConfig({
  entry: ['src/index.ts', 'src/test.ts'],
  format: ['cjs'],
  dts: true,
  clean: true,
  target: 'node22',
  external: ['@playwright/test'],
});
