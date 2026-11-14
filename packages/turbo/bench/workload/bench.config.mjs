// The reference benchmark: a typical unoptimized setup as the baseline, one variant per @piwitests/turbo lever, all public
// levers together ("tuned"), then the experimental hooks on top of them.
//
//   npm run turbo:bench                                            every variant against stock
//   npm run turbo:bench -- --only tuned,tuned+fast-png,tuned+retry,tuned+hooks --runs 8
//                                                            the hooks against the tuned suite
//   npm run turbo:bench -- --only stock,failure-screenshots,instant-animations,preset-safe,preset-fast,preset-experimental
//                                                            the newer levers and the presets against stock
// A variant's order in this list decides the baseline: the first variant of a run.
import { createRequire } from 'node:module';

const stock = { BENCH_AUTH: 'ui', BENCH_TRACE: 'on' };
const tuned = {
  BENCH_AUTH: 'state',
  BENCH_TRACE: 'retain-on-failure',
  BENCH_BLOCK_THIRD_PARTY: '1',
  BENCH_REDUCED_MOTION: '1',
  BENCH_WORKERS: '4',
};
const fastRetry = '10,20,40,50';
// Playwright's CLI by path: `npx` inside a workspace runs from the workspace's root, not from this folder.
const playwright = [process.execPath, createRequire(import.meta.url).resolve('@playwright/test/cli')];

export default {
  command: [...playwright, 'test'],
  runs: 5,
  warmup: 1,
  // Visual baselines come from the stock configuration, once, before any measured run.
  prepare: [[...playwright, 'test', '--grep', '@visual', '--update-snapshots', '--reporter=dot']],
  clean: ['test-results'],
  artifacts: ['test-results'],
  variants: [
    {
      name: 'stock',
      description:
        "A typical unoptimized setup: every test signs in through the form, trace on for every test, Playwright's default worker count, third-party scripts load.",
      env: stock,
    },
    {
      name: 'storage-state',
      description: 'signIn: sign in once in a setup project, load the saved state into each fresh context.',
      env: { ...stock, BENCH_AUTH: 'state' },
    },
    {
      name: 'trace-on-failure',
      description: 'trace: retain-on-failure.',
      env: { ...stock, BENCH_TRACE: 'retain-on-failure' },
    },
    {
      name: 'block-third-party',
      description: 'blockRequests: abort the third-party origin (analytics, chat widget).',
      env: { ...stock, BENCH_BLOCK_THIRD_PARTY: '1' },
    },
    {
      name: 'reduced-motion',
      description: 'reducedMotion: emulate prefers-reduced-motion; the app skips its transitions.',
      env: { ...stock, BENCH_REDUCED_MOTION: '1' },
    },
    {
      name: 'workers-4',
      description: 'Four workers instead of the default (half the CPUs).',
      env: { ...stock, BENCH_WORKERS: '4' },
    },
    {
      name: 'light-traces',
      description: 'lightTraces: traces for every test, with DOM snapshots only, without the screencast.',
      env: { ...stock, BENCH_LIGHT_TRACES: '1' },
    },
    {
      name: 'action-traces',
      description: "lightTraces: 'actions': traces for every test, without snapshots or the screencast.",
      env: { ...stock, BENCH_LIGHT_TRACES: 'actions' },
    },
    {
      name: 'differential-snapshots',
      description: 'Traces for every test, with the experimental differentialSnapshots hook.',
      env: { ...stock, BENCH_DIFFERENTIAL_SNAPSHOTS: '1' },
    },
    {
      name: 'light-traces+differential',
      description: 'lightTraces (DOM snapshots only), with the experimental differentialSnapshots hook.',
      env: { ...stock, BENCH_LIGHT_TRACES: '1', BENCH_DIFFERENTIAL_SNAPSHOTS: '1' },
    },
    {
      name: 'failure-screenshots',
      description: 'failureScreenshots: screenshots of failed tests only, in place of only-on-failure.',
      env: { ...stock, BENCH_FAILURE_SCREENSHOTS: '1' },
    },
    {
      name: 'instant-animations',
      description: 'instantAnimations: CSS and Web Animations run 1000 times faster.',
      env: { ...stock, BENCH_INSTANT_ANIMATIONS: '1' },
    },
    { name: 'preset-safe', description: "preset: 'safe'.", env: { BENCH_AUTH: 'ui', BENCH_PRESET: 'safe' } },
    { name: 'preset-fast', description: "preset: 'fast'.", env: { BENCH_AUTH: 'ui', BENCH_PRESET: 'fast' } },
    { name: 'preset-experimental', description: "preset: 'experimental'.", env: { BENCH_AUTH: 'ui', BENCH_PRESET: 'experimental' } },
    {
      name: 'stock-red',
      description: 'stock, with six failing tests.',
      env: { ...stock, BENCH_FAILING: '1' },
    },
    {
      name: 'stock-red+fail-fast',
      description: 'stock with six failing tests, plus the experimental failFast hook.',
      env: { ...stock, BENCH_FAILING: '1', BENCH_FAIL_FAST: '1' },
    },
    { name: 'tuned', description: 'Every public lever above together.', env: tuned },
    {
      name: 'tuned+fast-png',
      description: 'tuned, plus the experimental fastScreenshots hook.',
      env: { ...tuned, BENCH_FAST_SCREENSHOTS: '1' },
    },
    {
      name: 'tuned+retry',
      description: `tuned, plus the experimental retryIntervals hook at [${fastRetry}] ms.`,
      env: { ...tuned, BENCH_RETRY_INTERVALS: fastRetry },
    },
    {
      name: 'tuned+hooks',
      description: 'tuned, plus both experimental hooks.',
      env: { ...tuned, BENCH_FAST_SCREENSHOTS: '1', BENCH_RETRY_INTERVALS: fastRetry },
    },
    { name: 'tuned-red', description: 'tuned, with six failing tests.', env: { ...tuned, BENCH_FAILING: '1' } },
    {
      name: 'tuned-red+fail-fast',
      description: 'tuned with six failing tests, plus the experimental failFast hook.',
      env: { ...tuned, BENCH_FAILING: '1', BENCH_FAIL_FAST: '1' },
    },
  ],
};
