using System;
using System.Buffers;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PiwiTests.Instrumentation.Coverage;

namespace PiwiTests.Instrumentation.AspNetCore;

/// <summary>How the middleware serves coverage; the defaults come from the recorder.</summary>
internal sealed class PiwiCoverageSettings
{
    /// <summary>The recorder's mode, <c>PIWI_COVERAGE_MODE</c>.</summary>
    public PiwiCoverageMode Mode { get; init; } = PiwiCoverageRecorder.Mode;

    /// <summary>True when code built with coverage instrumentation runs in this process.</summary>
    public Func<bool> IsInstrumented { get; init; } = () => PiwiCoverageRecorder.HasInstrumentedModules;

    /// <summary>The most ended requests kept until they are collected.</summary>
    public int MaxRequests { get; init; } = 5000;

    /// <summary>The most memory, approximately, the ended requests kept take.</summary>
    public long MaxBytes { get; init; } = 64L * 1024 * 1024;
}

/// <summary>
/// Server coverage for the middleware: in <see cref="PiwiCoverageMode.Test"/> mode, each request records into
/// its own <see cref="PiwiRequestCoverage"/>, named on its response
/// (<c>X-Piwi-Coverage: &lt;process&gt;.&lt;sequence&gt;.&lt;secret&gt;</c>, the secret random per request, so only
/// the client that received an id can collect its coverage) when it recorded something, and kept until the reporter
/// collects it. Serves
/// <c>POST /__piwi/coverage/collect</c> (the coverage of the request ids a test received, merged per group) and
/// <c>GET /__piwi/coverage/run</c> (the run-level coverage). Everything here is inactive until code built with
/// coverage instrumentation runs in the process.
/// </summary>
internal sealed class PiwiServerCoverage
{
    internal const string HeaderName = "X-Piwi-Coverage";
    internal const string CollectPath = "/__piwi/coverage/collect";
    internal const string RunPath = "/__piwi/coverage/run";

    /// <summary>The largest collect request body read, in bytes.</summary>
    internal const int MaxBodyBytes = 1024 * 1024;

    /// <summary>The most request ids one collect request may name.</summary>
    internal const int MaxRequestIds = 10_000;

    /// <summary>Names this process in request ids, so an id from an earlier process reads as missing.</summary>
    internal static readonly string ProcessKey = Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant();

    private static long s_sequence;

    private readonly PiwiCoverageSettings _settings;
    private readonly PiwiCoverageStore _store;
    private string? _baseDirectory;
    private bool _baseDirectoryResolved;
    private int _unplacedWarned;

    internal PiwiServerCoverage(PiwiCoverageSettings settings)
    {
        _settings = settings;
        _store = new PiwiCoverageStore(settings.MaxRequests, settings.MaxBytes);
    }

    /// <summary>True once code built with coverage instrumentation runs in this process.</summary>
    internal bool IsActive => _settings.IsInstrumented();

    internal bool IsRequest(HttpRequest request) =>
        (HttpMethods.IsPost(request.Method) && request.Path.Equals(CollectPath, StringComparison.OrdinalIgnoreCase)) ||
        ((HttpMethods.IsGet(request.Method) || HttpMethods.IsHead(request.Method)) &&
         request.Path.Equals(RunPath, StringComparison.OrdinalIgnoreCase));

    /// <summary>Starts recording the current request's coverage; null when coverage is only kept at run level.</summary>
    internal TrackedRequest? Begin()
    {
        if (_settings.Mode != PiwiCoverageMode.Test)
            return null;

        var request = new TrackedRequest(new PiwiRequestCoverage());
        PiwiCoverageRecorder.Begin(request.Coverage);
        return request;
    }

    /// <summary>
    /// The request id to write on the response as it starts, or null when the request recorded nothing. The
    /// request is kept from here until it is collected.
    /// </summary>
    internal string? Name(TrackedRequest request)
    {
        if (request.Sequence is not null || !request.Coverage.HasPayloads)
            return null;

        var sequence = Interlocked.Increment(ref s_sequence);
        var secret = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        request.Sequence = sequence;
        AddToRunLevel(_store.Add(sequence, secret, request.Coverage, request.Ended));
        return $"{ProcessKey}.{sequence}.{secret}";
    }

