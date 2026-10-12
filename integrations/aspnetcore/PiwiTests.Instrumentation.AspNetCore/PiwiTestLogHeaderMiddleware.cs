using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;

namespace PiwiTests.Instrumentation.AspNetCore;

public sealed class PiwiTestLogHeaderMiddleware(RequestDelegate next)
{
    private const string HeaderName = "X-Piwi-Logs";
    private const string TraceHeaderName = "X-Piwi-Trace";
    private const string ProbeHeaderName = "X-Piwi-Probe";

    // The shared secret a probe run signs the X-Piwi-Probe header with. Server
    // probes stay off unless PIWI_SERVER_PROBES=true; when off (the default), a
    // verified probe is recorded but no fault is applied.
    private static readonly string? ProbeSecret = Environment.GetEnvironmentVariable("PIWI_PROBE_SECRET");
    private static readonly bool ServerProbesEnabled =
        string.Equals(Environment.GetEnvironmentVariable("PIWI_SERVER_PROBES"), "true", StringComparison.Ordinal);

    public async Task InvokeAsync(HttpContext context)
    {
        // Serve the declared-surface route manifest: this middleware joins the pipeline only in
        // the environments UsePiwiTestLogs allows, the same guard as log capture.
        if (PiwiRouteManifest.IsRequest(context.Request))
        {
            await PiwiRouteManifest.WriteAsync(context);
            return;
        }

        // Verify a signed probe header (this middleware joins the pipeline only
        // in the environments UsePiwiTestLogs allows, Development and Test by
        // default — the same guard as log capture). The verified
        // spec is recorded on the request for handlers to read; nothing is
        // applied while server probes are off.
        var startMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var probe = PiwiProbe.Verify(
            context.Request.Headers[ProbeHeaderName],
            ProbeSecret,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        if (probe is not null)
            context.Items["PiwiProbe"] = probe;

        PiwiTestLogCapture.Begin();

        // The headers are written when the response starts, the last moment they can still be
        // added. A handler that writes a body starts the response inside this capture, so the
        // entries are read from it there; a response that starts after this middleware returns
        // (no body, or an error page an outer handler writes) uses the entries kept at the end.
        List<PiwiTestLogEntry>? endedLogs = null;
        var captureEnded = false;
        context.Response.OnStarting(() =>
        {
            var logs = captureEnded ? endedLogs : PiwiTestLogCapture.Stop();
            WriteInstrumentationHeaders(context, probe, startMs, logs);
            return Task.CompletedTask;
        });

        var faultEndedResponse = false;
        try
        {
            if (probe is not null && ServerProbesEnabled &&
                PiwiProbeFaults.ShouldApply(probe.Route, context.Request.Method, context.Request.Path.Value ?? ""))
            {
                // A fault is marked applied (context.Items["PiwiProbeApplied"]) only
                // at the point it actually takes effect, so an unimplemented fault
                // (data/dependency/replay) is never marked applied and records as
                // inconclusive rather than a false gap. The applied label rides back
                // to the reporter on the X-Piwi-Trace root span below.
                var delay = PiwiProbeFaults.FaultDelayMs(probe.Fault);
                if (delay > 0)
                {
                    await Task.Delay(delay);
                    context.Items["PiwiProbeApplied"] = PiwiProbeFaults.AppliedLabel(probe);
                }

                if (PiwiProbeFaults.IsThrowFault(probe.Fault))
                {
                    context.Items["PiwiProbeApplied"] = PiwiProbeFaults.AppliedLabel(probe);
                    throw new InvalidOperationException("Piwi probe: injected error");
                }

                var status = PiwiProbeFaults.FaultStatus(probe.Fault);
                if (status is not null)
                {
                    context.Items["PiwiProbeApplied"] = PiwiProbeFaults.AppliedLabel(probe);
                    context.Response.StatusCode = status.Value;
                    faultEndedResponse = true;
                }
                else if (PiwiProbeFaults.IsExtremeFault(probe.Fault))
                {
                    context.Items["PiwiProbeApplied"] = PiwiProbeFaults.AppliedLabel(probe);
                    context.Response.StatusCode = 200;
                    faultEndedResponse = true;
                }
            }

            if (!faultEndedResponse)
                await next(context);
        }
        finally
        {
            // Always end capture for this request's async context.
            endedLogs = PiwiTestLogCapture.Stop();
            captureEnded = true;
        }
    }

    /// <summary>
    /// Write the X-Piwi-Logs and (for a verified probe request) X-Piwi-Trace
    /// headers as the response starts. The trace's root span names the fault
    /// the server actually applied (<c>piwi.probe.applied</c>), or omits it when
    /// none was, so the reporter records an unhonored probe as inconclusive.
    /// </summary>
    private static void WriteInstrumentationHeaders(
        HttpContext context, PiwiProbeSpec? probe, long startMs, List<PiwiTestLogEntry>? logs)
    {
        // The level filter, entry cap and message truncation are applied by PiwiTestLogCapture.TryAdd.
        // The header is written even when nothing was captured, so the reporter can tell the app is
        // instrumented (it fetches the route manifest only then).
        context.Response.Headers[HeaderName] = GzipBase64(PiwiTestLogJson.Serialize(logs ?? []));

        if (probe is null)
            return;

        var applied = context.Items.TryGetValue("PiwiProbeApplied", out var a) && a is string label ? label : null;
        var statusCode = context.Response.StatusCode;
        var attrs = new Dictionary<string, object>
        {
            ["http.method"] = context.Request.Method,
            ["http.route"] = context.Request.Path.Value ?? "",
            ["http.status_code"] = statusCode,
            ["piwi.probe"] = probe.Fault,
        };
        if (applied is not null)
            attrs["piwi.probe.applied"] = applied;

        var span = new
        {
            id = Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant(),
            name = $"{context.Request.Method} {context.Request.Path.Value}".Trim(),
            kind = "server",
            startMs,
            durMs = Math.Max(0, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - startMs),
            status = statusCode >= 500 ? "error" : "ok",
            attrs,
        };
        context.Response.Headers[TraceHeaderName] = GzipBase64(JsonSerializer.SerializeToUtf8Bytes(new[] { span }));
    }

    /// <summary>Gzip then base64-encode a payload, matching the reporter's decode.</summary>
    private static string GzipBase64(byte[] json)
    {
        using var ms = new MemoryStream();
        using (var gz = new GZipStream(ms, CompressionLevel.Fastest, leaveOpen: true))
            gz.Write(json);
        return Convert.ToBase64String(ms.ToArray());
    }
}
