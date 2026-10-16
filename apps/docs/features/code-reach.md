---
title: Code reach
description: "Which tests execute each application source file, recorded from Chromium's JavaScript coverage and an ASP.NET Core backend's coverage on a scheduled run, and used by test selection, change coverage and preflight."
lang: en-US
---

# Code reach

"Which tests reach this file?" has an answer for test code from the locators a test calls. Code reach answers it for
application code: an opt-in capture records the source files whose functions ran during each test, in the browser and,
with an instrumented ASP.NET Core backend, on the [server](#server-code), so a change to a component or a module maps
to the tests that execute it.

## Turn it on

Set `captureCodeReach: true` in the reporter options, or `PIWI_CAPTURE_CODE_REACH=true`, with the
[capture fixtures](/guide/capture-fixtures) in place. Coverage adds time to every test and reach changes slowly, so
turn it on in one scheduled job, a nightly run. A run without it keeps the reach the last one recorded.

```ts
// playwright.config.ts, in the nightly job
reporter: [['@piwitests/reporter', { captureCodeReach: !!process.env.NIGHTLY }]],
```

## What it records

The fixtures start Chromium's JavaScript coverage on every page the test has, up to 16: each page it opens, and each
page already open as it starts, such as one a `beforeAll` opened and the tests of a serial group share. At teardown,
they turn each script into source files:

- a module a dev server serves by path (Vite's `/src/components/Pay.vue`, `/@fs/…`) is the file itself;
- a bundle is read through its source map, inline or fetched once per worker (20 MB and 5 seconds at most).

A file counts when one of its functions ran. A module's top-level code runs as soon as it is imported, so it does not
count: otherwise every eagerly loaded file would be reached by every test. Paths are relative to the repository root;
files under `node_modules` or outside the repository are dropped, and at most 2,000 files are kept per test. Only the
paths leave the machine, never code, counts or line numbers.

With `coverage.browser: 'functions'` (or `PIWI_COVERAGE_BROWSER=functions`), each file also names the start and end
line of each function that ran, read through the module's or the bundle's source map (the file's own text when it
has none), and the git blob of the version they refer to, as server files do at `functions` granularity. Line numbers
then leave the machine, still never code or counts.

Paths resolve against the Playwright config's directory, then the repository root. Set `codeReachRoots` to the dev
server's root when it is elsewhere; for Nuxt that is `app/`:

```ts
reporter: [['@piwitests/reporter', { captureCodeReach: true, codeReachRoots: ['app'] }]],
```

When the tests reach several applications whose dev servers serve modules at the same paths (one Vite server per
portal, each with its own `/js/index.ts`), give `codeReachRoots` an object instead: each origin with its directories,
and `*` for every other origin. A script resolves against the directories of its own origin, else of the origin of the
page that loaded it, so the key can be the address the tests open:

```ts
codeReachRoots: {
  'http://localhost:5001': 'portals/admin/src',
  'http://localhost:5002': 'portals/customer/src',
  '*': ['shared'],
},
```

Code a bundler or dev server adds (module wrappers, hot-reload hooks) counts for no file.

When the backend is instrumented (the [Nitro or ASP.NET Core packages](/guide/backend-logs)), the handler file of each
route a test called also counts as reached, with no capture of its own.

## Supported builds

| Build | Source maps |
| --- | --- |
| Vite dev server, Nuxt dev included | none needed: modules are served by path |
| Vite build | `build: { sourcemap: true }` |
| Next.js dev, Turbopack or webpack | on by default |
| Next.js build, Turbopack or webpack | `productionBrowserSourceMaps: true` |
| webpack build | `devtool: 'source-map'` |

The map must be linked from the bundle: `sourcemap: 'hidden'` and webpack's `hidden-source-map` write the map but
not the comment that names it, so they record nothing.

Each was checked on a React app (Vite 8, webpack 5.111, Next.js 16.3) and on Piwi's own suite in Nuxt dev: every
test recorded exactly the files it ran.

## Cost

Code reach reads V8's function coverage, which records only whether each function ran, so the page's JavaScript runs
at nearly its usual speed: each test pays for a CDP session per page and one coverage read per document it leaves, and
a script's source is read once per worker. Medians on a 4-core sandbox, headless Chromium:

- **A script-heavy page** (Vue's development build rendering a 1,000-row table 30 times, plus 400 small ES modules): a
  test goes from 1,128 ms to 1,220 ms, 8% more, and 16% more for a worker's first test. Playwright's `page.coverage`
  adds 50%.
- **A light page** (the reporter's capture benchmark, `npm run reporter:bench`): 61 ms and 103 ms more per test in two
  runs, where `page.coverage` added 209 ms and 176 ms.

The extra time grows with the scripts a page loads and the documents a test opens.

## Server code

With an ASP.NET Core backend built for coverage, each test also records the backend code it ran:

1. Add the `PiwiTests.Instrumentation.Coverage` package to every project whose code you want covered, as its
   [README](https://github.com/PiwiTests/platform/tree/main/integrations/aspnetcore/PiwiTests.Instrumentation.Coverage#readme)
   shows, serve it with `app.UsePiwiTestLogs()` ([backend logs](/guide/backend-logs)), and build the test environment
   with `-p:PiwiCoverage=true`. Never ship that build to production.
2. Set the reporter's `coverage.server` option, or `PIWI_COVERAGE_SERVER`, with the capture fixtures in place.

```ts
reporter: [['@piwitests/reporter', { coverage: { server: 'lines' } }]],
```

The backend names each request's coverage on its response; once the test ends, the reporter asks the backend for the
coverage its pages' and API calls' responses named, several tests per call, outside the test's time.

| `coverage.server` | Records per test |
| --- | --- |
| `files` | the backend files that ran, paths only |
| `functions` | also the start and end line of each function that ran |
| `lines` | also the executed lines |

With `functions` and `lines`, each file names the git blob its line numbers refer to. At the end of the run the
reporter also sends the run's coverage of the backend, attributed to no test, with each file's executable lines at `lines` granularity. A test whose coverage the backend no longer held, or that could not be collected, is marked incomplete.
`coverage.browser: 'files'` is the same as `captureCodeReach: true`; `'functions'` adds the lines of each function
that ran in the browser.

- **Run level only:** lambdas created at startup (inline minimal API handlers, inline middleware, DI factory lambdas)
  and work outside a request (hosted services, timers). The methods they call count normally.
- **API calls** through Playwright's `request` fixture keep their last response's coverage only: a redirect's earlier
  responses, and a response `failOnStatusCode` turns into an error, name none.
- C# and Visual Basic only.

Measured on a prototype, per-test server coverage added under 2% to test duration on Microsoft's eShopOnWeb, whose
CPU goes to the framework, and up to 26% more server CPU on an application that spends its CPU in business logic.
Functions cost about what lines cost.

## On the execution page

Where its project records coverage, an execution's **Source** tab lists what the test ran: server files by executed
lines, then browser files. A file the failure's [suspect lines](/guide/concepts#suspect-lines) name, or that changed
since the last pass, is marked. A server file unfolds to its source at the version the test ran, marking the lines it
ran and, from the run's own coverage, the executable lines it did not.

<figure>
  <img src="/screenshots/execution-coverage.png" alt="The Coverage section of an execution's Source tab">
  <figcaption>What a failing test ran.</figcaption>
</figure>

## Which tests run a file

A file's **tests** link, on an execution or a cluster's suspect lines, and a file of the [Test Map](./scenario-gaps)
open its coverage page: its source at the version most tests ran, each line with how many tests ran it, the executable
lines none runs marked. Select a line, or Shift-click a range, for its tests and their latest outcome; on a line no
test runs, the nearest test to copy.

<figure>
  <img src="/screenshots/coverage-file.png" alt="A file's coverage page">
  <figcaption>Which tests run each line.</figcaption>
</figure>

## Where it is used

- **[Impact-from-diff](./test-selection#impact-from-diff)** maps a changed file to the tests that executed it. Code
  reach only adds tests: a changed source file no test reached still widens the run to the whole suite, since code
  reach misses top-level code, server code without [server coverage](#server-code) and type-only modules.
- **[Uncovered changes](./uncovered-changes)** counts a changed file as reached when a test executed it.
- **[Locator preflight](./preflight)** calls a break *likely* only when one of its tests reaches the changed file.
- **[Coverage in the editor](./editor-coverage)** marks the lines tests ran and the executable lines none runs, with
  the tests behind each line, in VS Code and the JetBrains IDEs.
- **[Suspect lines](/guide/concepts#suspect-lines)**: the changed lines a failure's tests executed, ranked against the
  passing tests, on the failure pages' [What changed](./failure-clusters#the-cluster-page) line and diff, in the
  [AI diagnosis](./ai-diagnosis#scm-grounded-context) and the [fix plan](./fix-plans).

The API serves the tests reaching one file and the whole map of a branch: see the
[API docs](https://piwitests.dev/demo/docs) (`/docs` on your instance).

## Limits

- **Chromium only** in the browser: other browsers have no JavaScript coverage and record no browser files. Server
  coverage works with every browser.
- **Browser files are reached, not covered:** a reached file, or a function at `functions` granularity, may hide an
  untested branch: V8 reports the functions that ran, not their lines.
- A build with neither per-module URLs nor source maps yields nothing, and so does code rendered on the server only,
  React server components included.
- A module whose top-level code calls its own functions, a table built on import, counts for every test that loads it.
- A function a minifier inlines into another as plain statements counts for the file it was inlined into.
- Chromium keeps no coverage of a document the page has left, so each one is read as it goes: the capture adds a
  `beforeunload` listener in an isolated world, out of the page's reach, and the debugger stops on it for that read. A
  document that leaves without `beforeunload` (a crash) keeps only what an earlier read saw.
- On a page open before the test, coverage starts with the test: what ran there before counts only if it runs again,
  and what a page runs on its own meanwhile (a timer, a poll) counts too, even on a page the test does not drive.
- Reach is per branch: a branch's own runs replace its tests' reach, and the default branch's stands in for the rest.

## Try it in the demo

<DemoExamples />

## Related

- [Capture fixtures](/guide/capture-fixtures): what else the fixtures record
- [Test selection](./test-selection): impact-from-diff
- [Privacy & data flow](/guide/privacy): what the reporter sends
