# @piwitests/turbo's benchmark

Compares configurations of a Playwright suite on the suite itself. It runs each configuration as a whole command,
several times, interleaved with the others. It measures the CPU and memory of every process the run starts, Chromium
included, compares each configuration with a baseline round by round with an interval, and shows where the test time
went, so you change what is actually slow. Dependency-free; not part of the published package.

## Why whole runs

Micro-benchmarks of one mechanism (a click on a static page, 24 screenshots in a row) answer "is this mechanism
faster?". They do not answer "is my suite faster?", because a real suite spends most of its time elsewhere: waiting
for navigation, for the backend, for third-party scripts, for animations. The benchmark measures whole runs and splits
their time by category, so a 40% gain on 1% of the time shows up as what it is.

## Commands

From the package folder:

```sh
node bench/cli.mjs profile --config <config>     # one run of the first variant, and where its test time went
node bench/cli.mjs run --config <config>         # every variant, interleaved; writes results.json and summary.md
node bench/cli.mjs report <results.json>         # the comparison again
```

`run` takes `--runs N`, `--warmup N`, `--only a,b` (the first selected variant is the baseline), `--out dir` and
`--min-effect 0.02`. `npm run turbo:bench` and `npm run turbo:bench:profile` run the reference workload.

## Configuration

```js
// bench.config.mjs, next to your playwright.config.ts
export default {
  command: ['npx', 'playwright', 'test'], // the command a run executes, in this file's folder
  runs: 5, // measured rounds
  warmup: 1, // rounds run first and left out of the comparison
  prepare: [['npx', 'playwright', 'test', '--grep', '@visual', '--update-snapshots']], // run once, before round one
  clean: ['test-results'], // deleted before every run
  artifacts: ['test-results'], // measured after every run
  variants: [
    { name: 'stock' }, // the first variant is the baseline
    { name: 'retry', env: { RETRY_INTERVALS: '10,20,40,50' } },
    { name: 'four-workers', args: ['--workers=4'] },
  ],
};
```

- **A variant** is environment variables (`env`), extra arguments (`args`) and paths to delete before each of its runs
  (`remove`). Read the variables in your `playwright.config.ts`, so one config serves every variant.
- **The profile reporter replaces your reporters** during a run (`--reporter`), so the measured runs leave out your
  HTML report's cost. To keep your reporters, set `injectReporter: false` and add `bench/src/profile-reporter.mjs` to
  your config's reporters: it writes nothing unless the benchmark runs it.
- `pauseMs` (default 2000) waits between runs; `sampleMs` (default 200) is the memory sampling interval.

## Reading the report

For each metric (wall time, CPU time, peak memory, artifact size), every variant gets:

| Column       | Meaning                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| Median       | The median over the measured rounds.                                                                     |
| Noise        | The median absolute deviation over the median: how much the variant moves from run to run on its own.    |
| Change       | The median of the per-round ratios against the baseline. Each round runs every variant back to back.     |
| 95% interval | A bootstrap interval of that median. With 5 rounds it is rough: read it with the next column.            |
| Rounds lower | In how many rounds the variant came out lower than the baseline.                                         |
| Verdict      | `lower` or `higher` when the interval excludes no change and the change is at least 2% (`--min-effect`). |

The correctness table counts failed runs, failed and flaky tests, and retries. A faster variant that fails or retries
more is not faster. The time breakdown attributes each step's own time (its duration minus its children's) to a
category from its Playwright step category and title, summed across workers.

## How it measures

- **Interleaved rounds**: round _n_ runs every variant once, in an order rotated each round and reversed every other
  round, so drift (a machine heating up, a neighbor on a shared CI host) affects every variant alike and the per-round
  ratios cancel it.
- **CPU** (Linux): the kernel's count of user and system time of every reaped descendant of the command, read from
  `/proc/self/stat` before and after: exact, and it includes Chromium, the web server and the workers. A process the
  run leaves behind, re-parented to `init` once its parent exits, is not counted.
- **Memory** (Linux): the peak, over samples, of the summed PSS of the process tree, which splits shared pages between
  the processes sharing them. macOS reports summed RSS, which overcounts; Windows reports wall time only.
- **Artifacts**: the size of `artifacts` after each run: traces, videos and screenshots cost upload time and storage.

## The reference workload

`workload/` is an orders console (a dependency-free Node server and a single-page app) and a 43-test suite with the
shapes real suites have: an API whose responses take 50–500 ms and a session check on every page load; two
third-party scripts on another origin that hold the `load` event for about a second; a debounced search, a 1,200-row
table, a polled export job; dialogs, toasts and page transitions that animate; tests that sign in, create their own
data through the API, run signed out, compare five screenshots and attach evidence screenshots.

Its `playwright.config.ts` applies each lever through @piwitests/turbo from one environment variable, and
`workload/bench.config.mjs` lists the variants. `LATENCY=0.5` halves every server delay.

## Limits

- One machine at a time: compare results from the same machine only.
- Five rounds detect changes of a few percent on a quiet machine. Add rounds when the noise column is close to the
  effect you want to see.
- The time categories come from step titles, which Playwright may rename between versions; time it cannot place counts
  as test code.
