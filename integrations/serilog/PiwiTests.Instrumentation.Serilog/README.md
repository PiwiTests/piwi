# PiwiTests.Instrumentation.Serilog

A [Serilog](https://serilog.net) sink for [Piwi Dashboard](https://piwitests.dev). `WriteTo.PiwiTestLogs()` feeds Warning, Error and Fatal events into the per-request capture that [`PiwiTests.Instrumentation.AspNetCore`](https://www.nuget.org/packages/PiwiTests.Instrumentation.AspNetCore) sends back to your Playwright tests on the `X-Piwi-Logs` response header.

Use it when your app logs through Serilog. With Serilog's default `writeToProviders: false`, Microsoft.Extensions.Logging providers are never called, so the provider `AddPiwiTestLogs()` registers captures nothing on its own.

## Installation

```bash
dotnet add package PiwiTests.Instrumentation.AspNetCore
dotnet add package PiwiTests.Instrumentation.Serilog
```

This package depends on Serilog and [`PiwiTests.Instrumentation.Core`](https://www.nuget.org/packages/PiwiTests.Instrumentation.Core) only, not on ASP.NET Core. The middleware that writes the header comes from the ASP.NET Core package.

## Usage

```csharp
// Serilog configuration
loggerConfiguration.WriteTo.PiwiTestLogs();

// Startup.Configure(IApplicationBuilder app, IHostEnvironment env)
app.UsePiwiTestLogs(env, e => e.IsDevelopment() || e.IsEnvironment("Podman") || e.IsEnvironment("Integration"));
```

Register the sink unconditionally. It does nothing outside a request the middleware brackets, so the middleware's environment gate is the only one you need. See [Choosing the environments](https://github.com/PiwiTests/piwi/tree/main/integrations/aspnetcore#choosing-the-environments) for the ways to set it.

| Serilog level               | Captured as  |
|-----------------------------|--------------|
| Verbose, Debug, Information | Not captured |
| Warning                     | Warning      |
| Error                       | Error        |
| Fatal                       | Critical     |

The category is the event's `SourceContext` (set by `ForContext<T>()` and by Serilog's Microsoft.Extensions.Logging bridge), and the message is the rendered template. `restrictedToMinimumLevel` can raise the floor, e.g. `WriteTo.PiwiTestLogs(LogEventLevel.Error)`; capture never goes below Warning, whatever it is set to.

## Requirements

- .NET 8, 9, or 10
- Serilog 3.1.1 or later

## License

MIT
