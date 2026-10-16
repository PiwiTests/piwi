---
title: Coverage cost
description: "What each coverage mode records, what leaves the machine, and what it costs in test time and CPU, measured on a large ASP.NET Core and Vue application and on synthetic pages."
lang: en-US
---

# Coverage cost

Coverage has two sides, each opt-in: the browser's, [code reach](/features/code-reach), and the backend's,
[server coverage](/features/server-coverage). Each mode below records more than the one above it on its side.

## The modes

| Mode | Turn it on | Records per test | Leaves the machine |
| --- | --- | --- | --- |
| Browser files | `coverage.browser: 'files'`, or `captureCodeReach: true` | the application files whose functions ran | paths |
| Browser functions | `coverage.browser: 'functions'` | also the start and end line of each function that ran | paths, line numbers, git blob ids |
| Server files | `coverage.server: 'files'`, with a coverage build | the backend files that ran | paths |
| Server functions | `coverage.server: 'functions'` | also the start and end line of each function that ran | paths, line numbers, git blob ids |
| Server lines | `coverage.server: 'lines'` | also the executed lines, and the run's executable lines | paths, line numbers, git blob ids |

Never source code, never hit counts. Each variable form (`PIWI_COVERAGE_BROWSER`, `PIWI_COVERAGE_SERVER`) fills the
option the Playwright config leaves unset.

## On a large ASP.NET Core and Vue application

Against the same suite, on the same coverage build, with every coverage option off:

| Mode | UI tests | API tests | Chromium CPU | Backend CPU |
| --- | ---: | ---: | ---: | ---: |
| Server lines | +2% (−7 to +6%) | 0% | −3% | −6% |
| Browser files | +40% (+38 to +58%) | −4% | +51% | +3% |
| Browser functions | +47% (+40 to +69%) | 0% | +55% | +5% |
| Server lines and browser functions | +51% (+40 to +64%) | +4% | +63% | +11% |

- **UI tests:** in each round, each UI test's time against its time in that round's pass with coverage off, and the
  median of those ratios; then the median over the rounds, their range in brackets. The UI tests that ran took 10 to 51
  seconds with coverage off; with browser coverage, the 51-second one took about 72.
- **CPU:** the run's total for Chromium's renderer processes, and for the four backend processes, against the same
  round's pass with coverage off.
- **Noise:** the passes with coverage off alone varied by more than 10% from one round to the next, which is why each
  mode is compared within its round: read a difference under 10% as none.
- **The coverage build itself,** every option off, ran within 1% of a normal build of the same backend.
- **Server files and server functions** were not measured apart: the build records the same way at every granularity,
  which only decides what each test's report names.

**The application:** an ASP.NET Core backend serving four web front-ends, each a Vue 3 application its own Vite dev
server serves, about 500 ES modules on a page, full page loads between screens, PostgreSQL. **The suite:** 18 tests,
6 driving the front-ends and 12 calling the backend through Playwright's `request` fixture, 3 workers, headless
Chromium, on a 20-core machine. After a warm-up pass, rounds ran one pass of each mode in turn, so each mode ran three
to five times.

**What the browser side spends.** For each document a test loads, the debugger reports every script, the reporter
reads the source of each application script its worker has not seen yet, and V8's precise coverage keeps a record of
every function the page runs; as the test leaves the document, the reporter stops the page to read that record and
resolves it to files. Each of these works on every module of every document, so the cost grows with the modules a page
loads and with the full page loads a test makes: an application that loads its modules once, then navigates on the
client, pays far less, as the synthetic pages below show. Files and functions cost about the same: both read the same
record, functions only keep more of it.

## On synthetic pages

Browser files, medians on a 4-core sandbox, headless Chromium, one page per test:

- **A script-heavy page** (Vue's development build rendering a 1,000-row table 30 times, 400 ES modules): 1,128 ms to
  1,220 ms per test, 8% more, and 16% for a worker's first test, where Playwright's `page.coverage` adds 50%.
- **A light page** (the reporter's capture benchmark, `npm run reporter:bench`): 61 to 103 ms more per test, where
  `page.coverage` adds 176 to 209 ms.

Server coverage, on a prototype of the coverage package: under 2% of test duration on Microsoft's eShopOnWeb, whose
CPU goes to the framework; up to 26% more backend CPU on an application written to spend its CPU in business logic, and
6% in its run-level mode. Functions cost about what lines cost: the cost is the recorder's call on every method call.

## Choosing

- **Server coverage** can stay on in every run: against a backend that is not a coverage build, it collects nothing
  and costs nothing, so the build decides. On a coverage build, every granularity costs what lines cost, under 10% of
  the UI tests' time: record lines, unless the reports' size matters more than their detail.
- **Browser coverage** belongs in a scheduled run on a large application served by a dev server, where it adds 40 to
  50% to the UI tests. Files and functions cost about the same, so a scheduled run may as well record functions. On an
  application that loads its modules once, it costs little enough to stay on.
