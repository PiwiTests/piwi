# Capture-overhead benchmark

What the capture fixtures cost a suite that uses them. Two harnesses, because the question has two halves:

| Harness    | Command                        | Answers                                                                 |
| ---------- | ------------------------------ | ----------------------------------------------------------------------- |
| End-to-end | `npm run reporter:bench`       | "how much slower is my suite" — real browser, real protocol round trips |
| Micro      | `npm run reporter:bench:micro` | "where does the worker's CPU go" — no browser, low variance             |

Both live here rather than in the Vitest unit suite or the integration project: `vitest.config.ts` excludes
`tests/bench/**` from `reporter:test`, and points `benchmark.include` at the `.bench.ts` file.

## End-to-end (`run.mjs`)

`workload.spec.ts` is one workload — a navigation, two form fills, N clicks that each trigger a fetch, and N web-first
assertions — run under a ladder of capture configurations. Each rung adds one layer, so the gap between neighbors is
the cost of that layer alone:

| Variant      | What it adds                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `baseline`   | plain `@playwright/test`, no Piwi fixtures registered                                                  |
| `fixtures`   | console/network listeners, web vitals, the teardown flush                                              |
| `page-state` | the end-of-test page/storage/cookie read                                                               |
| `full`       | locator healing capture                                                                                |
| `resources`  | the resource ledger and the per-test worker reads (`PIWI_CAPTURE_RESOURCES`) — the shipped default     |
| `code-reach` | Chromium JavaScript coverage for code reach (`PIWI_CAPTURE_CODE_REACH`), opt-in, on top of `resources` |

Variants are selected through the same `PIWI_*` env vars users set (`PIWI_CAPTURE_LOCATORS`,
`PIWI_CAPTURE_PAGE_STATE`, `PIWI_CAPTURE_RESOURCES`), and the spec imports `dist/` — the built package is what users install, so that is what
gets benchmarked. Run `npm run reporter:build` first (`reporter:bench` does it for you).

Every variant runs once per round and the rounds repeat, so a machine that drifts drifts across all variants rather
than penalizing whichever ran last. The first round is a warm-up and is discarded.

```bash
npm run reporter:bench                                          # defaults below
node tests/bench/run.mjs --rounds 5 --rows 800 --actions 20      # heavier page, more actions
node tests/bench/run.mjs --only baseline,full --target roleless  # isolate the ARIA snapshot
node tests/bench/run.mjs --json results.json                     # machine-readable
```

| Flag                         | Default    | Meaning                                                                    |
| ---------------------------- | ---------- | -------------------------------------------------------------------------- |
| `--rounds`                   | 3          | measured rounds (plus one discarded warm-up)                               |
| `--rows`                     | 200        | table rows on the fixture page — the DOM-size axis                         |
| `--tests`                    | 12         | test cases per run                                                         |
| `--actions` / `--assertions` | 10 / 10    | captured operations per test                                               |
| `--target`                   | `role`     | `role` (buttons) or `roleless` (plain spans)                               |
| `--sites`                    | `distinct` | `distinct` (one line per operation) or `shared` (one line, run repeatedly) |
| `--only`                     | all        | comma-separated variant keys                                               |
| `--json`                     | —          | write the aggregated rows to a file                                        |

### Three things worth knowing before reading the output

**Call-site shape sets the range.** The fixtures probe a target once per source location per test, so a suite that
spells every step out on its own line pays for every operation, while a loop or a repeatedly-called page-object method
pays once. `--sites distinct` and `--sites shared` bound that range; neither alone is a fair summary of "the" overhead.

**DOM size is a primary axis.** Page weight drives what a capture costs — mostly through Playwright re-resolving the
locator, and secondarily through the probe's document-wide scans. A number measured at `--rows 50` does not predict
`--rows 800`. Run the size you care about.

**Most of a capture is not our code.** Attributed at 200 rows: a `locator.evaluate` round trip is ~5.5 ms, of which
~4.5 ms is Playwright resolving the selector again and ~0.9 ms is the protocol hop (`page.evaluate(() => 1)` costs
0.94 ms). The probe body itself is ~1.8 ms, and its structural scan ~0.8 ms of that. So tuning the probe's DOM work
buys little; removing whole round trips is what moves the number.

