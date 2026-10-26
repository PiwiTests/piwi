---
title: Server coverage
description: "The backend files, functions and lines each Playwright test ran, recorded per test from an ASP.NET Core or Nitro build instrumented for coverage, even when the tests run in parallel against one backend."
lang: en-US
---

# Server coverage

With an ASP.NET Core or a Nitro backend built for coverage, each test records the backend code it ran: its files, the
functions that ran in them and, at the finest granularity, the executed lines. Requests are told apart, so tests running in
parallel against one shared backend each keep their own. The browser side is [code reach](./code-reach); both feed
the [execution page](./code-reach#on-the-execution-page), the [file coverage page](./code-reach#which-tests-run-a-file),
the [editors](./editor-coverage) and the [coverage insights](./coverage-insights).

## Turn it on

1. Build the backend for coverage, in the test environment only:
   - **ASP.NET Core:** add the `PiwiTests.Instrumentation.Coverage` package to every project whose code you want
     covered, as its
     [README](https://github.com/PiwiTests/piwi/tree/main/integrations/aspnetcore/PiwiTests.Instrumentation.Coverage#readme)
     shows, serve it with `app.UsePiwiTestLogs()` ([backend instrumentation](/guide/backend-logs)), and build with
     `-p:PiwiCoverage=true`. It refuses to start in the Production environment, and `PiwiCoverageForbidden` makes a
     build fail when coverage reaches it
     ([README](https://github.com/PiwiTests/piwi/tree/main/integrations/aspnetcore/PiwiTests.Instrumentation.Coverage#enabling-it)).
   - **Nitro:** with the plugin and the module of `@piwitests/instrumentation-nitro` in place
     ([README](https://github.com/PiwiTests/piwi/tree/main/integrations/nitro#server-coverage)), set
     `PIWI_COVERAGE_BUILD=true` when the server is built (`nitro build`, or `nitro dev`). The module then instruments
     the server's own code. A coverage build refuses to start where `NODE_ENV` is `production`, which `nitro build`
     makes it, unless `PIWI_TEST_LOGS_DISABLED=false` serves it there; `PIWI_COVERAGE_FORBIDDEN=true` makes a coverage
     build fail.

   Never ship that build to production: its code runs slower, and its coverage endpoints expose source paths and line
   numbers.
2. Set the reporter's `coverage.server` option, or `PIWI_COVERAGE_SERVER`, with the
   [capture fixtures](/guide/capture-fixtures) in place.

```ts
reporter: [['@piwitests/reporter', { coverage: { server: 'lines' } }]],
```

Against a backend that is not a coverage build, no response names any coverage, so the reporter collects nothing and
the option costs nothing: it can stay on, and the build decides.

## What it records

| `coverage.server` | Records per test |
| --- | --- |
| `files` | the backend files that ran, paths only |
| `functions` | also the start and end line of each function that ran |
| `lines` | also the executed lines |

With `functions` and `lines`, each file names the git blob its line numbers refer to. At the end of the run the
reporter also sends each backend's run-level coverage, attributed to no test, with each file's executable lines at
`lines`: the lines no test runs, in every assembly or every Nitro server file built with coverage, including those
whose code never ran. A test
whose coverage the backend no longer held, or that could not be collected, is marked incomplete.

<figure>
  <img src="/screenshots/server-coverage.png" alt="The backend files one test ran, recorded by line">
  <figcaption>One test's backend files, with the lines it ran.</figcaption>
</figure>

The backend names the checksum of the source each file was built from. When the file in the reporter's checkout
differs (the backend was built from another commit), the reporter keeps the file's path but drops its line numbers,
which would point at the wrong lines, and marks the test incomplete; the run-level coverage drops them the same way.

## How it is collected

Each response names its request's coverage in an `X-Piwi-Coverage` header. Once the test ends, outside its time, the
reporter asks each backend origin for the coverage its pages and API calls named, several tests per call. The
run-level coverage is read as the run's last test ends, while a Playwright `webServer` is still up, and the lines and
functions the tests' coverage named are added to it. Every answer names the backend process: a random id, which also
starts each request id, and when the process started. The run-level coverage is whole only when the process that
answers it is the one that served the run's first requests.

## Limits

- **API calls** through Playwright's `request` fixture keep their last response's coverage only: a redirect's earlier
  responses, and a response `failOnStatusCode` turns into an error, name none.
- **One backend per request:** a call the backend makes to another counts there only if it forwards the
  `X-Piwi-Coverage` header.
- **A restart during the run:** the new process starts with no coverage. Each test's lines are kept, from its own
  coverage; what the earlier process ran outside a request (startup, background work) is lost, and a test whose
  requests it served but the reporter had not yet collected is marked incomplete. The reporter warns, the run's header
  reads *Coverage incomplete: the backend restarted during the run*, and the run's coverage in the
  [API](https://piwitests.dev/demo/docs) names the origin and about when it restarted. A backend unreachable at the
  end of the run is flagged the same way, with only the tests' lines kept. The commit's
  [combined coverage](./combined-coverage) notes the run, and its `e2e` suite reads as incomplete unless a complete
  run of the commit counts beside it. A Nitro development server restarts on every rebuild.
- **Run level only:** work outside a request (hosted services, timers started at startup), and work a request started
  that still runs once the reporter collected its coverage. On ASP.NET Core, lambdas created at startup too (inline
  minimal API handlers, inline middleware, DI factory lambdas); the methods they call count normally. On Nitro, a
  module's top-level code: it runs when the module loads, often inside the first request that reaches its route.

**ASP.NET Core:**

- **Exclusions:** the coverage build leaves out what coverlet does, read from the project's coverlet settings
  ([README](https://github.com/PiwiTests/piwi/tree/main/integrations/aspnetcore/PiwiTests.Instrumentation.Coverage#what-it-leaves-out)):
  an excluded member has no executable lines and no coverage.
- C# and Visual Basic only.

**Nitro:**

- **The server's own code only:** the files the build bundles, under the repository, outside `node_modules`. A
  dependency Nitro keeps external is not covered. A Nuxt application's `server/` code is; its pages and components
  rendered on the server are not yet.
- **Lines are the statements' first lines**, as Istanbul and Vitest count them: a statement spanning several lines
  counts its first one. A class field's initializer is not instrumented.
- **Callbacks that lose the request's async context**, such as those a library queues without `AsyncResource`, count
  at run level.
- Node only: the Bun, Deno and edge presets are not covered.

## Cost

On a large ASP.NET Core and Vue application, the coverage build alone ran within 1% of a normal build, and per-test
line coverage added under 10% to its UI tests, with no measurable change in its CPU. The build records the same way
at every granularity, so files and functions cost what lines cost. [Coverage cost](/reference/coverage-cost) has every
mode, how it was measured, and the prototype figures.

## Try it in the demo

<DemoExamples />

## Related

- [Code reach](./code-reach): the browser side, and where the coverage is read
- [Coverage in the editor](./editor-coverage): the lines tests ran, in VS Code and the JetBrains IDEs
- [Backend instrumentation](/guide/backend-logs): the middleware that serves the coverage
- [Coverage cost](/reference/coverage-cost): what each mode costs
