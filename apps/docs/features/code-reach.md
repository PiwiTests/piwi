---
title: Code reach
description: "Which tests execute each application source file, recorded from Chromium's JavaScript coverage and an ASP.NET Core backend's coverage on a scheduled run, and used by test selection, change coverage and preflight."
lang: en-US
---

# Code reach

Code reach answers "which tests reach this file?" for application code: an opt-in capture records the source files
whose functions ran during each test, in the browser and, with an instrumented ASP.NET Core backend, on the
[server](#server-code), so a change to a component or a module maps to the tests that execute it.

## Turn it on

Set `captureCodeReach: true` in the reporter options, or `PIWI_CAPTURE_CODE_REACH=true`, with the
[capture fixtures](/guide/capture-fixtures) in place. Coverage adds time to every test and reach changes slowly, so
turn it on in one scheduled job; a run without it keeps the reach the last one recorded.

```ts
// playwright.config.ts, in the nightly job
reporter: [['@piwitests/reporter', { captureCodeReach: !!process.env.NIGHTLY }]],
```

## What it records

The fixtures start Chromium's JavaScript coverage on each page the test has, up to 16, a page a `beforeAll` opened
included, and at teardown turn each script into source files:

- a module a dev server serves by path (Vite's `/src/components/Pay.vue`, `/@fs/…`) is the file itself;
- a bundle is read through its source map, inline or fetched once per worker (20 MB and 5 seconds at most).

A file counts when one of its functions ran. A module's top-level code runs as soon as it is imported, so it does not
count, or every eagerly loaded file would be reached by every test. Paths are relative to the repository root;
files under `node_modules` or outside the repository are dropped, and at most 2,000 files are kept per test. Only the
paths leave the machine, never code, counts or line numbers.

`coverage.browser: 'functions'` adds each function's start and end line, through the source map, and the file's git
blob: line numbers then leave the machine.

Paths resolve against the Playwright config's directory, then the repository root. Set `codeReachRoots` to the dev
server's root when it is elsewhere; for Nuxt that is `app/`:

```ts
reporter: [['@piwitests/reporter', { captureCodeReach: true, codeReachRoots: ['app'] }]],
```

For dev servers that serve modules at the same paths (one per portal), map each origin to its directories, `*` for
the rest; a script takes its own origin's, else its page's:

```ts
codeReachRoots: {
  'http://localhost:5001': 'portals/admin/src',
  'http://localhost:5002': 'portals/customer/src',
  '*': ['shared'],
},
```

Code a bundler or dev server adds (module wrappers, hot-reload hooks) counts for no file.

With an instrumented backend (the [Nitro or ASP.NET Core packages](/guide/backend-logs)), the handler file of each
route a test called counts as reached too.

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

Each was checked on a React app (Vite 8, webpack 5.111, Next.js 16.3) and Piwi's own Nuxt dev suite: every test
recorded exactly the files it ran.

## Cost

Code reach reads V8's function coverage, which records only whether each function ran, so pages run at nearly their
usual speed: a test pays for a CDP session per page and a coverage read per document it leaves, and a script's source
is read once per worker. Medians on a 4-core sandbox, headless Chromium:

- **A script-heavy page** (Vue's development build rendering a 1,000-row table 30 times, 400 ES modules): 1,128 ms to
  1,220 ms per test, 8% more, 16% for a worker's first test, where Playwright's `page.coverage` adds 50%.
- **A light page** (`npm run reporter:bench`): 61 to 103 ms more per test, where `page.coverage` adds 176 to 209 ms.

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

Each response names its request's coverage; once the test ends, outside its time, the reporter collects what its pages
and API calls named, several tests per call.

| `coverage.server` | Records per test |
| --- | --- |
| `files` | the backend files that ran, paths only |
| `functions` | also the start and end line of each function that ran |
| `lines` | also the executed lines |

With `functions` and `lines`, each file names the git blob its line numbers refer to. The run's end also sends the
backend's run-level coverage, with each file's executable lines at `lines`. A test whose coverage the backend no
longer held, or that could not be collected, is marked incomplete.
`coverage.browser: 'files'` is the same as `captureCodeReach: true`.

- **Run level only:** lambdas created at startup (inline minimal API handlers, inline middleware, DI factory lambdas)
  and work outside a request (hosted services, timers). The methods they call count normally.
- **API calls** through Playwright's `request` fixture keep their last response's coverage only: a redirect's earlier
  responses, and a response `failOnStatusCode` turns into an error, name none.
- C# and Visual Basic only.

On a prototype, per-test server coverage added under 2% to test duration on Microsoft's eShopOnWeb, whose CPU goes to
the framework, and up to 26% server CPU where business logic takes it; functions cost about what lines cost.

## On the execution page

An execution's **Source** tab lists what the test ran: server files by executed lines, then browser files. A file the
failure's [suspect lines](/guide/concepts#suspect-lines) name, or that changed since the last pass, is marked. A file
with line numbers unfolds to its source at the version the test ran, marking what it ran and, from the run's own
coverage, the executable lines it did not.

<figure>
  <img src="/screenshots/execution-coverage.png" alt="The Coverage section of an execution's Source tab">
  <figcaption>What a failing test ran.</figcaption>
</figure>

## Which tests run a file

A file's **tests** link, on an execution, a cluster's suspect lines or the [Test Map](./scenario-gaps), opens its
coverage page: its source at the version most tests ran, each line with how many tests ran it, the executable lines
none runs marked. Select a line or a range for its tests and their latest outcome; on a line no test runs, the nearest
test to copy.

<figure>
  <img src="/screenshots/coverage-file.png" alt="A file's coverage page">
  <figcaption>Which tests run each line.</figcaption>
</figure>

## Where it is used

- **[Impact-from-diff](./test-selection#impact-from-diff)** maps a changed file to the tests that executed it; a changed
  file no test reached still widens the run to the whole suite, since code reach misses top-level code, server code
  without [server coverage](#server-code) and type-only modules.
- **[Uncovered changes](./uncovered-changes)** counts a changed file as reached when a test executed it.
- **[Locator preflight](./preflight)** calls a break *likely* only when one of its tests reaches the changed file.
- **[Coverage in the editor](./editor-coverage)** marks the lines tests ran and the ones none runs, in VS Code and the
  JetBrains IDEs.
- **[Suspect lines](/guide/concepts#suspect-lines)**: the changed lines a failure's tests executed, on the failure
  pages' [What changed](./failure-clusters#the-cluster-page), in the [AI diagnosis](./ai-diagnosis#scm-grounded-context)
  and the [fix plan](./fix-plans).

The [API](https://piwitests.dev/demo/docs) (`/docs` on your instance) serves the tests reaching a file and a branch's map.

## Limits

- **Chromium only** in the browser: other browsers have no JavaScript coverage and record no browser files. Server
  coverage works with every browser.
- **Browser files are reached, not covered:** a reached file may hide an untested branch.
- A build with neither per-module URLs nor source maps yields nothing, and so does code rendered on the server only,
  React server components included.
- A module whose top-level code calls its own functions, a table built on import, counts for every test that loads it.
- A function a minifier inlines into another counts for the file it was inlined into.
- Chromium drops the coverage of a document the page leaves, so it is read on `beforeunload`, from a listener in an
  isolated world; a document left without one (a crash) keeps what an earlier read saw.
- On a page open before the test, what ran before counts only if it runs again; what a page runs on its own (a timer)
  counts too.
- Reach is per branch: a branch's own runs replace its tests' reach, and the default branch's stands in for the rest.

## Try it in the demo

<DemoExamples />

## Related

- [Capture fixtures](/guide/capture-fixtures): what else the fixtures record
- [Test selection](./test-selection): impact-from-diff
- [Privacy & data flow](/guide/privacy): what the reporter sends
