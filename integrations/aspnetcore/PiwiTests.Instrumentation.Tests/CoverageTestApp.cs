using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using PiwiTests.Instrumentation.AspNetCore;
using PiwiTests.Instrumentation.CoverageFixture;
using Xunit;

namespace PiwiTests.Instrumentation.Tests;

/// <summary>
/// An in-memory app serving the coverage fixture's endpoints, built with coverage instrumentation, behind
/// <c>UsePiwiTestLogs()</c>. <c>/plain</c> is served by this test assembly, which is not instrumented.
/// </summary>
internal sealed class CoverageTestApp : IAsyncDisposable
{
    private static readonly JsonSerializerOptions ReadOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private readonly IHost _host;

    private CoverageTestApp(IHost host)
    {
        _host = host;
        Client = host.GetTestClient();
    }

    public HttpClient Client { get; }

    public static async Task<CoverageTestApp> StartAsync(PiwiCoverageSettings? settings = null, string? pathBase = null)
    {
        var host = await new HostBuilder()
            .ConfigureWebHost(web => web
                .UseTestServer()
                .UseEnvironment("Development")
                .ConfigureServices(s =>
                {
                    s.AddRouting();
                    s.AddPiwiTestLogs(o => o.Coverage = settings ?? new PiwiCoverageSettings());
                })
                .Configure(app =>
                {
                    if (pathBase is not null)
                        app.UsePathBase(pathBase);
                    app.UsePiwiTestLogs();
                    app.UseRouting();
                    app.UseEndpoints(e =>
                    {
                        FixtureEndpoints.Map(e);
                        e.MapGet("/plain", () => "plain");
                    });
                }))
            .StartAsync();
        return new CoverageTestApp(host);
    }

    /// <summary>Requests <paramref name="path"/> and returns its <c>X-Piwi-Coverage</c> request id, or null when absent.</summary>
    public async Task<string?> RequestIdAsync(string path)
    {
        var response = await Client.GetAsync(path);
        response.EnsureSuccessStatusCode();
        return RequestId(response);
    }

    public static string? RequestId(HttpResponseMessage response) =>
        response.Headers.TryGetValues("X-Piwi-Coverage", out var values) ? values.Single() : null;

    /// <summary>Collects the coverage of one group per request id, keyed by the id.</summary>
    public async Task<Dictionary<string, WireCoverageGroup>> CollectEachAsync(string granularity, IEnumerable<string> ids)
    {
        var groups = ids.Select(id => new { key = id, requests = new[] { id } }).ToArray();
        var answer = await CollectAsync(new { granularity, groups });
        return answer.Groups.ToDictionary(g => g.Key);
    }

    /// <summary>Collects one group, keyed <c>test</c>, holding <paramref name="ids"/>.</summary>
    public async Task<WireCoverageGroup> CollectAsync(string granularity, params string[] ids)
    {
        var answer = await CollectAsync(new { granularity, groups = new[] { new { key = "test", requests = ids } } });
        return Assert.Single(answer.Groups);
    }

    public async Task<WireCollectAnswer> CollectAsync(object body, string path = "/__piwi/coverage/collect")
    {
        var response = await Client.PostAsJsonAsync(path, body);
        response.EnsureSuccessStatusCode();
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        Assert.Null(RequestId(response));
        return (await response.Content.ReadFromJsonAsync<WireCollectAnswer>(ReadOptions))!;
    }

    public Task<HttpResponseMessage> PostCollectAsync(string json) =>
        Client.PostAsync("/__piwi/coverage/collect", new StringContent(json, Encoding.UTF8, "application/json"));

    /// <summary>Reads <c>/__piwi/coverage/run</c> at <paramref name="granularity"/> as raw JSON.</summary>
    public async Task<JsonDocument> RunJsonAsync(string granularity, string path = "/__piwi/coverage/run")
    {
        var response = await Client.GetAsync($"{path}?granularity={granularity}");
        response.EnsureSuccessStatusCode();
        Assert.Null(RequestId(response));
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync());
    }

    public async Task<WireRunAnswer> RunAsync(string granularity)
    {
        using var json = await RunJsonAsync(granularity);
        return json.RootElement.Deserialize<WireRunAnswer>(ReadOptions)!;
    }

    public async ValueTask DisposeAsync()
    {
        Client.Dispose();
        await _host.StopAsync();
        _host.Dispose();
    }
}

internal sealed record WireCoverageFile(string Path, string Runtime, int[][]? Functions, int[][]? Lines, int[][]? Executable, string[]? Checksums = null, int[][]? AllFunctions = null);

internal sealed record WireCoverageGroup(string Key, List<WireCoverageFile> Files, List<string> Missing)
{
    public string[] Paths => [.. Files.Select(f => f.Path)];

    public WireCoverageFile File(string name) => Assert.Single(Files, f => f.Path == FixtureSource.Path(name));
}

internal sealed record WireCollectAnswer(int V, List<WireCoverageGroup> Groups);

internal sealed record WireRunAnswer(int V, List<WireCoverageFile> Files)
{
    public WireCoverageFile File(string name) => Assert.Single(Files, f => f.Path == FixtureSource.Path(name));
}

/// <summary>
/// The coverage fixture's sources, read from the repository, for the line numbers a test expects: a line is found
/// by its text, a function by its declaration, through to the closing brace at the declaration's indentation.
/// </summary>
internal static class FixtureSource
{
    private const string Directory = "integrations/aspnetcore/PiwiTests.Instrumentation.CoverageFixture";

    private static readonly string RepositoryRoot = FindRepositoryRoot();

    /// <summary>The repository-relative path of fixture file <paramref name="name"/>.</summary>
    public static string Path(string name) => $"{Directory}/{name}";

    /// <summary>The 1-based number of the one line of <paramref name="name"/> containing <paramref name="text"/>.</summary>
    public static int Line(string name, string text)
    {
        var lines = Read(name);
        var matches = Enumerable.Range(0, lines.Length).Where(i => lines[i].Contains(text, StringComparison.Ordinal)).ToArray();
        return Assert.Single(matches) + 1;
    }

    /// <summary>The 1-based line range of the declaration containing <paramref name="declaration"/>.</summary>
    public static int[] Function(string name, string declaration)
    {
        var lines = Read(name);
        var start = Line(name, declaration) - 1;
        var indentation = lines[start].Length - lines[start].TrimStart().Length;
        for (var i = start + 1; i < lines.Length; i++)
        {
            if (lines[i].TrimEnd() == new string(' ', indentation) + "}")
                return [start + 1, i + 1];
        }

        throw new InvalidOperationException($"No closing brace for {declaration} in {name}.");
    }

    /// <summary>The given 1-based line numbers as sorted, merged ranges.</summary>
    public static int[][] Ranges(params int[] lines)
    {
        var ranges = new List<int[]>();
        foreach (var line in lines.Distinct().Order())
        {
            if (ranges.Count > 0 && ranges[^1][1] == line - 1)
                ranges[^1][1] = line;
            else
                ranges.Add([line, line]);
        }

        return [.. ranges];
    }

    /// <summary>The absolute path of the repository-relative path <paramref name="path"/>.</summary>
    public static string RepositoryFile(string path) => System.IO.Path.Combine(RepositoryRoot, path);

    private static string[] Read(string name) => File.ReadAllLines(System.IO.Path.Combine(RepositoryRoot, Directory, name));

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var git = System.IO.Path.Combine(directory.FullName, ".git");
            if (System.IO.Directory.Exists(git) || File.Exists(git))
                return directory.FullName;
        }

        throw new InvalidOperationException("The tests run from a Git checkout.");
    }
}
