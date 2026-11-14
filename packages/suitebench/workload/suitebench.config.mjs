// The reference benchmark: one realistic suite, a typical unoptimized setup as the baseline, and one variant per
// public lever, then all of them together. Run it with `npx suitebench run --config workload/suitebench.config.mjs`.
//
// A private hook is one more variant: load it into every Playwright process with NODE_OPTIONS, e.g.
//   { name: 'fast-png', env: { ...stock, NODE_OPTIONS: '--import ./hooks/fast-png.mjs' } }
const stock = { BENCH_AUTH: 'ui', BENCH_TRACE: 'on' };

export default {
  command: ['npx', 'playwright', 'test'],
  runs: 5,
  warmup: 1,
  // Visual baselines come from the stock configuration, once, before any measured run.
  prepare: [['npx', 'playwright', 'test', '--grep', '@visual', '--update-snapshots', '--reporter=dot']],
  clean: ['test-results'],
  artifacts: ['test-results'],
  variants: [
    {
      name: 'stock',
      description: 'A typical unoptimized setup: every test signs in through the form, trace on for every test, Playwright\'s default worker count, third-party scripts load.',
      env: stock,
    },
    {
      name: 'storage-state',
      description: 'Sign in once in a setup project and load the saved storageState into each fresh context.',
      env: { ...stock, BENCH_AUTH: 'state' },
    },
    {
      name: 'trace-on-failure',
      description: 'Record traces for every test but keep them only for failures (retain-on-failure).',
      env: { ...stock, BENCH_TRACE: 'retain-on-failure' },
    },
    {
      name: 'block-third-party',
      description: 'Abort requests to the third-party origin (analytics, chat widget) with context.route.',
      env: { ...stock, BENCH_BLOCK_THIRD_PARTY: '1' },
    },
    {
      name: 'reduced-motion',
      description: 'Emulate prefers-reduced-motion: reduce; the app then skips its transitions.',
      env: { ...stock, BENCH_REDUCED_MOTION: '1' },
    },
    {
      name: 'workers-4',
      description: 'Four workers instead of the default (half the CPUs).',
      env: { ...stock, BENCH_WORKERS: '4' },
    },
    {
      name: 'compile-cache',
      description: 'Node\'s compile cache (NODE_COMPILE_CACHE), warm: the warm-up round fills it.',
      env: { ...stock, NODE_COMPILE_CACHE: '.cache/node-compile' },
    },
    {
      name: 'all-public',
      description: 'Every public lever above together.',
      env: {
        BENCH_AUTH: 'state',
        BENCH_TRACE: 'retain-on-failure',
        BENCH_BLOCK_THIRD_PARTY: '1',
        BENCH_REDUCED_MOTION: '1',
        BENCH_WORKERS: '4',
        NODE_COMPILE_CACHE: '.cache/node-compile',
      },
    },
  ],
};
