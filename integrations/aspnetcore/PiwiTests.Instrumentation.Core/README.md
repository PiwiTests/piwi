# PiwiTests.Instrumentation.Core

The per-request backend log capture buffer shared by the [Piwi Dashboard](https://piwitests.dev) instrumentation packages. It has no ASP.NET Core dependency — only `Microsoft.Extensions.Logging.Abstractions`, for `LogLevel`.

You normally don't reference this package directly. Install the one that fits your stack, and it comes along:

| Package                                                                                                      | What it adds                                                                             |
|--------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| [`PiwiTests.Instrumentation.AspNetCore`](https://www.nuget.org/packages/PiwiTests.Instrumentation.AspNetCore) | The middleware that writes the `X-Piwi-Logs` header, and a Microsoft.Extensions.Logging provider |
| [`PiwiTests.Instrumentation.Serilog`](https://www.nuget.org/packages/PiwiTests.Instrumentation.Serilog)       | `WriteTo.PiwiTestLogs()`, a Serilog sink that feeds the same buffer                      |

## Feeding the buffer from another log source

`PiwiTestLogCapture` (namespace `PiwiTests.Instrumentation`) is public, so any other logging front-end can feed it:

```csharp
using PiwiTests.Instrumentation;

if (PiwiTestLogCapture.IsCapturing)
    PiwiTestLogCapture.TryAdd(LogLevel.Warning, category, message, exception);
```

The middleware brackets each HTTP request with `Begin()` / `Stop()`. Outside a request it brackets, `TryAdd` is a no-op, so an adapter costs nothing there. `TryAdd` applies the level filter (Warning and above), the 50-entry cap and the 500-character message truncation itself, so no adapter can over-capture.

`TryAddUnhandled(exception)` records an exception the request did not handle as an Error entry, with the exception's type as the category and its message as the message, unless an entry already carries that exception instance. The ASP.NET Core middleware calls it for an exception that leaves the request or that an exception handler answers.

## License

MIT
