using System;
using System.Collections.Generic;
using System.Threading;
using Microsoft.Extensions.Logging;

namespace PiwiTests.Instrumentation;

/// <summary>
/// The per-request capture buffer, decoupled from any single logging front-end and from ASP.NET Core.
///
/// <para>
/// The middleware in <c>PiwiTests.Instrumentation.AspNetCore</c> brackets each HTTP request with
/// <see cref="Begin"/> / <see cref="Stop"/>, and any log source feeds entries through
/// <see cref="TryAdd"/>: the Microsoft.Extensions.Logging provider registered by
/// <c>AddPiwiTestLogs()</c>, the Serilog sink in <c>PiwiTests.Instrumentation.Serilog</c>, or any
/// other adapter. <see cref="TryAdd"/> centralizes the level filter (<see cref="MinimumLevel"/>),
/// the entry cap and the message truncation, so every source captures the same way.
/// </para>
/// <para>
/// The middleware also records an exception the request did not handle through
/// <see cref="TryAddUnhandled"/>, once per exception instance.
/// </para>
/// </summary>
public static class PiwiTestLogCapture
{
    /// <summary>
    /// Minimum level captured. Entries below this are dropped by <see cref="TryAdd"/>.
    /// A log source can use this to pre-filter (e.g. a Serilog sink's default minimum level).
    /// </summary>
    public const LogLevel MinimumLevel = LogLevel.Warning;

    private const int MaxEntries = 50;
    private const int MessageMaxLength = 500;

    private static readonly AsyncLocal<RequestBuffer?> Buffer = new();

    /// <summary>
    /// True when a capture buffer is active for the current async context. A log source can
    /// check this on its hot path to skip work when nothing is capturing.
    /// </summary>
    public static bool IsCapturing => Buffer.Value is not null;

    /// <summary>Starts capturing for the current async context. Called by the middleware per request.</summary>
    public static void Begin() => Buffer.Value = new RequestBuffer();

    /// <summary>
    /// Stops capturing and returns a copy of the entries collected since <see cref="Begin"/>, or
    /// <c>null</c> if capture was never started for the current async context. A task the request
    /// started still holds the buffer: what it logs afterwards is dropped, never added to the copy.
    /// </summary>
    public static List<PiwiTestLogEntry>? Stop()
    {
        var buffer = Buffer.Value;
        Buffer.Value = null;
        if (buffer is null) return null;
        lock (buffer)
        {
            buffer.Stopped = true;
            return [.. buffer.Entries];
        }
    }

    /// <summary>
    /// Adds an entry to the active buffer, applying the shared level filter
    /// (<see cref="MinimumLevel"/>), the entry cap and the message truncation. A no-op when no
    /// buffer is active, when <paramref name="level"/> is below <see cref="MinimumLevel"/>, or
    /// when the cap is already reached. Safe to call from any source and any thread: the tasks a
    /// request runs in parallel share its buffer, which a lock guards.
    /// </summary>
    public static void TryAdd(LogLevel level, string category, string message, Exception? exception)
    {
        // Self-guard on the level: never rely on the caller having honored IsEnabled. Some
        // bridges (e.g. Serilog's LoggerProviderCollectionSink) emit without checking, which
        // would otherwise over-capture Information/Debug.
        if (level < MinimumLevel) return;
        if (Buffer.Value is not { } buffer) return;

        lock (buffer)
        {
            if (buffer.Stopped || buffer.Entries.Count >= MaxEntries) return;
            buffer.Entries.Add(new PiwiTestLogEntry(
                Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                Level: level.ToString(),
                Category: category,
                Message: Truncate(message, MessageMaxLength),
                ExceptionMessage: exception?.Message,
                StackTrace: ShrinkStackTrace(exception)
            ));
            if (exception is not null)
                (buffer.Exceptions ??= []).Add(exception);
        }
    }

