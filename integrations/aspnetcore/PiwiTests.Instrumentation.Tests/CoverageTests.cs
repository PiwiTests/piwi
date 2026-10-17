using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using PiwiTests.Instrumentation.AspNetCore;
using PiwiTests.Instrumentation.Coverage;
using Xunit;
using static PiwiTests.Instrumentation.Tests.FixtureSource;

namespace PiwiTests.Instrumentation.Tests;

public class CoverageTests
{
    /// <summary>What a request to each fixture endpoint executes: per file, its functions and lines.</summary>
    private static readonly Dictionary<string, string> ExpectedByPath = new()
    {
        ["/quote?quantity=3"] = Describe(QuoteFile(), PriceListFile()),
        ["/squares?count=3"] = Describe(SquaresFile(lambdaRan: true)),
        ["/check?value=5"] = Describe(CheckFile()),
        ["/report"] = Describe(ReportFile(), TotalsFile()),
    };

    [Fact]
    public async Task Names_a_request_that_ran_instrumented_code_and_collects_its_files_functions_and_lines()
    {
        await using var app = await CoverageTestApp.StartAsync();

        var id = await app.RequestIdAsync("/quote?quantity=3");

        Assert.Matches(new Regex("^[0-9a-f]{12}\\.[0-9]+$"), id);
        var group = await app.CollectAsync("lines", id!);
        Assert.Equal("test", group.Key);
        Assert.Empty(group.Missing);
        Assert.Equal(ExpectedByPath["/quote?quantity=3"], Describe(group.Files));
        Assert.All(group.Files, f => Assert.Equal("server", f.Runtime));
    }

    [Fact]
    public async Task Counts_only_the_first_line_of_a_primary_constructor()
    {
        await using var app = await CoverageTestApp.StartAsync();

        var group = await app.CollectAsync("lines", (await app.RequestIdAsync("/quote?quantity=3"))!);

        var file = group.File("PriceList.cs");
        Assert.Equal(
            Ranges(
                Line("PriceList.cs", "public sealed class PriceList("),
                Line("PriceList.cs", "private readonly decimal _discount = 0.1m;"),
                Line("PriceList.cs", "var gross = unitPrice * quantity;"),
                Line("PriceList.cs", "return gross - gross * _discount;")),
            file.Lines);
        Assert.Contains(Function("PriceList.cs", "public sealed class PriceList("), file.Functions!);
        Assert.DoesNotContain(Line("PriceList.cs", "return -Total(quantity);"), Expand(file.Lines!));
    }

    [Fact]
    public async Task Leaves_out_the_lines_of_an_untaken_branch()
    {
        await using var app = await CoverageTestApp.StartAsync();

        var group = await app.CollectAsync("lines", (await app.RequestIdAsync("/check?value=5"))!);

        Assert.Equal(Describe(CheckFile()), Describe(group.Files));
        Assert.DoesNotContain(Line("Checks.cs", "return Results.BadRequest(\"negative\");"), Expand(group.File("Checks.cs").Lines!));
    }

    [Fact]
    public async Task Counts_the_lines_of_a_lambda_only_when_it_ran()
    {
        await using var app = await CoverageTestApp.StartAsync();

        var ran = await app.CollectAsync("lines", (await app.RequestIdAsync("/squares?count=3"))!);
        var notRan = await app.CollectAsync("lines", (await app.RequestIdAsync("/squares?count=0"))!);

        Assert.Equal(Describe(SquaresFile(lambdaRan: true)), Describe(ran.Files));
        Assert.Equal(Describe(SquaresFile(lambdaRan: false)), Describe(notRan.Files));
    }

    [Fact]
    public async Task Attributes_an_async_method_and_the_work_it_starts_with_Task_Run_to_the_request()
    {
        await using var app = await CoverageTestApp.StartAsync();

        var group = await app.CollectAsync("lines", (await app.RequestIdAsync("/report"))!);

        Assert.Equal(Describe(ReportFile(), TotalsFile()), Describe(group.Files));
    }

