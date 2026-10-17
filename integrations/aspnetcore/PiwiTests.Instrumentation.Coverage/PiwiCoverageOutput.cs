using System;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Threading;

namespace PiwiTests.Instrumentation.Coverage;

/// <summary>
/// The run-level report a process writes when it exits, for a process that serves no coverage endpoint: a unit-test
/// host running code built with coverage instrumentation, with <c>PIWI_COVERAGE_OUTPUT</c> naming the file to write,
/// or a directory to write a file in, one per process.
/// The report is the one a backend serves at run level, <c>{ "v": 1, "files": [...] }</c> at the lines granularity,
/// with the executable lines of every instrumented assembly in the process's base directory, and its paths as the
/// compiler recorded them; <c>piwi coverage upload --format piwi</c> makes them repository-relative.
/// </summary>
/// <remarks>
/// A test host has little time left once its tests end: VSTest stops it 100 ms after the test session ends, unless
/// <c>VSTEST_TESTHOST_SHUTDOWN_TIMEOUT</c> gives it longer. The costly part of the report, reading the span table of
/// every instrumented assembly and the executable lines of each, is built on a background thread from the first
/// instrumented call on; at exit, the report adds the payloads the run recorded and is written to a temporary file,
/// then renamed, so a reader never sees half a report.
/// </remarks>
internal static class PiwiCoverageOutput
{
    internal const string Variable = "PIWI_COVERAGE_OUTPUT";

    private static int s_armed;

    /// <summary>
    /// When <c>PIWI_COVERAGE_OUTPUT</c> is set, starts building the report and writes it at process exit; once per
    /// process.
    /// </summary>
    internal static void Arm()
    {
        var setting = Environment.GetEnvironmentVariable(Variable)?.Trim();
        if (string.IsNullOrEmpty(setting) || Interlocked.Exchange(ref s_armed, 1) != 0)
            return;

        string path;
        try
        {
            path = ReportPath(setting, HostName(), Environment.ProcessId);
        }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException or IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"PiwiTests.Instrumentation.Coverage: {Variable} ({setting}) names no file: {e.Message}");
            return;
        }

        var report = new PendingReport();
        new Thread(report.Prepare) { IsBackground = true, Priority = ThreadPriority.BelowNormal, Name = "Piwi coverage report" }.Start();
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Write(path, report);
    }

    /// <summary>
    /// The file <c>PIWI_COVERAGE_OUTPUT</c> names, as a full path: the value itself, or, when it names a directory (it
    /// ends with a directory separator, or is an existing directory), the file
    /// <c>piwi-coverage-&lt;host&gt;-&lt;process id&gt;.json</c> in it, so the test hosts of several test projects
    /// write a report each.
    /// </summary>
    internal static string ReportPath(string setting, string host, int processId)
    {
        var full = Path.GetFullPath(setting);
        var directory = setting.EndsWith(Path.DirectorySeparatorChar) || setting.EndsWith(Path.AltDirectorySeparatorChar) || Directory.Exists(full);
        return directory ? Path.Combine(full, $"piwi-coverage-{host}-{processId}.json") : full;
    }

    /// <summary>
    /// The name of the application the process runs, for a file name: the one its <c>.deps.json</c> names (a VSTest
    /// host runs with the test project's), else the entry assembly's.
    /// </summary>
    internal static string HostName()
    {
        var deps = (AppContext.GetData("APP_CONTEXT_DEPS_FILES") as string)?.Split(';')[0];
        const string suffix = ".deps.json";
        var name = deps is not null && deps.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)
            ? Path.GetFileName(deps)[..^suffix.Length]
            : Assembly.GetEntryAssembly()?.GetName().Name;
        if (string.IsNullOrEmpty(name))
            return "process";

        foreach (var invalid in Path.GetInvalidFileNameChars())
            name = name.Replace(invalid, '_');
        return name;
    }

    /// <summary>Writes the process's run-level report to <paramref name="path"/>; a failure is written to standard error.</summary>
    internal static void Write(string path)
    {
        var report = new PendingReport();
        report.Prepare();
        Write(path, report);
    }

    private static void Write(string path, PendingReport report)
    {
        var temporary = $"{path}.{Environment.ProcessId}.tmp";
        try
        {
            var directory = Path.GetDirectoryName(Path.GetFullPath(path));
            if (!string.IsNullOrEmpty(directory))
                Directory.CreateDirectory(directory);

            using (var stream = File.Create(temporary))
                report.WriteTo(stream);
            File.Move(temporary, path, overwrite: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            Console.Error.WriteLine($"PiwiTests.Instrumentation.Coverage: could not write {Variable} ({path}): {e.Message}");
            try
            {
                File.Delete(temporary);
            }
            catch (Exception cleanup) when (cleanup is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
            {
                // The temporary file stays.
            }
        }
    }

    /// <summary>A run-level report whose executable lines are added ahead of the payloads, which only exit adds.</summary>
    private sealed class PendingReport
    {
        private readonly object _lock = new();
        private readonly PiwiCoverageReport _report = new(PiwiCoverageGranularity.Lines, document => document);

        /// <summary>
        /// Adds the executable lines of every instrumented module, and writes the report once to nowhere, which merges
        /// its ranges and compiles the code that writes it. Never throws: it runs on a thread of its own.
        /// </summary>
        public void Prepare()
        {
            try
            {
                lock (_lock)
                {
                    _report.AddExecutableLines();
                    using var writer = new Utf8JsonWriter(Stream.Null);
                    _report.WriteFiles(writer);
                }
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"PiwiTests.Instrumentation.Coverage: could not read the executable lines: {e.Message}");
            }
        }

        /// <summary>Adds the modules registered since <see cref="Prepare"/> and the run-level payloads, and writes the report.</summary>
        public void WriteTo(Stream stream)
        {
            lock (_lock)
            {
                _report.AddExecutableLines();
                _report.AddRunLevel();

                using var writer = new Utf8JsonWriter(stream);
                writer.WriteStartObject();
                writer.WriteNumber("v", 1);
                writer.WritePropertyName("files");
                _report.WriteFiles(writer);
                writer.WriteEndObject();
            }
        }
    }
}
