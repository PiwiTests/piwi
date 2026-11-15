import { defineConfig } from 'tsup';

// The config helper (`@piwitests/turbo`) and the fixtures (`@piwitests/turbo/test`), typed; the `piwi-turbo` command, and
// the files it runs in other processes by path: the code-cache hook, the spare worker, the warm daemon and its runner. Only the fixtures
// import the hooks, so the hooks' state exists once per process.
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/test.ts',
    'src/cli.ts',
    'src/code-cache.ts',
    'src/spare-worker.ts',
    'src/warm-daemon.ts',
    'src/warm-runner.ts',
  ],
  format: ['cjs'],
  dts: { entry: ['src/index.ts', 'src/test.ts'] },
  clean: true,
  target: 'node22',
  external: ['@playwright/test'],
});