**This harness cannot resolve small effects.** Two runs of identical code on a loaded machine have landed 10% apart on
the `distinct` shape and 2× apart on `shared` — the locator layer there is a handful of probes against a much larger
baseline, so a per-capture change of 1–2 ms disappears into it. Before believing a small win, measure the mechanism
directly: drive the two code paths against one page, alternating between them so warm-up and drift hit both, and
compare medians over tens of samples. Reach for this harness to size a layer, not to A/B a micro-optimization.

## Micro (`hot-path.bench.ts`)

Vitest benches for the Node-side work the fixtures do in the worker process: the stack capture taken on every action,
the Proxy indirection on every locator property access, alternative generation, and the teardown serialization. These
scale with test count rather than page weight, and they run against `src/` with fakes standing in for the browser, so
the browser's variance is out of the picture entirely.

The instrumented-action bench drives the **real** fixtures (`piwiFixtures.page` + `piwiFixtures.piwiCapture`) against a
fake page whose probe resolves immediately — no reimplementation of the hot path to drift out of sync.

## Reference numbers

Measured on the sandbox this was developed in — 4-core Xeon @ 2.10GHz, Node 22.22, Playwright 1.61.1, headless
Chromium. Treat them as shape, not as a spec; re-run on your own hardware for absolute figures.

End-to-end, 12 tests × (10 actions + 10 assertions) on a 200-row page, median per test:

| Call sites | baseline | + fixtures | + page state | + locator healing       |
| ---------- | -------- | ---------- | ------------ | ----------------------- |
| `distinct` | 798 ms   | —          | —            | **+29.4%** (11.7 ms/op) |
| `shared`   | 803 ms   | −0.7%      | +0.6%        | **+14.0%** (5.6 ms/op)  |

Everything except locator healing sits within run-to-run noise. Locator healing dominates, and its cost scales with
page weight: on the same workload the locator layer runs roughly 2× cheaper at 50 rows and 2–3× dearer at 800.

The resource ledger and the per-test worker reads (`resources`), on the same workload with Playwright 1.63, measured
+15 ms and +0 ms per test over `full` in two runs of four rounds (1,146 → 1,160 ms and 1,206 → 1,206 ms): within the
noise. Timed directly, a worker's reads take about 2 ms at each test's end, and a page that outlives its test about
2 ms more per test over CDP.

Code reach (`code-reach`, which sits on top of `resources`) reads V8's function coverage through a CDP session. On the
same workload with Playwright 1.63 and the pinned Chromium 141, it added 103 ms per test over `resources` in four
rounds (1,140 → 1,242 ms), and 61 ms in six rounds run against a build that read Playwright's block coverage
(`page.coverage`) instead, the two alternating round by round (1,215 → 1,276 ms); `page.coverage` added 176 ms and
209 ms in the same runs. The page runs little JavaScript, so that is close to the floor.
On a script-heavy page (Vue's development build and 400 ES modules), function coverage added 8% to a test where
`page.coverage` added 50%; the Code reach docs page has the details.

The pieces of one capture, timed directly against a single page (medians over tens of alternating samples, which is
how to measure anything this small — see above):

|                                                             | 200 rows | 800 rows |
| ----------------------------------------------------------- | -------- | -------- |
| DOM read, probe source shipped with the call                | 12.4 ms  | 16.4 ms  |
| DOM read, seeded probe called by name                       | 11.0 ms  | 14.9 ms  |
| extra `ariaSnapshot()`, when the name isn't already settled | 2.0 ms   | 3.7 ms   |

Micro, per captured operation:

|                                                         | mean              |
| ------------------------------------------------------- | ----------------- |
| `captureCallerLocation()`                               | 55 µs             |
| └ `new Error().stack` (capture half)                    | 38 µs             |
| └ walking the stack (parse half)                        | 4.9 µs            |
| `generateAlternatives()`                                | 2.4 µs            |
| `JSON.stringify` of the origin args                     | 0.3 µs            |
| dedupe + serialize 40 snapshots (per test, at teardown) | 68 µs             |
| locator property read, bare → through the proxy         | 0.09 µs → 0.16 µs |

The Node-side total is ~60 µs per operation — three orders of magnitude below the browser round trips above, so it
never shows up in the end-to-end numbers. Within it, materializing the stack for the call-site location is ~85% of the
cost and the parsing this package controls is the rest. That location is what keys the per-call-site dedupe, so it is
taken on every action whether or not a probe follows it.
