# PiwiTests.Instrumentation.Coverage

Per-test server code coverage for [Piwi Dashboard](https://piwitests.dev): which files, functions and lines of your ASP.NET Core backend each Playwright test executed, even when the tests run in parallel against one shared backend. It has no ASP.NET Core dependency; the middleware that serves the coverage comes from [`PiwiTests.Instrumentation.AspNetCore`](https://www.nuget.org/packages/PiwiTests.Instrumentation.AspNetCore), which depends on this package.

**Only in a coverage build.** Nothing is recorded unless the code was compiled with `-p:PiwiCoverage=true`. Without that property, no code calls into the package.

## How it works

The C# and Visual Basic compilers can instrument code for coverage themselves: compiled with `-instrument:TestCoverage` (the `Instrument` MSBuild property), every method marks its entry and each statement in a `bool[]`, its **payload**, and asks `Microsoft.CodeAnalysis.Runtime.Instrumentation.CreatePayload` for that array. This package supplies `CreatePayload`, so it decides, at run time, whose payload a method records into:

- the payload of the **HTTP request being served**, found through an `AsyncLocal` the middleware sets per request, so each request has its own coverage (work the request starts with `Task.Run` or a fire-and-forget task records into it too);
- a **shared** payload outside a request (startup, background work), which holds the run-level coverage.

The compiler also embeds a **span table** in the assembly (the `<DynamicAnalysisData>` resource): the source file, start and end line of each method and statement. A report maps the payloads to it: a method whose entry is marked gives a function (its line range), a marked statement gives its lines. Line ranges are 1-based and inclusive, file paths relative to the repository root: the one above the application's content root, else the one above the source file on this machine, or the directory `PIWI_SOURCE_ROOT` names when the application was built where its sources no longer are.

- A statement whose span encloses another method's span, such as a primary constructor, which spans the whole type, counts its first line only.
- A statement that declares a lambda counts its own lines, and the lambda's lines only once the lambda ran.
- Files under an `obj/` directory (the Razor generator's own output, for example) are left out. Razor views are covered at their `.cshtml` lines; a view's method is in the generated source, so a `.cshtml` file has lines but no functions.

## What it leaves out

A coverage build leaves out what coverlet leaves out, so its executable lines are the ones `dotnet test --collect "XPlat Code Coverage"` counts: an excluded method has no executable lines and no coverage, and a method's lambdas, local functions and `async` or iterator body go with it.

- **Attributes:** `ExcludeFromCodeCoverage` and `ExcludeFromCoverage`, in any namespace, and the attributes `ExcludeByAttribute` names (`GeneratedCode`, `GeneratedCodeAttribute` or `System.CodeDom.Compiler.GeneratedCodeAttribute`), on the assembly, a type and the types nested in it, a method or constructor, or a property. As in coverlet, an attribute on an event is not read; the compiler itself leaves out an event marked `[ExcludeFromCodeCoverage]`.
- **Files:** the `ExcludeByFile` globs (`**/Migrations/*.cs`, `**/Generated/`), matched against each method's source path without its root and ignoring case, as coverlet matches them; in a deterministic build, against the local path its `/_/` stands for.
- **Filters:** `Exclude` and `Include`, `[Assembly]Namespace.Type` with `*` and `?` (the character before it is optional), applied to a type and, for `Exclude`, to the types it is nested in.

The build reads them where coverlet does, when it compiles: the MSBuild properties of coverlet.msbuild (`ExcludeByAttribute`, `ExcludeByFile`, `Exclude`, `Include`, comma-separated), and the `Configuration` of the coverlet collector (`XPlat code coverage`) in the run settings file `dotnet test --settings` or else `RunSettingsFilePath` names, both when both are set:

```xml
<PropertyGroup>
  <ExcludeByAttribute>GeneratedCode</ExcludeByAttribute>
  <ExcludeByFile>**/Migrations/*.cs</ExcludeByFile>
  <RunSettingsFilePath>$(MSBuildThisFileDirectory)coverlet.runsettings</RunSettingsFilePath>
</PropertyGroup>
```

A build made apart from `dotnet test`, such as the end-to-end environment's, sees only a project file's or `Directory.Build.props`'s: set them there. Not read: `SkipAutoProps`, and Microsoft code coverage's run settings (`ModulePaths`, `Functions`, `Attributes`, `Sources`). Two differences from coverlet remain: with `CompilerGeneratedAttribute` in `ExcludeByAttribute`, coverlet also drops the bodies of lambdas, local functions, `async` and iterator methods, which the span table holds as their method's statements, so they count; and coverlet keeps, in a Release build, a local function an excluded method declares after its last statement.

## Enabling it

1. **Add the package to every project whose code you want covered.** A web project that references `PiwiTests.Instrumentation.AspNetCore` already has it; class libraries need it too:

   ```bash
   dotnet add package PiwiTests.Instrumentation.Coverage
   ```

   Or add it to every project of a solution from a `Directory.Build.props` at its root, with the version of `PiwiTests.Instrumentation.AspNetCore` you use:

   ```xml
   <Project>
     <ItemGroup Condition="'$(IsTestProject)' != 'true'">
       <PackageReference Include="PiwiTests.Instrumentation.Coverage" Version="x.y.z" />
     </ItemGroup>
   </Project>
   ```

2. **Serve it** with `app.UsePiwiTestLogs()` from `PiwiTests.Instrumentation.AspNetCore` (see its [usage](https://github.com/PiwiTests/platform/tree/main/integrations/aspnetcore#usage)). The middleware serves coverage only in the environments it is active in, Development and Test by default.

3. **Build the test environment with `-p:PiwiCoverage=true`**, which the package's `build/` and `buildTransitive/` props turn into `<Instrument>TestCoverage</Instrument>`:

   ```bash
   dotnet build -c Release -p:PiwiCoverage=true
   dotnet publish -c Release -p:PiwiCoverage=true
   ```

   Set the property on the command line or in `Directory.Build.props`, not in a project file: the package's props read it before the project file.

**Never ship a coverage build to production.** It runs slower code than the production build (every method call asks the recorder for its payload, property getters are no longer inlined), and the coverage endpoints expose source paths and line numbers. In a coverage build, `UsePiwiTestLogs()` logs a warning when the environment is one the middleware is not active in.

## Modes

| `PIWI_COVERAGE_MODE` | What is recorded                                                                                                                                                                            |
|----------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `test` (default)     | Per test: each request records into its own payloads, named on its response. Code that runs outside a request records at run level.                                                         |
| `run`                | Run level only: every method keeps one shared payload after its first call and no longer calls the recorder, and no request is named. For a coverage report of the whole run, not per test. |

The mode is read once, when the process starts.

## Unit tests: a report at process exit

A process that serves no coverage endpoint, a test host running unit tests on a coverage build, writes its run-level
report when it exits, where `PIWI_COVERAGE_OUTPUT` says:

```bash
dotnet build -p:PiwiCoverage=true
PIWI_COVERAGE_MODE=run PIWI_COVERAGE_OUTPUT=TestResults/piwi/ VSTEST_TESTHOST_SHUTDOWN_TIMEOUT=30000 dotnet test --no-build
npx @piwitests/reporter coverage upload "TestResults/piwi/*.json" --suite unit-back
```

```powershell
dotnet build -p:PiwiCoverage=true
$env:PIWI_COVERAGE_MODE='run'; $env:PIWI_COVERAGE_OUTPUT='TestResults/piwi/'; $env:VSTEST_TESTHOST_SHUTDOWN_TIMEOUT='30000'; dotnet test --no-build
npx @piwitests/reporter coverage upload "TestResults/piwi/*.json" --suite unit-back
```

- **A file or a directory.** A value ending in `/` (or `\`), or naming an existing directory, is a directory: each test
  host writes `piwi-coverage-<test project>-<process id>.json` in it, so a solution's test projects write a report
  each, and `piwi coverage upload` merges the files a pattern matches. Any other value is the file to write, which
  the last test host to exit overwrites. Empty the directory before a run: a report left from an earlier run would be
  uploaded with the new ones.
- **A relative path** starts from the directory `dotnet test` runs in: in a test project that references the package,
  directly or through the project it tests, the package's props pass it to the VSTest host as a full path, through
  the run settings. Elsewhere, with inline run settings on the command line (`dotnet test -- ...`), which replace
  those, or in a host that runs without VSTest, it starts from the host's working directory, the test project's
  output directory under VSTest: give a full path then.
- **The shutdown timeout.** VSTest stops a test host 100 ms after the test session ends, report written or not. The
  span tables and executable lines are read on a background thread while the tests run, so exit only adds the
  coverage and writes the file; tests that end before that read does leave it to exit. `VSTEST_TESTHOST_SHUTDOWN_TIMEOUT`
  (milliseconds) gives the host longer, and costs nothing when it exits sooner.
- The report is written to a temporary file beside it, then renamed: a file that exists is a whole report.

The report is the one `/__piwi/coverage/run` serves at the `lines` granularity, with the executable lines and every
method (`allFunctions`) of each instrumented assembly in the test host's directory, whether its code ran or not, and
its paths as the compiler recorded them: `piwi coverage upload` makes them repository-relative. Its lines are the span
table's, the ones the end-to-end suite counts. The report is written once the first instrumented method runs; a
process that runs none writes nothing.

## The header and the endpoints

In `test` mode, a response whose request ran instrumented code before the response started carries the request's id:

```
X-Piwi-Coverage: 3f9a1c0b7e21.42
```

The id is `<process key>.<sequence>`; the process key is the process's instance id, random per process, so an id from an earlier process reads as missing. The Piwi reporter records the ids each test's pages receive and collects them once the test ends. Static files and requests that ran no instrumented code get no id.

**`POST /__piwi/coverage/collect`** returns, per group, the coverage of its requests merged, and forgets them:

```json
{ "granularity": "lines", "groups": [{ "key": "test-1", "requests": ["3f9a1c0b7e21.42", "3f9a1c0b7e21.43"] }] }
```

```json
{
  "v": 1,
  "instance": { "id": "3f9a1c0b7e21", "startedAt": "2026-10-17T09:00:00.1234567+00:00" },
  "groups": [
    {
      "key": "test-1",
      "files": [
        {
          "path": "src/Web/Services/BasketService.cs",
          "runtime": "server",
          "functions": [[22, 25], [31, 48]],
          "lines": [[23, 24], [33, 35], [40, 40]],
          "checksums": ["sha256:9f2c…"]
        }
      ],
      "missing": ["3f9a1c0b7e21.43"]
    }
  ]
}
```

- `granularity` is `files` (`path` and `runtime` only), `functions` (with `functions`) or `lines` (with `functions` and `lines`, the default).
- `checksums`, at `functions` and `lines`, lists the checksum of the source the compiler read for the file, from the span table, one per version compiled into the process. The Piwi reporter compares it with the file in its checkout and drops the line numbers of a file built from another version, marking the test's coverage incomplete.
- `missing` lists the ids the backend does not hold: from another process, already collected, or evicted.
- `instance` names the process that answered: its instance id (`PiwiCoverageRecorder.InstanceId`, the process key of its request ids) and when instrumented code first ran in it (`StartedAt`). Both endpoints name it, so the Piwi reporter tells a backend that restarted during the run: it marks the run's server coverage incomplete, and keeps the lines its tests' coverage named.
- The body is limited to 1 MB and 10,000 request ids.

**`GET /__piwi/coverage/run?granularity=lines`** returns the run-level coverage: the code that ran outside any request, every request collected, evicted or still kept, and, at `lines` granularity, each file's `executable` lines (the lines of every statement, run or not) and `allFunctions` (the line range of every method, run or not). Executable lines cover every assembly built with coverage instrumentation, including those whose code never ran: the loaded ones, and those in the application's base directory, whose span tables are read from disk without loading them:

```json
{ "v": 1, "instance": { "id": "3f9a1c0b7e21", "startedAt": "2026-10-17T09:00:00.1234567+00:00" }, "files": [{ "path": "src/Web/Services/BasketViewModelService.cs", "runtime": "server", "functions": [[20, 26]], "lines": [[22, 25]], "executable": [[22, 25], [30, 50]], "allFunctions": [[20, 26], [28, 51]], "checksums": ["sha256:41d0…"] }] }
```

Both endpoints answer under the request's path base, beside `/__piwi/manifest`, and only once instrumented code runs in the process; otherwise the paths reach the application.

Requests are kept until they are collected: up to 5,000 ended requests and about 64 MB, the oldest evicted first.

## Limits

- **C# and Visual Basic only.** F# has no compiler instrumentation.
- **Lambdas created outside a request count at run level only.** A lambda records into the payload of the call that created it, so an inline minimal API handler (`app.MapGet("/x", () => ...)`), inline middleware or a DI factory lambda, all created at startup, never counts for a test. The methods they call count normally, and a method group handler (`app.MapGet("/x", Handlers.Get)`) counts per test.
- **Work outside a request** (hosted services, queue consumers, timers started at startup) counts at run level only.
- Server-to-server calls behind another server count only if that server forwards the `X-Piwi-Coverage` header.

## Cost

Measured on a prototype of this package: per-test coverage (`test` mode) added **under 2% to test duration** on Microsoft's eShopOnWeb, whose CPU goes to the framework, and **up to +26% server CPU** on an application written to spend its CPU in business logic (`run` mode: +6%). Recording functions costs about the same as recording lines: the cost is the call to `CreatePayload` on every method call.

## Using it without ASP.NET Core

`PiwiCoverageRecorder` (namespace `PiwiTests.Instrumentation.Coverage`) is public, for any host that serves requests:

```csharp
var request = new PiwiRequestCoverage();
PiwiCoverageRecorder.Begin(request);
try { await HandleAsync(); }
finally { PiwiCoverageRecorder.End(); }

var report = new PiwiCoverageReport(PiwiCoverageGranularity.Lines, document => RelativeToRepository(document));
report.AddRequest(request);
report.WriteFiles(jsonWriter);
```

`PiwiCoverageRecorder.HasInstrumentedModules` tells whether code from a coverage build ran, `InstanceId` and `StartedAt` name the process, `AddToRunLevel` adds a request to the run-level coverage once it is no longer kept, and `PiwiCoverageReport.AddRunLevel` and `AddExecutableLines` build the run-level report.

## Requirements

- .NET 8, 9, or 10
- A C# or Visual Basic project

## License

MIT
