using System;
using System.Linq;
using Microsoft.Extensions.Logging;
using Xunit;

namespace PiwiTests.Instrumentation.Tests;

public class CaptureTests
{
    [Fact]
    public void TryAdd_outside_a_capture_is_a_no_op()
    {
        Assert.False(PiwiTestLogCapture.IsCapturing);

        PiwiTestLogCapture.TryAdd(LogLevel.Error, "Orders", "dropped", null);
        PiwiTestLogCapture.TryAddUnhandled(Thrown());

        Assert.Null(PiwiTestLogCapture.Stop());
    }

    [Fact]
    public void Keeps_warning_and_above_only()
    {
        PiwiTestLogCapture.Begin();
        foreach (var level in Enum.GetValues<LogLevel>().Where(l => l != LogLevel.None))
            PiwiTestLogCapture.TryAdd(level, "Orders", level.ToString(), null);

        var logs = PiwiTestLogCapture.Stop()!;

        Assert.Equal(["Warning", "Error", "Critical"], logs.Select(e => e.Level));
    }

    [Fact]
    public void Caps_the_entries_and_truncates_long_messages()
    {
        PiwiTestLogCapture.Begin();
        PiwiTestLogCapture.TryAdd(LogLevel.Warning, "Orders", new string('x', 600), null);
        for (var i = 0; i < 60; i++)
            PiwiTestLogCapture.TryAdd(LogLevel.Warning, "Orders", "again", null);

        var logs = PiwiTestLogCapture.Stop()!;

        Assert.Equal(50, logs.Count);
        Assert.Equal(new string('x', 500) + "…", logs[0].Message);
    }

    [Fact]
    public void Records_the_exception_message_and_a_shrunk_stack()
    {
        PiwiTestLogCapture.Begin();
        PiwiTestLogCapture.TryAdd(LogLevel.Error, "Orders", "failed", Thrown());

        var entry = Assert.Single(PiwiTestLogCapture.Stop()!);

        Assert.Equal("boom", entry.ExceptionMessage);
        Assert.Contains("p.i.t.CaptureTests.Thrown", entry.StackTrace);
    }

    [Fact]
    public void Records_an_unhandled_exception_as_an_error_named_by_its_type()
    {
        PiwiTestLogCapture.Begin();
        PiwiTestLogCapture.TryAddUnhandled(Thrown());

        var entry = Assert.Single(PiwiTestLogCapture.Stop()!);

        Assert.Equal("Error", entry.Level);
        Assert.Equal("System.InvalidOperationException", entry.Category);
        Assert.Equal("boom", entry.Message);
        Assert.Equal("boom", entry.ExceptionMessage);
        Assert.Contains("p.i.t.CaptureTests.Thrown", entry.StackTrace);
    }

    [Fact]
    public void Records_an_unhandled_exception_once_unless_a_captured_entry_already_carries_it()
    {
        PiwiTestLogCapture.Begin();
        var logged = Thrown();
        var loggedBelowWarning = Thrown();
        PiwiTestLogCapture.TryAdd(LogLevel.Error, "Orders", "failed", logged);
        PiwiTestLogCapture.TryAdd(LogLevel.Information, "Orders", "retrying", loggedBelowWarning);
        PiwiTestLogCapture.TryAddUnhandled(logged);
        PiwiTestLogCapture.TryAddUnhandled(loggedBelowWarning);
        PiwiTestLogCapture.TryAddUnhandled(loggedBelowWarning);

        var logs = PiwiTestLogCapture.Stop()!;

        Assert.Equal(["failed", "boom"], logs.Select(e => e.Message));
    }

    [Fact]
    public void Shrinks_namespace_segments_to_their_first_letter()
    {
        Assert.Equal(
            "m.s.PaymentService.ProcessPayment",
            PiwiTestLogCapture.ShrinkNamespace("MyApp.Services.PaymentService.ProcessPayment"));
    }

    private static Exception Thrown()
    {
        try
        {
            throw new InvalidOperationException("boom");
        }
        catch (Exception e)
        {
            return e;
        }
    }
}