    [Fact]
    public async Task Counts_an_inline_handler_created_at_startup_at_run_level_only()
    {
        await using var app = await CoverageTestApp.StartAsync();

        var group = await app.CollectAsync("lines", (await app.RequestIdAsync("/inline?name=piwi"))!);
        var run = await app.RunAsync("lines");

        // The request records the method the handler calls, not the handler's own lines.
        Assert.Equal([Path("Greetings.cs")], group.Paths);
        var inline = Expand(run.File("FixtureEndpoints.cs").Lines!);
        Assert.Contains(Line("FixtureEndpoints.cs", "var greeting = Greetings.Text(name);"), inline);
        Assert.Contains(Line("FixtureEndpoints.cs", "var length = greeting.Length;"), inline);
        Assert.Contains(Line("FixtureEndpoints.cs", "return Results.Ok(new { greeting, length });"), inline);
    }

    [Fact]
    public async Task Names_a_response_that_starts_after_the_middleware_returns()
    {
        await using var app = await CoverageTestApp.StartAsync();

        var response = await app.Client.GetAsync("/empty");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        var group = await app.CollectAsync("functions", CoverageTestApp.RequestId(response)!);
        Assert.Empty(group.Missing);
        Assert.Equal([Function("Checks.cs", "public static IResult Empty(")], group.File("Checks.cs").Functions);
    }

    [Fact]
    public async Task Attributes_concurrent_requests_to_different_endpoints_to_each_request_alone()
    {
        await using var app = await CoverageTestApp.StartAsync();
        var paths = ExpectedByPath.Keys.ToArray();
        var requests = Enumerable.Range(0, 200).Select(i => paths[i % paths.Length]).ToArray();

        var ids = await Task.WhenAll(requests.Select(app.RequestIdAsync));
        var groups = await app.CollectEachAsync("lines", ids.Select(id => id!));

        Assert.Equal(requests.Length, ids.Distinct().Count());
        for (var i = 0; i < requests.Length; i++)
        {
            var group = groups[ids[i]!];
            Assert.Empty(group.Missing);
            Assert.Equal(ExpectedByPath[requests[i]], Describe(group.Files));
        }

    }

    [Fact]
    public async Task Merges_the_requests_of_a_group()
    {
        await using var app = await CoverageTestApp.StartAsync();
        var quote = await app.RequestIdAsync("/quote?quantity=3");
        var check = await app.RequestIdAsync("/check?value=5");

        var group = await app.CollectAsync("lines", quote!, check!, quote!);

        Assert.Empty(group.Missing);
        Assert.Equal(Describe(CheckFile(), PriceListFile(), QuoteFile()), Describe(group.Files));
    }

    [Fact]
    public async Task Reports_ids_it_does_not_hold_as_missing()
    {
        await using var app = await CoverageTestApp.StartAsync();
        var id = (await app.RequestIdAsync("/check?value=5"))!;
        var otherProcess = (id[0] == 'a' ? 'b' : 'a') + id[1..];
        var unknownSequence = id[..id.IndexOf('.')] + ".999999999";

        var first = await app.CollectAsync("files", id, otherProcess, unknownSequence, "not-an-id");
        var second = await app.CollectAsync("files", id);

        Assert.Equal([Path("Checks.cs")], first.Paths);
        Assert.Equal([otherProcess, unknownSequence, "not-an-id"], first.Missing);
        Assert.Empty(second.Files);
        Assert.Equal([id], second.Missing);
    }

    [Fact]
    public async Task Evicts_the_oldest_ended_requests_beyond_the_count_cap()
    {
        await using var app = await CoverageTestApp.StartAsync(new PiwiCoverageSettings { MaxRequests = 2 });
        var ids = new List<string>();
        for (var i = 0; i < 3; i++)
            ids.Add((await app.RequestIdAsync("/check?value=5"))!);

        var answer = await app.CollectEachAsync("files", ids);

        Assert.Equal([ids[0]], answer[ids[0]].Missing);
        Assert.Empty(answer[ids[1]].Missing);
        Assert.Empty(answer[ids[2]].Missing);
    }

