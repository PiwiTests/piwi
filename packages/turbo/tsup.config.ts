import { defineConfig } from 'tsup';

// The config helper (`@piwitests/turbo`) and the fixtures (`@piwitests/turbo/test`), typed; the `piwi-turbo` command, and
// the two files it loads in other processes by path: the code-cache hook and the spare worker. Only the fixtures
// import the hooks, so the hooks' state exists once per process.
export default defineConfig({
  entry: ['src/index.ts', 'src/test.ts', 'src/cli.ts', 'src/code-cache.ts', 'src/spare-worker.ts'],
  format: ['cjs'],
  dts: { entry: ['src/index.ts', 'src/test.ts'] },
  clean: true,
  target: 'node22',
  external: ['@playwright/test'],
});