    /// <summary>Stops recording the current request's coverage.</summary>
    internal void End(TrackedRequest request, bool responseStarted)
    {
        PiwiCoverageRecorder.End();
        request.Ended = true;

        if (request.Sequence is { } sequence)
        {
            var kept = _store.End(sequence, out var evicted);
            AddToRunLevel(evicted);

            // Collected while it ran: what it recorded since still counts at run level.
            if (!kept)
                PiwiCoverageRecorder.AddToRunLevel(request.Coverage);
        }
        else if (responseStarted && request.Coverage.HasPayloads)
        {
            // Recorded only after its response started, so never named: it counts at run level.
            PiwiCoverageRecorder.AddToRunLevel(request.Coverage);
        }
    }

    internal Task WriteAsync(HttpContext context) =>
        HttpMethods.IsPost(context.Request.Method) ? CollectAsync(context) : RunAsync(context);

    private async Task CollectAsync(HttpContext context)
    {
        var body = await ReadBodyAsync(context.Request);
        if (body is null)
        {
            await WriteErrorAsync(context, StatusCodes.Status413PayloadTooLarge, $"The body exceeds {MaxBodyBytes} bytes.");
            return;
        }

        CollectRequest? collect;
        try
        {
            collect = ParseCollect(body.Value);
        }
        catch (JsonException)
        {
            collect = null;
        }

        if (collect is null)
        {
            await WriteErrorAsync(context, StatusCodes.Status400BadRequest,
                "Expected { \"granularity\": \"files\" | \"functions\" | \"lines\", \"groups\": [{ \"key\": string, \"requests\": [string] }] }.");
            return;
        }

        if (collect.RequestCount > MaxRequestIds)
        {
            await WriteErrorAsync(context, StatusCodes.Status400BadRequest, $"At most {MaxRequestIds} request ids per call.");
            return;
        }

        var repositoryPath = RepositoryPath(context);
        var collected = new List<PiwiRequestCoverage>();
        var output = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartObject();
            writer.WriteNumber("v", 1);
            writer.WriteStartArray("groups");
            foreach (var group in collect.Groups)
            {
                var report = new PiwiCoverageReport(collect.Granularity, repositoryPath);
                var missing = new List<string>();
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (var id in group.Requests)
                {
                    if (!seen.Add(id))
                        continue;

                    if (ParseId(id) is { } parsed && _store.Take(parsed.Sequence, parsed.Secret) is { } coverage)
                    {
                        report.AddRequest(coverage);
                        collected.Add(coverage);
                    }
                    else
                    {
                        missing.Add(id);
                    }
                }

                writer.WriteStartObject();
                writer.WriteString("key", group.Key);
                writer.WritePropertyName("files");
                report.WriteFiles(writer);
                writer.WriteStartArray("missing");
                foreach (var id in missing)
                    writer.WriteStringValue(id);
                writer.WriteEndArray();
                writer.WriteEndObject();
            }

            writer.WriteEndArray();
            writer.WriteEndObject();
        }