    [Fact]
    public async Task Evicts_ended_requests_beyond_the_byte_cap()
    {
        await using var app = await CoverageTestApp.StartAsync(new PiwiCoverageSettings { MaxBytes = 1 });
        var id = (await app.RequestIdAsync("/check?value=5"))!;

        var group = await app.CollectAsync("files", id);

        Assert.Equal([id], group.Missing);
    }

    [Theory]
    [InlineData("files", new[] { "path", "runtime" })]
    [InlineData("functions", new[] { "checksums", "functions", "path", "runtime" })]
    [InlineData("lines", new[] { "checksums", "functions", "lines", "path", "runtime" })]
    public async Task Projects_the_answer_to_the_granularity_asked_for(string granularity, string[] keys)
    {
        await using var app = await CoverageTestApp.StartAsync();
        var id = await app.RequestIdAsync("/quote?quantity=3");

        var response = await app.Client.PostAsync("/__piwi/coverage/collect", Json(new
        {
            granularity,
            groups = new[] { new { key = "k", requests = new[] { id } } },
        }));

        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = json.RootElement;
        Assert.Equal(["groups", "v"], TestApp.SortedKeys(root));
        Assert.Equal(1, root.GetProperty("v").GetInt32());
        var group = Assert.Single(root.GetProperty("groups").EnumerateArray().ToList());
        Assert.Equal(["files", "key", "missing"], TestApp.SortedKeys(group));
        var files = group.GetProperty("files").EnumerateArray().ToList();
        Assert.Equal([Path("PriceList.cs"), Path("Quotes.cs")], files.Select(f => f.GetProperty("path").GetString()));
        Assert.All(files, f => Assert.Equal(keys, TestApp.SortedKeys(f)));
    }

    [Theory]
    [InlineData("files", new[] { "path", "runtime" })]
    [InlineData("functions", new[] { "checksums", "functions", "path", "runtime" })]
    [InlineData("lines", new[] { "allFunctions", "checksums", "executable", "functions", "lines", "path", "runtime" })]
    public async Task Serves_the_run_level_coverage_at_the_granularity_asked_for(string granularity, string[] keys)
    {
        await using var app = await CoverageTestApp.StartAsync();
        await app.RequestIdAsync("/check?value=5");

        using var json = await app.RunJsonAsync(granularity);

        Assert.Equal(["files", "v"], TestApp.SortedKeys(json.RootElement));
        var check = Assert.Single(json.RootElement.GetProperty("files").EnumerateArray(), f => f.GetProperty("path").GetString() == Path("Checks.cs"));
        Assert.Equal(keys, TestApp.SortedKeys(check));
    }

    [Fact]
    public async Task Lists_executable_lines_at_run_level_whether_they_ran_or_not()
    {
        await using var app = await CoverageTestApp.StartAsync();
        await app.RequestIdAsync("/check?value=5");

        var run = await app.RunAsync("lines");

        var check = run.File("Checks.cs");
        var badRequest = Line("Checks.cs", "return Results.BadRequest(\"negative\");");
        Assert.Contains(badRequest, Expand(check.Executable!));
        Assert.DoesNotContain(badRequest, Expand(check.Lines!));
        Assert.Contains(Line("Checks.cs", "return Results.Ok(value);"), Expand(check.Lines!));
    }