    /// <summary>
    /// Adds an Error entry for an exception the request did not handle: the exception's type
    /// name as the category, its message, and its shrunk stack trace. A no-op when an entry
    /// carrying this exception instance was already captured for the request, so an exception
    /// the application logged, or one recorded here before, appears once. Otherwise the rules of
    /// <see cref="TryAdd"/> apply.
    /// </summary>
    public static void TryAddUnhandled(Exception exception)
    {
        if (Buffer.Value is { } buffer)
        {
            lock (buffer)
            {
                if (buffer.Exceptions?.Exists(e => ReferenceEquals(e, exception)) == true) return;
            }
        }

        var type = exception.GetType();
        TryAdd(LogLevel.Error, type.FullName ?? type.Name, exception.Message, exception);
    }

    /// <summary>
    /// One request's entries, and the exceptions they carry. Locked on itself: the parallel tasks
    /// of one request add to it from several threads.
    /// </summary>
    private sealed class RequestBuffer
    {
        public readonly List<PiwiTestLogEntry> Entries = [];
        public List<Exception>? Exceptions;
        public bool Stopped;
    }

    private static string Truncate(string s, int maxLength) =>
        s.Length <= maxLength ? s : string.Concat(s.AsSpan(0, maxLength), "…");

    /// <summary>
    /// Extract and shrink an exception's stack trace: filter out framework frames,
    /// shorten namespace parts to their first letter, strip parameters, keep max 5 frames.
    /// </summary>
    internal static string? ShrinkStackTrace(Exception? exception)
    {
        if (exception?.StackTrace is not { Length: > 0 } stack)
            return null;

        var lines = stack.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var frames = new List<string>();

        foreach (var line in lines)
        {
            // Skip framework / runtime frames, the delegates compiled at run time (minimal API
            // handlers) and the Piwi middleware every exception escaping a request passes through
            if (line.Contains(" System.") ||
                line.Contains(" Microsoft.") ||
                line.Contains(" lambda_method") ||
                line.Contains(" PiwiTests.Instrumentation.AspNetCore.") ||
                line.Contains(" in /usr/share/dotnet/") ||
                line.Contains(" in /dotnet/shared/") ||
                line.StartsWith("---") ||
                line.StartsWith("Server stack trace") ||
                line.StartsWith("Exception rethrown"))
                continue;

            if (frames.Count >= 5) break;

            var frame = ShrinkFrame(line);
            if (frame != null)
                frames.Add(frame);
        }

        return frames.Count > 0 ? string.Join("\n", frames) : null;
    }

    internal static string? ShrinkFrame(string line)
    {
        var trimmed = line.TrimStart();
        if (trimmed.StartsWith("at ", StringComparison.Ordinal))
            trimmed = trimmed[3..];

        var inIdx = trimmed.IndexOf(" in ", StringComparison.Ordinal);
        string identifier;
        string? location;

        if (inIdx >= 0)
        {
            // Has source file location — extract method part and strip parameters
            var methodPart = trimmed[..inIdx];
            location = trimmed[inIdx..];

            var parenIdx = methodPart.LastIndexOf('(');
            if (parenIdx > 0)
                methodPart = methodPart[..parenIdx];

            identifier = methodPart;
        }
        else
        {
            identifier = trimmed;
            location = null;
        }

        var shrunk = ShrinkNamespace(identifier);
        return location != null ? $"{shrunk}{location}" : shrunk;
    }

    /// <summary>
    /// Shorten each namespace segment to its first lowercase letter.
    /// e.g. "MyApp.Services.PaymentService.ProcessPayment" → "m.s.PaymentService.ProcessPayment"
    /// </summary>
    internal static string ShrinkNamespace(string identifier)
    {
        var parts = identifier.Split('.');
        if (parts.Length <= 2) return identifier;

        // Keep the last two parts (class.method) as-is, shrink the namespace prefix
        for (var i = 0; i < parts.Length - 2; i++)
        {
            if (parts[i].Length > 0 && char.IsUpper(parts[i][0]))
                parts[i] = char.ToLowerInvariant(parts[i][0]).ToString();
        }

        return string.Join(".", parts);
    }
}
