# Playwright for .NET: an MIT NuGet adapter that reports to Piwi

**Status.** Proposed 2026-11-15, nothing built. The maintainer chose this over stating Playwright for .NET a non-goal
(step L7 of [editor-ux-coherence.md](editor-ux-coherence.md)). Java and Python stay outside: this proposal is about
.NET alone, where Piwi already instruments the backend (`integrations/aspnetcore`).

**Summary.** A team that writes its Playwright tests in C# (NUnit, MSTest or xUnit, through Microsoft's
`Microsoft.Playwright.*` test packages) cannot report to Piwi: the reporter is a Playwright Test reporter for
TypeScript and JavaScript. Such a team often has its backend in ASP.NET Core, which Piwi's instrumentation already
reads, so it gets the server side of Piwi without the test side. An MIT NuGet package, living beside the
instrumentation, would write Piwi's run report from those frameworks' results and upload it the way the TypeScript
reporter's batch path does. It brings run history, failure grouping, flaky scores and traces to those suites; the
features built on the TypeScript reporter's fixtures and run channel stay TypeScript's, each said plainly below.

## 1. What Piwi needs from a run

The instance takes a whole run in one request: `POST /api/test-runs/submit` with the run's body
(`TestRunSubmitPayload` in `apps/application/shared/types.ts`: the run's metadata, then one `TestCasePayload` per
attempt), or `POST /api/test-runs/upload` with the files beside it. The TypeScript reporter falls back to these when it
cannot stream; an adapter that only submits at the run's end needs nothing new from the instance. Per attempt, Piwi
reads:

| Field                           | From a .NET test                                                                                                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `location`                      | The test method's source file and line (`file:line:column`), from the test assembly's portable PDB, made repository-relative by the rule `PiwiSourceFiles` already follows (`PIWI_SOURCE_ROOT`, a deterministic build's `/_/`, the repository root) |
| `suitePath`, `title`            | The namespace and class as the describe path, the method name (with a test case's arguments) as the title                                                                                                                                           |
| `browser`                       | The browser the framework ran (`BROWSER`, the `.runsettings` Playwright section)                                                                                                                                                                    |
| `status`, `duration`, `retries` | The framework's outcome; NUnit's `[Retry]` attempts as retries                                                                                                                                                                                      |
| `error`                         | The exception's message and stack                                                                                                                                                                                                                   |
| `externalId`                    | A stable id the suite gives a test, when it gives one                                                                                                                                                                                               |
| files                           | The trace (`context.Tracing.StopAsync` to a file), the screenshot on failure, the video, sent with the body to `/upload`                                                                                                                            |

The run's metadata comes from the environment as the TypeScript reporter's does: the CI's variables, the commit, the
branch, `PIWI_DASHBOARD_URL`, `PIWI_API_KEY` and `PIWI_PROJECT_NAME`.

## 2. The package

- **`integrations/playwright-dotnet/`**, MIT, a solution beside `integrations/aspnetcore`, published to NuGet by
  `reusable-publish-nuget.yml` as the instrumentation is. Its `LICENSE` and `license` metadata are MIT, as the
  root guide asks of a new integration.
- **One core package** (`PiwiTests.Playwright`): the run's body, the upload, the source-file lookup, the CI metadata.
  **One package per framework** (`PiwiTests.Playwright.NUnit`, `.MSTest`, `.Xunit`), each a small hook into that
  framework's run lifecycle (an NUnit `ITestEventListener` or a `[SetUpFixture]`, an MSTest `[AssemblyCleanup]`, an
  xUnit runner reporter), so a suite adds one package and one line.
- **Traces by default on failure**, as the TypeScript reporter's `trace: 'retain-on-failure'` advice: the framework
  package starts tracing on each test's context and keeps the file when the test fails. A suite that already traces
  keeps its own files.
- **Never blocks a run**: an unreachable instance writes the body to a file the `piwi` command can upload later, as the
  TypeScript reporter's fallback ladder ends.

## 3. What works, and what does not

Works from the first stage, since it reads only the stored run: the run and test pages, history, failure clusters (the
fingerprint reads the error text and the locator a Playwright error names, the same in both languages), flaky scores
and Flake Lab's analysis, the trace viewer (one trace format), notifications, the gate, MCP tools, the Test Map's
server side through the instrumentation.

Not without more work, each a later stage or a non-goal:

- **Locator healing** reads the locator snapshots the capture fixtures take in the page; a .NET port of the fixtures
  is a stage of its own (S4).
- **Live progress and the live view** stream from the TypeScript reporter's workers; streaming from .NET is S5.
- **The editors' run control** (stops, the paused page, Hold failures) talks to the TypeScript reporter's run channel;
  a .NET test would need its own client of it. Not planned.
- **The editors' spec features** (test lines, the test card, Run with Piwi) parse TypeScript specs; C# test files would
  need a parser in the editor service. Not planned; Rider's own test runner stays the way to run them.
- **Coverage of browser code** is recorded by the capture fixtures; not planned.

## 4. Stages

| Stage | Builds                                                                                                                             |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| S1    | The core package and NUnit: the body, the submit, source files, CI metadata; a sample in `examples/` reporting to a local instance |
| S2    | MSTest and xUnit                                                                                                                   |
| S3    | Traces, screenshots and videos uploaded with the body (`/upload`)                                                                  |
| S4    | Locator snapshots from a .NET port of the probe, for locator healing                                                               |
| S5    | Streaming: the run's progress and live view while it runs                                                                          |

Each stage ships with its docs page section and a test suite run by CI's .NET job (`dotnet test` over the new
solution), as the instrumentation's is.

## 5. Open questions

- A test's identity: a test renamed in C# keeps no identity across runs, as in TypeScript, unless it carries an
  `externalId` ([external-test-ids.md](external-test-ids.md)); whether the adapter derives one (from a `[Property]`, an
  attribute of its own) is open.
- Whether the docs present it as a tool of its own or a section of the reporter's setup page.
- Whether `piwi` (the npm command line) is the upload fallback, or the package ships its own `dotnet piwi` tool.