    [Fact]
    public async Task Lists_the_executable_lines_of_an_instrumented_assembly_whose_code_never_ran()
    {
        const string idle = "PiwiTests.Instrumentation.CoverageIdleFixture";
        Assert.DoesNotContain(AppDomain.CurrentDomain.GetAssemblies(), a => a.GetName().Name == idle);
        await using var app = await CoverageTestApp.StartAsync();
        await app.RequestIdAsync("/check?value=5");

        var run = await app.RunAsync("lines");

        var discounts = Assert.Single(run.Files, f => f.Path == $"integrations/aspnetcore/{idle}/Discounts.cs");
        Assert.Empty(discounts.Lines!);
        Assert.Empty(discounts.Functions!);
        var source = System.IO.File.ReadAllLines(RepositoryFile(discounts.Path));
        var returned = Array.FindIndex(source, l => l.Contains("return price - price * percent / 100;", StringComparison.Ordinal)) + 1;
        Assert.Contains(returned, Expand(discounts.Executable!));
        var declared = Array.FindIndex(source, l => l.Contains("public static decimal Apply(", StringComparison.Ordinal)) + 1;
        Assert.Equal(declared, Assert.Single(discounts.AllFunctions!)[0]);
        Assert.DoesNotContain(AppDomain.CurrentDomain.GetAssemblies(), a => a.GetName().Name == idle);
    }

