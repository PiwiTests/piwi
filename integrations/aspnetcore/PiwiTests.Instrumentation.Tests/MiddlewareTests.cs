using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using PiwiTests.Instrumentation.AspNetCore;
using Xunit;

namespace PiwiTests.Instrumentation.Tests;

public class MiddlewareTests
{
    [Theory]
    [InlineData("/json")]
    [InlineData("/empty")]
    public async Task Emits_the_captured_warning_whether_or_not_the_handler_writes_a_body(string path)
    {
        await using var app = await TestApp.StartAsync("Development", (a, _) => a.UsePiwiTestLogs());

        var logs = await app.GetLogsAsync(path);

        var entry = Assert.Single(logs!);
        Assert.Equal("Warning", entry.Level);
        Assert.Equal("Orders", entry.Category);
        Assert.Equal("Stock low for 42", entry.Message);
    }

    [Fact]
    public async Task Writes_the_dashboard_keys_with_the_exception_folded_into_stack()
    {
        await using var app = await TestApp.StartAsync("Development", (a, _) => a.UsePiwiTestLogs());

        using var json = TestApp.DecodeRawLogs(await app.Client.GetAsync("/error"))!;

        var entries = json.RootElement.EnumerateArray().ToList();
        Assert.Equal(2, entries.Count);
        Assert.Equal(["category", "level", "message", "timestamp"], TestApp.SortedKeys(entries[0]));
        Assert.Equal(["category", "level", "message", "stack", "timestamp"], TestApp.SortedKeys(entries[1]));
        Assert.Equal("Error", entries[1].GetProperty("level").GetString());
        Assert.Equal("Order 7 failed", entries[1].GetProperty("message").GetString());
        var stack = entries[1].GetProperty("stack").GetString()!;
        Assert.StartsWith("boom\n", stack);
        Assert.Contains("TestApp.HandleAsync", stack);
    }

    [Fact]
    public async Task Emits_the_header_on_the_error_response_an_outer_exception_handler_writes()
    {
        await using var app = await TestApp.StartAsync(
            "Development",
            (a, _) => a.UsePiwiTestLogs(),
            outer: a => a.UseExceptionHandler(new ExceptionHandlerOptions
            {
                ExceptionHandler = context =>
                {
                    context.Response.StatusCode = StatusCodes.Status500InternalServerError;
                    return context.Response.WriteAsync("failed");
                },
            }));

        var response = await app.Client.GetAsync("/throw");

        Assert.Equal(500, (int)response.StatusCode);
        var entry = Assert.Single(TestApp.DecodeLogs(response)!);
        Assert.Equal("Stock low for 42", entry.Message);
    }

    [Fact]
    public async Task Emits_an_empty_list_when_the_request_logged_nothing_capturable()
    {
        await using var app = await TestApp.StartAsync("Development", (a, _) => a.UsePiwiTestLogs(),
            services: s => s.Configure<LoggerFilterOptions>(o => o.MinLevel = LogLevel.Error));

        Assert.Empty((await app.GetLogsAsync("/json"))!);
    }
}
