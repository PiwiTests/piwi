# PiwiTests.Instrumentation.AspNetCore

ASP.NET Core integration for [Piwi Dashboard](https://piwitests.dev) — captures Warning and Error log entries per HTTP request and delivers them to the Piwi Dashboard reporter via the `X-Piwi-Logs` response header.

During a Playwright test run, the reporter reads this header from every response and stores the entries alongside the network request. The entries are then available in the Piwi Dashboard test-case view and are included in the AI diagnosis context.

**Active in Development and Test by default.** No header is emitted in Production unless you opt in — see [Choosing the environments](#choosing-the-environments) for recette tiers with their own environment names.

## Installation

```bash
dotnet add package PiwiTests.Instrumentation.AspNetCore
```

Logging through Serilog? Add `PiwiTests.Instrumentation.Serilog` too — see [Serilog](#serilog).

## Usage

```csharp
var builder = WebApplication.CreateBuilder(args);

// 1. Register the log capture provider (before Build())
builder.AddPiwiTestLogs();

var app = builder.Build();

// 2. Add the response header middleware (early in the pipeline)
app.UsePiwiTestLogs();

app.Run();
```

`AddPiwiTestLogs()` registers an `ILoggerProvider` that feeds Warning and Error entries into a per-request capture buffer (`PiwiTestLogCapture`, from the [`PiwiTests.Instrumentation.Core`](https://www.nuget.org/packages/PiwiTests.Instrumentation.Core) package this one depends on), scoped to the current HTTP request with `AsyncLocal`.

`UsePiwiTestLogs()` adds middleware that serializes the buffer to JSON, gzip-compresses it, and writes the result (Base64-encoded) to the `X-Piwi-Logs` response header as the response starts, but only in the active environments (Development and Test by default). Entries logged after that point (while a body is still streaming) can no longer ride on the response. The header is sent on every response, with an empty array when nothing was captured, so the reporter can tell the application is instrumented. The same middleware serves the [route manifest](#route-manifest).

## Generic Host + classic `Startup`

The capture buffer is decoupled from any single logging front-end, so the integration is not limited to minimal hosting or to the Microsoft.Extensions.Logging pipeline. Hosting-agnostic overloads cover `Startup`-based apps:

```csharp
public void ConfigureServices(IServiceCollection services)
{
    services.AddPiwiTestLogs();   // also available on ILoggingBuilder
}

public void Configure(IApplicationBuilder app, IHostEnvironment env)
{
    app.UsePiwiTestLogs(env, "Development", "Podman", "Integration");
}
```

`app.UsePiwiTestLogs(env)` keeps the Development/Test default; [Choosing the environments](#choosing-the-environments) lists every way to set them.

## Serilog

When logging is routed through **Serilog** (with the default `writeToProviders: false`), other `ILoggerProvider`s are never called, so `AddPiwiTestLogs()` alone captures nothing. Add the [`PiwiTests.Instrumentation.Serilog`](https://www.nuget.org/packages/PiwiTests.Instrumentation.Serilog) sink instead:

```bash
dotnet add package PiwiTests.Instrumentation.Serilog
```

```csharp
// Serilog configuration
loggerConfiguration.WriteTo.PiwiTestLogs();

// Startup.Configure(IApplicationBuilder app, IHostEnvironment env)
app.UsePiwiTestLogs(env, e => e.IsDevelopment() || e.IsEnvironment("Podman") || e.IsEnvironment("Integration"));
```

The sink captures Warning, Error and Fatal events (Fatal as `Critical`), takes the category from `SourceContext`, and does nothing outside a request the middleware brackets — so register it unconditionally and let the middleware decide the environments.

Any other logging front-end can feed the same buffer through `PiwiTestLogCapture.TryAdd` (namespace `PiwiTests.Instrumentation`). `TryAdd` centralizes the level filter (Warning and above), the 50-entry cap, and the 500-character message truncation, so no feeding path can over-capture, even one that bypasses `IsEnabled`.

## Choosing the environments

Test tiers often run under their own environment names (`Podman`, `Integration`, …). Only the middleware needs to know them: outside a request it brackets, the capture buffer is inert, so the log provider and the Serilog sink can stay registered everywhere at no cost.

Pick where the middleware is active in one of three ways:

```csharp
// 1. A predicate, for full control
app.UsePiwiTestLogs(env, e => e.IsDevelopment() || e.IsEnvironment("Podman") || e.IsEnvironment("Integration"));

// 2. Environment names (case-insensitive)
app.UsePiwiTestLogs(env, "Development", "Podman", "Integration");

// 3. Options, set once in ConfigureServices (or builder.AddPiwiTestLogs(o => ...))
services.AddPiwiTestLogs(o => o.IsActive = e => e.IsDevelopment() || e.IsEnvironment("Integration"));
services.AddPiwiTestLogs(o => o.Environments.Add("Integration"));   // replaces the Development/Test default
```

Or leave the code alone and set the variables on the backend:

| Variable                      | Effect                                                                                  |
|-------------------------------|-----------------------------------------------------------------------------------------|
| `PIWI_TEST_LOGS_ENVIRONMENTS` | Comma-separated environment names, e.g. `Development,Podman,Integration`                |
| `PIWI_TEST_LOGS_DISABLED`     | `true` turns the middleware off everywhere; `false` turns it on in any environment      |

The first setting present wins:

1. `PIWI_TEST_LOGS_DISABLED` (`true` or `false`) — overrides everything below
2. the predicate passed to `UsePiwiTestLogs`
3. the environment names passed to `UsePiwiTestLogs`
4. `PiwiTestLogsOptions.IsActive`
5. `PiwiTestLogsOptions.Environments`
6. `PIWI_TEST_LOGS_ENVIRONMENTS`
7. the default: Development and Test

The decision is made once, when the pipeline is built.

## What gets captured

| Level       | Included |
|-------------|----------|
| Trace       | No       |
| Debug       | No       |
| Information | No       |
| Warning     | Yes      |
| Error       | Yes      |
| Critical    | Yes      |

Each captured entry contains:

| Field              | Description                                                                                          |
|--------------------|------------------------------------------------------------------------------------------------------|
| `timestamp`        | Unix timestamp in milliseconds                                                                       |
| `level`            | `"Warning"`, `"Error"`, or `"Critical"`                                                              |
| `category`         | Logger category name (e.g. `MyApp.Services.OrderService`)                                            |
| `message`          | Formatted log message                                                                                |
| `stack`            | Exception message, then the shrunk stack trace (5 frames max, framework frames removed, namespace parts shortened to first letter); omitted when no exception was logged |

## Requirements

- .NET 8, 9, or 10
- `Microsoft.AspNetCore.App` framework reference (included automatically in ASP.NET Core projects)

## How it works with Piwi Dashboard

```
Playwright test
  └─ page.goto('/api/orders')
       └─ ASP.NET Core handler runs
            ├─ logger.LogWarning("Stock low for {ProductId}", id)   ← captured
            └─ HTTP response
                 └─ X-Piwi-Logs: <gzip+base64 JSON>
                      └─ Piwi reporter reads header
                           └─ stored as serverLogs on the network request
                                └─ visible in test-case detail + AI diagnosis
```

## Route manifest

Wherever the middleware is active, it also serves `GET /__piwi/manifest`: the routes and pages the application declares, read from its endpoint table. The Piwi reporter fetches it when a run starts (only when the base URL's response carries `X-Piwi-Logs`) and uploads it, so a declared route or page that no test reaches becomes a **declared, never hit** gap in the Test Map. Because the endpoint table is read, the manifest holds every route from the first run, hit or not.

```json
{
  "routes": [
    { "method": "GET", "pattern": "/api/orders/{id:int}", "handler": "src/Shop/Controllers/OrdersController.cs" },
    { "method": "POST", "pattern": "/hubs/chat/negotiate", "handler": "src/Shop/Hubs/ChatHub.cs" }
  ],
  "pages": [
    { "pattern": "/Orders/Details/{id:int}", "name": "Pages/Orders/Details.cshtml" },
    { "pattern": "/counter", "name": "Components/Pages/Counter.razor" }
  ]
}
```

| Endpoint                                              | Declared as                                                                                                              |
|-------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------|
| Minimal API, route group                              | A route at its template                                                                                                  |
| Controller action, attribute routing                  | A route, with the `[controller]` and `[action]` tokens and any route token transformer applied                           |
| Controller action, conventional routing (areas too)   | One route, at the URL the first matching conventional route generates: `/` for `Home/Index`, `/Home/Privacy/{id?}`     |
| SignalR hub, connection handler                       | `POST <path>/negotiate`, the request a client starts with; the connection itself runs over a WebSocket                   |
| Health checks, any endpoint without a method          | A `GET` route                                                                                                            |
| Razor Page                                            | A page named by its `.cshtml` file, at its canonical URL (`/Orders`, not `/Orders/Index`)                                |
| Blazor component with `@page`                         | A page named by its `.razor` file                                                                                        |

- **Pattern.** Template syntax, with constraint names kept and their arguments dropped (`{id:int}`, `{ssn:regex}`, `{**path}`). Trailing optional and default-valued parameters are marked optional (`/archive/{page?}`, `/feed/{format?}`), except after a conventional route value equal to its default, where link generation leaves them all out (`/` for `Home/Index`). Literals are lower-cased when `RouteOptions.LowercaseUrls` is set, and the request's path base is prepended: for an application mounted below the origin, the reporter asks for the manifest under the base URL's path first. The dashboard reads `{id:guid}` as a uuid segment and any other parameter as an id segment.
- **Method.** An endpoint that accepts any method is declared as `GET`, the method a navigation uses. `HEAD` is left out when the endpoint also accepts `GET`.
- **Handler.** The source file of the controller action, minimal API delegate or hub, read from the assembly's portable PDB (embedded or next to the DLL). The path is relative to the repository root: the one above the content root, else the one above the source file on this machine; a deterministic build's `/_/` root is the repository root, and `PIWI_SOURCE_ROOT` names it for a build made where the sources no longer are (a Docker build that compiled them at `/src`). It is left out when no PDB is found.
- **Left out.** Static files (`MapStaticAssets`), fallbacks (`MapFallback*`) and routes that are a lone catch-all, endpoints marked `ExcludeFromDescription()` (the OpenAPI document among them), link-generation-only endpoints, the framework's own paths (`/_framework`, `/_blazor`, `/_content`), and the connection endpoint next to a negotiate endpoint. To keep one of your endpoints out, mark it `ExcludeFromDescription()`; it then leaves the OpenAPI document too.
- **Limit.** Up to 5000 routes and 5000 pages, the most the dashboard accepts in one upload.

## Server coverage

In a coverage build, the middleware also records which code each request executes, so the Piwi reporter can tell, per test, which server files, functions and lines ran. The recorder comes from [`PiwiTests.Instrumentation.Coverage`](https://www.nuget.org/packages/PiwiTests.Instrumentation.Coverage), which this package depends on.

1. Add `PiwiTests.Instrumentation.Coverage` to every class library whose code you want covered. A project that references this package already has it.
2. Build the test environment with `-p:PiwiCoverage=true`, for example `dotnet build -c Release -p:PiwiCoverage=true`.
3. Keep `app.UsePiwiTestLogs()`. Wherever the middleware is active, once instrumented code runs, it:
   - names each request that ran instrumented code before its response started: `X-Piwi-Coverage: <process>.<sequence>`;
   - serves `POST /__piwi/coverage/collect`, the coverage of the request ids a test received, merged per group, at `files`, `functions` or `lines` granularity, and `GET /__piwi/coverage/run`, the run-level coverage with each file's executable lines;
   - keeps each named request until it is collected, up to 5,000 ended requests and about 64 MB, the oldest evicted first.

`PIWI_COVERAGE_MODE=run` records run-level coverage only, at a lower cost, and names no request. File paths follow the handler rule of the route manifest, `PIWI_SOURCE_ROOT` included; a source file outside every repository it can find is left out, with a warning in the log. Without a coverage build nothing changes: no header, and the coverage paths reach the application. Never ship a coverage build to production; in one, `UsePiwiTestLogs()` logs a warning when the environment is one the middleware is not active in.

Lambdas created at startup, such as inline minimal API handlers, and work outside a request count at run level only. The [coverage package's README](https://github.com/PiwiTests/platform/tree/main/integrations/aspnetcore/PiwiTests.Instrumentation.Coverage#readme) has the JSON shapes, how statements map to lines, the limits and the measured cost.

## Server probes — the `X-Piwi-Probe` header

The middleware accepts a signed fault instruction from a Piwi probe run (Test
Map, level two). A verified header is recorded on `HttpContext.Items["PiwiProbe"]`;
a fault is **applied** only once a project turns server probes on
(`PIWI_SERVER_PROBES=true`), which stays off by default. The middleware runs only
in the environments it is active in, Development and Test by default (the same
guard as log capture).

| Variable             | Effect                                                             |
|----------------------|-------------------------------------------------------------------|
| `PIWI_PROBE_SECRET`  | Shared HMAC secret. When unset, the probe header is ignored.      |
| `PIWI_SERVER_PROBES` | `true` to apply verified faults to the signed request.            |

**Faults applied — the honest subset for ASP.NET Core** (`PiwiProbeFaults`):
handler-level faults only — `throw`, `status`/`auth` (500/401), `delay`/`slow`/
`slow-first` (+5s) and `extreme` (empty 200), matched to the target route. The
reporter picks the Nth match and signs that one request, so the fault applies to
any request the header matches and the single-use nonce keeps it from repeating.
Data mutation before serialization and dependency faults on outbound
`HttpClient` calls are the Nitro package's fuller subset; they need response
buffering and a delegating handler this package does not yet wire, so they are
**not applied here and never marked applied** — a probe naming one records as
inconclusive rather than a false gap. A fault is marked applied
(`HttpContext.Items["PiwiProbeApplied"]`) only once it actually takes effect, and
that label is reported to the reporter on the response's `X-Piwi-Trace` root span
(`piwi.probe.applied`), which the reporter compares with the fault it asked for.

**Header format.** `X-Piwi-Probe` carries a base64-encoded JSON envelope, the
same scheme as the Nitro package:

```jsonc
{
  "nonce": "<hex, single use>",
  "ts": 1700000000000,            // issued-at, Unix ms; honored within 60s
  "specJson": "{\"route\":\"POST /api/orders\",\"fault\":\"status-500\",\"nth\":1}",
  "sig": "<hex HMAC-SHA256>"      // over `${nonce}.${ts}.${specJson}` with PIWI_PROBE_SECRET
}
```

A verified spec is stored in `HttpContext.Items["PiwiProbe"]`. Verification lives
in `PiwiProbe.Verify`; `PiwiProbe.Sign` produces a matching signature.

> **Single-use nonces are tracked per process** (`ProbeNonceCache`), so the replay
> guard is exact only against one server instance — a header replayed to a
> different instance behind a load balancer, or after a restart, is bounded only
> by the signature and the 60s TTL. Probe runs target a single instance, so this
> is not a concern in practice.

> **Scope note.** For a verified probe request this package emits an `X-Piwi-Trace`
> header whose root span names the applied fault (`piwi.probe.applied`), alongside
> `X-Piwi-Logs`. It does not yet apply data mutation or dependency faults (see the
> honest subset above).

## Development

The packages and their tests build from one solution, the same command CI runs:

```bash
dotnet test integrations/aspnetcore/PiwiTests.Instrumentation.slnx
```

## License

MIT