    [Fact]
    public async Task Writes_the_run_level_report_to_a_file_with_the_paths_the_compiler_recorded()
    {
        await using var app = await CoverageTestApp.StartAsync();
        await app.RequestIdAsync("/check?value=5");
        var output = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"piwi-coverage-{Guid.NewGuid():N}", "unit.json");
        try
        {
            PiwiCoverageOutput.Write(output);

            using var json = JsonDocument.Parse(System.IO.File.ReadAllText(output));
            Assert.Equal(["files", "v"], TestApp.SortedKeys(json.RootElement));
            var files = json.RootElement.GetProperty("files").Deserialize<List<WireCoverageFile>>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
            var check = Assert.Single(files, f => f.Path.Replace('\\', '/').EndsWith("/" + Path("Checks.cs"), StringComparison.Ordinal));
            Assert.True(System.IO.Path.IsPathRooted(check.Path));
            Assert.Contains(Line("Checks.cs", "return Results.Ok(value);"), Expand(check.Lines!));
            Assert.NotEmpty(check.Executable!);
            Assert.NotEmpty(check.AllFunctions!);
            Assert.Equal([output], System.IO.Directory.GetFiles(System.IO.Path.GetDirectoryName(output)!));
        }
        finally
        {
            System.IO.Directory.Delete(System.IO.Path.GetDirectoryName(output)!, recursive: true);
        }
    }

    [Fact]
    public async Task Names_the_checksum_of_each_files_source_with_its_lines()
    {
        await using var app = await CoverageTestApp.StartAsync();
        var id = (await app.RequestIdAsync("/quote?quantity=3"))!;
        var expected = "sha256:" + Convert.ToHexString(SHA256.HashData(System.IO.File.ReadAllBytes(RepositoryFile(Path("Quotes.cs"))))).ToLowerInvariant();

        var collected = await app.CollectAsync("lines", id);
        var run = await app.RunAsync("lines");

        Assert.Equal([expected], collected.File("Quotes.cs").Checksums!);
        Assert.Equal([expected], run.File("Quotes.cs").Checksums!);
    }

    [Fact]
    public async Task Run_mode_names_no_request_and_counts_every_call_at_run_level()
    {
        await using var app = await CoverageTestApp.StartAsync(new PiwiCoverageSettings { Mode = PiwiCoverageMode.Run });

        var id = await app.RequestIdAsync("/quote?quantity=3");
        var run = await app.RunAsync("lines");

        Assert.Null(id);
        var quote = run.File("Quotes.cs");
        Assert.Contains(Function("Quotes.cs", "public static IResult Quote("), quote.Functions!);
        Assert.Contains(Line("Quotes.cs", "var total = prices.Total(quantity);"), Expand(quote.Lines!));
    }

    [Fact]
    public async Task Names_no_request_served_by_code_built_without_instrumentation()
    {
        await using var app = await CoverageTestApp.StartAsync();

        Assert.Null(await app.RequestIdAsync("/plain"));
    }

    [Fact]
    public async Task Serves_the_endpoints_under_the_path_base()
    {
        await using var app = await CoverageTestApp.StartAsync(pathBase: "/shop");
        var id = await app.RequestIdAsync("/shop/check?value=5");

        var answer = await app.CollectAsync(
            new { granularity = "files", groups = new[] { new { key = "k", requests = new[] { id } } } },
            "/shop/__piwi/coverage/collect");
        using var run = await app.RunJsonAsync("files", "/shop/__piwi/coverage/run");

        Assert.Equal([Path("Checks.cs")], Assert.Single(answer.Groups).Paths);
        Assert.Equal(1, run.RootElement.GetProperty("v").GetInt32());
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("{ \"groups\": {} }")]
    [InlineData("{ \"granularity\": \"statements\", \"groups\": [] }")]
    [InlineData("{ \"groups\": [{ \"key\": 1, \"requests\": [] }] }")]
    [InlineData("{ \"groups\": [{ \"key\": \"k\", \"requests\": [1] }] }")]
    public async Task Rejects_a_collect_body_of_the_wrong_shape(string body)
    {
        await using var app = await CoverageTestApp.StartAsync();

        var response = await app.PostCollectAsync(body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Rejects_too_many_request_ids_and_too_large_a_body()
    {
        await using var app = await CoverageTestApp.StartAsync();
        var ids = Enumerable.Range(1, PiwiServerCoverage.MaxRequestIds + 1).Select(i => $"x.{i}").ToArray();

        var tooMany = await app.Client.PostAsync("/__piwi/coverage/collect", Json(new { groups = new[] { new { key = "k", requests = ids } } }));
        var tooLarge = await app.PostCollectAsync($"{{ \"groups\": [], \"pad\": \"{new string('x', PiwiServerCoverage.MaxBodyBytes)}\" }}");

        Assert.Equal(HttpStatusCode.BadRequest, tooMany.StatusCode);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, tooLarge.StatusCode);
    }

    [Fact]
    public async Task Leaves_the_coverage_paths_to_the_app_and_names_nothing_when_no_code_is_instrumented()
    {
        await using var app = await TestApp.StartAsync(
            "Development",
            (a, _) => a.UsePiwiTestLogs(),
            services: s => s.AddPiwiTestLogs(o => o.Coverage = new PiwiCoverageSettings { IsInstrumented = () => false }));

        var run = await app.Client.GetAsync("/__piwi/coverage/run");
        var collect = await app.Client.PostAsync("/__piwi/coverage/collect", Json(new { groups = Array.Empty<object>() }));

        foreach (var response in new[] { run, collect })
        {
            Assert.Equal("{\"ok\":true}", await response.Content.ReadAsStringAsync());
            Assert.NotNull(TestApp.DecodeLogs(response));
            Assert.Null(CoverageTestApp.RequestId(response));
        }
    }

    [Fact]
    public async Task Names_nothing_in_an_app_whose_own_code_is_not_instrumented()
    {
        await using var app = await TestApp.StartAsync("Development", (a, _) => a.UsePiwiTestLogs());

        var response = await app.Client.GetAsync("/json");

        Assert.Single(TestApp.DecodeLogs(response)!);
        Assert.Null(CoverageTestApp.RequestId(response));
    }

    [Fact]
    public async Task Warns_when_a_coverage_build_runs_where_the_middleware_is_not_active()
    {
        var logs = new ListLoggerProvider();
        await using var app = await TestApp.StartAsync(
            "Production",
            (a, _) => a.UsePiwiTestLogs(),
            services: s =>
            {
                s.AddLogging(l => l.AddProvider(logs));
                s.AddPiwiTestLogs(o => o.Coverage = new PiwiCoverageSettings { IsInstrumented = () => true });
            });

        var warning = Assert.Single(logs.Messages, m => m.Contains("-p:PiwiCoverage=true", StringComparison.Ordinal));
        Assert.Contains("Production", warning);
        Assert.Null(CoverageTestApp.RequestId(await app.Client.GetAsync("/json")));
    }

    private static StringContent Json(object body) =>
        new(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

    private static int[] Expand(int[][] ranges) => [.. ranges.SelectMany(r => Enumerable.Range(r[0], r[1] - r[0] + 1))];

    private static ExpectedFile QuoteFile() => new(
        "Quotes.cs",
        [Function("Quotes.cs", "public static IResult Quote(")],
        Ranges(
            Line("Quotes.cs", "var prices = new PriceList(2.5m);"),
            Line("Quotes.cs", "var total = prices.Total(quantity);"),
            Line("Quotes.cs", "return Results.Ok(new { quantity, total });")));

    private static ExpectedFile PriceListFile() => new(
        "PriceList.cs",
        [Function("PriceList.cs", "public sealed class PriceList("), Function("PriceList.cs", "public decimal Total(")],
        Ranges(
            Line("PriceList.cs", "public sealed class PriceList("),
            Line("PriceList.cs", "private readonly decimal _discount = 0.1m;"),
            Line("PriceList.cs", "var gross = unitPrice * quantity;"),
            Line("PriceList.cs", "return gross - gross * _discount;")));

    private static ExpectedFile SquaresFile(bool lambdaRan)
    {
        var first = Line("Squares.cs", "var squares = Enumerable.Range(1, count)");
        var last = Line("Squares.cs", "return Results.Ok(squares);");
        var lambda = new[] { Line("Squares.cs", "var square = i * i;"), Line("Squares.cs", "return square;") };
        var lines = Enumerable.Range(first, last - first + 1).Where(line => lambdaRan || !lambda.Contains(line)).ToArray();
        return new ExpectedFile("Squares.cs", [Function("Squares.cs", "public static IResult Handle(")], Ranges(lines));
    }

    private static ExpectedFile CheckFile() => new(
        "Checks.cs",
        [Function("Checks.cs", "public static IResult Handle(")],
        Ranges(Line("Checks.cs", "if (value < 0)"), Line("Checks.cs", "return Results.Ok(value);")));

    private static ExpectedFile ReportFile() => new(
        "Reports.cs",
        [Function("Reports.cs", "public static async Task<IResult> HandleAsync(")],
        Ranges(
            Line("Reports.cs", "await Task.Yield();"),
            Line("Reports.cs", "var total = await Task.Run(() => Totals.Compute(10));"),
            Line("Reports.cs", "await Task.Delay(1);"),
            Line("Reports.cs", "return Results.Ok(new { total });")));

    private static ExpectedFile TotalsFile() => new(
        "Totals.cs",
        [Function("Totals.cs", "public static int Compute(")],
        Ranges(
            Line("Totals.cs", "var total = 0;"),
            Line("Totals.cs", "for (var i = 1; i <= count; i++)"),
            Line("Totals.cs", "total += i;"),
            Line("Totals.cs", "return total;")));

    private static string Describe(params ExpectedFile[] files) =>
        Describe(files.Select(f => new WireCoverageFile(Path(f.Name), "server", f.Functions, f.Lines, null)));

    private static string Describe(IEnumerable<WireCoverageFile> files) =>
        string.Join("\n", files.OrderBy(f => f.Path, StringComparer.Ordinal).Select(f => $"{f.Path} functions={Format(f.Functions)} lines={Format(f.Lines)}"));

    private static string Format(int[][]? ranges) =>
        ranges is null ? "-" : string.Join(",", ranges.OrderBy(r => r[0]).ThenBy(r => r[1]).Select(r => $"{r[0]}-{r[1]}"));

    private sealed record ExpectedFile(string Name, int[][] Functions, int[][] Lines);

    private sealed class ListLoggerProvider : ILoggerProvider, ILogger
    {
        public ConcurrentQueue<string> Messages { get; } = new();

        public ILogger CreateLogger(string categoryName) => this;

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            Messages.Enqueue(formatter(state, exception));

        public void Dispose()
        {
        }
    }
}