        AddToRunLevel(collected);
        await WriteJsonAsync(context, output);
    }

    private async Task RunAsync(HttpContext context)
    {
        var value = context.Request.Query["granularity"].ToString();
        var granularity = string.IsNullOrEmpty(value) ? PiwiCoverageGranularity.Lines : ParseGranularity(value);
        if (granularity is null)
        {
            await WriteErrorAsync(context, StatusCodes.Status400BadRequest, "granularity must be files, functions or lines.");
            return;
        }

        var report = new PiwiCoverageReport(granularity.Value, RepositoryPath(context));
        report.AddRunLevel();
        foreach (var coverage in _store.Snapshot())
            report.AddRequest(coverage);
        report.AddExecutableLines();

        var output = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartObject();
            writer.WriteNumber("v", 1);
            writer.WritePropertyName("files");
            report.WriteFiles(writer);
            writer.WriteEndObject();
        }

        await WriteJsonAsync(context, output);
    }

    /// <summary>The sequence and the secret of a request id this process gave out, or null.</summary>
    internal static (long Sequence, string Secret)? ParseId(string id)
    {
        var parts = id.Split('.');
        if (parts.Length != 3 || parts[0] != ProcessKey || parts[2].Length == 0)
            return null;

        return long.TryParse(parts[1], System.Globalization.NumberStyles.None,
            System.Globalization.CultureInfo.InvariantCulture, out var sequence) && sequence > 0
            ? (sequence, parts[2])
            : null;
    }

    private Func<string, string?> RepositoryPath(HttpContext context)
    {
        if (!_baseDirectoryResolved)
        {
            _baseDirectory = PiwiSourceFiles.BaseDirectory(context.RequestServices.GetService<IHostEnvironment>()?.ContentRootPath);
            _baseDirectoryResolved = true;
        }

        var baseDirectory = _baseDirectory;
        var logger = context.RequestServices.GetService<ILoggerFactory>()?.CreateLogger("PiwiTests.Instrumentation");
        return document =>
        {
            var path = PiwiSourceFiles.RepositoryRelative(baseDirectory, document);
            if (path is null && Path.IsPathRooted(document) && Interlocked.Exchange(ref _unplacedWarned, 1) == 0)
            {
                logger?.LogWarning(
                    "Server coverage leaves out {Document} and every other source file outside the repository: the sources are not under the content root's repository nor in a repository on this machine. Set PIWI_SOURCE_ROOT to the directory the sources were compiled from.",
                    document);
            }

            return path;
        };
    }

    private static void AddToRunLevel(List<PiwiRequestCoverage>? requests)
    {
        if (requests is null)
            return;

        foreach (var request in requests)
            PiwiCoverageRecorder.AddToRunLevel(request);
    }

    private static PiwiCoverageGranularity? ParseGranularity(string? value) => value switch
    {
        "files" => PiwiCoverageGranularity.Files,
        "functions" => PiwiCoverageGranularity.Functions,
        "lines" => PiwiCoverageGranularity.Lines,
        _ => null,
    };

    /// <summary>The collect request body, or null when it does not have the expected shape.</summary>
    private static CollectRequest? ParseCollect(ReadOnlyMemory<byte> body)
    {
        using var document = JsonDocument.Parse(body);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
            return null;

        var granularity = PiwiCoverageGranularity.Lines;
        if (root.TryGetProperty("granularity", out var granularityElement))
        {
            if (granularityElement.ValueKind != JsonValueKind.String || ParseGranularity(granularityElement.GetString()) is not { } parsed)
                return null;
            granularity = parsed;
        }

        if (!root.TryGetProperty("groups", out var groupsElement) || groupsElement.ValueKind != JsonValueKind.Array)
            return null;

        var groups = new List<CollectGroup>();
        var requestCount = 0;
        foreach (var groupElement in groupsElement.EnumerateArray())
        {
            if (groupElement.ValueKind != JsonValueKind.Object ||
                !groupElement.TryGetProperty("key", out var keyElement) || keyElement.ValueKind != JsonValueKind.String ||
                !groupElement.TryGetProperty("requests", out var requestsElement) || requestsElement.ValueKind != JsonValueKind.Array)
                return null;

            var requests = new List<string>();
            foreach (var requestElement in requestsElement.EnumerateArray())
            {
                if (requestElement.ValueKind != JsonValueKind.String)
                    return null;
                requests.Add(requestElement.GetString()!);
            }

            requestCount += requests.Count;
            groups.Add(new CollectGroup(keyElement.GetString()!, requests));
        }

        return new CollectRequest(granularity, groups, requestCount);
    }

    /// <summary>The request body, or null when it is larger than <see cref="MaxBodyBytes"/>.</summary>
    private static async Task<ReadOnlyMemory<byte>?> ReadBodyAsync(HttpRequest request)
    {
        if (request.ContentLength > MaxBodyBytes)
            return null;

        using var buffer = new MemoryStream();
        var chunk = new byte[16 * 1024];
        int read;
        while ((read = await request.Body.ReadAsync(chunk)) > 0)
        {
            if (buffer.Length + read > MaxBodyBytes)
                return null;
            buffer.Write(chunk, 0, read);
        }

        return buffer.GetBuffer().AsMemory(0, (int)buffer.Length);
    }

    private static async Task WriteJsonAsync(HttpContext context, ArrayBufferWriter<byte> output)
    {
        context.Response.StatusCode = StatusCodes.Status200OK;
        context.Response.ContentType = "application/json";
        context.Response.Headers.CacheControl = "no-store";
        await context.Response.Body.WriteAsync(output.WrittenMemory);
    }

    private static Task WriteErrorAsync(HttpContext context, int status, string message)
    {
        context.Response.StatusCode = status;
        context.Response.ContentType = "text/plain; charset=utf-8";
        return context.Response.WriteAsync(message);
    }

    /// <summary>The coverage of one request as the middleware tracks it.</summary>
    internal sealed class TrackedRequest(PiwiRequestCoverage coverage)
    {
        public PiwiRequestCoverage Coverage { get; } = coverage;

        /// <summary>The sequence the request was named with, once its response started.</summary>
        public long? Sequence { get; set; }

        /// <summary>True once the request left the middleware.</summary>
        public bool Ended { get; set; }
    }

    private sealed record CollectGroup(string Key, List<string> Requests);

    private sealed record CollectRequest(PiwiCoverageGranularity Granularity, List<CollectGroup> Groups, int RequestCount);
}
