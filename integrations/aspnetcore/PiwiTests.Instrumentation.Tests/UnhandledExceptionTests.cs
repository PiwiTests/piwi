using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using PiwiTests.Instrumentation.AspNetCore;
using Xunit;

namespace PiwiTests.Instrumentation.Tests;

public class UnhandledExceptionTests
{
    [Fact]
    public async Task Records_an_exception_the_developer_exception_page_of_a_web_application_answers()
    {
        // In Development, WebApplication adds the developer exception page outside every middleware the app adds.
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Development" });
        builder.WebHost.UseTestServer();
        builder.AddPiwiTestLogs();
        await using var app = builder.Build();
        app.UsePiwiTestLogs();
        app.MapGet("/throw", Throw);
        await app.StartAsync();

        var response = await app.GetTestClient().GetAsync("/throw");

        Assert.Equal(500, (int)response.StatusCode);
        AssertRecorded(Assert.Single(TestApp.DecodeLogs(response)!), "UnhandledExceptionTests.Throw");
    }

    [Fact]
    public async Task Records_an_exception_the_exception_handler_middleware_answers_inside_the_middleware()
    {
        await using var app = await TestApp.StartAsync(
            "Development",
            (a, _) => a.UsePiwiTestLogs(),
            services: s => s.AddProblemDetails(),
            inner: a => a.UseExceptionHandler());

        var response = await app.Client.GetAsync("/throw");

        Assert.Equal(500, (int)response.StatusCode);
        var logs = TestApp.DecodeLogs(response)!;
        Assert.Equal(["Warning", "Error"], logs.Select(e => e.Level));
        AssertRecorded(logs[1]);
    }

    [Theory]
    [InlineData(500, true)]
    [InlineData(503, true)]
    [InlineData(404, false)]
    public async Task Records_an_exception_an_exception_handler_inside_the_middleware_answers_with_a_server_error(
        int status, bool recorded)
    {
        await using var app = await TestApp.StartAsync(
            "Development",
            (a, _) => a.UsePiwiTestLogs(),
            services: s => s.AddProblemDetails().AddSingleton<IExceptionHandler>(new Answers(status, logs: false)),
            inner: a => a.UseExceptionHandler());

        var response = await app.Client.GetAsync("/throw");

        Assert.Equal(status, (int)response.StatusCode);
        var logs = TestApp.DecodeLogs(response)!;
        if (!recorded)
        {
            Assert.Equal(["Warning"], logs.Select(e => e.Level));
            return;
        }
        Assert.Equal(["Warning", "Error"], logs.Select(e => e.Level));
        AssertRecorded(logs[1]);
    }

    [Fact]
    public async Task Keeps_only_the_entry_an_exception_handler_logs_before_it_answers()
    {
        await using var app = await TestApp.StartAsync(
            "Development",
            (a, _) => a.UsePiwiTestLogs(),
            services: s => s.AddProblemDetails().AddSingleton<IExceptionHandler>(new Answers(500, logs: true)),
            inner: a => a.UseExceptionHandler());

        var response = await app.Client.GetAsync("/throw");

        var logs = TestApp.DecodeLogs(response)!;
        Assert.Equal(["Warning", "Error"], logs.Select(e => e.Level));
        Assert.EndsWith("UnhandledExceptionTests.Answers", logs[1].Category);
        Assert.Equal("Request failed", logs[1].Message);
        Assert.StartsWith("boom\n", logs[1].Stack);
    }

    [Theory]
    [InlineData("an exception handler outside the middleware")]
    [InlineData("an exception handler inside the middleware")]
    public async Task Keeps_only_the_entry_of_an_exception_the_application_logged_before_rethrowing_it(string setup)
    {
        var inside = setup == "an exception handler inside the middleware";
        await using var app = await TestApp.StartAsync(
            "Development",
            (a, _) => a.UsePiwiTestLogs(),
            services: s => s.AddProblemDetails(),
            outer: a =>
            {
                if (!inside) a.UseExceptionHandler();
            },
            inner: a =>
            {
                if (inside) a.UseExceptionHandler();
            });

        var response = await app.Client.GetAsync("/rethrow");

        Assert.Equal(500, (int)response.StatusCode);
        var logs = TestApp.DecodeLogs(response)!;
        Assert.Equal(["Warning", "Error"], logs.Select(e => e.Level));
        Assert.Equal("Order 7 failed", logs[1].Message);
    }

    /// <summary>Asserts that <paramref name="entry"/> records the <c>InvalidOperationException("boom")</c> a request threw.</summary>
    private static void AssertRecorded(WireLogEntry entry, string thrower = "TestApp.HandleAsync")
    {
        Assert.Equal("Error", entry.Level);
        Assert.Equal("System.InvalidOperationException", entry.Category);
        Assert.Equal("boom", entry.Message);
        Assert.StartsWith("boom\n", entry.Stack);
        Assert.Contains(thrower, entry.Stack);
        Assert.DoesNotContain("lambda_method", entry.Stack);
        Assert.DoesNotContain("PiwiTestLogHeaderMiddleware", entry.Stack);
    }

    private static void Throw() => throw new InvalidOperationException("boom");

    /// <summary>Answers every exception with <paramref name="status"/>, logging it first when <paramref name="logs"/> is set.</summary>
    private sealed class Answers(int status, bool logs) : IExceptionHandler
    {
        public async ValueTask<bool> TryHandleAsync(HttpContext context, Exception exception, CancellationToken cancellationToken)
        {
            if (logs)
                context.RequestServices.GetRequiredService<ILogger<Answers>>().LogError(exception, "Request failed");
            context.Response.StatusCode = status;
            await context.Response.WriteAsJsonAsync(new { failed = true }, cancellationToken);
            return true;
        }
    }
}
