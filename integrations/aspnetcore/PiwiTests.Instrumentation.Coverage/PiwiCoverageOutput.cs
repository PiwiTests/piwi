using System;
using System.IO;
using System.Text.Json;

namespace PiwiTests.Instrumentation.Coverage;

/// <summary>
/// The run-level report a process writes when it exits, for a process that serves no coverage endpoint: a unit-test
/// host running code built with coverage instrumentation, with <c>PIWI_COVERAGE_OUTPUT</c> set to the file to write.
/// The report is the one a backend serves at run level, <c>{ "v": 1, "files": [...] }</c> at the lines granularity,
/// with the executable lines of every instrumented assembly in the process's base directory, and its paths as the
/// compiler recorded them; <c>piwi coverage upload --format piwi</c> makes them repository-relative.
/// </summary>
internal static class PiwiCoverageOutput
{
    internal const string Variable = "PIWI_COVERAGE_OUTPUT";

    private static int s_armed;

    /// <summary>Writes the report at process exit when <c>PIWI_COVERAGE_OUTPUT</c> names a file; once per process.</summary>
    internal static void Arm()
    {
        var path = Environment.GetEnvironmentVariable(Variable)?.Trim();
        if (string.IsNullOrEmpty(path) || System.Threading.Interlocked.Exchange(ref s_armed, 1) != 0)
            return;

        AppDomain.CurrentDomain.ProcessExit += (_, _) => Write(path);
    }

    /// <summary>Writes the process's run-level report to <paramref name="path"/>; a failure is written to standard error.</summary>
    internal static void Write(string path)
    {
        try
        {
            var report = new PiwiCoverageReport(PiwiCoverageGranularity.Lines, document => document);
            report.AddRunLevel();
            report.AddExecutableLines();

            var directory = Path.GetDirectoryName(Path.GetFullPath(path));
            if (!string.IsNullOrEmpty(directory))
                Directory.CreateDirectory(directory);

            using var stream = File.Create(path);
            using var writer = new Utf8JsonWriter(stream);
            writer.WriteStartObject();
            writer.WriteNumber("v", 1);
            writer.WritePropertyName("files");
            report.WriteFiles(writer);
            writer.WriteEndObject();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            Console.Error.WriteLine($"PiwiTests.Instrumentation.Coverage: could not write {Variable} ({path}): {e.Message}");
        }
    }
}
