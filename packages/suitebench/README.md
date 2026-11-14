# suitebench

Compare configurations of a Playwright suite on the suite itself. suitebench runs each configuration as a whole
command, several times, interleaved with the others. It measures the CPU and memory of every process the run starts,
Chromium included, and compares each configuration with a baseline round by round, with an interval. It also shows
where the test time went, so you change what is actually slow.

suitebench works with any Playwright project and has no dependencies. Its own reference workload, a realistic app and
its suite, comes with it in `workload/`.

## Why another benchmark

Micro-benchmarks of one mechanism (a click on a static page, 24 screenshots in a row) answer "is this mechanism
faster?". They do not answer "is my suite faster?", because a real suite spends most of its time elsewhere: waiting
for navigation, for the backend, for third-party scripts, for animations. suitebench measures whole runs of a real
suite and splits their time by category, so a 40% gain on 1% of the time shows up as what it is.

## Quick start

```sh
npm install --save-dev suitebench
npx suitebench profile
npx suitebench run
```

`profile` runs your suite once and prints where the time went:

```
Test time by category (155.1s across 2 workers, 80.5s wall):
  navigation            92.4s   60%
  assertions            43.6s   28%
  actions                7.6s    5%
  ...
```

`run` runs every variant of `suitebench.config.mjs` and writes `results.json` (every run, raw) and `summary.md` (the
comparison) to `.suitebench/<date>/`. `suitebench report <results.json>` prints the comparison again.

## Configuration

```js
// suitebench.config.mjs
export default {
  command: ['npx', 'playwright', 'test'], // the command a run executes, in this file's folder
  runs: 5, // measured rounds
  warmup: 1, // rounds run first and left out of the comparison
  prepare: [['npx', 'playwright', 'test', '--grep', '@visual', '--update-snapshots']], // run once, before round one
  clean: ['test-results'], // deleted before every run
  artifacts: ['test-results'], // measured after every run
  variants: [
    { name: 'stock' }, // the first variant is the baseline
    { name: 'retain-on-failure', env: { TRACE: 'retain-on-failure' } },
    { name: 'shard-free', args: ['--workers=4'] },
    { name: 'cold-cache', env: { NODE_COMPILE_CACHE: '.cache/node' }, remove: ['.cache/node'] },
  ],
};
```

- **A variant** is environment variables (`env`), extra arguments (`args`) and paths to delete before each of its runs
  (`remove`). Read the variables in your `playwright.config.ts`, so one config serves every variant.
- **The profile reporter replaces your reporters** during a run (`--reporter`), so the measured runs do not include
  your HTML report's cost. To keep your reporters, set `injectReporter: false` and add `'suitebench/reporter'` to your
  config's `reporter` list: it writes nothing unless suitebench runs it.
- **A private hook or patch** is one more variant: `env: { NODE_OPTIONS: '--import ./hooks/my-hook.mjs' }` loads it into
  the runner and every worker.
- `pauseMs` (default 2000) waits between runs; `sampleMs` (default 200) is the memory sampling interval.

## Reading the report

For each metric (wall time, CPU time, peak memory, artifact size), every variant gets:

| Column       | Meaning                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| Median       | The median over the measured rounds.                                                                      |
| Noise        | The median absolute deviation over the median: how much this variant moves from run to run on its own.  |
| Change       | The median of the per-round ratios against the baseline. Each round runs every variant back to back.      |
| 95% interval | A bootstrap interval of that median. With 5 rounds it is rough: read it with the next column.              |
| Rounds lower | In how many rounds the variant came out lower than the baseline.                                          |
| Verdict      | `lower` or `higher` when the interval excludes no change and the change is at least 2% (`--min-effect`). |

The correctness table counts failed runs, failed and flaky tests, and retries per variant. A faster variant that
fails or retries more is not faster.

The time breakdown attributes each step's own time (its duration minus its children's) to a category from its
Playwright step category and title. It sums across workers, so it reads as "test time", not wall time.

## How it measures

- **Interleaved rounds**: round _n_ runs every variant once, in an order rotated each round and reversed every other
  round. A machine that heats up, a backup that starts or a neighbor on a shared CI host affects every variant alike,
  and the per-round ratios cancel it.
- **CPU** (Linux): the kernel's count of user and system time of every reaped descendant of the command, read from
  `/proc/self/stat` before and after. It is exact and includes Chromium, the web server and the workers.
- **Memory** (Linux): the peak, over samples, of the summed PSS of the process tree. PSS splits shared pages between
  the processes sharing them, so the sum is not inflated by Chromium's shared memory. macOS reports summed RSS instead,
  which overcounts; Windows reports wall time only.
- **Artifacts**: the size of `artifacts` after each run, since traces, videos and screenshots cost upload time and
  storage in CI.

## The reference workload

`workload/` is an orders console (a dependency-free Node server and a single-page app) and a 43-test suite that has the
shapes real suites have:

- an API whose responses take 50–500 ms, and a session check on every page load
- two third-party scripts on another origin (analytics, a chat widget) that hold the `load` event for about a second
- a debounced search, a 1,200-row table, a polled export job
- dialogs, toasts and page transitions that animate
- tests that sign in, tests that create their own data through the API, signed-out tests, five visual comparisons and
  a few evidence screenshots

Its `playwright.config.ts` reads one environment variable per lever (sign-in, tracing, workers, reduced motion,
third-party blocking, screenshot format), and `workload/suitebench.config.mjs` compares them. From this package's
folder, with `@playwright/test` and Chromium installed:

```sh
npm run workload:profile
npm run workload
```

`LATENCY=0.5` halves every server delay, `LATENCY=0` removes them.

## Limits

- One machine at a time. Compare results from the same machine only.
- Five rounds detect changes of a few percent on a quiet machine, not 1% changes. Add rounds when the noise column is
  close to the effect you want to see.
- The time categories come from step titles, which Playwright may rename between versions; time it cannot place counts
  as test code.

## License

MIT
