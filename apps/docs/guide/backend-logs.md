---
title: Backend instrumentation
description: "Add the ASP.NET Core or Nitro package to your backend so each test's requests carry the server's logs, spans and routes, with server probes as an experimental fourth use."
lang: en-US
---

# Backend instrumentation

A small package in your backend attaches to each HTTP response what the server did for that request, and the
[capture fixtures](./capture-fixtures) read it from the response while your tests run. Nothing leaves your backend
except in those response headers, or from the coverage endpoints of a coverage build, and only outside production.

| Use | What you get | ASP.NET Core | Nitro / Nuxt |
|---|---|:---:|:---:|
| [Backend logs](#backend-logs) | The server's warnings and errors, next to the request that caused them | ✓ | ✓ |
| [Server spans](#server-spans) | The server's time on a request, and the handler and dependencies it reached | | ✓ |
| [Route manifest](#route-manifest) | The routes the server has, so the Test Map can name the ones no test reaches | ✓ | ✓ |
| [Server probes](#server-probes) | A fault injected inside the server for one request (**Experimental**) | ✓ | ✓ |
| [Server coverage](/features/server-coverage) | The backend files, functions and lines each test ran, from a coverage build | ✓ | |

**Active only in non-production environments by default.** The ASP.NET Core integration emits its headers in the Development and Test environments unless you [choose others](#choosing-the-environments); the Nitro/Nuxt integration only when `NODE_ENV` is `development` or `test`. Both honor `PIWI_TEST_LOGS_DISABLED`: set it to `true` to turn capture off anywhere, or to `false` to force capture on in a production-mode test deployment.

## Install

### ASP.NET Core (NuGet)

```bash
dotnet add package PiwiTests.Instrumentation.AspNetCore
```

```csharp
var builder = WebApplication.CreateBuilder(args);

// Register the log capture provider (before Build())
builder.AddPiwiTestLogs();

var app = builder.Build();

// Add the response header middleware (early in the pipeline)
app.UsePiwiTestLogs();

app.Run();
```

`AddPiwiTestLogs()` registers a logger provider that collects Warning and Error entries per request; `UsePiwiTestLogs()` adds the middleware that writes them to the response, only in the active environments.

An unhandled exception answered with a 5xx is recorded too, once, its type as the category. Outside Development, register `UseExceptionHandler()`: the server's bare 500 carries no header.

The capture buffer is decoupled from the logging front-end, so it also works outside minimal hosting. Apps on the classic **Generic Host + `Startup`** model use the hosting-agnostic overloads: `services.AddPiwiTestLogs()` (or `ILoggingBuilder.AddPiwiTestLogs()`) in `ConfigureServices`, and `app.UsePiwiTestLogs(env)` on `IApplicationBuilder` in `Configure`.

Apps that route logging through **Serilog** never call other logging providers (with Serilog's default `writeToProviders: false`), so they add the sink package instead:

```bash
dotnet add package PiwiTests.Instrumentation.Serilog
```

```csharp
// Serilog configuration
loggerConfiguration.WriteTo.PiwiTestLogs();

// Startup.Configure(IApplicationBuilder app, IHostEnvironment env)
app.UsePiwiTestLogs(env, e => e.IsDevelopment() || e.IsEnvironment("Podman") || e.IsEnvironment("Integration"));
```

The sink captures Warning, Error and Fatal events and does nothing outside a request the middleware brackets, so it stays registered in every environment; the middleware decides where capture runs.

#### Choosing the environments

Test tiers often run under their own environment names (`Podman`, `Integration`, …). Only the middleware needs to know them — outside a request it brackets, capture does nothing — so pick where it is active in one of three ways:

```csharp
// A predicate, for full control
app.UsePiwiTestLogs(env, e => e.IsDevelopment() || e.IsEnvironment("Podman") || e.IsEnvironment("Integration"));

// Environment names (case-insensitive)
app.UsePiwiTestLogs(env, "Development", "Podman", "Integration");

// Options, set once in ConfigureServices
services.AddPiwiTestLogs(o => o.IsActive = e => e.IsDevelopment() || e.IsEnvironment("Integration"));
```

Or, without touching code, set `PIWI_TEST_LOGS_ENVIRONMENTS=Development,Podman,Integration` on the backend. The first setting present wins: a predicate passed to `UsePiwiTestLogs`, then names passed to it, then `PiwiTestLogsOptions.IsActive`, then `PiwiTestLogsOptions.Environments`, then `PIWI_TEST_LOGS_ENVIRONMENTS`, then the Development/Test default. `PIWI_TEST_LOGS_DISABLED` overrides all of them.

**Requirements:** .NET 8, 9, or 10.

[`examples/sample-app`](https://github.com/PiwiTests/platform/tree/main/examples/sample-app) runs an ASP.NET Core app with this package wired in, and a Playwright suite that checks what it sends.

### Nitro / Nuxt (npm)

```bash
npm install @piwitests/instrumentation-nitro
```

Create a file in your project's server plugins directory:

```typescript
// Nuxt: server/plugins/piwi-test-logs.ts
// Standalone Nitro: plugins/piwi-test-logs.ts
export { default } from '@piwitests/instrumentation-nitro'
```

The plugin is auto-loaded by Nitro. It captures `consola` Warning/Error entries (bare `console.*` calls are not captured) and unhandled H3 errors, then writes the header just before each response goes out — including error responses. Capture is on outside production; override either way with `PIWI_TEST_LOGS_DISABLED` (`true` = always off, `false` = on even in production).

**Requirements:** Nuxt 3+ / Nitro 2+ (peer deps `nitropack ≥2`, `h3 ≥1`, `consola ≥3` — all included in any Nuxt project).

[`examples/sample-app`](https://github.com/PiwiTests/platform/tree/main/examples/sample-app) runs a standalone Nitro app with this package wired in, and the same Playwright suite.

### Reporter setup

On the Playwright side there is nothing to configure: the reporter reads the headers from every request the
[capture fixtures](./capture-fixtures) record, the `request` fixture's API calls included, so every spec must import
`test` from your fixtures file.

## Backend logs

The integration adds an `X-Piwi-Logs` response header (gzip-compressed, Base64-encoded JSON) to every HTTP response, with an empty array when nothing was logged, so the reporter can tell the application is instrumented. The reporter stores its entries as `serverLogs` on that request. They appear in:

- **The [execution page](/features/evidence#one-execution-diagnosis-first)**: in the network requests, a request that returned server-side logs shows a warning and error count and expands to every entry attached to it (level, category, message, timestamp and stack trace). Error logs also raise a [clue](/features/evidence#clues).
- **The [AI diagnosis](/features/ai-diagnosis) context**: warnings and errors are included when a failure is diagnosed.

Because the logs are stored per request, you can tell which HTTP call produced a given warning or error.

### Log entry format

Each entry in the `X-Piwi-Logs` array has this shape:

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | `number` | Unix timestamp in milliseconds |
| `level` | `string` | `"Warning"` or `"Error"` (the ASP.NET Core integration also emits `"Critical"`) |
| `category` | `string` | Logger category or tag (e.g. `MyApp.Services.OrderService`) |
| `message` | `string` | Log message (truncated at 500 characters) |
| `stack` | `string` | Optional. Shrunk stack trace, max 5 frames — framework/internal frames removed (`node:internal` and `node_modules` for Nitro); the ASP.NET Core integration also shortens namespace parts to their first lowercase letter |

In the ASP.NET Core integration, `stack` starts with the exception's message and is omitted when no exception was logged.

## Server spans

The Nitro plugin also writes an `X-Piwi-Trace` header: a root span for the request, with the matched handler's
source file when Nitro exposes it, plus any child spans your code records with `recordServerSpan` (a database query,
a downstream call). The dashboard shows them next to the network request, and the [Test Map](/features/scenario-gaps)
uses the handler and dependencies they name. The reporter reads them while `captureServerTraces` is on (the default).

## Route manifest

Both packages serve `/__piwi/manifest` outside production: the routes the server has, as JSON. The
reporter fetches it from each `baseURL` and each other origin whose responses carry an instrumentation header, and
uploads it with the run, so a route or page nothing reaches becomes a
[declared, never hit](/features/scenario-gaps#declared-surface) gap. Any backend can commit a
`piwi.manifest.json` next to the Playwright config. Turn the upload off with `uploadManifest: false`.

- **ASP.NET Core** reads the application's endpoint table, so the manifest holds every route from the first run, hit
  or not: minimal APIs and route groups, controllers (attribute routes, conventional routes and areas) and SignalR
  hubs as routes, Razor Pages and routable Blazor components as pages. Each one is declared at the URL link
  generation produces (`/` for `Home/Index`), optional parameters marked optional (`/archive/{page?}`), with the source
  file of its handler when the build has a PDB. Static files, fallbacks and endpoints marked `ExcludeFromDescription()` are left out. See
  the [package README](https://github.com/PiwiTests/platform/tree/main/integrations/aspnetcore#route-manifest) for
  every rule.
- **Nitro** reads its route table at build time through the package's module
  (`modules: ['@piwitests/instrumentation-nitro/module']`, under `nitro` in Nuxt); without it, only matched routes.

## Server probes

**Experimental.** Both packages accept a signed fault instruction on one request (`X-Piwi-Probe`, HMAC-signed with
`PIWI_PROBE_SECRET`) and apply it inside the server, so a probe run can check whether a passing test notices the
server's real error path. Faults are applied only with `PIWI_SERVER_PROBES=true` on the backend, only outside
production, and only for projects that turn server probes on. See
[Server probes](/features/probes#server-probes) for what they report and when to turn them on.

## Building your own integration

Any backend can implement the `X-Piwi-Logs` protocol by:

1. Initializing a per-request log buffer when the request starts
2. Capturing Warning and Error log entries into the buffer during request processing
3. Before sending the response, serializing the buffer to a JSON array, gzip-compressing it, Base64-encoding the result, and writing it to the `X-Piwi-Logs` response header

The reporter decodes the header with:

```typescript
import { gunzipSync } from 'zlib'
const entries = JSON.parse(gunzipSync(Buffer.from(header, 'base64')).toString('utf-8'))
```

Cap entries at a reasonable limit (50 is the default in the provided integrations) and truncate long messages to avoid bloating responses.

## Related

- [Capture fixtures](./capture-fixtures): the fixtures that read these headers
- [Failure evidence](/features/evidence): where backend logs appear on a failing execution
- [Scenario gaps & the Test Map](/features/scenario-gaps): what spans, the manifest and probes feed
- [Server coverage](/features/server-coverage): the backend code each test ran
- [Configuration reference](/reference/configuration#backend-logs): `PIWI_TEST_LOGS_DISABLED` and `PIWI_TEST_LOGS_ENVIRONMENTS`
