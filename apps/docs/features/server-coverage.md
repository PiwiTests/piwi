---
title: Server coverage
description: "The backend files, functions and lines each Playwright test ran, recorded per test from an ASP.NET Core build instrumented for coverage, even when the tests run in parallel against one backend."
lang: en-US
---

# Server coverage

With an ASP.NET Core backend built for coverage, each test records the backend code it ran: its files, the functions
that ran in them and, at the finest granularity, the executed lines. Requests are told apart, so tests running in
parallel against one shared backend each keep their own. The browser side is [code reach](./code-reach); both feed
the [execution page](./code-reach#on-the-execution-page), the [file coverage page](./code-reach#which-tests-run-a-file),
the [editors](./editor-coverage) and the [coverage insights](./coverage-insights).

## Turn it on

1. Add the `PiwiTests.Instrumentation.Coverage` package to every project whose code you want covered, as its
   [README](https://github.com/PiwiTests/platform/tree/main/integrations/aspnetcore/PiwiTests.Instrumentation.Coverage#readme)
   shows, serve it with `app.UsePiwiTestLogs()` ([backend instrumentation](/guide/backend-logs)), and build the test
   environment with `-p:PiwiCoverage=true`. Never ship that build to production: its code runs slower, and its
   coverage endpoints expose source paths and line numbers.
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
`lines`: the lines no test runs. A test whose coverage the backend no longer held, or that could not be collected,
is marked incomplete.

## How it is collected

Each response names its request's coverage in an `X-Piwi-Coverage` header. Once the test ends, outside its time, the
reporter asks each backend origin for the coverage its pages and API calls named, several tests per call. The
run-level coverage is read as the run's last test ends, while a Playwright `webServer` is still up.

## Limits

- **Run level only:** lambdas created at startup (inline minimal API handlers, inline middleware, DI factory lambdas)
  and work outside a request (hosted services, timers). The methods they call count normally.
- **API calls** through Playwright's `request` fixture keep their last response's coverage only: a redirect's earlier
  responses, and a response `failOnStatusCode` turns into an error, name none.
- **One backend per request:** a call the backend makes to another counts there only if it forwards the
  `X-Piwi-Coverage` header.
- C# and Visual Basic only.

## Cost

On a large ASP.NET Core and Vue application, the coverage build alone ran within 1% of a normal build, and per-test
line coverage added under 10% to its UI tests, with no measurable change in its CPU. The build records the same way
at every granularity, so files and functions cost what lines cost. [Coverage cost](/reference/coverage-cost) has every
mode, how it was measured, and the prototype figures.

## Related

- [Code reach](./code-reach): the browser side, and where the coverage is read
- [Coverage in the editor](./editor-coverage): the lines tests ran, in VS Code and the JetBrains IDEs
- [Backend instrumentation](/guide/backend-logs): the middleware that serves the coverage
- [Coverage cost](/reference/coverage-cost): what each mode costs
