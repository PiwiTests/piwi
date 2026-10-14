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
turn it on in one scheduled job, a nightly run, rather than on every run. A run without it keeps the reach the last one
recorded.

```ts
// playwright.config.ts, in the nightly job
reporter: [['@piwitests/reporter', { captureCodeReach: !!process.env.NIGHTLY }]],
```

## What it records

The fixtures start Chromium's JavaScript coverage on the test's first page and, at teardown, turn each script into
source files:

- a module a dev server serves by path (Vite's `/src/components/Pay.vue`, `/@fs/…`) is the file itself;
- a bundle is read through its source map, inline or fetched once per worker (20 MB and 5 seconds at most).

A file counts when one of its functions ran. A module's top-level code runs as soon as it is imported, so it does not
count: otherwise every eagerly loaded file would be reached by every test. Paths are relative to the repository root;
files under `node_modules` or outside the repository are dropped, and at most 2,000 files are kept per test. Only the
paths leave the machine, never code, counts or line numbers.

Paths resolve against the Playwright config's directory, then the repository root. Set `codeReachRoots` to the dev
server's root when it is elsewhere; for Nuxt that is `app/`:

```ts
reporter: [['@piwitests/reporter', { captureCodeReach: true, codeReachRoots: ['app'] }]],
```

Code a bundler or dev server adds (module wrappers, preload helpers, hot-reload hooks) maps to no source of its own and
counts for no file.

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

Each was checked on a React app with four components, a lazy-loaded one, a shared utility and a module imported on
start but never called, with Vite 8, webpack 5.111 and Next.js 16.3: every test recorded exactly the files it ran,
none missed and none extra. Nuxt dev was checked on Piwi's own suite. The same builds without source maps record
nothing.

## Cost

Code reach reads V8's function coverage, which records only whether each function ran, so the page's own JavaScript
runs at nearly its usual speed. Each test pays for a CDP session with the debugger on, which reports every script's
version, and for one coverage read at the end. A script's source is read once per worker, the first time a test loads
that version of it. Measured on a 4-core sandbox (Xeon at 2.10 GHz, Ubuntu 24.04, Node 22, Playwright 1.63, headless
Chromium), each configuration run in turn, round after round, medians:

- **A script-heavy page** (Vue's development build rendering a 1,000-row table of components 30 times, plus 400 small
  ES modules; a new browser context per test, 15 rounds): a test goes from 1,128 ms to 1,220 ms, 8% more, and 16% more
  for a worker's first test, which reads all 403 sources. With two documents per test, 17% more. Playwright's
  `page.coverage`, which records block coverage and reads every script's source in every test, adds 50% and 54% on the
  same page, and reaches the same 137 files. Over three runs on a machine shared with other work, code reach added 5% to
  23% to a test, `page.coverage` 44% to 55%.
- **A light page** (the reporter's capture benchmark, `npm run reporter:bench`, 12 tests of 20 actions and
  assertions): 61 ms and 103 ms more per test on top of the default capture in two runs, a median test going from 1,215
  to 1,276 ms in one and from 1,140 to 1,242 ms in the other; `page.coverage` added 209 ms and 176 ms.

The extra time grows with the number of scripts the page loads and the number of documents a test opens.

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

The backend names each request's coverage on its response. The fixtures keep the names a test's pages received; once
the test ends, the reporter asks the backend for their coverage, several tests per call, outside the test's time, and
the test's result reaches the dashboard with it.

| `coverage.server` | Records per test |
| --- | --- |
| `files` | the backend files that ran, paths only |
| `functions` | also the start and end line of each function that ran |
| `lines` | also the executed lines |

With `functions` and `lines`, each file names its git blob, as `git hash-object` gives it, which its line numbers
refer to. At the end of the run the reporter also sends the run's coverage of the backend, attributed to no test, with each
file's executable lines at `lines` granularity. A test whose coverage the backend no longer held, or that could not be collected, is marked incomplete.
`coverage.browser: 'files'` is the same as `captureCodeReach: true`.

- **Run level only:** lambdas created at startup (inline minimal API handlers, inline middleware, DI factory lambdas)
  and work outside a request (hosted services, timers). The methods they call count normally.
- **Pages only:** API tests through Playwright's `request` fixture record no server coverage.
- C# and Visual Basic only.

Measured on a prototype, per-test server coverage added under 2% to test duration on Microsoft's eShopOnWeb, whose
CPU goes to the framework, and up to 26% more server CPU on an application that spends its CPU in business logic.
Functions cost about what lines cost.

## Where it is used

- **[Impact-from-diff](./test-selection#impact-from-diff)** maps a changed file to the tests that executed it. Code
  reach only adds tests: a changed source file that no test reached still widens the run to the whole suite, since
  code reach does not see module top-level code, server code without [server coverage](#server-code), or type-only
  modules.
- **[Uncovered changes](./uncovered-changes)** counts a changed file as reached when a test executed it.
- **[Locator preflight](./preflight)** calls a break *likely* only when one of its tests reaches the changed file.
- **[Suspect lines](/guide/concepts#suspect-lines)**: the changed lines a failure's tests executed, ranked against the
  passing tests, on the failure pages' [What changed](./failure-clusters#the-cluster-page) line and diff, in the
  [AI diagnosis](./ai-diagnosis#scm-grounded-context) and the [fix plan](./fix-plans).

The dashboard's API serves the tests reaching one file and the whole map of a branch; see the
[API docs](https://piwitests.dev/demo/docs) (`/docs` on your instance).

## Limits

- **Chromium only** in the browser: other browsers have no JavaScript coverage and record no browser files. Server
  coverage works with every browser.
- **Observed reach, not coverage.** A reached file may hide an untested branch: the unit is the file, never the line.
- A build with neither per-module URLs nor source maps yields nothing, and so does code rendered on the server only,
  React server components included.
- A module whose top-level code calls its own functions, a table built on import, counts for every test that loads it.
- A function a minifier inlines into another as plain statements counts for the file it was inlined into.
- A test that loads a new document in its page reaches the files of the last document only: Chromium keeps no
  coverage of a document the page has left. Client-side navigation stays in one document, and an iframe's earlier
  documents stay covered.
- Reach is per branch: a branch's own runs replace its tests' reach, and the default branch's stands in for the rest.

## Related

- [Capture fixtures](/guide/capture-fixtures): what else the fixtures record
- [Test selection](./test-selection): impact-from-diff
- [Privacy & data flow](/guide/privacy): what the reporter sends
